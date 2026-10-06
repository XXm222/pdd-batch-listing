const test=require('node:test');
const assert=require('node:assert/strict');
const {AgentService,parseDiagnosis,allowedActions,taskFacts}=require('../dist-electron/electron/agent-service');
const {ModelClient}=require('../dist-electron/electron/model-client');

const answer=(action='resume')=>({summary:'依据当前任务继续核对原页面。',proposals:[{action,reason:'重新核对原商品页面再继续。',evidence:['当前未尝试保存。']}]});
function fixture(overrides={},pageFacts){
  const shop={id:'s',name:'fixture shop',account:'fixture-private-account',credentialsSaved:true,updatedAt:'2026-01-01'};
  let task={id:'t',shopId:shop.id,shopName:shop.name,shopSnapshot:{name:shop.name,account:shop.account,updatedAt:shop.updatedAt},time:'2026-01-01',status:'awaiting_user',attempt:1,goodsId:'123',code:'fixture',title:'fixture',error:{code:'form_changed',message:'页面未接受字段',recovery:'inspect_form'},productSnapshot:{id:'p',code:'fixture',title:'fixture',category:'泡脚桶',brand:'无品牌',material:'塑料',audience:'',foldable:'',reference:'100',skuCode:'',discount:'',shipping:'48小时',freight:'默认',expectedShop:'',demo:false,source:'/private/fixture',skus:[],main:[],detail:[],images:{},templateFormat:'2'},...overrides};
  const config={baseUrl:'https://fixture.invalid/v1',model:'fixture-model',keySaved:true,autoDiagnose:true,autoReadPage:true,autoRecover:true};
  const store={all:kind=>structuredClone(kind==='tasks'?[task]:kind==='shops'?[shop]:[]),setting:()=>({value:config,secret:'encrypted-fixture-key'}),updateTask:value=>{task=structuredClone(value);}};
  let inspections=0,repairs=0;
  const agent=new AgentService(store,async v=>v,async()=>'fixture-api-key',()=>false,async()=>{inspections++;return pageFacts||{available:true,capturedAt:'2026-01-01',fields:[{name:'材质',value:'塑料'}]};},async()=>{repairs++;return {ok:true,message:'原页面已恢复响应'};});
  return {agent,store,config,get task(){return task;},get inspections(){return inspections;},get repairs(){return repairs;}};
}
async function withReplies(replies,work){
  const original=ModelClient.prototype.complete,requests=[];
  ModelClient.prototype.complete=async function(messages,tools,signal,options){requests.push({messages:structuredClone(messages),tools,options});const reply=replies.shift();assert(reply,'unexpected model call');return reply;};
  try{await work(requests);}finally{ModelClient.prototype.complete=original;}
}
const reply=content=>({message:{role:'assistant',content},tokens:10});

test('diagnosis accepts a unique JSON object wrapped in prose or a Markdown fence',()=>{
  const task=fixture().task;
  for(const content of [JSON.stringify(answer()),'```JSON\n'+JSON.stringify(answer())+'\n```','以下是诊断：\n'+JSON.stringify(answer())+'\n以上为结果。'])assert.equal(parseDiagnosis(content,task).proposals[0].action,'resume');
  const escaped={...answer(),summary:'字段值含 {花括号} 和 "引号"。'};
  assert.equal(parseDiagnosis('结果：'+JSON.stringify(escaped),task).summary,escaped.summary);
});

test('compatibility parsing still rejects ambiguous answers and prohibited actions',()=>{
  const task=fixture().task;
  assert.throws(()=>parseDiagnosis(JSON.stringify(answer())+'\n'+JSON.stringify(answer('manual')),task),/多份诊断/);
  assert.throws(()=>parseDiagnosis(JSON.stringify(answer('publish')),task),/已拦截/);
  assert.throws(()=>parseDiagnosis('null',task),/缺少建议/);
  assert.throws(()=>parseDiagnosis(JSON.stringify(answer()),{...task,saveAttemptedAt:'2026-01-01'}),/已拦截/);
});

test('malformed final answer gets exactly one bounded retry with no tools',async()=>{
  const f=fixture();
  await withReplies([reply('请检查页面。'),reply(JSON.stringify(answer()))],async requests=>{
    await f.agent.diagnose('t',false);
    assert.equal(f.task.agentDiagnosis.status,'done');
    assert.equal(requests.length,2);assert.equal(requests[1].tools,undefined);assert.equal(requests[1].options.maxTokens,4096);
    assert.equal(f.task.agentDiagnosis.tokens,20);assert.match(f.task.agentDiagnosis.sources.join(' '),/一次只读格式重试/);
    const payload=JSON.stringify(requests);assert(!payload.includes('fixture-private-account'));assert(!payload.includes('fixture-api-key'));assert(!payload.includes('/private/fixture'));
  });
});

test('format retry does not repeat a page recovery tool',async()=>{
  const f=fixture();
  await withReplies([{message:{role:'assistant',content:null,tool_calls:[{id:'one',type:'function',function:{name:'wait_form_ready',arguments:'{}'}}]}},reply('恢复完成。'),reply(JSON.stringify(answer()))],async requests=>{
    await f.agent.diagnose('t',true,'automatic');
    assert.equal(f.task.agentDiagnosis.status,'done');assert.equal(f.repairs,1);assert.equal(f.inspections,2);
    assert.equal(requests.length,3);assert.equal(requests[2].tools,undefined);
    assert(requests[2].messages.some(m=>m.role==='tool'&&m.content.includes('原页面已恢复响应')));
  });
});

test('repeated malformed response leaves task resumable and does not auto continue',async()=>{
  const f=fixture();let continuations=0;
  await withReplies([reply('not json'),reply('still not json')],async requests=>{
    await f.agent.handleFailure('t',()=>continuations++);
    assert.equal(f.task.agentDiagnosis.status,'failed');assert.match(f.task.agentDiagnosis.error,/已自动重试一次.*原任务已保留/);
    assert.equal(f.task.status,'awaiting_user');assert.equal(f.task.error.code,'form_changed');assert.equal(continuations,0);assert.equal(requests.length,2);
  });
});

test('reasoning-only truncated response has a useful error without saving reasoning',async()=>{
  const f=fixture();
  await withReplies([{message:{role:'assistant',content:null,reasoning_content:'private reasoning'},finishReason:'length'},{message:{role:'assistant',content:null,reasoning_content:'private reasoning'},finishReason:'length'}],async()=>{
    await f.agent.diagnose('t',false);
    assert.match(f.task.agentDiagnosis.error,/输出长度限制截断/);assert(!JSON.stringify(f.task.agentDiagnosis).includes('private reasoning'));
  });
});

test('unsafe actions and key echoes are rejected without a format retry',async()=>{
  for(const content of [JSON.stringify(answer('publish')),'fixture-api-key malformed']){
    const f=fixture();
    await withReplies([reply(content)],async requests=>{await f.agent.diagnose('t',false);assert.equal(f.task.agentDiagnosis.status,'failed');assert.equal(requests.length,1);assert(!JSON.stringify(f.task).includes('fixture-api-key'));});
  }
});

test('tool requests in format retry never execute',async()=>{
  const f=fixture();
  await withReplies([reply('not json'),{message:{role:'assistant',tool_calls:[{id:'unsafe',type:'function',function:{name:'wait_form_ready',arguments:'{}'}}]}}],async()=>{
    await f.agent.diagnose('t',true,'automatic');assert.equal(f.repairs,0);assert.equal(f.task.agentDiagnosis.status,'failed');assert.match(f.task.agentDiagnosis.error,/仍请求执行工具/);
  });
});

async function withApiResponses(messages,work){
  const original=global.fetch,requests=[];
  global.fetch=async(_url,options)=>{requests.push(JSON.parse(options.body));const message=messages.shift();assert(message,'unexpected model request');return Response.json({choices:[{message,finish_reason:'stop'}],usage:{total_tokens:10}});};
  try{await work(requests);}finally{global.fetch=original;}
}
const tool=(name,id=name,args='{}')=>({id,type:'function',function:{name,arguments:args}});

test('three compatible tool calls are normalized then dispatched serially within the existing budget',async()=>{
  const f=fixture();
  await withApiResponses([{content:null,tool_calls:[tool('read_task_facts'),{id:'page',function:{name:'read_form_fields',arguments:{}}},tool('wait_form_ready')]},{content:JSON.stringify(answer('manual'))}],async requests=>{
    await f.agent.diagnose('t',true,'automatic');assert.equal(f.task.agentDiagnosis.status,'done');assert.equal(f.repairs,1);assert.equal(requests.length,2);
    assert.equal(requests[1].messages.filter(m=>m.role==='tool').length,3);assert.equal(f.task.agentDiagnosis.tokens,20);
  });
});

test('malformed transport gets one tools-disabled correction and no part of that batch executes',async()=>{
  const f=fixture();
  await withApiResponses([{content:null,tool_calls:[tool('wait_form_ready'),tool('read_form_fields','')]},{content:JSON.stringify(answer('manual'))}],async requests=>{
    await f.agent.diagnose('t',true,'automatic');assert.equal(f.task.agentDiagnosis.status,'done');assert.equal(f.repairs,0);assert.equal(requests.length,2);assert.equal(requests[1].tools,undefined);
    assert(!requests[1].messages.some(m=>m.role==='tool'||m.tool_calls));assert.match(f.task.agentDiagnosis.sources.join(' '),/ID.*该批工具未执行/);
  });
});

test('invalid JSON or extra arguments reject the entire batch before a valid recovery tool runs',async()=>{
  for(const args of ['{','{"script":"private-payload"}','[]','null']){
    const f=fixture();
    await withReplies([{message:{role:'assistant',tool_calls:[tool('wait_form_ready'),tool('read_form_fields','bad',args)]}},reply(JSON.stringify(answer('manual')))],async requests=>{
      await f.agent.diagnose('t',true,'automatic');assert.equal(f.task.agentDiagnosis.status,'done');assert.equal(f.repairs,0);assert.equal(requests.length,2);assert.equal(requests[1].tools,undefined);
      assert(!JSON.stringify(requests[1]).includes('private-payload'));assert(!JSON.stringify(f.task.agentDiagnosis).includes('private-payload'));
    });
  }
});

test('a forbidden later tool prevents earlier recovery execution without offering an action retry',async()=>{
  const f=fixture();
  await withReplies([{message:{role:'assistant',tool_calls:[tool('wait_form_ready'),tool('execute_js')]}}],async requests=>{
    await f.agent.diagnose('t',true,'automatic');assert.equal(f.task.agentDiagnosis.status,'failed');assert.equal(f.repairs,0);assert.equal(requests.length,1);assert.match(f.task.agentDiagnosis.error,/工具调用超出/);
  });
});

test('tool-format correction preserves previous completed operations and never replays them',async()=>{
  const f=fixture();
  await withApiResponses([{content:null,tool_calls:[tool('wait_form_ready')]},{content:null,tool_calls:[tool('read_form_fields','')]},{content:JSON.stringify(answer('manual'))}],async requests=>{
    await f.agent.diagnose('t',true,'automatic');assert.equal(f.task.agentDiagnosis.status,'done');assert.equal(f.repairs,1);assert.equal(requests.length,3);assert.equal(requests[2].tools,undefined);
    assert.equal(requests[2].messages.filter(m=>m.role==='tool').length,1);assert.equal(f.task.agentDiagnosis.operations.length,1);
  });
});

test('repeated malformed tools stop after one correction with no automatic continuation',async()=>{
  const f=fixture();let continued=0;
  await withApiResponses([{content:null,tool_calls:[tool('read_form_fields','')]},{content:null,tool_calls:[tool('wait_form_ready','')]}],async requests=>{
    await f.agent.handleFailure('t',()=>continued++);assert.equal(f.task.agentDiagnosis.status,'failed');assert.equal(f.repairs,0);assert.equal(continued,0);assert.equal(requests.length,2);assert.match(f.task.agentDiagnosis.error,/已自动重试一次/);
  });
});

test('connection diagnosis remains local even without a model configuration',async()=>{
  for(const code of ['browser_unavailable']){
    const f=fixture({goodsId:undefined,error:{code,message:'请检查浏览器',recovery:'retry'}});f.store.setting=()=>undefined;
    await withReplies([],async()=>{
      await f.agent.diagnose('t',true);assert.equal(f.task.agentDiagnosis.status,'done');assert.equal(f.task.agentDiagnosis.model,'本机流程检查');assert.equal(f.task.agentDiagnosis.proposals[0].action,'resume');assert.equal(f.inspections,0);assert.match(f.task.agentDiagnosis.summary,/未调用模型/);
      assert.equal(f.agent.proposal('t',f.task.agentDiagnosis.id,0).action,'resume');
    });
  }
});

test('local connection diagnosis preserves save and shop confirmation guards',async()=>{
  for(const [recovery,expected] of [['readback','readback'],['confirm_shop','manual']]){
    const f=fixture({saveAttemptedAt:'2026-01-01',error:{code:'browser_unavailable',message:'连接中断',recovery}});
    await withReplies([],async()=>{await f.agent.diagnose('t',false);assert.equal(f.task.agentDiagnosis.proposals[0].action,expected);});
  }
});

test('legacy connection timeout is local only for the exact pre-form connection failure',async()=>{
  const error={code:'page_timeout',message:'请在默认浏览器中打开拼多多后台，并确认 Kimi 扩展已连接',recovery:'retry'};
  const f=fixture({goodsId:undefined,error,checkpoint:{step:'connect',state:'running',updatedAt:'2026-01-01'}});
  await withReplies([],async()=>{await f.agent.diagnose('t',true);assert.equal(f.task.agentDiagnosis.model,'本机流程检查');assert.equal(f.inspections,0);});
  for(const overrides of [{goodsId:'123'},{checkpoint:{step:'form',state:'running',updatedAt:'2026-01-01'}},{error:{...error,message:'商品页面加载超时'}}]){
    const other=fixture({goodsId:undefined,error,checkpoint:{step:'connect',state:'running',updatedAt:'2026-01-01'},...overrides});
    await withReplies([reply(JSON.stringify(answer()))],async requests=>{await other.agent.diagnose('t',false);assert.equal(requests.length,1);assert.equal(other.task.agentDiagnosis.model,'fixture-model');});
  }
});

test('ModelClient normalizes compatible content blocks and preserves truncation metadata',async()=>{
  const original=global.fetch;
  try{
    global.fetch=async()=>Response.json({choices:[{finish_reason:'stop',message:{content:[{type:'text',text:'{"summary":'},{type:'text',text:'"hello"}' }]}}]});
    const client=new ModelClient({baseUrl:'https://fixture.invalid',model:'fixture',apiKey:''});
    const normal=await client.complete([{role:'user',content:'fixture'}]);assert.equal(normal.message.content,'{"summary":"hello"}');assert.equal(normal.finishReason,'stop');
    global.fetch=async()=>Response.json({choices:[{finish_reason:'length',message:{content:null,reasoning_content:'reasoning'}}]});
    const truncated=await client.complete([{role:'user',content:'fixture'}]);assert.equal(truncated.message.content,null);assert.equal(truncated.finishReason,'length');
  }finally{global.fetch=original;}
});

const loginScene=(extra={})=>({available:true,capturedAt:'2026-01-01',login:{trustedOrigin:true,path:'/home',headerPresent:true,headerLoaded:true,logoutPresent:true,logoutVisible:false,signedIn:true,loginPage:false,accountFormVisible:false,shopExact:false,shopCaseOnly:true,accountExact:false,accountRequired:true,identityMatches:true,security:'none',...extra}});

test('login page failure sends only structured login evidence, without product or credential data',async()=>{
  const f=fixture({goodsId:undefined,error:{code:'login_required',message:'登录身份与 fixture-private-account 不一致',recovery:'retry'},checkpoint:{step:'login',state:'running',updatedAt:'2026-01-01'}},loginScene());
  await withReplies([reply(JSON.stringify(answer('manual')))],async requests=>{
    await f.agent.diagnose('t',true);assert.equal(f.inspections,1);assert.equal(f.task.agentDiagnosis.status,'done');
    const payload=JSON.stringify(requests[0].messages);assert(payload.includes('shopCaseOnly'));assert(payload.includes('identity_mismatch'));
    for(const value of ['fixture-private-account','fixture-api-key','塑料','泡脚桶','/private/fixture'])assert(!payload.includes(value));
    assert.equal(JSON.parse(requests[0].messages[1].content).task.fields,undefined);
    assert(requests[0].tools.every(t=>['read_task_facts','read_form_fields'].includes(t.function.name)));
  });
});

test('stable verified login auto-resumes once with a check-only marker',async()=>{
  const f=fixture({goodsId:undefined,error:{code:'login_required',message:'登录尚未确认',recovery:'retry'},checkpoint:{step:'login',state:'running',updatedAt:'2026-01-01'}},loginScene());let continued=0;
  await withReplies([reply(JSON.stringify(answer()))],async()=>{await f.agent.handleFailure('t',()=>continued++);assert.equal(f.task.agentDiagnosis.status,'done');assert.equal(f.task.agentDiagnosis.trigger,'automatic');assert.equal(continued,1);assert.equal(f.task.loginCheckOnly,true);assert.equal(f.task.autoRecoveryCount,1);assert.equal(f.inspections,2);assert.equal(f.repairs,0);await f.agent.handleFailure('t',()=>continued++);assert.equal(continued,1);});
});

test('known credential and challenge failures stay local and cannot propose resubmission',async()=>{
  for(const message of ['后台提示账号或密码有误或账号被锁定，请修改店铺登录信息；程序不会反复尝试','请在已连接的浏览器完成验证码或短信验证，再点击核对登录结果','请先在已连接的浏览器完成登录验证，再继续任务']){
    const f=fixture({goodsId:undefined,error:{code:'login_required',message,recovery:'retry'}});f.store.setting=()=>undefined;
    await withReplies([],async()=>{await f.agent.diagnose('t',true);assert.equal(f.task.agentDiagnosis.proposals[0].action,'manual');assert.equal(f.inspections,0);assert.throws(()=>parseDiagnosis(JSON.stringify(answer()),f.task),/已拦截/);});
  }
});

test('new security challenge visible in login facts prevents any model call or retry',async()=>{
  const f=fixture({goodsId:undefined,error:{code:'login_required',message:'登录尚未确认',recovery:'retry'}},loginScene({security:'captcha'}));
  await withReplies([],async()=>{await f.agent.diagnose('t',true);assert.equal(f.inspections,1);assert.equal(f.task.agentDiagnosis.proposals[0].action,'manual');assert.equal(f.task.agentDiagnosis.model,'本机登录状态检查');assert.equal(f.repairs,0);});
});

const loginTask=()=>({goodsId:undefined,error:{code:'login_required',message:'登录尚未确认',recovery:'retry'},checkpoint:{step:'login',state:'running',updatedAt:'2026-01-01'}});

test('fresh login inspection refuses changed or unsafe browser state after model analysis',async()=>{
  for(const change of [{trustedOrigin:false},{headerPresent:false},{headerLoaded:false},{signedIn:false},{identityMatches:false},{loginPage:true},{accountFormVisible:true},{security:'captcha'},{security:'credentials_rejected'}]){
    const f=fixture(loginTask(),loginScene());let inspections=0,continued=0;f.agent.inspect=async()=>loginScene(++inspections===1?{}:change);
    await withReplies([reply(JSON.stringify(answer()))],async()=>{await f.agent.handleFailure('t',()=>continued++);assert.equal(continued,0,JSON.stringify(change));assert.equal(f.task.loginCheckOnly,undefined);assert.equal(inspections,2);});
  }
});

test('fresh login recovery stops when task, shop, pause state or diagnosis changes during inspection',async()=>{
  for(const scenario of ['task','shop','pause','diagnosis','running','setting']){
    const f=fixture(loginTask(),loginScene());let inspections=0,continued=0,paused=false;const all=f.store.all;
    f.agent.inspect=async()=>{if(++inspections===2){
      if(scenario==='task'){const t=f.task;t.productSnapshot.title='changed';f.store.updateTask(t);}
      if(scenario==='shop')f.store.all=kind=>kind==='shops'?all(kind).map(s=>({...s,updatedAt:'changed'})):all(kind);
      if(scenario==='pause')paused=true;
      if(scenario==='diagnosis'){const t=f.task;t.agentDiagnosis.id='replaced';f.store.updateTask(t);}
      if(scenario==='running')f.agent.isRunning=()=>true;
      if(scenario==='setting')f.config.autoRecover=false;
    }return loginScene();};
    await withReplies([reply(JSON.stringify(answer()))],async()=>{await f.agent.handleFailure('t',()=>continued++,()=>!paused);assert.equal(continued,0,scenario);assert.equal(f.task.loginCheckOnly,undefined);});
  }
});

test('login auto-recovery respects consent, recovery setting and once limit',async()=>{
  for(const scenario of ['consent','setting','once']){
    const f=fixture({...loginTask(),...(scenario==='once'?{autoRecoveryCount:1}:{})},loginScene());let continued=0;
    if(scenario==='consent')f.config.autoReadPage=false;if(scenario==='setting')f.config.autoRecover=false;
    await withReplies(scenario==='once'?[]:[reply(JSON.stringify(answer()))],async()=>{await f.agent.handleFailure('t',()=>continued++);assert.equal(continued,0);assert.equal(f.task.loginCheckOnly,undefined);});
  }
});

test('failed recovery dispatch clears the unconsumed one-use login marker',async()=>{
  const f=fixture(loginTask(),loginScene());
  await withReplies([reply(JSON.stringify(answer()))],async()=>{await f.agent.handleFailure('t',()=>{assert.equal(f.task.loginCheckOnly,true);throw Error('dispatch stopped');});assert.equal(f.task.loginCheckOnly,undefined);assert.equal(f.task.autoRecoveryCount,1);});
});

test('Agent is never offered a navigation recovery tool and a fabricated restore call is rejected',async()=>{
  const f=fixture();
  await withReplies([{message:{role:'assistant',tool_calls:[{id:'restore',type:'function',function:{name:'restore_original_form',arguments:'{}'}}]}}],async requests=>{
    await f.agent.diagnose('t',true,'automatic');assert(!requests[0].tools.some(t=>t.function.name==='restore_original_form'));assert.equal(f.repairs,0);assert.equal(f.task.agentDiagnosis.status,'failed');assert.match(f.task.agentDiagnosis.error,/工具调用超出/);
  });
});

test('Agent downgrades recovery success when its immediate field read no longer matches the verified state',async()=>{
  const before={available:true,fields:[{name:'商品标题',value:'filled'}],errors:[],dialogs:[]};
  const f=fixture();let reads=0,continued=0;f.agent.inspect=async()=>++reads===1?before:{...before,fields:[{name:'商品标题',value:''}]};
  f.agent.repair=async()=>({ok:true,message:'原字段稳定',formState:JSON.stringify([before.fields,before.errors,before.dialogs,before.sku])});
  await withReplies([{message:{role:'assistant',tool_calls:[{id:'wait',type:'function',function:{name:'wait_form_ready',arguments:'{}'}}]}},reply(JSON.stringify(answer()))],async requests=>{
    await f.agent.handleFailure('t',()=>continued++);assert.equal(continued,0);assert.equal(f.task.agentDiagnosis.status,'done');assert.equal(f.task.agentDiagnosis.operations[0].ok,false);assert.match(f.task.agentDiagnosis.operations[0].message,/字段再次变化/);
    const observed=JSON.parse(requests[1].messages.find(m=>m.role==='tool').content);assert.equal(observed.ok,false);assert.equal(observed.observedPage.fields[0].value,'');
  });
});


test('expected Excel rows and observed browser SKU count use separate, explicit sources',async()=>{
  const sku={source:'browser_dom',valueMeaning:'input_values_not_generated_skus',dimensions:[{name:'颜色',enteredValues:['紫色','灰色'],emptyValueInputs:1},{name:'容量',enteredValues:['10L','20L','30L'],emptyValueInputs:1}],priceTable:{available:true,candidateCount:1,headers:['拼单价(元)','单买价(元)','库存'],rowCount:1}};
  const f=fixture({error:{code:'page_timeout',message:'后台生成的规格数量与 Excel 不一致',recovery:'retry'},checkpoint:{step:'skus'}},{available:true,fields:[{name:'商品标题',value:'fixture'}],sku});
  const t=f.task;t.productSnapshot.skus=['紫色','灰色'].flatMap(color=>['10L','20L','30L'].map(size=>({options:[{name:'颜色',value:color},{name:'容量',value:size}],group:'89',single:'90',stock:'10'})));f.store.updateTask(t);
  await withReplies([{message:{role:'assistant',tool_calls:[{id:'task',type:'function',function:{name:'read_task_facts',arguments:'{}'}},{id:'page',type:'function',function:{name:'read_form_fields',arguments:'{}'}}]}},reply(JSON.stringify(answer('manual')))],async requests=>{
    await f.agent.diagnose('t',true,'automatic');assert.equal(f.task.agentDiagnosis.status,'done');
    const initial=JSON.parse(requests[0].messages[1].content);assert.equal(initial.task.fields,undefined);assert.equal(initial.task.expectedProduct.skuCount,6);assert.equal(initial.task.expectedProduct.skus.length,6);assert.equal(initial.observedPage.sku.priceTable.rowCount,1);assert.equal(initial.observedPage.sku.dimensions[1].enteredValues.length,3);assert.equal(initial.faultScene,undefined);
    const tools=requests[1].messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));assert.equal(tools[0].expectedProduct.skuCount,6);assert.equal(tools[1].observedPage.sku.priceTable.rowCount,1);
    assert.match(requests[0].messages[0].content,/输入框中已输入的值，不代表后台已生成组合/);
  });
});

test('page/script failures cannot propose editing Excel while explicit product validation errors can',()=>{
  for(const code of ['page_timeout','platform_changed','form_lost','form_changed']){
    const t=fixture({error:{code,message:'page failure',recovery:'retry'}}).task;assert(!allowedActions(t,true).includes('edit_product'));assert.throws(()=>parseDiagnosis(JSON.stringify(answer('edit_product')),t,true),/已拦截/);
  }
  const t=fixture({error:{code:'invalid_product',message:'库存格式错误',recovery:'edit_product'}}).task;assert(allowedActions(t,true).includes('edit_product'));assert.equal(parseDiagnosis(JSON.stringify(answer('edit_product')),t,true).proposals[0].action,'edit_product');
});

test('discount diagnosis distinguishes task target from collapsed page value without offering new actions',async()=>{
  const discount={source:'browser_dom',expectedValue:'9.9',currentValue:'9.5',matchesExpected:false,regionCount:1,inputCount:0,editable:false,state:'collapsed'};
  const f=fixture({error:{code:'platform_changed',message:'未找到可编辑的满件折扣输入框',recovery:'inspect_form'}},{available:true,fields:[],discount});
  const t=f.task;t.productSnapshot.discount='9.9';f.store.updateTask(t);
  await withReplies([reply(JSON.stringify(answer('manual')))],async requests=>{
    await f.agent.diagnose('t',true,'automatic');assert.equal(f.task.agentDiagnosis.status,'done');
    const payload=JSON.parse(requests[0].messages[1].content);assert.equal(payload.task.expectedProduct.discount,'9.9');assert.deepEqual(payload.observedPage.discount,discount);
    assert.match(requests[0].messages[0].content,/不能推断类目不支持折扣/);
    assert.deepEqual(requests[0].tools.map(t=>t.function.name),['read_task_facts','read_form_fields','dismiss_notice','wait_form_ready','wait_uploads']);assert.equal(f.repairs,0);
  });
});

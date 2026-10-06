const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {PddAdapter}=require('../dist-electron/electron/platforms/pdd-adapter');
const shop={id:'s',name:'mandla旗舰店',account:'mandla旗舰店:小秘',credentialsSaved:true,updatedAt:'2026-01-01'};
const task={goodsId:undefined,shopSnapshot:{name:shop.name,account:shop.account},checkpoint:{step:'login'},error:{code:'login_required'}};
function scene({origin='https://mms.pinduoduo.com',names=['Mandla旗舰店','Mandla旗舰店:小秘','规则中心','退出当前账号'],path='/home/',body='private body fixture-password cookie-fixture',visibleLogout=false}={}){
  const logout={children:[],textContent:'退出当前账号',getClientRects:()=>visibleLogout?[{}]:[]};
  const header={innerText:names.join('\n'),textContent:names.join('\n'),children:[logout],querySelectorAll:()=>[logout]};
  const input={getClientRects:()=>[],get value(){throw Error('must not read credentials');}};
  return {location:{origin,pathname:path,href:origin+path+'?token=private-token'},document:{get cookie(){throw Error('must not read cookies');},body:{innerText:body},querySelector:s=>s==='header'?header:s==='#usernameId'||s==='#passwordId'?input:null,querySelectorAll:()=>[]},getComputedStyle:()=>({visibility:'visible'})};
}
function adapter(context){const a=new PddAdapter('/unused',async()=>{throw Error('must not decrypt shop password');});let calls=0;a.bridge={eval:async code=>{calls++;return vm.runInNewContext(code,context);}};return {a,get calls(){return calls;}};}

test('login diagnosis reads classifications before goods ID exists without exporting page or credentials',async()=>{
  const {a}=adapter(scene());const facts=await a.inspectDiagnosis(task,shop);
  assert.equal(facts.available,true);assert.equal(facts.login.shopExact,false);assert.equal(facts.login.shopCaseOnly,true);assert.equal(facts.login.accountExact,false);assert.equal(facts.login.logoutPresent,true);assert.equal(facts.login.logoutVisible,false);assert.equal(facts.login.path,'/home');
  for(const privateValue of ['Mandla','mandla','fixture-password','cookie-fixture','private-token','private body'])assert(!JSON.stringify(facts).includes(privateValue));
  assert.equal(facts.fields,undefined);
});

test('login facts reject a changed task shop and untrusted origin without reading sensitive DOM',async()=>{
  const f=adapter(scene());assert.equal((await f.a.inspectDiagnosis(task,{...shop,account:'changed'})).available,false);assert.equal(f.calls,0);
  const hostile=adapter({location:{origin:'https://example.invalid'},get document(){throw Error('untrusted DOM read');}});
  assert.equal((await hostile.a.inspectDiagnosis(task,shop)).available,false);
});

test('security classifications are returned without the source messages',async()=>{
  for(const [body,expected] of [['账号或密码错误','credentials_rejected'],['账号被锁定','account_locked'],['请输入短信验证码','sms'],['请拖动滑块','captcha'],['没有访问权限','permission_required']]){
    const {a}=adapter(scene({path:'/login',body}));const facts=await a.inspectDiagnosis(task,shop);assert.equal(facts.login.security,expected);assert.equal(facts.login.path,'/login');assert(!JSON.stringify(facts).includes(body));
  }
});

test('adapter strips unexpected browser response properties and validates classified shape',async()=>{
  const {a}=adapter(scene());const valid=(await a.inspectDiagnosis(task,shop)).login;
  a.bridge={eval:async()=>({...valid,password:'never export',names:['never export'],cookie:'never export'})};
  assert(!JSON.stringify(await a.inspectDiagnosis(task,shop)).includes('never export'));
  a.bridge={eval:async()=>({...valid,path:'/home/private-account'})};assert.equal((await a.inspectDiagnosis(task,shop)).available,false);
});

test('adapter identity check shares the complete-pair casing rule and tolerates unrelated masked text',async()=>{
  const a=new PddAdapter('/unused',async()=>{throw Error('must not decrypt');});let updates=0;
  a.task={backendChecks:[]};a.context={patch:()=>updates++};
  const state={trusted:true,loginPage:false,form:false,rejected:false,challenge:false,structure:{logoutTextPresent:true},names:['Mandla旗舰店','Mandla旗舰店:小秘','退出当前账号','138****1234']};
  a.bridge={eval:async()=>state,wait:async check=>check()};
  await a.checkIdentity(shop);assert.equal(updates,1);
  await assert.rejects(a.checkIdentity({...shop,account:'13800000000'}),/不一致/);
  a.bridge.eval=async()=>({...state,names:['Mandla旗舰店','Mandla旗舰店:另一个账号','退出当前账号']});
  await assert.rejects(a.checkIdentity(shop),/不一致/);
});

test('form diagnosis accepts the same complete identity pair and rejects another account',async()=>{
  const context=scene();context.location.href='https://mms.pinduoduo.com/goods/goods_add/index?goods_id=123';context.URL=URL;
  const original=context.document.querySelector;
  context.document.querySelector=s=>s==='[data-tracking-click-viewid="title_input_area"]'?{value:'商品标题'}:original(s);
  const {a}=adapter(context);const formTask={...task,goodsId:'123'};
  assert.equal((await a.inspectDiagnosis(formTask,shop)).available,true);
  const anotherShop={...shop,account:'mandla旗舰店:另一个账号'};
  assert.equal((await a.inspectDiagnosis({...formTask,shopSnapshot:{name:anotherShop.name,account:anotherShop.account}},anotherShop)).available,false);
});

test('form diagnosis reads entered spec values and actual SKU table headers/count without writing the DOM',async()=>{
  const context=scene();context.location.href='https://mms.pinduoduo.com/goods/goods_add/index?goods_id=123';context.URL=URL;
  const visible={getClientRects:()=>[{}],setAttribute:()=>{throw Error('diagnosis must not write DOM');},dispatchEvent:()=>{throw Error('diagnosis must not trigger input events');}};
  const dimensions=[['颜色',['紫色','灰色']],['容量',['10L','20L','30L']]].map(([name,values])=>({...visible,querySelector:()=>({value:name}),querySelectorAll:()=>[...values,''].map(value=>({...visible,value,disabled:false,readOnly:false}))}));
  const table={...visible,innerText:'默认 拼单价 单买价 库存',querySelectorAll:s=>s==='thead th'?['拼单价(元)','单买价(元)','库存'].map(innerText=>({innerText})):[{}]};
  const original=context.document.querySelector;context.document.querySelector=s=>s==='[data-tracking-click-viewid="title_input_area"]'?{value:'商品标题'}:original(s);
  context.document.querySelectorAll=s=>s==='.goods-spec-row'?dimensions:s==='table'?[table]:[];
  const {a}=adapter(context);const facts=await a.inspectDiagnosis({...task,goodsId:'123'},shop);
  assert.equal(facts.sku.source,'browser_dom');assert.equal(facts.sku.valueMeaning,'input_values_not_generated_skus');
  assert.deepEqual(JSON.parse(JSON.stringify(facts.sku.dimensions.map(d=>d.enteredValues))),[['紫色','灰色'],['10L','20L','30L']]);
  assert.equal(facts.sku.priceTable.rowCount,1);assert.deepEqual(JSON.parse(JSON.stringify(facts.sku.priceTable.headers)),['拼单价(元)','单买价(元)','库存']);
});

test('form diagnosis exposes scoped discount facts without claiming hidden stale input values',async()=>{
  const context=scene();context.location.href='https://mms.pinduoduo.com/goods/goods_add/index?goods_id=123';context.URL=URL;
  const hiddenInput={value:'9.9',getClientRects:()=>[],disabled:false,readOnly:false};
  const region={innerText:'满2件9.5折 修改',getClientRects:()=>[{}],querySelectorAll:()=>[hiddenInput],setAttribute:()=>assert.fail('diagnosis must not write DOM')};
  const original=context.document.querySelector;context.document.querySelector=s=>s==='[data-tracking-click-viewid="title_input_area"]'?{value:'商品标题'}:original(s);
  context.document.querySelectorAll=s=>s==='[id="sku.batch_discount"]'?[region]:[];
  const {a}=adapter(context);const facts=await a.inspectDiagnosis({...task,goodsId:'123',productSnapshot:{discount:'9.9'}},shop);
  assert.equal(facts.discount.expectedValue,'9.9');assert.equal(facts.discount.currentValue,'9.5');assert.equal(facts.discount.matchesExpected,false);assert.equal(facts.discount.state,'collapsed');assert.equal(facts.discount.editable,false);
  assert(!JSON.stringify(facts).includes('fixture-password'));assert(!JSON.stringify(facts).includes('mandla'));
});

const test=require('node:test');
const assert=require('node:assert/strict');
const {PddAdapter}=require('../dist-electron/electron/platforms/pdd-adapter');
const {ExecutionError}=require('../dist-electron/electron/execution');
const shop={id:'s',name:'测试店铺',account:'测试店铺:运营',credentialsSaved:true,updatedAt:'2026-01-01'};
function fixture(state,extra={}){
  let decrypted=0,filled=0,connected=0,resources=false;const a=new PddAdapter('/unused',async()=>{decrypted++;throw Error('must never decrypt');});
  const task={id:'existing-task',status:'running',loginCheckOnly:true,backendChecks:[],productSnapshot:{},...extra};
  a.bridge={connect:async()=>{connected++;},eval:async()=>state,fill:async()=>{filled++;},wait:async check=>{const result=await check();if(!result)throw new ExecutionError('page_timeout','fixture wait');return result;}};
  const context={guard:()=>{},patch:v=>Object.assign(task,v),step:async(name,work)=>{if(name==='检查本机图片资源'){resources=true;throw Error('reached resource step');}return work();}};
  return {a,task,context,get decrypted(){return decrypted;},get filled(){return filled;},get connected(){return connected;},get resources(){return resources;}};
}
const signedIn={structure:{logoutTextPresent:true},trusted:true,signedIn:true,names:['测试店铺','测试店铺:运营','退出当前账号'],loginPage:false,form:false,rejected:false,challenge:false};

test('one-use login resume verifies existing identity and continues without decrypting or filling credentials',async()=>{
  const f=fixture(signedIn);await assert.rejects(f.a.execute(f.task,shop,f.context),/reached resource step/);
  assert.equal(f.task.id,'existing-task');assert.equal(f.task.loginCheckOnly,undefined);assert.equal(f.decrypted,0);assert.equal(f.filled,0);assert.equal(f.resources,true);
});

test('session expiry, challenge or changed identity after fresh inspection stops check-only recovery',async()=>{
  for(const state of [{...signedIn,signedIn:false,loginPage:true,form:true,names:[]},{...signedIn,signedIn:false,challenge:true},{...signedIn,signedIn:false,rejected:true},{...signedIn,names:['其他店铺','其他店铺:运营','退出当前账号']}]){
    const f=fixture(state);await assert.rejects(f.a.execute(f.task,shop,f.context),error=>error.code==='login_required');
    assert.equal(f.task.loginCheckOnly,undefined);assert.equal(f.decrypted,0);assert.equal(f.filled,0);assert.equal(f.resources,false);
  }
});

test('check-only marker cannot be used for a new restart or task with a goods/save checkpoint',async()=>{
  for(const [extra,restart] of [[{goodsId:'123'},false],[{saveAttemptedAt:'now'},false],[{},true]]){
    const f=fixture(signedIn,extra);await assert.rejects(f.a.execute(f.task,shop,f.context,false,restart),/恢复状态已变化/);
    assert.equal(f.task.loginCheckOnly,undefined);assert.equal(f.connected,0);assert.equal(f.decrypted,0);assert.equal(f.filled,0);
  }
});

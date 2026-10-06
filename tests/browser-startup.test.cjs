const test = require('node:test');
const assert = require('node:assert/strict');
const {ensureBrowserReady} = require('../dist-electron/electron/bridge-setup');
const status = state => ({state,message:state,httpAddress:'http://127.0.0.1:10086',wsAddress:'ws://127.0.0.1:10086/ws'});
test('connected browser is reused without opening a different system browser', async()=>{
 let opened=0,checked=0;
 const result=await ensureBrowserReady({start:async()=>status('ready'),check:async()=>{checked++;return status('ready');}},async()=>{opened++;});
 assert.equal(result.state,'ready');assert.equal(opened,0);assert.equal(checked,0);
});
test('closed browser is opened once and connection is rechecked before continuing', async()=>{
 const events=[];
 const result=await ensureBrowserReady({start:async()=>status('extension_disconnected'),check:async()=>{events.push('check');return status('ready');}},async()=>{events.push('open');});
 assert.equal(result.state,'ready');assert.deepEqual(events,['open','check']);
});
test('unconnected default browser returns a bounded and specific installation hint', async()=>{
 let opened=0;
 const result=await ensureBrowserReady({start:async()=>status('extension_disconnected'),check:async()=>status('extension_disconnected')},async()=>{opened++;},0);
 assert.equal(opened,1);assert.equal(result.state,'extension_disconnected');assert.match(result.message,/系统默认浏览器/);assert.match(result.message,/继续原任务/);
});
test('service failure or version mismatch does not launch browsers or claim readiness', async()=>{
 for(const state of ['service_unavailable','version_mismatch','unsupported']){
 const result=await ensureBrowserReady({start:async()=>status(state),check:async()=>assert.fail('no check')},async()=>assert.fail('no launch'));
 assert.equal(result.state,state);
 }
});

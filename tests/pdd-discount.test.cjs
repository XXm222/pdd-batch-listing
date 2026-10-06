const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {PddAdapter}=require('../dist-electron/electron/platforms/pdd-adapter');
const element=(data={})=>({value:'',innerText:'',disabled:false,readOnly:false,...data,getClientRects(){return this.hidden?[]:[{}];}});
function fixture(inputs=[],labels=[element()],outside=[],edits=[]){
  const filled=[],clicked=[],adapter=new PddAdapter('/isolated',async()=>assert.fail('no credentials'));
  for(const label of labels)label.querySelectorAll=s=>s==='input[placeholder="5.0~9.9"]'?inputs:s==='span.price-text > span.edit'?edits:assert.fail(`unexpected scoped selector: ${s}`);
  adapter.bridge={
    eval:async code=>vm.runInNewContext(code,{document:{querySelectorAll:s=>s==='input[placeholder="5.0~9.9"]'?outside:s==='[id="sku.batch_discount"]'?labels:assert.fail(`unexpected selector: ${s}`)},getComputedStyle:()=>({visibility:'visible'})}),
    call:async(action,args)=>{assert.equal(action,'click');assert.equal(args.selector,'[id="sku.batch_discount"] span.price-text > span.edit');clicked.push(args.selector);inputs.push(element({value:'9.5'}));labels[0].innerText='';},
    fill:async(...args)=>{filled.push(args);inputs[0].value=args[1];},
    wait:async(check,_timeout,message)=>{const value=await check();if(!value)throw Error(message);return value;}
  };
  return {adapter,filled,clicked};
}
test('same visible collapsed discount skips filling, including numeric-equivalent formatting',async()=>{
  for(const text of ['满2件9.5折 修改','满2件 9.50 折 修改']){const f=fixture([],[element({innerText:text})]);await f.adapter.discount('9.5');assert.deepEqual(f.filled,[]);}
});
test('a unique editable input continues to fill a different discount',async()=>{
  const f=fixture([element({value:'9.9'})]);await f.adapter.discount('9.5');assert.deepEqual(f.filled,[['[id="sku.batch_discount"] input[placeholder="5.0~9.9"]','9.5']]);
});
test('empty, invalid, hidden or ambiguous readings never prove the discount already matches',async()=>{
  const scenes=[fixture(),fixture([],[element({innerText:'满2件 折'})]),fixture([],[element({innerText:'满2件9.5.0折'})]),fixture([],[element({innerText:'满2件9.5折',hidden:true})]),fixture([],[element({innerText:'满2件9.5折 满2件9.5折'})]),fixture([element({value:'9.5',hidden:true})]),fixture([],[element({innerText:'满2件9.9折'})])];
  for(const f of scenes){await assert.rejects(f.adapter.discount('9.5'),/未找到可编辑的满件折扣输入框/);assert.deepEqual(f.filled,[]);}
});
test('readonly, disabled and duplicate inputs cannot be written on a mismatch',async()=>{
  for(const inputs of [[element({value:'9.9',readOnly:true})],[element({value:'9.9',disabled:true})],[element({value:'9.9'}),element({value:'9.9'})]]){const f=fixture(inputs);await assert.rejects(f.adapter.discount('9.5'),/未找到可编辑的满件折扣输入框/);assert.deepEqual(f.filled,[]);}
});
test('shared reading scopes to one visible discount region and ignores unrelated or hidden stale inputs',async()=>{
  const f=fixture([element({value:'9.9',hidden:true})],[element({innerText:'满2件9.5折 修改'})],[element({value:'9.9'})]);
  const state=await f.adapter.discountState('9.9');assert.equal(state.source,'browser_dom');assert.equal(state.expectedValue,'9.9');assert.equal(state.currentValue,'9.5');assert.equal(state.matchesExpected,false);assert.equal(state.state,'collapsed');assert.equal(state.editable,false);
  await assert.rejects(f.adapter.discount('9.9'),/未找到可编辑/);assert.deepEqual(f.filled,[]);
});
test('missing/duplicate regions and conflicting input/static values never pass a same-value check',async()=>{
  const scenes=[fixture([],[]),fixture([],[element({innerText:'满2件9.9折'}),element({innerText:'满2件9.9折'})]),fixture([element({value:'9.9'})],[element({innerText:'满2件9.5折'})])];
  for(const f of scenes){const state=await f.adapter.discountState('9.9');assert.equal(state.currentValue,null);assert.equal(state.matchesExpected,false);assert.equal(state.editable,false);await assert.rejects(f.adapter.discount('9.9'),/未找到可编辑/);}
});
test('a hidden duplicate region cannot redirect a scoped fill to the wrong control',async()=>{
  const f=fixture([element({value:'9.5'})],[element({hidden:true}),element()]);const state=await f.adapter.discountState('9.9');assert.equal(state.currentValue,'9.5');assert.equal(state.editable,false);await assert.rejects(f.adapter.discount('9.9'),/未找到可编辑/);assert.deepEqual(f.filled,[]);
});
test('observed unique scoped 修改 entry expands a mismatching collapsed value, then writes and verifies',async()=>{
  const f=fixture([],[element({innerText:'满2件9.5折 修改'})],[],[element({innerText:'修改'})]);
  await f.adapter.discount('9.9');assert.deepEqual(f.clicked,['[id="sku.batch_discount"] span.price-text > span.edit']);assert.equal((await f.adapter.discountState('9.9')).matchesExpected,true);assert.equal(f.filled.length,1);
});
test('hidden, duplicated, stale or unrelated edit controls never expand the discount',async()=>{
  for(const edits of [[element({innerText:'修改',hidden:true})],[element({innerText:'修改'}),element({innerText:'修改'})],[element({innerText:'删除'})]]){
    const f=fixture([],[element({innerText:'满2件9.5折 修改'})],[],edits);await assert.rejects(f.adapter.discount('9.9'),/未找到可编辑/);assert.deepEqual(f.clicked,[]);
  }
});
test('unchanged discount after filling cannot pass verification',async()=>{
  const f=fixture([element({value:'9.5'})]);f.adapter.bridge.fill=async()=>{};
  await assert.rejects(f.adapter.discount('9.9'),/填写后与商品资料不一致/);
});

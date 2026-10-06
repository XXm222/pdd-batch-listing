export type DiscountPageFacts={source:'browser_dom';expectedValue:string;currentValue:string|null;matchesExpected:boolean;regionCount:number;inputCount:number;editable:boolean;editAvailable:boolean;state:'unreadable'|'ambiguous'|'collapsed'|'editable'|'readonly';reason?:string};
// Serialized into the page for both execution and diagnostics. Keep this function
// self-contained and read-only; no guessed edit control or generic page action.
function readPddDiscount(expectedValue:string):DiscountPageFacts{
  const visible=(e:Element)=>e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
  const decimal=(value:string)=>/^\d+(?:\.\d+)?$/.test(value.trim())&&value.trim().length<=20?Number(value.trim()):NaN;
  const allRegions=[...document.querySelectorAll<HTMLElement>('[id="sku.batch_discount"]')],regions=allRegions.filter(visible);
  const result:DiscountPageFacts={source:'browser_dom',expectedValue,currentValue:null,matchesExpected:false,regionCount:regions.length,inputCount:0,editable:false,editAvailable:false,state:'unreadable'};
  if(regions.length!==1)return {...result,state:regions.length?'ambiguous':'unreadable',reason:'未唯一读取到可见的满件折扣区域，不能判断类目是否支持'};
  const all=[...regions[0].querySelectorAll<HTMLInputElement>('input[placeholder="5.0~9.9"]')],inputs=all.filter(visible);
  const staticValues=[...regions[0].innerText.matchAll(/满2件\s*([0-9.]+)\s*折/g)].map(match=>match[1]);
  result.inputCount=inputs.length;
  if(inputs.length+staticValues.length>1)return {...result,state:'ambiguous',reason:'折扣读数不唯一，未确认当前值或编辑入口'};
  if(inputs.length===1){
    result.editable=allRegions.length===1&&all.length===1&&!inputs[0].disabled&&!inputs[0].readOnly;
    result.state=result.editable?'editable':'readonly';
  }else if(staticValues.length===1){
    result.state='collapsed';
    // Observed on the original PDD form: span.price-text > span.edit (修改).
    const edits=[...regions[0].querySelectorAll<HTMLElement>('span.price-text > span.edit')];
    result.editAvailable=allRegions.length===1&&all.length===0&&edits.length===1&&visible(edits[0])&&edits[0].innerText.trim()==='修改';
  }
  const raw=(inputs[0]?.value??staticValues[0]??'').trim(),numeric=decimal(raw);
  if(Number.isFinite(numeric)){result.currentValue=raw;result.matchesExpected=Number.isFinite(decimal(expectedValue))&&numeric===decimal(expectedValue);}
  else result.reason='当前折扣数值为空或不可确认';
  return result;
}
export const PDD_DISCOUNT_STATE=`(${readPddDiscount.toString()})`;

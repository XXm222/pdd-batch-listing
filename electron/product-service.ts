import { Store } from './store';
import { safeImageName } from '../src/domain';
import type { Asset, Product } from '../src/types';
const uuid=/^[a-f0-9-]{36}$/i;
export function sanitizeProducts(store:Store,input: unknown): Product[] {
  if (!Array.isArray(input) || !input.length || input.length > 200) throw new Error('商品资料数量不正确');
  const assets = new Map(store.all<Asset>('assets').map(a => [a.id, a]));
  const ids = new Set<string>(); const codes = new Set<string>();
  return input.map(raw => {
    if (!raw || typeof raw !== 'object' || !uuid.test(raw.id) || ids.has(raw.id)) throw new Error('商品标识无效或重复'); ids.add(raw.id);
    const p = { id: raw.id, images: {} } as Product;
    for (const key of ['code', 'title', 'category', 'brand', 'material', 'audience', 'foldable', 'reference', 'skuCode', 'discount', 'shipping', 'freight', 'expectedShop', 'source', 'templateFormat'] as const) {
      if (typeof raw[key] !== 'string' || raw[key].length > 2000) throw new Error('商品字段内容不正确'); p[key] = raw[key].trim();
    }
    if (!p.code || p.code.length > 100 || codes.has(p.code)) throw new Error('商品编码须填写且不能重复'); codes.add(p.code);
    const previous = store.all<Product>('products').find(existing => existing.id === p.id);
    if (previous && previous.savedAt !== raw.savedAt) throw new Error(`商品 ${p.code} 已被更新，请关闭后重新导入或打开资料，核对最新版再保存`);
    if (store.all<Product>('products').some(existing => existing.code === p.code && existing.id !== p.id)) throw new Error(`商品编码 ${p.code} 已存在，请编辑原商品`);
    if (!Array.isArray(raw.skus) || raw.skus.length > 100) throw new Error('商品规格数量不正确');
    p.skus = raw.skus.map((sku: Record<string, unknown>) => {
      const s: Record<string, string> = {};
      for (const key of ['spec', 'group', 'single', 'stock']) { if (typeof sku[key] !== 'string' || sku[key].length > 200) throw new Error('规格字段内容不正确'); s[key] = sku[key].trim(); }
      for (const key of ['code','image']) { const value=sku[key]??'';if(typeof value!=='string'||value.length>250)throw new Error('规格编码或图片字段不正确');s[key]=value.trim(); }
      if(s.image&&!safeImageName(s.image))throw new Error('规格图片文件名无效');
      const options=sku.options??[]; if(!Array.isArray(options)||options.length>2)throw new Error('最多两种规格类型');
      const sanitizedOptions=options.map(o=>{if(!o||typeof o.name!=='string'||typeof o.value!=='string'||o.name.length>50||o.value.length>100)throw new Error('规格类型或值不正确');return{name:o.name.trim(),value:o.value.trim()};});
      return {...s,options:sanitizedOptions} as Product['skus'][number];
    });
    if(raw.attributes!==undefined&&(!Array.isArray(raw.attributes)||raw.attributes.length>50))throw new Error('类目属性格式不正确');
    p.attributes=(raw.attributes||[]).map((a:any)=>{if(!a||typeof a.name!=='string'||typeof a.value!=='string'||a.name.length>100||a.value.length>500)throw new Error('类目属性内容不正确');return{name:a.name.trim(),value:a.value.trim(),required:a.required===true};});
    if(raw.services!=null&&(typeof raw.services!=='object'||Array.isArray(raw.services)))throw new Error('服务与承诺设置不正确');
    const services={sevenDay:'按平台规则',invoice:'否',authenticity:'否',...raw.services};p.services={sevenDay:'',invoice:'',authenticity:''};
    for(const key of ['sevenDay','invoice','authenticity'] as const){if(!['是','否','按平台规则'].includes(services[key]))throw new Error('服务与承诺设置不正确');p.services[key]=services[key];}
    for (const key of ['main', 'detail'] as const) {
      if (!Array.isArray(raw[key]) || raw[key].length > 60 || raw[key].some((name: unknown) => !safeImageName(name))) throw new Error('图片文件名无效');
      p[key] = [...raw[key]];
      for (const name of p[key]) { const id = raw.images?.[name]?.id; if (id && assets.has(id)) p.images[name] = { ...assets.get(id)!, name }; }
    }
    for(const sku of p.skus)if(sku.image){const id=raw.images?.[sku.image]?.id;if(id&&assets.has(id))p.images[sku.image]={...assets.get(id)!,name:sku.image};}
    p.demo = raw.demo === true; p.demoDeclared=raw.demoDeclared===true;p.savedAt = new Date().toISOString(); return p;
  });
}

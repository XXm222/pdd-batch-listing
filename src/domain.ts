import type { Asset, ImageTarget, Product } from './types';
export const uid = () => crypto.randomUUID();
export const isStructuredProduct = (p: Product) => ['运营模板 v2', '运营模板 v3'].includes(p.templateFormat);
export const safeImageName = (name: unknown): name is string => typeof name === 'string' && name.length > 0 && name.length <= 250 && !['.', '..', '__proto__', 'constructor', 'prototype'].includes(name) && !/[\\/;；\u0000]/.test(name);
export const fields = [
  ['code', '商品编码'], ['brand', '商品品牌'], ['title', '商品标题'], ['category', '商品类目'],
  ['material', '材质'], ['audience', '适用人群']
] as const;
export const extraFields = [
  ['reference', '参考价'], ['foldable', '是否可折叠'], ['skuCode', '规格编码'], ['discount', '满2件折扣（折）'],
  ['shipping', '发货承诺'], ['freight', '运费模板']
] as const;
// Common PDD defaults; custom names come from imported/saved products and are checked against the selected shop before execution.
export const freightOptions = (current: string, products: readonly Product[]) => [...new Set(['新疆西藏不配送默认模板', '新疆西藏收费默认模板', ...products.map(p => p.freight), current].filter(Boolean))];
export function newProduct(code = '', title = ''): Product {
  return { id: uid(), code, title, category: '', brand: '', material: '', audience: '', foldable: '', reference: '',
    skuCode: '', discount: '', shipping: '', freight: '', expectedShop: '', demo: false, source: '',
    skus: [{ spec: '默认规格', group: '', single: '', stock: '' }], main: [], detail: [], images: {}, templateFormat: '逐项填写' };
}
export function problems(p: Product): string[] {
  const out: string[] = [];
  for (const [key, label] of [['code', '商品编码'], ['title', '商品标题'], ['category', '商品类目'], ['reference', '参考价'], ['shipping', '发货承诺']] as const)
    if (!p[key].trim()) out.push(`请补充${label}`);
  if ([...p.title].reduce((n, c) => n + (c.charCodeAt(0) > 127 ? 2 : 1), 0) > 60) out.push('商品标题最多 60 字符，汉字按 2 字符计');
  if (!p.skus.length) out.push('请补充商品规格');
  const specs = new Set<string>();
  const skuCodes = new Set<string>();
  const combinations = new Set<string>();
  p.skus.forEach((s, i) => {
    const row = `${isStructuredProduct(p) ? '组合' : '规格'} ${i + 1}`;
    if (!s.spec.trim()) out.push(`${row} 名称未填写`);
    if (!isStructuredProduct(p) && specs.has(s.spec.trim())) out.push(`规格名称重复：${s.spec}`);
    specs.add(s.spec.trim());
    if (s.code?.trim()) {
      if (skuCodes.has(s.code.trim())) out.push(`规格编码重复：${s.code}`);
      skuCodes.add(s.code.trim());
    }
    if (isStructuredProduct(p)) {
      const options = s.options || [];
      const combination=JSON.stringify(options.map(o=>[o.name.trim(),o.value.trim()]));
      if(combinations.has(combination))out.push(`${row} 与前面的规格组合重复`);combinations.add(combination);
      if (options.length > 2 || options.some(o => !o.name.trim() || !o.value.trim())) out.push(`${row} 请同时填写区分方式和具体选项，如“颜色＋紫色”，最多填两组`);
      if (new Set(options.map(o => o.name.trim())).size !== options.length) out.push(`${row} 的两组区分方式不能相同，如不要都填“颜色”`);
      if (p.skus.length > 1 && !options.length) out.push(`${row} 请填清是哪一款，如“颜色＋紫色”`);
      if (options.map(o => o.name.trim()).join('\u0000') !== (p.skus[0].options || []).map(o => o.name.trim()).join('\u0000')) out.push('每行的区分方式和顺序要一致，如第一组都填颜色，第二组都填尺寸');
    }
    for (const [key, label] of [['group', '拼单价'], ['single', '单买价']] as const)
      if (!/^\d+(\.\d{1,2})?$/.test(s[key].trim()) || Number(s[key]) <= 0) out.push(`${row} ${label}须为正金额，最多两位小数`);
    if (Number(s.group) > Number(s.single)) out.push(`${row} 拼单价不能高于单买价`);
    if (!/^\d+$/.test(s.stock.trim()) || Number(s.stock) > 99999999) out.push(`${row} 库存须为非负整数`);
  });
  const services = { sevenDay: '按平台规则', invoice: '否', authenticity: '否', ...p.services };
  if (p.category.endsWith('沐浴桶/沐浴盆') && services.sevenDay === '否') out.push('当前泡脚桶类目必须支持 7 天无理由退货');
  for (const [label, value] of [['7天无理由退货', services.sevenDay], ['正品发票', services.invoice], ['假一赔十', services.authenticity]])
    if (!['是', '否', '按平台规则'].includes(value)) out.push(`${label}请选择是、否或按平台规则`);
  const attributes = new Set<string>();
  for (const a of p.attributes || []) {
    if (!a.name.trim() || (a.required && !a.value.trim())) out.push(`类目属性${a.name || '名称'}未填写完整`);
    if (attributes.has(a.name.trim()) || ['材质','适用人群','是否可折叠','品牌','商品品牌','授权品牌'].includes(a.name.trim())) out.push(`类目属性重复：${a.name}`);
    attributes.add(a.name.trim());
  }
  if (p.reference.trim() && (!/^\d+(\.\d{1,2})?$/.test(p.reference) || Number(p.reference) <= Math.max(...p.skus.map(s => Number(s.single))))) out.push('参考价须高于单买价');
  if (p.discount.trim() && (!Number.isFinite(Number(p.discount)) || Number(p.discount) < 5 || Number(p.discount) > 9.9)) out.push('满 2 件折扣须为 5.0 至 9.9 折');
  for (const [key, label, max] of [['main', '主图', 10], ['detail', '详情图', 50]] as const) {
    if (key === 'main' && !p[key].length) out.push('请补充主图');
    if (p[key].length > max) out.push(`${label}最多 ${max} 张`);
    if (new Set(p[key]).size !== p[key].length) out.push(`${label}图片重复`);
    for (const name of p[key]) {
      if (!safeImageName(name)) { out.push(`${label}文件名无效：${name}`); continue; }
      const a = Object.hasOwn(p.images, name) ? p.images[name] : undefined;
      if (!a) out.push(`${label}未匹配：${name}`);
      else if (!Number.isFinite(a.width) || !Number.isFinite(a.height) || a.width <= 0 || a.height <= 0)
        out.push(`${name} 图片尺寸无效`);
      else if (key === 'main' && (a.bytes >= 3 * 1024 * 1024 || a.width <= 480 || a.height <= 480 || !(a.width === a.height || a.width * 4 === a.height * 3)))
        out.push(`${name} 须为 1:1 或 3:4，宽高大于 480px，且小于 3MB`);
    }
  }
  for (const [i,s] of p.skus.entries()) if (s.image) {
    if (!safeImageName(s.image)) out.push(`规格 ${i+1} 图片文件名无效`);
    else if (!Object.hasOwn(p.images,s.image)) out.push(`规格图未匹配：${s.image}`);
    else { const a=p.images[s.image]; if(!Number.isFinite(a.width)||!Number.isFinite(a.height)||a.width<=0||a.height<=0) out.push(`规格图 ${s.image} 图片尺寸无效`); }
  }
  return [...new Set(out)];
}
export function lowestPrice(p: Product): string {
  const prices = p.skus.map(s => Number(s.group)).filter(n => Number.isFinite(n) && n > 0);
  return prices.length ? `¥${Math.min(...prices).toFixed(2)}` : '价格待补充';
}
// Keep the image lists authoritative. A filename collision must never replace another image.
export function applyImages(p: Product, assets: Asset[], target: ImageTarget): Product {
  const replacing = target.kind === 'sku' || target.index !== undefined;
  if (replacing && assets.length !== 1) throw Error('替换图片或添加规格图时，请只选择一张图片');
  if (!assets.length) return p;
  const images = { ...p.images };
  const names = [...new Map(assets.map(a => [a.id, a])).values()].map(asset => {
    const found = Object.keys(images).find(name => images[name].id === asset.id);
    if (found) return found;
    let name = asset.name;
    if (Object.hasOwn(images, name)) {
      const extension = /\.[^.]+$/.exec(name)?.[0] || '.jpg';
      name = `图片-${asset.id}${extension}`;
    }
    images[name] = { ...asset, name }; return name;
  });
  if (target.kind === 'sku') {
    if (target.index === undefined || !p.skus[target.index]) throw Error('规格组合已变化，请重新选择');
    return { ...p, images, skus: p.skus.map((sku, i) => i === target.index ? { ...sku, image: names[0] } : sku) };
  }
  let list = [...p[target.kind]];
  if (target.index !== undefined) {
    if (!list[target.index]) throw Error('图片位置已变化，请重新选择');
    if (list.some((name, i) => i !== target.index && images[name]?.id === images[names[0]].id)) throw Error('该图片已在此清单中，请选择其他图片');
    list[target.index] = names[0];
  } else {
    const additions = names.filter(name => !list.some(current => images[current]?.id === images[name].id));
    if (!additions.length) throw Error('所选图片已在此清单中，无需重复添加');
    list = [...list, ...additions];
  }
  const max = target.kind === 'main' ? 10 : 50;
  if (list.length > max) throw Error(`${target.kind === 'main' ? '轮播图' : '详情图'}最多 ${max} 张，请减少所选图片`);
  return { ...p, images, [target.kind]: list };
}

export function productChanges(before: Product, after: Product) {
  const changes: { label: string; before: string; after: string }[] = [];
  for (const [key, label] of [...fields, ...extraFields]) if (before[key] !== after[key]) changes.push({ label, before: before[key] || '未填写', after: after[key] || '未填写' });
  const skuText = (p: Product) => p.skus.map((s, i) => `${i + 1}. ${s.spec}；拼单 ${s.group} / 单买 ${s.single} / 库存 ${s.stock}${s.code ? `；编码 ${s.code}` : ''}${s.image ? '；有规格图' : ''}`).join('\n');
  const skuIdentity = (p: Product) => p.skus.map(s => ({
    spec: s.spec, options: (s.options || []).map(o => ({ name: o.name, value: o.value })),
    code: s.code || '', group: s.group, single: s.single, stock: s.stock,
    image: s.image ? p.images[s.image]?.id || s.image : ''
  }));
  if (JSON.stringify(skuIdentity(before)) !== JSON.stringify(skuIdentity(after))) changes.push({ label: '规格组合、价格、库存与规格图', before: skuText(before), after: `${skuText(after)}\n请核对规格图是否需要替换。` });
  for (const [key, label] of [['main', '轮播图与顺序'], ['detail', '详情图与顺序']] as const) {
    const ids = (p: Product) => p[key].map(name => p.images[name]?.id || name);
    if (JSON.stringify(ids(before)) !== JSON.stringify(ids(after))) changes.push({ label, before: `${before[key].length} 张`, after: `${after[key].length} 张，图片或顺序有变化，请在识别结果中核对。` });
  }
  for (const [key, label] of [['attributes', '其他类目属性'], ['services', '服务与承诺']] as const) {
    const display = (p: Product) => key === 'attributes' ? (p.attributes || []).map(a => `${a.name}：${a.value || '未填写'}${a.required ? '（后台必填）' : ''}`).join('\n') : `7天无理由退货：${p.services?.sevenDay || '按平台规则'}；正品发票：${p.services?.invoice || '否'}；假一赔十：${p.services?.authenticity || '否'}`;
    if (display(before) !== display(after)) changes.push({ label, before: display(before) || '未填写', after: display(after) || '未填写' });
  }
  return changes;
}
export function shopNameFromAccount(account: string): string {
  const text = account.trim(); const index = text.search(/[:：]/);
  return index > 0 && text.slice(index + 1).trim() ? text.slice(0, index).trim() : '';
}
export function resolveShopName(name: string, account: string, isNew: boolean): string {
  const resolved = isNew ? shopNameFromAccount(account) : name.trim();
  if (isNew && !resolved) throw new Error('登录账号请按“店铺名:子账号”填写，支持中英文冒号');
  if (!resolved || resolved.length > 50) throw new Error('店铺名称须为 1 至 50 个字符');
  return resolved;
}

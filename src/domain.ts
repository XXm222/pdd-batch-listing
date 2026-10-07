import type { Asset, ImageTarget, Product } from './types';
import { DEFAULT_PLATFORM, platformMeta, type PlatformId } from './platforms';
export const uid = () => crypto.randomUUID();
/** 淘宝模板的 templateFormat 标记；导入器与校验都按它分支。 */
export const TAOBAO_TEMPLATE_FORMAT = '淘宝运营模板 v4';
export const isTaobaoProduct = (p: Product) => p.templateFormat === TAOBAO_TEMPLATE_FORMAT;
export const LOCAL_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const imageSizeText = (bytes: number) =>
  Number.isFinite(bytes) && bytes >= 0 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : '大小未读取';
export function imageProblems(a: Asset, kind: string, taobao = false): string[] {
  const out: string[] = [];
  if (!Number.isSafeInteger(a.bytes) || a.bytes <= 0)
    out.push(`${a.name}：无法确认图片大小，请重新添加`);
  else if (a.bytes > LOCAL_IMAGE_MAX_BYTES)
    out.push(`${a.name}：${imageSizeText(a.bytes)}，超过本机单张读取上限 20MB`);
  if (
    !Number.isSafeInteger(a.width) ||
    !Number.isSafeInteger(a.height) ||
    a.width <= 0 ||
    a.height <= 0
  )
    out.push(`${a.name} 图片尺寸无效`);
  if (a.format !== undefined && !['png', 'jpg'].includes(a.format))
    out.push(`${a.name}：只支持 PNG 或 JPEG 图片`);
  if (kind === 'main') {
    if (Number.isSafeInteger(a.bytes) && a.bytes >= 3 * 1024 * 1024)
      out.push(`${a.name}：${imageSizeText(a.bytes)}，主图须小于 3MB`);
    if (
      a.width <= 480 ||
      a.height <= 480 ||
      !(a.width === a.height || (!taobao && a.width * 4 === a.height * 3))
    )
      out.push(
        taobao ? `${a.name} 须为 1:1，宽高大于 480px` : `${a.name} 须为 1:1 或 3:4，宽高大于 480px`,
      );
  }
  // 详情与规格图没有已核实的统一平台大小上限；执行时读取当前上传区要求。
  return out;
}
export function imageUploadSizeLimit(
  text: string,
): { bytes: number; strict: boolean; label: string } | undefined {
  const patterns = [
    /(?:大小|体积|单张|单个|图片|文件)([^。；;\n]{0,24}?)(不(?:能|可|得)?超过|不能大于|最大(?:为|支持|不超过)?|小于|≤|<=|<)\s*(\d+(?:\.\d+)?)\s*(MB|M|KB|K)(?![a-z])/gi,
    /(?:大小|体积|单张|单个)([^。；;\n]{0,12}?)(\d+(?:\.\d+)?)\s*(MB|M|KB|K)\s*(以内|以下)/gi,
  ];
  const limits: { bytes: number; strict: boolean; label: string }[] = [];
  for (const [index, pattern] of patterns.entries())
    for (const match of text.matchAll(pattern)) {
      const before = text.slice(Math.max(0, (match.index || 0) - 8), match.index);
      if (/建议|推荐/.test(match[1]) || /(?:建议|推荐)[^。；;]*$/.test(before)) continue;
      const amount = Number(match[index === 0 ? 3 : 2]),
        unit = match[index === 0 ? 4 : 3].toUpperCase();
      const bytes = amount * (unit.startsWith('K') ? 1024 : 1024 * 1024);
      if (Number.isFinite(bytes) && bytes > 0)
        limits.push({
          bytes,
          strict: index === 0 && ['小于', '<'].includes(match[2]),
          label: match[0].trim(),
        });
    }
  return limits.sort((a, b) => a.bytes - b.bytes || Number(b.strict) - Number(a.strict))[0];
}
/**
 * 商品资料里的「运费模板」是否必填。
 * 天猫发品表单没有独立的运费模板字段（运费只能在勾选「邮寄」后选承担方），
 * 所以只有拼多多需要它 —— 淘宝任务不该因为这一栏留空就被拦下。
 */
export const requiresFreightTemplate = (platform: PlatformId) => platform !== 'taobao';
export const isStructuredProduct = (p: Product) =>
  ['运营模板 v2', '运营模板 v3', TAOBAO_TEMPLATE_FORMAT].includes(p.templateFormat);
// Missing previews are a prompt, not a universal platform requirement. The
// selected shop's current category decides whether execution needs an image.
export const missingSkuImages = (p: Product): number[] =>
  isTaobaoProduct(p)
    ? []
    : p.skus.flatMap((sku, index) =>
        sku.options?.some((option) => option.name.trim() || option.value.trim()) &&
        (!sku.image || !Object.hasOwn(p.images, sku.image))
          ? [index]
          : [],
      );
export const safeImageName = (name: unknown): name is string =>
  typeof name === 'string' &&
  name.length > 0 &&
  name.length <= 250 &&
  !['.', '..', '__proto__', 'constructor', 'prototype'].includes(name) &&
  !/[\\/;；\u0000]/.test(name);
export const fields = [
  ['code', '商品编码'],
  ['brand', '商品品牌'],
  ['title', '商品标题'],
  ['category', '商品类目'],
  ['material', '材质'],
  ['audience', '适用人群'],
] as const;
export const extraFields = [
  ['reference', '参考价'],
  ['foldable', '是否可折叠'],
  ['skuCode', '规格编码'],
  ['discount', '满2件折扣（折）'],
  ['shipping', '发货承诺'],
  ['freight', '运费模板'],
] as const;
// Common PDD defaults; custom names come from imported/saved products and are checked against the selected shop before execution.
export const freightOptions = (current: string, products: readonly Product[]) => [
  ...new Set(
    [
      '新疆西藏不配送默认模板',
      '新疆西藏收费默认模板',
      ...products.map((p) => p.freight),
      current,
    ].filter(Boolean),
  ),
];
export function newProduct(code = '', title = ''): Product {
  return {
    id: uid(),
    code,
    title,
    category: '',
    brand: '',
    material: '',
    audience: '',
    foldable: '',
    reference: '',
    skuCode: '',
    discount: '',
    shipping: '',
    freight: '',
    expectedShop: '',
    demo: false,
    source: '',
    skus: [{ spec: '默认规格', group: '', single: '', stock: '' }],
    main: [],
    detail: [],
    images: {},
    templateFormat: '逐项填写',
  };
}
export function problems(p: Product): string[] {
  const out: string[] = [];
  const taobao = isTaobaoProduct(p);
  for (const [key, label] of [
    ['code', '商品编码'],
    ['title', '商品标题'],
    ['category', '商品类目'],
    // 「参考价」与「发货承诺」都是拼多多口径：天猫发品表单里没有这两个字段
    // （天猫只有一个「发货时间」，由商品资料的 taobao.deliveryTime 表达）。
    ...(taobao
      ? []
      : ([
          ['reference', '参考价'],
          ['shipping', '发货承诺'],
        ] as const)),
  ] as const)
    if (!p[key].trim()) out.push(`请补充${label}`);
  if ([...p.title].reduce((n, c) => n + (c.charCodeAt(0) > 127 ? 2 : 1), 0) > 60)
    out.push('商品标题最多 60 字符，汉字按 2 字符计');
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
      const combination = JSON.stringify(options.map((o) => [o.name.trim(), o.value.trim()]));
      if (combinations.has(combination)) out.push(`${row} 与前面的规格组合重复`);
      combinations.add(combination);
      if (options.length > 2 || options.some((o) => !o.name.trim() || !o.value.trim()))
        out.push(`${row} 请同时填写区分方式和具体选项，如“颜色＋紫色”，最多填两组`);
      if (new Set(options.map((o) => o.name.trim())).size !== options.length)
        out.push(`${row} 的两组区分方式不能相同，如不要都填“颜色”`);
      if (p.skus.length > 1 && !options.length) out.push(`${row} 请填清是哪一款，如“颜色＋紫色”`);
      if (
        options.map((o) => o.name.trim()).join('\u0000') !==
        (p.skus[0].options || []).map((o) => o.name.trim()).join('\u0000')
      )
        out.push('每行的区分方式和顺序要一致，如第一组都填颜色，第二组都填尺寸');
    }
    // 天猫只有一个「一口价」（存在 single）；拼多多是拼单价 + 单买价两列。
    for (const [key, label] of taobao
      ? ([['single', '一口价']] as const)
      : ([
          ['group', '拼单价'],
          ['single', '单买价'],
        ] as const))
      if (!/^\d+(\.\d{1,2})?$/.test(s[key].trim()) || Number(s[key]) <= 0)
        out.push(`${row} ${label}须为正金额，最多两位小数`);
    if (!taobao && Number(s.group) > Number(s.single)) out.push(`${row} 拼单价不能高于单买价`);
    if (!/^\d+$/.test(s.stock.trim()) || Number(s.stock) > 99999999)
      out.push(`${row} 库存须为非负整数`);
  });
  const services = { sevenDay: '按平台规则', invoice: '否', authenticity: '否', ...p.services };
  if (p.category.endsWith('沐浴桶/沐浴盆') && services.sevenDay === '否')
    out.push('当前泡脚桶类目必须支持 7 天无理由退货');
  for (const [label, value] of [
    ['7天无理由退货', services.sevenDay],
    ['正品发票', services.invoice],
    ['假一赔十', services.authenticity],
  ])
    if (!['是', '否', '按平台规则'].includes(value)) out.push(`${label}请选择是、否或按平台规则`);
  const attributes = new Set<string>();
  for (const a of p.attributes || []) {
    if (!a.name.trim() || (a.required && !a.value.trim()))
      out.push(`类目属性${a.name || '名称'}未填写完整`);
    if (
      attributes.has(a.name.trim()) ||
      ['材质', '适用人群', '是否可折叠', '品牌', '商品品牌', '授权品牌'].includes(a.name.trim())
    )
      out.push(`类目属性重复：${a.name}`);
    attributes.add(a.name.trim());
  }
  if (
    !taobao &&
    p.reference.trim() &&
    (!/^\d+(\.\d{1,2})?$/.test(p.reference) ||
      Number(p.reference) <= Math.max(...p.skus.map((s) => Number(s.single))))
  )
    out.push('参考价须高于单买价');
  if (
    !taobao &&
    p.discount.trim() &&
    (!Number.isFinite(Number(p.discount)) || Number(p.discount) < 5 || Number(p.discount) > 9.9)
  )
    out.push('满 2 件折扣须为 5.0 至 9.9 折');
  // 图片位上限按平台走：天猫 1:1主图最多 5 张、详情图最多 20 张。
  for (const [key, label, max] of taobao
    ? ([
        ['main', '主图', 5],
        ['detail', '详情图', 20],
        ['threeToFour', '3:4主图', 5],
        ['whiteBg', '白底图', 1],
        ['usp', '卖点图', 1],
      ] as const)
    : ([
        ['main', '主图', 10],
        ['detail', '详情图', 50],
      ] as const)) {
    const names = p[key] || [];
    if (key === 'main' && !names.length) out.push('请补充主图');
    if (names.length > max) out.push(`${label}最多 ${max} 张`);
    if (new Set(names).size !== names.length) out.push(`${label}图片重复`);
    for (const name of names) {
      if (!safeImageName(name)) {
        out.push(`${label}文件名无效：${name}`);
        continue;
      }
      const a = Object.hasOwn(p.images, name) ? p.images[name] : undefined;
      if (!a) out.push(`${label}未匹配：${name}`);
      else out.push(...imageProblems({ ...a, name }, key, taobao));
    }
  }
  for (const [i, s] of p.skus.entries())
    if (s.image) {
      if (!safeImageName(s.image)) out.push(`规格 ${i + 1} 图片文件名无效`);
      else if (!Object.hasOwn(p.images, s.image)) out.push(`规格图未匹配：${s.image}`);
      else {
        const a = p.images[s.image];
        out.push(...imageProblems({ ...a, name: s.image }, 'sku', taobao));
      }
    }
  // 淘宝发品专有设置：这几项在天猫后台都是必填或半必填，模板里就要拦住。
  if (p.taobao) {
    const t = p.taobao;
    if (!t.originProvince.trim() || !t.originCity.trim())
      out.push('淘宝发货地必须填到「省 / 市」两级，少一级后台会报「必填项未填」');
    if (!['邮寄', '电子交易凭证'].includes(t.extractWay))
      out.push('提取方式请选择邮寄或电子交易凭证');
    if (!['卖家承担', '买家承担'].includes(t.freightBearer))
      out.push('运费承担请选择卖家承担或买家承担');
    if (!['今日发', '48小时', '大于48小时'].includes(t.deliveryTime))
      out.push('发货时间请选择今日发、48小时或大于48小时');
    if (!['放入仓库', '立刻上架', '定时上架'].includes(t.shelfTime))
      out.push('上架时间请选择放入仓库、立刻上架或定时上架');
    if (!/^[01](\.5)?$/.test(t.auctionPoint.trim()) || Number(t.auctionPoint) > 1.5)
      out.push('返点比例须为 0.5% 至 1.5%，且是 0.5 的整数倍');
  }
  return [...new Set(out)];
}
export function lowestPrice(p: Product): string {
  const prices = p.skus.map((s) => Number(s.group)).filter((n) => Number.isFinite(n) && n > 0);
  return prices.length ? `¥${Math.min(...prices).toFixed(2)}` : '价格待补充';
}
// Keep the image lists authoritative. A filename collision must never replace another image.
export function applyImages(p: Product, assets: Asset[], target: ImageTarget): Product {
  const replacing = target.kind === 'sku' || target.index !== undefined;
  if (replacing && assets.length !== 1) throw Error('替换图片或添加规格图时，请只选择一张图片');
  if (!assets.length) return p;
  const failures = assets.flatMap((a) => imageProblems(a, target.kind, isTaobaoProduct(p)));
  if (failures.length)
    throw Object.assign(
      new Error(
        failures.length <= 2
          ? failures.join('；')
          : `所选图片未添加，共 ${failures.length} 项校验问题，请查看完整列表`,
      ),
      { imageIssues: failures },
    );
  const images = { ...p.images };
  const names = [...new Map(assets.map((a) => [a.id, a])).values()].map((asset) => {
    const found = Object.keys(images).find((name) => images[name].id === asset.id);
    if (found) return found;
    let name = asset.name;
    if (Object.hasOwn(images, name)) {
      const extension = /\.[^.]+$/.exec(name)?.[0] || '.jpg';
      name = `图片-${asset.id}${extension}`;
    }
    images[name] = { ...asset, name };
    return name;
  });
  if (target.kind === 'sku') {
    if (target.index === undefined || !p.skus[target.index])
      throw Error('规格组合已变化，请重新选择');
    return {
      ...p,
      images,
      skus: p.skus.map((sku, i) => (i === target.index ? { ...sku, image: names[0] } : sku)),
    };
  }
  let list = [...p[target.kind]];
  if (target.index !== undefined) {
    if (!list[target.index]) throw Error('图片位置已变化，请重新选择');
    if (list.some((name, i) => i !== target.index && images[name]?.id === images[names[0]].id))
      throw Error('该图片已在此清单中，请选择其他图片');
    list[target.index] = names[0];
  } else {
    const additions = names.filter(
      (name) => !list.some((current) => images[current]?.id === images[name].id),
    );
    if (!additions.length) throw Error('所选图片已在此清单中，无需重复添加');
    list = [...list, ...additions];
  }
  const max = target.kind === 'main' ? 10 : 50;
  if (list.length > max)
    throw Error(`${target.kind === 'main' ? '轮播图' : '详情图'}最多 ${max} 张，请减少所选图片`);
  return { ...p, images, [target.kind]: list };
}

export function productChanges(before: Product, after: Product) {
  const changes: { label: string; before: string; after: string }[] = [];
  for (const [key, label] of [...fields, ...extraFields])
    if (before[key] !== after[key])
      changes.push({ label, before: before[key] || '未填写', after: after[key] || '未填写' });
  const skuText = (p: Product) =>
    p.skus
      .map(
        (s, i) =>
          `${i + 1}. ${s.spec}；拼单 ${s.group} / 单买 ${s.single} / 库存 ${s.stock}${s.code ? `；编码 ${s.code}` : ''}${s.image ? '；有规格图' : ''}`,
      )
      .join('\n');
  const skuIdentity = (p: Product) =>
    p.skus.map((s) => ({
      spec: s.spec,
      options: (s.options || []).map((o) => ({ name: o.name, value: o.value })),
      code: s.code || '',
      group: s.group,
      single: s.single,
      stock: s.stock,
      image: s.image ? p.images[s.image]?.id || s.image : '',
    }));
  if (JSON.stringify(skuIdentity(before)) !== JSON.stringify(skuIdentity(after)))
    changes.push({
      label: '规格组合、价格、库存与规格图',
      before: skuText(before),
      after: `${skuText(after)}\n请核对规格图是否需要替换。`,
    });
  for (const [key, label] of [
    ['main', '轮播图与顺序'],
    ['detail', '详情图与顺序'],
  ] as const) {
    const ids = (p: Product) => p[key].map((name) => p.images[name]?.id || name);
    if (JSON.stringify(ids(before)) !== JSON.stringify(ids(after)))
      changes.push({
        label,
        before: `${before[key].length} 张`,
        after: `${after[key].length} 张，图片或顺序有变化，请在识别结果中核对。`,
      });
  }
  for (const [key, label] of [
    ['attributes', '其他类目属性'],
    ['services', '服务与承诺'],
  ] as const) {
    const display = (p: Product) =>
      key === 'attributes'
        ? (p.attributes || [])
            .map((a) => `${a.name}：${a.value || '未填写'}${a.required ? '（后台必填）' : ''}`)
            .join('\n')
        : `7天无理由退货：${p.services?.sevenDay || '按平台规则'}；正品发票：${p.services?.invoice || '否'}；假一赔十：${p.services?.authenticity || '否'}`;
    if (display(before) !== display(after))
      changes.push({
        label,
        before: display(before) || '未填写',
        after: display(after) || '未填写',
      });
  }
  return changes;
}
export function shopNameFromAccount(account: string): string {
  const text = account.trim();
  const index = text.search(/[:：]/);
  return index > 0 && text.slice(index + 1).trim() ? text.slice(0, index).trim() : '';
}
export function resolveShopName(
  name: string,
  account: string,
  isNew: boolean,
  platform: PlatformId = DEFAULT_PLATFORM,
): string {
  const meta = platformMeta(platform);
  const resolved =
    isNew && meta.derivesNameFromAccount ? shopNameFromAccount(account) : name.trim();
  if (isNew && !resolved)
    throw new Error(
      meta.derivesNameFromAccount
        ? '登录账号请按“店铺名:子账号”填写，支持中英文冒号'
        : `请填写${meta.label}店铺名称`,
    );
  if (!resolved || resolved.length > 50) throw new Error('店铺名称须为 1 至 50 个字符');
  return resolved;
}

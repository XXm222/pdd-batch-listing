import type { Product } from './types';

/**
 * 上架前的体检。这些都是"后台一定会拒绝"或"上架后一定出问题"的事，
 * 与其等执行四十秒被接口打回来，不如导入完就把黄条拍在脸上。
 */
export function preflight(product: Product): string[] {
  const issues: string[] = [];
  const skus = product.skus || [];
  const zero = skus.filter((sku) => String(sku.stock).trim() === '0').length;
  if (zero) issues.push(`${zero} 个规格库存为 0，上架时按 1 件提交，请在后台改成实际库存`);
  const singles = skus
    .map((sku) => Number(sku.single))
    .filter((value) => Number.isFinite(value) && value > 0);
  const reference = Number(product.reference);
  if (singles.length && Number.isFinite(reference) && reference > 0) {
    const highest = Math.max(...singles);
    if (reference <= highest)
      issues.push(`参考价 ${product.reference} 不高于最贵单买价 ${highest}，后台会拒绝提交`);
  }
  if (product.install) {
    if (!product.install.template.trim()) issues.push('已开启到店安装但没填模板');
    const missing = skus.filter((sku) => !(sku.rim || '').trim()).length;
    if (missing) issues.push(`${missing} 个规格缺轮辋直径，后台会拒绝提交`);
  }
  return issues;
}

/** 导入完成后的汇总，最多点名前 3 件商品的 3 条问题，其余折成数量。 */
export function preflightNotice(products: Product[]): string {
  const lines = products.flatMap((product) =>
    preflight(product).map((issue) => `${product.code || product.title}：${issue}`),
  );
  if (!lines.length) return '';
  const head = lines.slice(0, 3).join('；');
  return lines.length > 3
    ? `导入完成，有 ${lines.length} 条上架前待处理：${head}；另有 ${lines.length - 3} 条同类问题`
    : `导入完成，有 ${lines.length} 条上架前待处理：${head}`;
}

/**
 * 图片归属自检：导出前确认每个图片引用都真的落在本商品的图片清单里，
 * 且清单里没有"谁都引用不到"的孤儿图。跨商品串图、抓错列、漏写清单
 * 都会在这里暴露成一条明确的错误，而不是等买家看见一堆相同的规格图。
 */
export function auditImages(product: Product): string[] {
  const images = product.images || {};
  const names = new Set(Object.keys(images));
  const issues: string[] = [];
  const refs: [string, string | undefined][] = [
    ...(product.main || []).map((name, i): [string, string] => [`轮播图 ${i + 1}`, name]),
    ...(product.detail || []).map((name, i): [string, string] => [`详情图 ${i + 1}`, name]),
    ...(product.skus || []).map((sku, i): [string, string | undefined] => [
      `第 ${i + 1} 行规格图`,
      sku.image,
    ]),
  ];
  const used = new Set<string>();
  for (const [label, name] of refs)
    if (name) {
      used.add(name);
      if (!names.has(name)) issues.push(`${label}「${name}」不在图片清单里`);
    }
  for (const name of names)
    if (!used.has(name)) issues.push(`图片清单里的「${name}」没有任何位置引用`);
  return issues;
}

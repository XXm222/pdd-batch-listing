import type { Shop } from '../src/types';

/**
 * 比较用的店铺名归一：去所有空白、全角转半角、转小写。
 * 运营手填「邓禄普黑豆专卖店」时常带一个尾空格或全角括号，逐字符比较会认不出来。
 */
const key = (value: string) =>
  String(value || '')
    .replace(/[\u3000\s]/g, '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase();

/**
 * 资料上的「目标店铺」→ 店铺记录。
 * 可以填店铺 ID（最稳），也可以填店铺名（归一化后比对）；同名店铺多于一家时报歧义让人选，
 * 绝不「找到第一个就用」——那会把 A 店的资料提交到 B 店。
 */
export function pickShop(shops: Shop[], expected: string): Shop {
  const wanted = String(expected || '').trim();
  if (wanted) {
    const byId = shops.find((shop) => shop.id === wanted);
    if (byId) return byId;
    const named = shops.filter((shop) => key(shop.name) === key(wanted));
    if (named.length === 1) return named[0];
    if (named.length > 1)
      throw new Error(
        `有 ${named.length} 家店铺都叫「${wanted}」，请在资料的「目标店铺」里改成其中一家的名称或店铺 ID`,
      );
    // 填了名字却对不上：即使只有一家店也不猜，否则改名/手误会把资料提交到错店。
    throw new Error(
      shops.length
        ? `找不到店铺「${wanted}」，资料里的「目标店铺」要写店铺管理里已有的名称或店铺 ID`
        : '还没有添加店铺，请先在店铺管理里添加',
    );
  }
  if (shops.length === 1) return shops[0];
  throw new Error(
    shops.length
      ? '资料里没写「目标店铺」，而店铺管理里有多家店铺，请写清店铺名称或店铺 ID'
      : '还没有添加店铺，请先在店铺管理里添加',
  );
}

import type { PddAnchor } from './pdd-identity';
import type { Shop } from '../../src/types';

/**
 * 读模板前的店铺守门：只有拿到「正向身份凭据」才允许读。
 * - 店铺绑定了后台编号：当前页必须给出同两个编号（缺一个也算读不到）。
 * - 店铺没绑定：只认当前页返回的店铺名，名字读不到就停下，绝不「没证据就放行」。
 * 返回 null 表示核对通过，否则返回要展示给运营的原因。
 */
export function templateShopProblem(shop: Shop, live: PddAnchor | undefined): string | null {
  const mall = typeof live?.mallId === 'number' ? live.mallId : undefined;
  const user = typeof live?.userId === 'number' ? live.userId : undefined;
  const name = String(live?.mallName || '').trim();
  const bound = typeof shop.mallId === 'number' && typeof shop.userId === 'number';
  if (bound) {
    if (mall === undefined || user === undefined)
      return `读不到当前页面的后台店铺 ID / 账号 ID，无法确认是不是「${shop.name}」。请先在浏览器登录这家店并停在商品编辑页，再点一次「读取后台模板」。`;
    if (mall !== shop.mallId || user !== shop.userId)
      return `浏览器里打开的是另一家店（后台店铺 ID ${mall}、账号 ID ${user}），不是「${shop.name}」（${shop.mallId} / ${shop.userId}）。请先在浏览器切到这家店的商品编辑页，再点一次「读取后台模板」。`;
    return null;
  }
  if (!name)
    return `读不到当前页面的店铺名，无法确认打开的是不是「${shop.name}」。请先在店铺管理里点一次「核对登录」把店铺绑定上，或直接打开这家店的商品编辑页后再读取。`;
  if (name !== shop.name)
    return `浏览器里打开的店铺是「${name}」，不是「${shop.name}」。请先在浏览器切到这家店的商品编辑页，再点一次「读取后台模板」。`;
  return null;
}

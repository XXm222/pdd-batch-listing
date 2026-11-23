import { Store } from './store';
import { resolveShopName } from '../src/domain';
import { accountKey, derivableShopName, isMaskedAccount, normalizePddAccount } from '../src/shop-account';
import { accountKind as pddAccountKind } from '../src/shop-account';
import {
  DEFAULT_PLATFORM,
  isPlatformId,
  normalizePlatform,
  platformMeta,
  requireEnabledPlatform,
} from '../src/platforms';
import type { Shop, ShopInput } from '../src/types';
const uuid = /^[a-f0-9-]{36}$/i;
export class ShopService {
  constructor(
    private store: Store,
    private encrypt: (password: string) => Promise<string>,
    private isBusy: (id: string) => boolean,
  ) {}
  async save(raw: ShopInput): Promise<Shop> {
    if (
      !raw ||
      typeof raw.name !== 'string' ||
      typeof raw.account !== 'string' ||
      typeof raw.password !== 'string'
    )
      throw new Error('店铺资料不正确');
    if (raw.platform !== undefined && !isPlatformId(raw.platform))
      throw new Error('店铺平台不正确');
    // 归一化后入库：全角冒号、尾部真实姓名、零宽字符都不该变成「另一个账号」。
    const account = normalizePddAccount(raw.account);
    if (!account || account.length > 100 || raw.password.length > 256)
      throw new Error('请填写有效的账号及密码');
    if (isMaskedAccount(account))
      throw new Error('登录账号含掩码字符，请填写可登录的完整账号');
    if (raw.id && !uuid.test(raw.id)) throw new Error('店铺标识无效');
    if (raw.id && this.isBusy(raw.id))
      throw new Error('该店铺正在执行任务，请暂停并等待任务结束后再修改');
    const existing = this.store.all<Shop>('shops').find((s) => s.id === raw.id);
    if (raw.id && !existing) throw new Error('店铺不存在，请刷新后重试');
    // 编辑时未选择平台则沿用原平台，避免把已保存的店铺误改成默认平台。
    const platform = isPlatformId(raw.platform)
      ? raw.platform
      : existing
        ? normalizePlatform(existing.platform)
        : DEFAULT_PLATFORM;
    requireEnabledPlatform(platform);
    const name = resolveShopName(raw.name, account, !existing, platform, derivableShopName(account));
    if (!platformMeta(platform).allowsSubAccount && account.includes(':'))
      throw new Error(
        `${platformMeta(platform).label}登录账号请填写会员名或手机号，不要使用“店铺名:子账号”格式`,
      );
    // 去重按归一化键：只差全角冒号、大小写或真实姓名的写法视为同一个账号。
    const key = accountKey(account);
    if (this.store.all<Shop>('shops').some((s) => accountKey(s.account) === key && s.id !== raw.id))
      throw new Error('该账号已保存，请编辑原店铺');
    // 账号没变（按归一化键比较）时允许留空沿用原密码。
    if (!raw.password && (!existing || accountKey(existing.account) !== key))
      throw new Error('新增店铺或更换账号时请填写密码');
    const secret = raw.password
      ? await this.encrypt(raw.password)
      : this.store.secret(existing!.id);
    // 账号按归一化键没变时，后台绑定继续沿用；换了账号，旧绑定必须作废，
    // 否则新账号第一次核对就会被「绑定不一致」拦住。
    const sameAccount = !!existing && accountKey(existing.account) === key;
    const shop: Shop = {
      id: existing?.id || crypto.randomUUID(),
      name,
      account,
      credentialsSaved: true,
      updatedAt: new Date().toISOString(),
      platform,
      accountKind: pddAccountKind(account),
      mallId: sameAccount ? existing?.mallId : undefined,
      userId: sameAccount ? existing?.userId : undefined,
      boundAt: sameAccount ? existing?.boundAt : undefined,
    };
    this.store.saveShop(shop, secret);
    return shop;
  }
}

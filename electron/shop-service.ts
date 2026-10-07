import { Store } from './store';
import { resolveShopName } from '../src/domain';
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
    const account = raw.account.trim();
    if (!account || account.length > 100 || raw.password.length > 256)
      throw new Error('请填写有效的账号及密码');
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
    const name = resolveShopName(raw.name, account, !existing, platform);
    if (!platformMeta(platform).allowsSubAccount && /[:：]/.test(account))
      throw new Error(
        `${platformMeta(platform).label}登录账号请填写会员名或手机号，不要使用“店铺名:子账号”格式`,
      );
    if (this.store.all<Shop>('shops').some((s) => s.account === account && s.id !== raw.id))
      throw new Error('该账号已保存，请编辑原店铺');
    if (!raw.password && (!existing || existing.account !== account))
      throw new Error('新增店铺或更换账号时请填写密码');
    const secret = raw.password
      ? await this.encrypt(raw.password)
      : this.store.secret(existing!.id);
    const shop: Shop = {
      id: existing?.id || crypto.randomUUID(),
      name,
      account,
      credentialsSaved: true,
      updatedAt: new Date().toISOString(),
      platform,
    };
    this.store.saveShop(shop, secret);
    return shop;
  }
}

/**
 * 平台元数据：界面文案、入口地址和该平台的能力边界。
 *
 * 这里只放平台级的公开信息（名称、入口、输入提示、支持范围），
 * 具体页面选择器只留在 `electron/platforms/` 下，不进入 React。
 */
export const PLATFORM_IDS = ['pdd', 'taobao'] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export type PlatformDefinition = {
  id: PlatformId;
  /** 是否开放运营入口；关闭时保留资料与已有适配代码。 */
  enabled: boolean;
  /** 界面与执行记录中显示的平台名称 */
  label: string;
  /** 商家后台入口；连接浏览器时用它打开默认浏览器 */
  portal: string;
  /** 登录账号输入框的示例文案 */
  accountExample: string;
  /** 新增店铺时的账号格式说明 */
  accountHint: string;
  /** 店铺名称是否由登录账号推导（拼多多为「店铺名:子账号」） */
  derivesNameFromAccount: boolean;
  /** 登录账号是否使用「店铺名:子账号」格式 */
  allowsSubAccount: boolean;
  /** 店铺名称输入框的提示 */
  namePlaceholder: string;
  /** 登录与核对弹窗中的说明 */
  loginHint: string;
  /** 该平台是否已实现商品草稿保存 */
  draftPublishing: boolean;
  /** 草稿流程未实现时对运营的说明 */
  draftPendingMessage: string;
};

export const PLATFORMS: Record<PlatformId, PlatformDefinition> = {
  pdd: {
    id: 'pdd',
    enabled: true,
    label: '拼多多',
    portal: 'https://mms.pinduoduo.com/home/',
    accountExample: '例如：日用生活馆:运营账号',
    accountHint: '账号格式：店铺名:子账号，店铺名称自动取冒号前的文字。',
    derivesNameFromAccount: true,
    allowsSubAccount: true,
    namePlaceholder: '由登录账号中冒号前的店铺名自动生成',
    loginHint:
      '在已连接浏览器退出当前拼多多账号，自动填写此店铺保存的账号密码并点击登录。登录后核对店铺名称与子账号。',
    draftPublishing: true,
    draftPendingMessage: '',
  },
  taobao: {
    id: 'taobao',
    enabled: false,
    label: '淘宝',
    portal: 'https://myseller.taobao.com/home.htm',
    accountExample: '例如：淘宝会员名或手机号',
    accountHint:
      '填写千牛登录用的淘宝会员名或手机号；淘宝账号不是「店铺名:子账号」格式，店铺名称请手动填写。',
    derivesNameFromAccount: false,
    allowsSubAccount: false,
    namePlaceholder: '填写与千牛后台一致的店铺名称',
    loginHint:
      '在已连接浏览器打开千牛登录页，可用扫码、密码或短信登录；验证码和滑块由运营在浏览器中完成，脚本只负责填表和核对登录结果。',
    draftPublishing: true,
    draftPendingMessage: '',
  },
};

export const PLATFORM_ORDER: readonly PlatformId[] = PLATFORM_IDS;
export const DEFAULT_PLATFORM: PlatformId = 'pdd';

export function isPlatformId(value: unknown): value is PlatformId {
  return typeof value === 'string' && (PLATFORM_IDS as readonly string[]).includes(value);
}

/** 旧资料没有平台字段，一律按拼多多读取，不做破坏性迁移。 */
export function normalizePlatform(value: unknown): PlatformId {
  return isPlatformId(value) ? value : DEFAULT_PLATFORM;
}

export function platformMeta(value: unknown): PlatformDefinition {
  return PLATFORMS[normalizePlatform(value)];
}

export function requireEnabledPlatform(value: unknown): PlatformDefinition {
  const meta = platformMeta(value);
  if (!meta.enabled) throw new Error(`${meta.label}暂未开放，目前仅支持拼多多`);
  return meta;
}

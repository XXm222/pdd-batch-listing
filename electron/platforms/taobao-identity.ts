/**
 * 淘宝/千牛后台的登录状态与店铺身份判定。
 *
 * 与拼多多的差别：淘宝登录页在 havanalogin.taobao.com，登录成功后进入
 * myseller.taobao.com 的千牛工作台；工作台顶部显示的是店铺名称，登录账号
 * 可能是淘宝会员名或手机号，不一定出现在页面上。因此身份以店铺名称为准，
 * 子账号格式（店铺名:子账号）才要求账号也出现。
 */
type ShopIdentity = { name: string; account: string };
export type TaobaoLoginState = {
  trusted: boolean;
  /** 工作台顶部候选文本，用于核对子账号等附加信息。 */
  names: string[];
  /** 千牛工作台店铺名称元素读到的名称（真实页面为 .shopName-* 元素）；优先用它核对店铺。 */
  shopNames: string[];
  loginPage: boolean;
  form: boolean;
  rejected: boolean;
  challenge: boolean;
  /** 已离开登录页但尚未核对身份 */
  leftLogin: boolean;
  /** 页面可见的提示文字（仅用于判断，不进日志） */
  message?: string;
  structure?: {
    host: string;
    loginHost: string;
    workbenchHost: boolean;
    formVisible: boolean;
    sliderVisible: boolean;
    nameCount: number;
    shopNameCount: number;
  };
};

const asciiLower = (value: string) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());
const caseOnly = (names: string[], value: string) =>
  names.some((name) => name !== value && asciiLower(name) === asciiLower(value));
/** 子账号按「店铺名:子账号」填写时，冒号后的部分是子账号名。 */
export const subAccountOf = (account: string) => {
  const index = account.search(/[:：]/);
  return index > 0 && account.slice(index + 1).trim() ? account.slice(index + 1).trim() : '';
};
export function matchesTaobaoIdentity(
  names: string[],
  shop: ShopIdentity,
  shopNames: string[] = [],
): boolean {
  // 工作台有专门的店铺名称元素时只信它，避免页头其它文字被当成店铺名。
  const scope = shopNames.length ? shopNames : names;
  if (!scope.includes(shop.name)) return false;
  // 淘宝普通账号是会员名或手机号，工作台不一定回显；只有子账号格式才强制核对账号。
  const sub = subAccountOf(shop.account);
  return sub ? names.includes(sub) : true;
}
export function taobaoIdentityProblem(
  names: string[],
  shop: ShopIdentity,
  shopNames: string[] = [],
): string {
  const scope = shopNames.length ? shopNames : names;
  if (!scope.length) return '已登录千牛后台，但未读取到店铺名称，请检查后台顶部的店铺区域后重试';
  if (scope.includes(shop.name)) {
    const sub = subAccountOf(shop.account);
    if (sub && !names.includes(sub))
      return `后台店铺名称已匹配，但未读取到子账号“${sub}”；已保留当前登录，请核对后台账号区`;
    return '';
  }
  if (caseOnly(scope, shop.name))
    return `后台店铺名称与保存的“${shop.name}”仅大小写不同，请到店铺管理按后台名称修改后继续`;
  return `后台店铺名称与保存的“${shop.name}”不一致，请核对店铺管理中的名称和当前后台店铺`;
}
export const shopIdentityMessage = (shop: Pick<ShopIdentity, 'name'>) =>
  `已核对千牛后台店铺：${shop.name}`;

/** 页面脚本：只返回分类和候选名称，不返回密码、Cookie 或整页正文。 */
export const TAOBAO_LOGIN_STATE = `(() => {
  const HOST = location.hostname;
  const KNOWN = ['havanalogin.taobao.com','loginmyseller.taobao.com','myseller.taobao.com','qianniu.taobao.com','login.taobao.com'];
  const trusted = KNOWN.includes(HOST) || /\\.taobao\\.com$/.test(HOST);
  const workbenchHost = /(^|\\.)myseller\\.taobao\\.com$/.test(HOST) || /(^|\\.)qianniu\\.taobao\\.com$/.test(HOST);
  const loginHost = /havana|login/i.test(HOST);
  if (!trusted) return {trusted:false,names:[],shopNames:[],loginPage:false,form:false,rejected:false,challenge:false,leftLogin:false};
  const visible = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const idVisible = (id) => visible(document.querySelector('#' + id));
  const passwordForm = idVisible('fm-login-id') && idVisible('fm-login-password');
  const smsForm = idVisible('fm-sms-login-id') && idVisible('fm-smscode');
  const form = passwordForm || smsForm;
  const sliderVisible = visible(document.querySelector('.nc_wrapper'));
  const body = document.body ? document.body.innerText : '';
  const errorEl = [...document.querySelectorAll('.login-error-msg,.login-error,.fm-error')].find(visible);
  const message = errorEl ? (errorEl.innerText || '').trim().slice(0, 120) : '';
  const rejected = /账号或密码错误|账户或密码错误|用户名或密码错误|密码不正确|密码错误|账号不存在|账户不存在|账号已被冻结|账号被冻结|账号已被锁定/.test(body) || /账号或密码错误|密码不正确|密码错误|账号不存在/.test(message);
  const challenge = sliderVisible || /请按住滑块|拖动滑块|滑动(?:完成)?验证|点击完成验证|请完成安全验证|请输入短信验证码|短信校验|请完成验证/.test(body) || /请完成验证|验证码/.test(message);
  const names = [];
  // innerText 会排除隐藏子元素；千牛工作台的店铺名称元素内部还有隐藏的下拉菜单，
  // 用 textContent 会把「账号信息/退出当前账号」等文字拼进店铺名称。
  const readText = (node) => {
    const text = typeof node.innerText === 'string' && node.innerText.trim() ? node.innerText : node.textContent;
    return String(text || '').replace(/\\s+/g, ' ').trim();
  };
  const push = (value) => {
    const text = String(value || '').replace(/\\s+/g, ' ').trim();
    if (!text || text.length > 50 || names.includes(text) || names.length >= 40) return;
    names.push(text);
  };
  const roots = ['header','[role=banner]','[class*=header]','[class*=Header]','[class*=topbar]','[class*=Topbar]','[class*=shop-info]','[class*=shopName]','[class*=seller-info]','[class*=user-info]'];
  for (const selector of roots) {
    for (const root of document.querySelectorAll(selector)) {
      if (!visible(root)) continue;
      push(root.getAttribute('title'));
      for (const node of root.querySelectorAll('*')) {
        if (node.children.length) continue;
        push(node.getAttribute('title'));
        push(node.textContent);
      }
      push(readText(root));
    }
  }
  const shopNames = [];
  const pushShopName = (value) => {
    const text = String(value || '').replace(/\\s+/g, ' ').trim();
    if (!text || text.length > 50 || shopNames.includes(text) || shopNames.length >= 8) return;
    shopNames.push(text);
  };
  // 真实千牛工作台把店铺名称放在 .shopName-* 元素里（2026-10-06 现场核对）。
  for (const node of document.querySelectorAll('[class*=shopName],[class*=shop-name],[class*=seller-name]')) {
    if (!visible(node)) continue;
    pushShopName(node.getAttribute('title'));
    pushShopName(readText(node));
  }
  for (const node of document.querySelectorAll('[class*=shop-name],[class*=shopName],[class*=seller-name],[class*=nick]')) {
    if (!visible(node)) continue;
    push(node.getAttribute('title'));
    push(readText(node));
  }
  const loginPage = loginHost || form;
  return {trusted:true,names,shopNames,loginPage,form,rejected,challenge,
    leftLogin: workbenchHost && !form && !rejected && !challenge,
    message,
    structure:{host:HOST,loginHost:loginHost?'yes':'no',workbenchHost,formVisible:form,sliderVisible,nameCount:names.length,shopNameCount:shopNames.length}};
})()`;

import type { BrowserBridge } from '../browser-bridge';
import { ExecutionError } from '../execution';
import { ShopLoginError } from './shop-login';
import {
  TAOBAO_LOGIN_STATE,
  matchesTaobaoIdentity,
  taobaoIdentityProblem,
  shopIdentityMessage,
  type TaobaoLoginState,
} from './taobao-identity';
import type { Shop, ShopLoginEvent } from '../../src/types';

/** 千牛工作台入口；未登录时淘宝会把它重定向到登录页。 */
export const TAOBAO_WORKBENCH = 'https://myseller.taobao.com/home.htm';
/**
 * 千牛登录页。登录表单在跨域 iframe 里，直接打开该地址才能由脚本填写；
 * 参数与「登录千牛工作台」实际使用的地址一致（2026-10-06 现场核对）。
 */
export const TAOBAO_LOGIN_URL =
  'https://havanalogin.taobao.com/mini_login.htm?lang=zh_CN&appName=taobao&appEntrance=qianniu_pc_web' +
  '&styleType=vertical&notLoadSsoView=true&notKeepLogin=false&isMobile=false' +
  `&returnUrl=${encodeURIComponent(TAOBAO_WORKBENCH)}`;

type Bridge = Pick<BrowserBridge, 'eval' | 'fill' | 'wait' | 'navigate'>;

/** 切到密码登录视图；返回 true 表示密码输入框已经可填。 */
export const TAOBAO_SHOW_PASSWORD_FORM = `(() => {
  const visible=(e)=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
  const id=document.querySelector('#fm-login-id'),password=document.querySelector('#fm-login-password');
  if(visible(id)&&visible(password))return true;
  const tab=document.querySelector('a.password-login-tab-item');
  if(!tab||!visible(tab))return false;
  tab.click();
  return false;
})()`;

/** 点击当前登录方式下唯一的登录按钮。 */
export const TAOBAO_SUBMIT_LOGIN = `(() => {
  const visible=(e)=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
  const selector=visible(document.querySelector('#fm-login-password'))
    ?'button.fm-submit.password-login':'button.fm-submit.sms-login';
  const buttons=[...document.querySelectorAll(selector)].filter((e)=>visible(e)&&!e.disabled);
  if(buttons.length!==1)return false;
  buttons[0].click();
  return true;
})()`;

export class TaobaoLogin {
  private lastState?: TaobaoLoginState;
  constructor(
    private bridge: Bridge,
    private decrypt: (shop: Shop) => Promise<string>,
    private onEvent: (event: ShopLoginEvent) => void = () => {},
    private guard: () => void = () => {},
  ) {}
  private async step<T>(name: string, work: () => Promise<T>): Promise<T> {
    this.guard();
    const startedAt = new Date().toISOString(),
      start = performance.now();
    this.onEvent({ name, startedAt, status: 'running' });
    try {
      const value = await work();
      this.onEvent({
        name,
        startedAt,
        status: 'done',
        durationMs: Math.round(performance.now() - start),
      });
      return value;
    } catch (error) {
      this.onEvent({
        name,
        startedAt,
        status: 'failed',
        durationMs: Math.round(performance.now() - start),
      });
      throw error;
    }
  }
  private async state() {
    this.guard();
    return (this.lastState = await this.bridge.eval<TaobaoLoginState>(TAOBAO_LOGIN_STATE, 5000));
  }
  private async trusted() {
    if (!(await this.state()).trusted)
      throw new ShopLoginError('failed', '当前页面不是千牛后台地址，已停止操作');
  }
  private async poll(
    check: (state: TaobaoLoginState) => boolean,
    message: string,
    timeout = 15000,
  ) {
    return this.bridge.wait(
      async () => {
        const state = await this.state();
        return check(state) ? state : false;
      },
      timeout,
      message,
    );
  }
  private timeoutState(message: string) {
    const state = this.lastState;
    const where = state?.trusted
      ? state.leftLogin
        ? '已在千牛工作台'
        : `当前页面：${state.structure?.host || '未知地址'}`
      : '页面地址未确认';
    return new ShopLoginError('failed', `${message}（${where}）`, state?.structure);
  }
  /** 只读核对：不再提交账号密码，只判断当前登录结果并核对店铺身份。 */
  private async verify(shop: Shop) {
    let result: TaobaoLoginState;
    try {
      result = await this.poll(
        (state) =>
          state.trusted &&
          (state.leftLogin || state.rejected || state.challenge || (state.loginPage && state.form)),
        '登录结果尚未确认，请查看已连接的浏览器后核对登录状态',
        20000,
      );
    } catch (error) {
      if (error instanceof ExecutionError && error.code === 'page_timeout')
        throw this.timeoutState('尚未读取到登录结果');
      throw error;
    }
    if (result.leftLogin) {
      const problem = taobaoIdentityProblem(result.names, shop, result.shopNames);
      if (problem) throw new ShopLoginError('failed', problem, result.structure);
      return;
    }
    if (result.rejected)
      throw new ShopLoginError(
        'credentials_rejected',
        '后台提示账号或密码有误，请修改店铺登录信息；程序不会反复尝试',
      );
    if (result.challenge)
      throw new ShopLoginError(
        'verification_required',
        '请在已连接的浏览器完成滑块或短信验证码，再点击“核对登录结果”',
      );
    throw new ShopLoginError(
      'failed',
      '当前仍停留在千牛登录页，请先在浏览器完成扫码、密码或短信登录，再点击“核对登录结果”',
      result.structure,
    );
  }
  private async waitForManualLogin(shop: Shop, timeout: number) {
    try {
      await this.poll(
        (state) => state.trusted && (state.leftLogin || state.rejected || state.challenge),
        '等待登录完成超时',
        timeout,
      );
    } catch (error) {
      if (error instanceof ExecutionError && error.code === 'page_timeout')
        throw new ShopLoginError(
          'verification_required',
          '仍在等待登录完成：请在已连接的浏览器扫码或输入验证码，然后点击“核对登录结果”',
        );
      throw error;
    }
    await this.verify(shop);
  }
  private async showPasswordForm() {
    try {
      await this.bridge.wait(
        async () => {
          await this.trusted();
          return this.bridge.eval<boolean>(TAOBAO_SHOW_PASSWORD_FORM, 5000);
        },
        12000,
        '密码登录输入框未显示',
      );
    } catch (error) {
      if (error instanceof ExecutionError && error.code === 'page_timeout')
        throw new ShopLoginError(
          'verification_required',
          '千牛登录页未显示密码登录输入框，请在已连接的浏览器继续登录，再点击“核对登录结果”',
        );
      throw error;
    }
  }
  async run(shop: Shop, mode: 'reuse' | 'relogin' | 'check' = 'relogin') {
    this.lastState = undefined;
    if (mode === 'check') {
      await this.step('核对千牛后台店铺', () => this.verify(shop));
      return;
    }
    let initial: TaobaoLoginState;
    try {
      initial = await this.step('打开千牛工作台', async () => {
        await this.bridge.navigate(TAOBAO_WORKBENCH);
        return this.poll((state) => state.trusted, '千牛工作台未加载，请检查已连接的浏览器', 20000);
      });
    } catch (error) {
      if (error instanceof ExecutionError && error.code === 'page_timeout')
        throw this.timeoutState('千牛工作台未加载');
      throw error;
    }
    // 已经登录：不再退出账号，直接核对身份；身份不符时明确要求人工切换。
    if (initial.leftLogin) {
      const problem = taobaoIdentityProblem(initial.names, shop, initial.shopNames);
      if (problem)
        throw new ShopLoginError(
          'failed',
          `${problem}。当前浏览器登录的是其他店铺，请在该浏览器退出登录后重新开始`,
          initial.structure,
        );
      await this.step('核对千牛后台店铺', () => this.verify(shop));
      return;
    }
    await this.step('打开千牛登录页', async () => {
      await this.bridge.navigate(TAOBAO_LOGIN_URL);
      await this.poll(
        (state) => state.trusted && (state.form || state.challenge || state.leftLogin),
        '千牛登录页未加载，请检查已连接的浏览器',
        20000,
      );
    });
    const page = await this.state();
    if (page.leftLogin) {
      await this.step('核对千牛后台店铺', () => this.verify(shop));
      return;
    }
    if (page.challenge)
      throw new ShopLoginError(
        'verification_required',
        '请在已连接的浏览器完成滑块或短信验证码，再点击“核对登录结果”',
      );
    let password = '';
    await this.step('读取本机保存的登录信息', async () => {
      try {
        password = await this.decrypt(shop);
      } catch {
        password = '';
      }
    });
    try {
      // 没有可用密码时不猜测，交给运营在浏览器里扫码或短信登录。
      if (!password) {
        await this.step('等待人工登录', () => this.waitForManualLogin(shop, 90000));
        return;
      }
      await this.step('填写保存的账号和密码', async () => {
        await this.showPasswordForm();
        try {
          await this.bridge.fill('#fm-login-id', shop.account);
          await this.trusted();
          await this.bridge.fill('#fm-login-password', password);
        } catch (error) {
          if (error instanceof ShopLoginError || error instanceof ExecutionError) throw error;
          throw new ShopLoginError('failed', '账号密码填写未确认，请检查千牛登录页面');
        }
      });
      password = '';
      await this.step('点击登录', async () => {
        await this.trusted();
        const clicked = await this.bridge.eval<boolean>(TAOBAO_SUBMIT_LOGIN, 5000);
        if (!clicked)
          throw new ShopLoginError('failed', '登录按钮未就绪或无法唯一定位，请检查已连接的浏览器');
      });
      await this.step('核对千牛后台店铺', () => this.verify(shop));
    } finally {
      password = '';
    }
  }
}

export { matchesTaobaoIdentity, shopIdentityMessage };

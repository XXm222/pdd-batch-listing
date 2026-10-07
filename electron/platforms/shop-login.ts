import { ExecutionError } from '../execution';
import type { ShopLoginStatus } from '../../src/types';

/**
 * 店铺登录失败的分类结果。status 决定运营看到的处理方式：
 * verification_required 需要人工完成验证码 / 扫码后再核对，credentials_rejected 需要改账号密码。
 */
export class ShopLoginError extends ExecutionError {
  constructor(
    public loginStatus: Exclude<ShopLoginStatus, 'running' | 'succeeded'>,
    message: string,
    public readonly diagnostics?: unknown,
  ) {
    super('login_required', message, 'retry');
  }
}

/**
 * 这里只覆盖登录流程的分支与安全边界（不重复提交、遇验证码停手、身份不符不冒充成功）。
 * 真实登录结果以 verification/taobao-20261006/verify-login.cjs 在真实千牛页面上的
 * 只读核对为准；本文件不模拟页面，只替身浏览器命令的调用顺序与返回分类。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TaobaoLogin,
  TAOBAO_LOGIN_URL,
  TAOBAO_WORKBENCH,
  TAOBAO_SHOW_PASSWORD_FORM,
  TAOBAO_SUBMIT_LOGIN,
} = require('../dist-electron/electron/platforms/taobao-login.js');
const { TAOBAO_LOGIN_STATE } = require('../dist-electron/electron/platforms/taobao-identity.js');
const { ShopLoginError } = require('../dist-electron/electron/platforms/shop-login.js');
const { ExecutionError } = require('../dist-electron/electron/execution.js');

const shop = { name: 'Mandla旗舰店', account: 'mandla_member' };
const signedIn = (names = [shop.name], shopNames = [shop.name]) => ({
  trusted: true,
  names,
  shopNames,
  loginPage: false,
  form: false,
  rejected: false,
  challenge: false,
  leftLogin: true,
  structure: { host: 'myseller.taobao.com', loginHost: 'no', workbenchHost: true },
});
const loginPage = (overrides = {}) => ({
  trusted: true,
  names: [],
  shopNames: [],
  loginPage: true,
  form: true,
  rejected: false,
  challenge: false,
  leftLogin: false,
  structure: { host: 'havanalogin.taobao.com', loginHost: 'yes', workbenchHost: false },
  ...overrides,
});

function fixture(initial, options = {}) {
  const state = { ...initial };
  const calls = [],
    events = [],
    waits = [];
  let decrypts = 0;
  const bridge = {
    async navigate(url) {
      calls.push(['navigate', url]);
    },
    async eval(code) {
      if (code === TAOBAO_LOGIN_STATE) return { ...state };
      if (code === TAOBAO_SHOW_PASSWORD_FORM) {
        calls.push('show-password-form');
        return true;
      }
      if (code === TAOBAO_SUBMIT_LOGIN) {
        calls.push('submit-login');
        if (options.afterSubmit) Object.assign(state, options.afterSubmit);
        return true;
      }
      throw new Error('unexpected browser script');
    },
    async fill(selector, value) {
      calls.push([selector, value]);
    },
    async wait(check, timeout, message) {
      waits.push(timeout);
      for (let i = 0; i < 6; i++) {
        options.beforeCheck?.(state, i);
        const value = await check();
        if (value) return value;
      }
      throw new ExecutionError('page_timeout', message);
    },
  };
  const login = new TaobaoLogin(
    bridge,
    async () => {
      decrypts++;
      return options.password ?? 'isolated-password';
    },
    (event) => events.push(event),
    () => {},
  );
  return { login, calls, events, waits, decrypts: () => decrypts, state };
}

async function rejection(fixture, mode) {
  try {
    await fixture.login.run(shop, mode);
  } catch (error) {
    assert.ok(error instanceof ShopLoginError, `期望 ShopLoginError，实际 ${error.message}`);
    return error;
  }
  throw new Error('本应失败却成功了');
}

test('check 只读核对：已登录且名称一致时完成，不读取密码也不填写', async () => {
  const f = fixture(signedIn());
  await f.login.run(shop, 'check');
  assert.equal(f.decrypts(), 0);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(
    f.events.map((event) => [event.name, event.status]),
    [
      ['核对千牛后台店铺', 'running'],
      ['核对千牛后台店铺', 'done'],
    ],
  );
});

test('check 只读核对：名称不一致、验证码和密码被拒分别给出对应状态', async () => {
  const mismatch = await rejection(fixture(signedIn(['其他店铺'], ['其他店铺'])), 'check');
  assert.equal(mismatch.loginStatus, 'failed');
  assert.match(mismatch.message, /不一致/);

  const challenge = await rejection(fixture(loginPage({ challenge: true, form: false })), 'check');
  assert.equal(challenge.loginStatus, 'verification_required');
  assert.match(challenge.message, /滑块或短信验证码/);

  const rejected = await rejection(fixture(loginPage({ rejected: true, form: false })), 'check');
  assert.equal(rejected.loginStatus, 'credentials_rejected');
  assert.match(rejected.message, /不会反复尝试/);
});

test('check 只读核对：仍停留在登录页时不冒充成功', async () => {
  const error = await rejection(fixture(loginPage()), 'check');
  assert.equal(error.loginStatus, 'failed');
  assert.match(error.message, /仍停留在千牛登录页/);
});

test('relogin：已登录所选店铺时直接核对，不退出也不重新提交密码', async () => {
  const f = fixture(signedIn());
  await f.login.run(shop, 'relogin');
  assert.equal(f.decrypts(), 0);
  assert.deepEqual(f.calls, [['navigate', TAOBAO_WORKBENCH]]);
  assert.equal(
    f.events.some((event) => /填写保存的账号和密码|点击登录/.test(event.name)),
    false,
  );
});

test('relogin：当前登录的是其他店铺时要求人工切换，不自动退出', async () => {
  const f = fixture(signedIn(['其他店铺'], ['其他店铺']));
  const error = await rejection(f, 'relogin');
  assert.equal(error.loginStatus, 'failed');
  assert.match(error.message, /退出登录后重新开始/);
  assert.equal(f.decrypts(), 0);
  assert.deepEqual(f.calls, [['navigate', TAOBAO_WORKBENCH]]);
});

test('relogin：未登录且有保存密码时走密码登录并核对身份', async () => {
  const f = fixture(loginPage(), { afterSubmit: signedIn() });
  await f.login.run(shop, 'relogin');
  assert.deepEqual(f.calls, [
    ['navigate', TAOBAO_WORKBENCH],
    ['navigate', TAOBAO_LOGIN_URL],
    'show-password-form',
    ['#fm-login-id', shop.account],
    ['#fm-login-password', 'isolated-password'],
    'submit-login',
  ]);
  assert.equal(f.decrypts(), 1);
  assert.deepEqual(
    f.events.filter((event) => event.status === 'running').map((event) => event.name),
    [
      '打开千牛工作台',
      '打开千牛登录页',
      '读取本机保存的登录信息',
      '填写保存的账号和密码',
      '点击登录',
      '核对千牛后台店铺',
    ],
  );
  assert.equal(
    f.events.every((event) => event.status !== 'failed'),
    true,
  );
});

test('relogin：没有可用密码时等待人工登录，成功后仍核对店铺', async () => {
  const f = fixture(loginPage(), {
    password: '',
    beforeCheck: (state, index) => {
      if (index >= 1) Object.assign(state, signedIn());
    },
  });
  await f.login.run(shop, 'relogin');
  assert.deepEqual(f.calls, [
    ['navigate', TAOBAO_WORKBENCH],
    ['navigate', TAOBAO_LOGIN_URL],
  ]);
  assert.equal(
    f.events.some((event) => event.name === '等待人工登录' && event.status === 'done'),
    true,
  );
});

test('relogin：人工登录等待超时提示继续核对，不重复提交', async () => {
  const f = fixture(loginPage(), { password: '' });
  const error = await rejection(f, 'relogin');
  assert.equal(error.loginStatus, 'verification_required');
  assert.match(error.message, /核对登录结果/);
  assert.equal(
    f.calls.some((call) => call === 'submit-login'),
    false,
  );
});

test('relogin：登录页出现滑块时先交人工处理，不读取密码', async () => {
  const f = fixture(loginPage({ form: false, challenge: true }));
  const error = await rejection(f, 'relogin');
  assert.equal(error.loginStatus, 'verification_required');
  assert.equal(f.decrypts(), 0);
  assert.deepEqual(f.calls, [
    ['navigate', TAOBAO_WORKBENCH],
    ['navigate', TAOBAO_LOGIN_URL],
  ]);
});

test('登录页地址与工作台地址都是该平台后台的合法入口', () => {
  assert.match(TAOBAO_WORKBENCH, /^https:\/\/myseller\.taobao\.com\//);
  assert.match(TAOBAO_LOGIN_URL, /^https:\/\/havanalogin\.taobao\.com\/mini_login\.htm\?/);
  assert.match(TAOBAO_LOGIN_URL, /returnUrl=https%3A%2F%2Fmyseller\.taobao\.com%2Fhome\.htm/);
  assert.match(TAOBAO_LOGIN_URL, /appEntrance=qianniu_pc_web/);
});

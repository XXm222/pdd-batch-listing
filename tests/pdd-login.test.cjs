const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { PddLogin, LOGIN_STATE, shopIdentityMessage } = require('../dist-electron/electron/platforms/pdd-login');
const { matchesPddIdentity, PDD_IDENTITY_MATCH, isPddLoginConfirmed, PDD_LOGIN_CONFIRMED } = require('../dist-electron/electron/platforms/pdd-identity');
const { ExecutionError } = require('../dist-electron/electron/execution');

const shop = { name: '隔离店铺', account: '隔离店铺:运营' };
function fixture(overrides = {}, afterSubmit = {}) {
  const state = { trusted: true, signedIn: false, names: [], loginPage: true, form: false, challenge: false, rejected: false, ...overrides };
  const calls = [], events = [], waits = [];
  let decrypts = 0;
  const bridge = {
    async eval(code) {
      if (code === LOGIN_STATE) return { ...state, structure: state.structure || {
        headerPresent: !!state.names.length, bannerPresent: false, logoutTextPresent: state.signedIn,
        logoutDomPresent: state.signedIn, logoutVisible: state.signedIn, maskedTextPresent: state.names.some(name => name.includes('*')), nameCount: state.names.length
      } };
      if (code.includes("textContent.trim()==='账号登录'")) {
        calls.push('account-tab'); state.form = true; return true;
      }
      if (code.includes('/^登\\s*录$/')) {
        calls.push('submit-login'); Object.assign(state, { signedIn: true, names: [shop.name, shop.account, '退出当前账号'], loginPage: false, form: false }, afterSubmit); return true;
      }
      if (code.includes("querySelectorAll('header *,[role=banner] *')")) {
        calls.push('logout'); Object.assign(state, { signedIn: false, names: [], loginPage: true, form: false }); return true;
      }
      throw new Error('unexpected browser script');
    },
    async fill(selector, value) { calls.push([selector, value]); },
    async wait(check, _timeout, message) {
      waits.push(_timeout);
      for (let i = 0; i < 5; i++) { const value = await check(); if (value) return value; }
      throw new ExecutionError('page_timeout', message);
    }
  };
  const login = new PddLogin(bridge, async () => { decrypts++; return 'isolated-password'; }, event => events.push(event));
  return { state, calls, events, waits, login, decrypts: () => decrypts };
}

test('QR login page automatically switches to account login and submits the saved credentials once', async () => {
  const f = fixture();
  await f.login.run(shop);
  assert.deepEqual(f.calls, ['account-tab', ['#usernameId', shop.account], ['#passwordId', 'isolated-password'], 'submit-login']);
  assert.equal(f.decrypts(), 1);
  assert.equal(f.events.at(-1).status, 'done');
  assert.ok(!JSON.stringify(f.events).includes('isolated-password'));
});

test('a pending login verification is preserved rather than submitting saved credentials again', async () => {
  const f = fixture({ challenge: true });
  await assert.rejects(f.login.run(shop), error => error.loginStatus === 'verification_required');
  assert.equal(f.decrypts(), 0);
  assert.deepEqual(f.calls, []);
});

test('a confirmed existing shop session is reused without reading the password', async () => {
  const f = fixture({ signedIn: true, names: [shop.name, shop.account, '退出当前账号'], loginPage: false });
  await f.login.run(shop);
  assert.equal(f.decrypts(), 0);
  assert.deepEqual(f.calls, []);
});

test('checking a different subaccount stops the task without reading or submitting credentials', async () => {
  const f = fixture({ signedIn: true, names: [shop.name, '隔离店铺:另一账号', '退出当前账号'], loginPage: false });
  await assert.rejects(f.login.run(shop, 'check'), error => error.loginStatus === 'failed' && /不一致/.test(error.message));
  assert.equal(f.decrypts(), 0);
  assert.deepEqual(f.calls, []);
});

test('ordinary-account confirmation accurately describes a shop-name check', async () => {
  const ordinary = { ...shop, account: '13800000000' };
  const f = fixture({ signedIn: true, names: [shop.name, '退出当前账号'], loginPage: false });
  await f.login.run(ordinary);
  assert.equal(f.events.at(-1).name, '核对后台店铺');
  assert.match(shopIdentityMessage(ordinary), /按店铺名称核对/);
  assert.ok(!shopIdentityMessage(ordinary).includes('已核对后台店铺及登录账号'));
});

function readState(headerText, bannerText, pathname = '/home/', hiddenLogout = false) {
  const root = text => {
    const leaves = text.split('\n').map(textContent => ({ textContent, children: [], getClientRects: () => [{}] }));
    if (hiddenLogout) leaves.push({ textContent: '退出当前账号', children: [], getClientRects: () => [] });
    return { innerText: text, textContent: text, children: leaves, querySelectorAll: () => leaves, getClientRects: () => [{}] };
  };
  const document = {
    querySelector: selector => selector === 'header' && headerText !== null ? root(headerText)
      : selector === '[role=banner]' && bannerText !== null ? root(bannerText) : null,
    querySelectorAll: () => [], body: { innerText: '正常后台首页' }
  };
  return JSON.parse(JSON.stringify(vm.runInNewContext(LOGIN_STATE, {
    document, location: { origin: 'https://mms.pinduoduo.com', pathname }, getComputedStyle: () => ({ visibility: 'visible' })
  })));
}

test('real login-state script keeps an authenticated header with unrelated masked information signed in', async () => {
  const state = readState(`${shop.name}\n${shop.account}\n138****0000\n退出当前账号`, null);
  assert.equal(state.signedIn, true);
  assert.deepEqual(state.structure, { headerPresent: true, bannerPresent: false, logoutTextPresent: true, logoutDomPresent: true, logoutVisible: true, maskedTextPresent: true, nameCount: 4 });
  const f = fixture(state);
  await f.login.run(shop);
  assert.equal(f.decrypts(), 0);
  assert.deepEqual(f.calls, []);
});

test('home URL without identity markup is not enough to declare a successful login', async () => {
  const state = readState(null, null);
  assert.equal(state.signedIn, false);
  assert.deepEqual(state.structure, { headerPresent: false, bannerPresent: false, logoutTextPresent: false, logoutDomPresent: false, logoutVisible: false, maskedTextPresent: false, nameCount: 0 });
  const f = fixture(state);
  await assert.rejects(f.login.run(shop, 'check'), error => error.loginStatus === 'failed' && /账号区未读取/.test(error.message) && error.diagnostics.nameCount === 0);
  assert.equal(f.waits[0], 20000);
  assert.equal(f.decrypts(), 0);
  assert.deepEqual(f.calls, []);
});

test('incomplete identity text without a logout marker gives a distinct verification failure', async () => {
  const state = readState(shop.name, null);
  const f = fixture(state);
  await assert.rejects(f.login.run(shop, 'check'), error => /账号区已读取.*未识别到登录完成标记/.test(error.message) && error.diagnostics.logoutTextPresent === false);
  assert.equal(f.decrypts(), 0);
});

test('a hidden logout menu is a login marker without claiming the menu is visible', async () => {
  const state = readState(`${shop.name}\n${shop.account}`, null, '/home/', true);
  assert.equal(state.signedIn, true);
  assert.equal(state.structure.logoutDomPresent, true);
  assert.equal(state.structure.logoutVisible, false);
  assert.equal(state.structure.logoutTextPresent, false);
  const f = fixture(state);
  await f.login.run(shop, 'check');
  assert.equal(f.decrypts(), 0);
  assert.deepEqual(f.calls, []);
});

test('check mode can confirm one full matching subaccount pair even when logout is not mounted', async () => {
  const state = readState(`${shop.name}\n${shop.account}`, null);
  assert.equal(state.signedIn, false, 'raw DOM marker is absent');
  assert.equal(isPddLoginConfirmed(state, shop), true, 'a complete trusted identity supplies separate confirmation');
  const f = fixture(state);
  await f.login.run(shop, 'check');
  assert.equal(f.decrypts(), 0);
  assert.deepEqual(f.calls, []);
});

test('ordinary accounts require a reliable logout marker even when the shop name is exact', async () => {
  const ordinary = { ...shop, account: '13800000000' };
  const missing = readState(`${shop.name}\n${shop.account}`, null);
  assert.equal(isPddLoginConfirmed(missing, ordinary), false);
  const f = fixture(missing);
  await assert.rejects(f.login.run(ordinary, 'check'), /未识别到登录完成标记/);
  const hidden = fixture(readState(`${shop.name}\n${shop.account}`, null, '/home/', true));
  await hidden.login.run(ordinary, 'check');
  assert.equal(hidden.decrypts(), 0);
});

test('complete identity cannot confirm login on a login page, login form, rejection, challenge, or untrusted page', () => {
  const base = readState(`${shop.name}\n${shop.account}`, null);
  const pageConfirm = vm.runInNewContext(`(${PDD_LOGIN_CONFIRMED})`);
  for (const override of [{ loginPage: true }, { form: true }, { rejected: true }, { challenge: true }, { trusted: false }]) {
    const state = { ...base, ...override };
    assert.equal(isPddLoginConfirmed(state, shop), false);
    assert.equal(pageConfirm(state, shop), false);
  }
  assert.equal(pageConfirm(base, shop), true);
});

test('one complete shop and subaccount pair accepts only backend ASCII casing normalization', async () => {
  const configured = { name: 'mandla旗舰店', account: 'mandla旗舰店:运营' };
  const state = readState('Mandla旗舰店\nMandla旗舰店:运营\n退出当前账号', null);
  const f = fixture(state);
  await f.login.run(configured);
  await f.login.run(configured);
  assert.equal(f.decrypts(), 0);
  assert.deepEqual(f.calls, []);
});

test('an incomplete or ambiguous account pair cannot use the casing exception', async () => {
  const configured = { ...shop, account: `${shop.name}:Ops` };
  const f = fixture(readState(`${shop.name}\n${shop.name}:ops\n${shop.name}:第二账号\n退出当前账号`, null));
  await assert.rejects(f.login.run(configured), error => /店铺名称已匹配.*登录账号.*仅大小写不同/.test(error.message) && !error.message.includes(':ops') && !error.message.includes(':Ops'));
  assert.equal(f.decrypts(), 0);
  assert.deepEqual(f.calls, []);
});

test('ordinary accounts still require an exact shop name despite a case-only backend difference', async () => {
  const configured = { name: 'mandla旗舰店', account: '13800000000' };
  const f = fixture(readState('Mandla旗舰店\nMandla旗舰店:运营\n退出当前账号', null));
  await assert.rejects(f.login.run(configured), error => /店铺名称.*仅大小写不同/.test(error.message));
  assert.equal(f.decrypts(), 0);
  assert.deepEqual(f.calls, []);
});

test('host and embedded page identity guards enforce the same narrowly scoped normalization', () => {
  const configured = { name: 'mandla旗舰店', account: 'mandla旗舰店:Ops' };
  const pageMatch = vm.runInNewContext(`(${PDD_IDENTITY_MATCH})`);
  const cases = [
    [['Mandla旗舰店', 'Mandla旗舰店:ops'], true],
    [['Mandla旗舰店', 'Mandla旗舰店:其他人'], false],
    [['Mandla旗舰店', 'Mandla旗舰店：ops'], false],
    [['Mandla旗舰店', 'Mandla旗舰店:ops*'], false],
    [['Mandla旗舰店', 'Mandla旗舰店:ops', 'Mandla旗舰店:OTHER'], false],
    [['Mandla旗舰店:ops'], false],
    [['Mandla旗舰店', 'mandla旗舰店:ops'], false],
    [['mandla旗舰店', 'mandla旗舰店:Ops'], true],
    [['Ｍandla旗舰店', 'Ｍandla旗舰店:Ops'], false]
  ];
  for (const [names, expected] of cases) {
    assert.equal(matchesPddIdentity(names, configured), expected);
    assert.equal(pageMatch(names, configured), expected);
  }
});

test('a masked subaccount is treated as unknown identity rather than logged-out', async () => {
  const state = readState(`${shop.name}\n${shop.name}:***\n退出当前账号`, null);
  assert.equal(state.signedIn, true);
  const f = fixture(state);
  await assert.rejects(f.login.run(shop), error => /店铺名称已匹配.*登录账号被隐藏/.test(error.message));
  assert.equal(f.decrypts(), 0);
  assert.deepEqual(f.calls, []);
});

test('partial logged-in identity is preserved without a guessed account switch', async () => {
  const f = fixture(readState('退出当前账号', null));
  await assert.rejects(f.login.run(shop), error => /信息未完整读取/.test(error.message));
  assert.equal(f.decrypts(), 0);
  assert.deepEqual(f.calls, []);
});

test('a fully identified other shop still automatically switches accounts for the task', async () => {
  const f = fixture(readState('另一店铺\n另一店铺:运营\n退出当前账号', null));
  await f.login.run(shop);
  assert.deepEqual(f.calls, ['logout', 'account-tab', ['#usernameId', shop.account], ['#passwordId', 'isolated-password'], 'submit-login']);
  assert.equal(f.decrypts(), 1);
});

test('a fully identified other subaccount can still switch to the saved subaccount', async () => {
  const f = fixture(readState(`${shop.name}\n${shop.name}:另一账号\n退出当前账号`, null));
  await f.login.run(shop);
  assert.equal(f.calls[0], 'logout');
  assert.equal(f.decrypts(), 1);
});

test('a clear different subaccount can switch even when the shop uses backend-canonicalized casing', async () => {
  const configured = { name: 'mandla旗舰店', account: 'mandla旗舰店:运营' };
  const actual = { name: 'Mandla旗舰店', account: 'Mandla旗舰店:运营' };
  const f = fixture(readState('Mandla旗舰店\nMandla旗舰店:另一账号\n退出当前账号', null),
    readState(`${actual.name}\n${actual.account}\n退出当前账号`, null));
  await f.login.run(configured);
  assert.equal(f.calls[0], 'logout');
  assert.equal(f.decrypts(), 1);
});

test('relogin reports an unavailable logout control instead of guessing another UI action', async () => {
  const state = readState(`${shop.name}\n${shop.account}`, null);
  const actions = [];
  const login = new PddLogin({
    eval: async code => code === LOGIN_STATE ? state : (actions.push('logout-attempt'), false),
    fill: async () => assert.fail('must not fill before logout'),
    wait: async check => check()
  }, async () => 'isolated-password');
  await assert.rejects(login.run(shop, 'relogin'), /未能唯一找到退出账号入口/);
  assert.deepEqual(actions, ['logout-attempt']);
});

test('explicit relogin retains the user-requested logout and login behavior', async () => {
  const f = fixture(readState(`${shop.name}\n${shop.account}\n退出当前账号`, null));
  await f.login.run(shop, 'relogin');
  assert.equal(f.calls[0], 'logout');
  assert.equal(f.decrypts(), 1);
});

test('post-submit identity failures distinguish a different shop from a different account', async () => {
  for (const [state, message] of [
    [readState('其他店铺\n其他店铺:运营\n退出当前账号', null), /店铺名称与保存的.*不一致/],
    [readState(`${shop.name}\n${shop.name}:其他账号\n退出当前账号`, null), /店铺名称已匹配.*登录账号.*不一致/]
  ]) {
    const f = fixture({}, state);
    await assert.rejects(f.login.run(shop), error => message.test(error.message));
    assert.equal(f.calls.filter(value => value === 'submit-login').length, 1);
    assert.equal(f.calls.includes('logout'), false);
  }
});

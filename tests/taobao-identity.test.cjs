/**
 * 这里只覆盖「分类分支」：密码错误、滑块验证码、非淘宝域名等状态无法在真实账号上
 * 按需复现，CI 里也没有浏览器。真实页面的验收不靠本文件，而是靠
 * verification/taobao-20261006/verify-login.cjs 直接在千牛登录页和工作台上跑的只读核对。
 * 本文件的 DOM 桩只提供 TAOBAO_LOGIN_STATE 真正读取的字段，不模拟页面行为。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  TAOBAO_LOGIN_STATE,
  matchesTaobaoIdentity,
  shopIdentityMessage,
  subAccountOf,
  taobaoIdentityProblem,
} = require('../dist-electron/electron/platforms/taobao-identity.js');

/** 最小 DOM 桩：只提供 TAOBAO_LOGIN_STATE 真正读取的字段。 */
function element(options = {}) {
  const node = {
    children: options.children || [],
    textContent: options.text || '',
    innerText: options.text || '',
    getAttribute: (name) => (name === 'title' ? (options.title ?? null) : null),
    getClientRects: () => (options.visible === false ? [] : [{}]),
    querySelectorAll: () => node.children,
  };
  return node;
}
function readState({
  hostname,
  body = '',
  bySelector = {},
  roots = [],
  shopNameNodes,
  errors = [],
}) {
  const document = {
    querySelector: (selector) => bySelector[selector] || null,
    querySelectorAll: (selector) => {
      if (selector.includes('login-error')) return errors;
      if (selector.startsWith('[class*=shopName]')) return shopNameNodes ?? roots;
      return roots;
    },
    body: { innerText: body },
  };
  return JSON.parse(
    JSON.stringify(
      vm.runInNewContext(TAOBAO_LOGIN_STATE, {
        document,
        location: { hostname, origin: `https://${hostname}`, pathname: '/' },
        getComputedStyle: () => ({ visibility: 'visible' }),
      }),
    ),
  );
}

test('千牛登录页识别为登录页并读到密码表单', () => {
  const state = readState({
    hostname: 'havanalogin.taobao.com',
    bySelector: { '#fm-login-id': element(), '#fm-login-password': element() },
  });
  assert.equal(state.trusted, true);
  assert.equal(state.loginPage, true);
  assert.equal(state.form, true);
  assert.equal(state.leftLogin, false);
  assert.equal(state.rejected, false);
  assert.equal(state.challenge, false);
  assert.equal(state.structure.workbenchHost, false);
});

test('千牛工作台读到店铺名称才算已离开登录页', () => {
  const state = readState({
    hostname: 'myseller.taobao.com',
    roots: [element({ text: 'Mandla旗舰店' })],
  });
  assert.equal(state.trusted, true);
  assert.equal(state.loginPage, false);
  assert.equal(state.form, false);
  assert.equal(state.leftLogin, true);
  assert.ok(state.names.includes('Mandla旗舰店'));
  assert.deepEqual(state.shopNames, ['Mandla旗舰店']);
  assert.equal(state.structure.workbenchHost, true);
  assert.equal(state.structure.shopNameCount, 1);
});

test('有专门的店铺名称元素时，页头其他文字不会被当成店铺名', () => {
  // 页头出现与店铺名同名的无关文字，但专门的店铺名称元素给出的是另一个店铺。
  const state = readState({
    hostname: 'myseller.taobao.com',
    roots: [element({ text: 'Mandla旗舰店' }), element({ text: '商家日历' })],
    shopNameNodes: [element({ text: '其他店铺' })],
  });
  assert.equal(state.leftLogin, true);
  assert.deepEqual(state.shopNames, ['其他店铺']);
  assert.equal(
    matchesTaobaoIdentity(state.names, { name: 'Mandla旗舰店', account: 'x' }, state.shopNames),
    false,
  );
  assert.match(
    taobaoIdentityProblem(state.names, { name: 'Mandla旗舰店', account: 'x' }, state.shopNames),
    /不一致/,
  );
});

test('工作台上的滑块或验证码提示不算登录完成', () => {
  const challengeState = readState({
    hostname: 'myseller.taobao.com',
    roots: [element({ text: 'Mandla旗舰店' })],
    bySelector: { '.nc_wrapper': element() },
  });
  assert.equal(challengeState.challenge, true);
  assert.equal(challengeState.leftLogin, false);

  const textState = readState({
    hostname: 'myseller.taobao.com',
    body: '请完成安全验证',
    roots: [element({ text: 'Mandla旗舰店' })],
  });
  assert.equal(textState.challenge, true);
  assert.equal(textState.leftLogin, false);
});

test('登录页错误提示识别为账号密码被拒绝', () => {
  const state = readState({
    hostname: 'havanalogin.taobao.com',
    bySelector: { '#fm-login-id': element(), '#fm-login-password': element() },
    errors: [element({ text: '账号或密码错误' })],
  });
  assert.equal(state.rejected, true);
  assert.equal(state.leftLogin, false);
});

test('非淘宝域名不受信任，脚本不读取页面', () => {
  const state = readState({
    hostname: 'www.baidu.com',
    roots: [element({ text: 'Mandla旗舰店' })],
  });
  assert.equal(state.trusted, false);
  assert.deepEqual(state.names, []);
  assert.equal(state.loginPage, false);
  assert.equal(state.leftLogin, false);
});

test('店铺身份以名称为准，子账号格式才要求账号出现', () => {
  const shop = { name: 'Mandla旗舰店', account: 'mandla_member' };
  assert.equal(matchesTaobaoIdentity(['Mandla旗舰店'], shop), true);
  assert.equal(matchesTaobaoIdentity(['Mandla旗舰店', 'mandla_member'], shop), true);
  assert.equal(matchesTaobaoIdentity(['其他店铺'], shop), false);
  assert.equal(matchesTaobaoIdentity([], shop), false);
  // 有专门的店铺名称元素时只信它。
  assert.equal(matchesTaobaoIdentity(['Mandla旗舰店'], shop, ['其他店铺']), false);
  assert.equal(matchesTaobaoIdentity(['其他店铺'], shop, ['Mandla旗舰店']), true);

  const sub = { name: 'Mandla旗舰店', account: 'Mandla旗舰店:运营小秘' };
  assert.equal(matchesTaobaoIdentity(['Mandla旗舰店'], sub), false);
  assert.equal(matchesTaobaoIdentity(['Mandla旗舰店', '运营小秘'], sub), true);
  assert.equal(matchesTaobaoIdentity(['运营小秘'], sub, ['Mandla旗舰店']), true);
  // 子账号名必须来自工作台文本，专门的店铺名称元素不能替代它。
  assert.equal(matchesTaobaoIdentity([], sub, ['Mandla旗舰店']), false);
  assert.equal(subAccountOf('Mandla旗舰店：运营小秘'), '运营小秘');
  assert.equal(subAccountOf('mandla_member'), '');
});

test('身份不符时的提示区分未读取、仅大小写不同和不一致', () => {
  const shop = { name: 'Mandla旗舰店', account: 'mandla_member' };
  assert.match(taobaoIdentityProblem([], shop), /未读取到店铺名称/);
  assert.match(taobaoIdentityProblem(['mandla旗舰店'], shop), /仅大小写不同/);
  assert.match(taobaoIdentityProblem(['其他店铺'], shop), /不一致/);
  assert.equal(taobaoIdentityProblem(['Mandla旗舰店'], shop), '');
  assert.match(
    taobaoIdentityProblem(['Mandla旗舰店'], { name: 'Mandla旗舰店', account: '店:运营' }),
    /未读取到子账号/,
  );
  assert.equal(shopIdentityMessage(shop), '已核对千牛后台店铺：Mandla旗舰店');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  accountKey,
  accountKind,
  derivableShopName,
  normalizePddAccount,
} = require('../dist-electron/src/shop-account.js');
const { Store } = require('../dist-electron/electron/store.js');
const { ShopService } = require('../dist-electron/electron/shop-service.js');

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goods-shop-account-'));
  const store = await Store.open(directory);
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const service = new ShopService(
    store,
    async (password) => `cipher:${password}`,
    () => false,
  );
  return { store, service };
}

test('归一化只抹平确定安全的差异：全角、零宽、尾部真实姓名', () => {
  assert.equal(normalizePddAccount('邓禄普：珠珠（王玮珠） '), '邓禄普:珠珠');
  assert.equal(normalizePddAccount('  邓禄普 : 珠珠  '), '邓禄普:珠珠');
  assert.equal(normalizePddAccount('邓禄普:珠珠(王玮珠)(客服)'), '邓禄普:珠珠');
  assert.equal(normalizePddAccount('ＡＢＣ１２３'), 'ABC123');
  assert.equal(normalizePddAccount('店\u200b铺\u00a0甲:运营'), '店铺 甲:运营');
  // 中文与其它文字不做折叠，避免把两个不同账号合并。
  assert.equal(normalizePddAccount('㈱商店:运营'), '㈱商店:运营');
});

test('账号形态识别区分主账号与子账号', () => {
  assert.equal(accountKind('邓禄普:珠珠'), 'main:sub');
  assert.equal(accountKind('13812345678'), 'mobile');
  assert.equal(accountKind('＋86 138 1234 5678'), 'mobile');
  assert.equal(accountKind('190551753'), 'numeric-id');
  assert.equal(accountKind('ops@example.com'), 'email');
  assert.equal(accountKind('demo_operator_local'), 'plain');
  assert.equal(accountKind('   '), 'plain');
});

test('只有像店名的前半段才允许推导店铺名称', () => {
  assert.equal(derivableShopName('日用生活馆:运营账号'), '日用生活馆');
  assert.equal(derivableShopName('邓禄普：珠珠'), '邓禄普');
  // 主账号是手机号、数字 ID、邮箱时，前半段是账号名而不是店名。
  assert.equal(derivableShopName('13812345678:店长'), '');
  assert.equal(derivableShopName('190551753:店长'), '');
  assert.equal(derivableShopName('ops@example.com:店长'), '');
  assert.equal(derivableShopName('demo_operator'), '');
  assert.equal(derivableShopName(':运营账号'), '');
});

test('去重键把同一账号的不同写法折叠成一把钥匙', () => {
  assert.equal(accountKey('邓禄普：珠珠（王玮珠）'), accountKey('邓禄普:珠珠'));
  assert.equal(accountKey('Mandla旗舰店:Ops'), accountKey('mandla旗舰店:ops'));
  assert.notEqual(accountKey('邓禄普:珠珠'), accountKey('邓禄普:阿珍'));
});

test('保存店铺时归一化账号，并保留手填的店铺名称', async (t) => {
  const { store, service } = await fixture(t);
  const shop = await service.save({
    name: '邓禄普黑豆专卖店',
    account: ' 邓禄普：珠珠（王玮珠） ',
    password: 'isolated-password',
  });
  assert.equal(shop.account, '邓禄普:珠珠');
  assert.equal(shop.name, '邓禄普黑豆专卖店');
  assert.equal(store.secret(shop.id), 'cipher:isolated-password');
});

test('同一账号的其它写法不能重复保存', async (t) => {
  const { service } = await fixture(t);
  await service.save({
    name: '邓禄普黑豆专卖店',
    account: '邓禄普:珠珠',
    password: 'isolated-password',
  });
  await assert.rejects(
    () =>
      service.save({
        name: '邓禄普黑豆专卖店',
        account: '邓禄普：珠珠（王玮珠）',
        password: 'isolated-password',
      }),
    /该账号已保存/,
  );
});

test('编辑时只改写法视为同一账号，可以留空沿用原密码', async (t) => {
  const { store, service } = await fixture(t);
  const saved = await service.save({
    name: '邓禄普黑豆专卖店',
    account: '邓禄普:珠珠',
    password: 'isolated-password',
  });
  const edited = await service.save({
    id: saved.id,
    name: '邓禄普黑豆专卖店',
    account: '邓禄普：珠珠（王玮珠）',
    password: '',
  });
  assert.equal(edited.id, saved.id);
  assert.equal(edited.account, '邓禄普:珠珠');
  assert.equal(store.secret(saved.id), 'cipher:isolated-password');
});

test('掩码账号不允许保存，主账号需要手填店铺名称', async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(
    () =>
      service.save({
        name: '邓禄普黑豆专卖店',
        account: '邓*普:珠*',
        password: 'isolated-password',
      }),
    /掩码/,
  );
  await assert.rejects(
    () => service.save({ name: '', account: '13812345678', password: 'isolated-password' }),
    /请填写与后台一致的店铺名称/,
  );
  const shop = await service.save({
    name: '邓禄普黑豆专卖店',
    account: '13812345678',
    password: 'isolated-password',
  });
  assert.equal(shop.account, '13812345678');
  assert.equal(shop.name, '邓禄普黑豆专卖店');
});

test('后台绑定只在账号未变时保留，换账号立刻作废', async (t) => {
  const { store, service } = await fixture(t);
  const saved = await service.save({
    name: '邓禄普黑豆专卖店',
    account: '邓禄普:珠珠',
    password: 'isolated-password',
  });
  const bound = store.bindShopIdentity(saved.id, { mallId: 549046886, userId: 190551753 });
  assert.equal(bound.mallId, 549046886);
  assert.equal(bound.userId, 190551753);
  // 绑定只是核对用的元数据：不改 updatedAt，也不算店铺资料被改过。
  assert.equal(bound.updatedAt, saved.updatedAt);
  // 同一账号换一种写法保存：绑定继续有效。
  const same = await service.save({
    id: saved.id,
    name: '邓禄普黑豆专卖店',
    account: '邓禄普：珠珠（王玮珠）',
    password: '',
  });
  assert.equal(same.account, '邓禄普:珠珠');
  assert.equal(same.mallId, 549046886);
  assert.equal(same.userId, 190551753);
  assert.ok(same.boundAt);
  // 换成另一个子账号：旧绑定必须作废，否则新账号第一次核对就被「绑定不一致」拦住。
  const other = await service.save({
    id: saved.id,
    name: '邓禄普黑豆专卖店',
    account: '邓禄普:阿珍',
    password: 'another-password',
  });
  assert.equal(other.mallId, undefined);
  assert.equal(other.userId, undefined);
  assert.equal(other.accountKind, 'main:sub');
  const stored = store.all('shops').find((shop) => shop.id === saved.id);
  assert.equal(stored.mallId, undefined);
  assert.equal(stored.userId, undefined);
});

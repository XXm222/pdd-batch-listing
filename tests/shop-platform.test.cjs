const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../dist-electron/electron/store.js');
const { ShopService } = require('../dist-electron/electron/shop-service.js');

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goods-shop-platform-'));
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

test('新增拼多多店铺：未传平台时按默认平台保存手填店铺名称', async (t) => {
  const { store, service } = await fixture(t);
  const shop = await service.save({
    name: '日用生活馆旗舰店',
    account: ' 日用生活馆:运营账号 ',
    password: 'isolated-password',
  });
  assert.equal(shop.platform, 'pdd');
  assert.equal(shop.name, '日用生活馆旗舰店');
  assert.equal(shop.account, '日用生活馆:运营账号');
  assert.equal(store.secret(shop.id), 'cipher:isolated-password');
  assert.equal(store.all('shops')[0].platform, 'pdd');
});

test('淘宝已开放：可以新增淘宝店铺，平台字段原样保存', async (t) => {
  const { store, service } = await fixture(t);
  await service.save({
    name: 'Mandla旗舰店',
    account: 'mandla_member',
    password: 'isolated-password',
    platform: 'taobao',
  });
  const shops = store.all('shops');
  assert.equal(shops.length, 1);
  assert.equal(shops[0].platform, 'taobao');
});

test('旧淘宝店铺可读；改名后平台与账号密码不被重置', async (t) => {
  const { store, service } = await fixture(t);
  const saved = {
    id: require('node:crypto').randomUUID(),
    name: 'Mandla旗舰店',
    account: 'mandla_member',
    platform: 'taobao',
    credentialsSaved: true,
    updatedAt: '2026-10-06T00:00:00.000Z',
  };
  store.saveShop(saved, 'isolated-saved-secret');
  await service.save({
    id: saved.id,
    name: 'Mandla旗舰店（新名）',
    account: saved.account,
    password: '',
  });
  const [after] = store.all('shops');
  assert.equal(after.name, 'Mandla旗舰店（新名）');
  assert.equal(after.platform, 'taobao', '改名不能把平台重置成拼多多');
  assert.equal(store.secret(saved.id), 'isolated-saved-secret', '空密码不改已有凭据');
});

test('非法平台字段被拒绝，账号重复仍然阻止保存', async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(
    () =>
      service.save({
        name: '店铺',
        account: 'account-a',
        password: 'isolated-password',
        platform: 'jd',
      }),
    /店铺平台不正确/,
  );
  await service.save({
    name: '店铺甲',
    account: '店铺甲:运营账号',
    password: 'isolated-password',
  });
  await assert.rejects(
    () =>
      service.save({ name: '店铺乙', account: '店铺甲:运营账号', password: 'isolated-password' }),
    /该账号已保存/,
  );
});

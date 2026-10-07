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

test('新增拼多多店铺：未传平台时按默认平台保存，店铺名称由账号推导', async (t) => {
  const { store, service } = await fixture(t);
  const shop = await service.save({
    name: '',
    account: ' 日用生活馆:运营账号 ',
    password: 'isolated-password',
  });
  assert.equal(shop.platform, 'pdd');
  assert.equal(shop.name, '日用生活馆');
  assert.equal(shop.account, '日用生活馆:运营账号');
  assert.equal(store.secret(shop.id), 'cipher:isolated-password');
  assert.equal(store.all('shops')[0].platform, 'pdd');
});

test('禁用淘宝后不能新增店铺，已有店铺资料不受影响', async (t) => {
  const { store, service } = await fixture(t);
  await assert.rejects(
    () =>
      service.save({
        name: 'Mandla旗舰店',
        account: 'mandla_member',
        password: 'isolated-password',
        platform: 'taobao',
      }),
    /淘宝暂未开放/,
  );
  assert.deepEqual(store.all('shops'), []);
});

test('旧淘宝店铺仍可读，修改被拒绝时不会重置平台或账号密码', async (t) => {
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
  await assert.rejects(
    () =>
      service.save({
        id: saved.id,
        name: 'Mandla旗舰店（新名）',
        account: saved.account,
        password: '',
      }),
    /淘宝暂未开放/,
  );
  assert.deepEqual(store.all('shops'), [saved]);
  assert.equal(store.secret(saved.id), 'isolated-saved-secret');
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
    name: '',
    account: '店铺甲:运营账号',
    password: 'isolated-password',
  });
  await assert.rejects(
    () => service.save({ name: '', account: '店铺甲:运营账号', password: 'isolated-password' }),
    /该账号已保存/,
  );
});

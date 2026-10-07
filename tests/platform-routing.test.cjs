const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Store } = require('../dist-electron/electron/store.js');
const { prepareTasks, TaskRunner } = require('../dist-electron/electron/task-runner.js');
const { PlatformRegistry } = require('../dist-electron/electron/platforms/registry.js');
const { newProduct, problems } = require('../dist-electron/src/domain.js');
const { platformMeta } = require('../dist-electron/src/platforms.js');
const { BrowserBridge } = require('../dist-electron/electron/browser-bridge.js');
const {
  TAOBAO_LOGIN_URL,
  TAOBAO_WORKBENCH,
} = require('../dist-electron/electron/platforms/taobao-login.js');

const savedAt = '2026-10-01T01:00:00.000Z';

function product(code = 'PLATFORM-001') {
  const p = {
    ...newProduct(code, '可折叠泡脚桶'),
    category: '家居日用 > 沐浴桶/沐浴盆',
    brand: '无品牌',
    reference: '100',
    shipping: '48小时发货及揽收',
    freight: '默认运费模板',
    savedAt,
    skus: [{ spec: '默认规格', group: '29.90', single: '39.90', stock: '10' }],
    main: ['主图.png'],
    images: {
      '主图.png': {
        id: 'b'.repeat(64),
        name: '主图.png',
        url: `media://asset/${'b'.repeat(64)}`,
        bytes: 1024,
        width: 600,
        height: 600,
      },
    },
  };
  assert.deepEqual(problems(p), [], '隔离资料必须通过实际商品校验');
  return p;
}

function shopFor(platform) {
  return {
    id: randomUUID(),
    name: platform === 'taobao' ? 'Mandla旗舰店' : '隔离店铺',
    account: platform === 'taobao' ? 'mandla_member' : '隔离店铺:运营',
    credentialsSaved: true,
    updatedAt: savedAt,
    platform,
  };
}

async function fixture(t, platform = 'pdd') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goods-platform-routing-'));
  const store = await Store.open(directory);
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const shop = shopFor(platform);
  const products = [product()];
  store.saveShop(shop, 'isolated-test-secret');
  store.saveProducts(products);
  return { directory, store, shop, products };
}

const readTask = (store, id) => store.all('tasks').find((task) => task.id === id);
const input = ({ shop, products }) => ({ shopId: shop.id, productIds: products.map((p) => p.id) });

test('适配器注册表按店铺平台分发，未知或缺失平台回落到拼多多', () => {
  const registry = new PlatformRegistry('/isolated', async () => 'isolated-password');
  const pdd = registry.of('pdd');
  assert.throws(() => registry.of('taobao'), /淘宝暂未开放/);
  assert.equal(registry.of(undefined).id, 'pdd');
  assert.equal(registry.of('jd').id, 'pdd');
  assert.throws(() => registry.adapterFor({ platform: 'taobao' }), /淘宝暂未开放/);
  assert.equal(registry.adapterFor({ platform: 'pdd' }), pdd.adapter);
  assert.equal(registry.adapterFor({}), pdd.adapter);
  assert.equal(pdd.portal, platformMeta('pdd').portal);
});

test('拼多多任务正常建立；淘宝禁用后不建立任务或更改已有店铺', async (t) => {
  const pdd = await fixture(t, 'pdd');
  const ids = prepareTasks(pdd.store, input(pdd));
  const created = readTask(pdd.store, ids[0]);
  assert.equal(created.platform, 'pdd');
  assert.equal(created.shopSnapshot.platform, 'pdd');

  const taobao = await fixture(t, 'taobao');
  const before = taobao.store.all('shops');
  assert.throws(() => prepareTasks(taobao.store, input(taobao)), /淘宝暂未开放/);
  assert.equal(taobao.store.all('tasks').length, 0);
  assert.deepEqual(taobao.store.all('shops'), before);
  const archived = { ...pdd.products[0], templateFormat: '淘宝运营模板 v4' };
  assert.deepEqual(problems(archived), []);
  pdd.store.saveProducts([archived]);
  assert.throws(() => prepareTasks(pdd.store, input(pdd)), /淘宝暂未开放/);
  assert.equal(pdd.store.all('tasks').length, 1, '不允许把淘宝资料投到拼多多店铺');
  // 升级前保存的淘宝任务也不能经继续执行启动浏览器。
  const oldTask = {
    ...created,
    id: randomUUID(),
    shopId: taobao.shop.id,
    platform: 'taobao',
    shopSnapshot: { ...created.shopSnapshot, platform: 'taobao' },
  };
  taobao.store.saveTasks([oldTask]);
  const runner = new TaskRunner(taobao.store, taobao.directory, () => {
    throw Error('不应调用适配器');
  });
  assert.throws(() => runner.start([oldTask.id]), /淘宝暂未开放/);
  assert.equal(runner.isActive, false);
  assert.deepEqual(readTask(taobao.store, oldTask.id), oldTask);
});

test('任务记录的平台与店铺当前平台不一致时停止执行，不投到另一个后台', async (t) => {
  const f = await fixture(t, 'pdd');
  fs.mkdirSync(path.join(f.directory, 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(f.directory, 'assets', f.products[0].images['主图.png'].id),
    'isolated asset',
  );
  const ids = prepareTasks(f.store, input(f));
  // 模拟店铺平台被改成淘宝（旧资料或人工改动）。
  f.store.saveShop({ ...f.shop, platform: 'taobao' }, 'isolated-test-secret');
  const seen = [];
  const runner = new TaskRunner(f.store, f.directory, (shop) => {
    seen.push(shop.platform);
    return { execute: async () => {} };
  });
  const done = new Promise((resolve) =>
    f.store.onTaskChanged((task) => {
      if (task.id === ids[0] && task.completedAt) resolve();
    }),
  );
  runner.start(ids);
  await done;
  const task = readTask(f.store, ids[0]);
  assert.equal(seen.length, 0, '平台不一致时不应调用任何适配器');
  assert.equal(task.error.code, 'shop_changed');
  assert.match(task.error.message, /当前店铺已改为淘宝/);
});

test('确认任务店铺不能把任务改投到另一个平台', async (t) => {
  const f = await fixture(t, 'pdd');
  fs.mkdirSync(path.join(f.directory, 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(f.directory, 'assets', f.products[0].images['主图.png'].id),
    'isolated asset',
  );
  const ids = prepareTasks(f.store, input(f));
  f.store.saveShop({ ...f.shop, platform: 'taobao' }, 'isolated-test-secret');
  const runner = new TaskRunner(f.store, f.directory, () => ({ execute: async () => {} }));
  assert.throws(() => runner.confirmShop(ids[0]), /请新增店铺后重新建立任务/);
  const task = readTask(f.store, ids[0]);
  assert.equal(task.platform, 'pdd');
  assert.equal(task.shopSnapshot.platform, 'pdd');
  assert.equal(task.error, undefined);
});

test('淘宝连接信任登录页与工作台两个来源，其他来源一律拒绝', () => {
  const bridge = new BrowserBridge(TAOBAO_WORKBENCH, [
    TAOBAO_LOGIN_URL,
    'https://loginmyseller.taobao.com',
  ]);
  const tab = (url) => ({ success: true, tabId: 1, url });
  // 未登录时淘宝会把工作台重定向到登录来源，两个来源都必须被接受。
  assert.doesNotThrow(() => bridge.checkTab(tab(TAOBAO_WORKBENCH)));
  assert.doesNotThrow(() => bridge.checkTab(tab(TAOBAO_LOGIN_URL)));
  assert.doesNotThrow(() => bridge.checkTab(tab('https://loginmyseller.taobao.com/')));
  // 抓错标签页要立刻停止，不能把普通网页当成商家后台。
  assert.throws(
    () => bridge.checkTab(tab('https://www.taobao.com/')),
    /未能在已连接的浏览器中打开目标商家后台/,
  );
  assert.throws(() => bridge.checkTab(tab('https://mms.pinduoduo.com/home/')), /目标商家后台/);
  assert.throws(
    () => bridge.checkTab({ success: false, tabId: 1, url: TAOBAO_WORKBENCH }),
    /目标商家后台/,
  );
  assert.throws(
    () => new BrowserBridge(TAOBAO_WORKBENCH, ['http://loginmyseller.taobao.com']),
    /HTTPS/,
  );
});

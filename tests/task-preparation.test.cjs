const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Store } = require('../dist-electron/electron/store.js');
const { prepareTasks, TaskRunner } = require('../dist-electron/electron/task-runner.js');
const { newProduct, problems } = require('../dist-electron/src/domain.js');

const savedAt = '2026-10-01T01:00:00.000Z';

function product(code = 'REPEAT-001') {
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
        id: 'a'.repeat(64),
        name: '主图.png',
        url: `media://asset/${'a'.repeat(64)}`,
        bytes: 1024,
        width: 600,
        height: 600,
      },
    },
  };
  assert.deepEqual(problems(p), [], '隔离资料必须通过实际商品校验');
  return p;
}

async function fixture(t, codes = ['REPEAT-001']) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goods-task-preparation-'));
  const store = await Store.open(directory);
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const shop = {
    id: randomUUID(),
    name: '隔离店铺',
    account: '隔离店铺:运营',
    credentialsSaved: true,
    updatedAt: savedAt,
  };
  const products = codes.map(product);
  store.saveShop(shop, 'isolated-test-secret');
  store.saveProducts(products);
  return { directory, store, shop, products };
}

function taskFor(p, shop, overrides = {}) {
  return {
    id: randomUUID(),
    shopId: shop.id,
    shopName: shop.name,
    shopSnapshot: { name: shop.name, account: shop.account, updatedAt: shop.updatedAt },
    code: p.code,
    title: p.title,
    status: 'failed',
    time: savedAt,
    productSnapshot: structuredClone(p),
    revision: 4,
    ...overrides,
  };
}

function succeededTask(p, shop) {
  return taskFor(p, shop, {
    status: 'succeeded',
    goodsId: '1010000000001',
    formUrl: 'https://mms.pinduoduo.com/goods/goods_add/index?goods_id=1010000000001',
    saveAttemptedAt: savedAt,
    result: {
      goodsId: '1010000000001',
      status: '草稿',
      shopName: shop.name,
      title: p.title,
      verifiedAt: savedAt,
    },
    logs: [{ time: savedAt, message: '原草稿已核对' }],
    timings: [
      {
        name: '保存草稿',
        attempt: 2,
        startedAt: savedAt,
        endedAt: savedAt,
        durationMs: 5,
        status: 'done',
      },
    ],
    backendChecks: [{ key: 'skus', label: '规格', status: 'passed', message: '原规格已核对' }],
    evidence: '/isolated/original-evidence.png',
    startedAt: savedAt,
    completedAt: savedAt,
    attempt: 2,
    runElapsedMs: 5,
    checkpoint: { step: 'draft_list', state: 'done', updatedAt: savedAt },
    uploadManifest: { goodsId: '1010000000001', main: ['original-image'], detail: [] },
    previousGoodsIds: ['1010000000000'],
    agentDiagnosis: { id: 'old-diagnosis', status: 'done', summary: '历史处理结果' },
    automaticDiagnosisAttempt: 1,
    autoRecoveryCount: 1,
  });
}

const inputFor = ({ shop, products }) => ({
  shopId: shop.id,
  productIds: products.map((p) => p.id),
});
const readTask = (store, id) => store.all('tasks').find((task) => task.id === id);
const browserForbidden = {
  execute: async () => {
    throw new Error('本文件不允许操作浏览器');
  },
};

test('成功历史即使有保存标记，也可新建；原记录完全保留，新任务不继承执行状态', async (t) => {
  const f = await fixture(t);
  const old = succeededTask(f.products[0], f.shop);
  f.store.saveTasks([old]);
  const before = readTask(f.store, old.id);
  const ids = prepareTasks(f.store, inputFor(f));
  assert.equal(ids.length, 1);
  assert.notEqual(ids[0], old.id);
  const created = readTask(f.store, ids[0]);
  assert.equal(created.status, 'prepared');
  assert.equal(created.revision, 0);
  assert.deepEqual(created.productSnapshot, f.products[0]);
  assert.deepEqual(created.shopSnapshot, old.shopSnapshot);
  for (const key of [
    'goodsId',
    'formUrl',
    'saveAttemptedAt',
    'result',
    'logs',
    'timings',
    'evidence',
    'startedAt',
    'completedAt',
    'attempt',
    'runElapsedMs',
    'checkpoint',
    'uploadManifest',
    'previousGoodsIds',
    'agentDiagnosis',
    'automaticDiagnosisAttempt',
    'autoRecoveryCount',
  ])
    assert.equal(Object.hasOwn(created, key), false, `新任务不应继承 ${key}`);
  assert.ok(created.backendChecks.length > 0);
  assert.ok(
    created.backendChecks.every((check) => ['pending', 'not_checked'].includes(check.status)),
  );
  assert.deepEqual(readTask(f.store, old.id), before, '成功历史的每个字段必须原样保留');
  assert.equal(f.store.all('tasks').length, 2);
});

test('未尝试保存的失败历史不阻止重新执行', async (t) => {
  const f = await fixture(t);
  const old = taskFor(f.products[0], f.shop, {
    error: { code: 'invalid_product', recovery: 'edit_product', message: '旧资料不完整' },
  });
  f.store.saveTasks([old]);
  const ids = prepareTasks(f.store, inputFor(f));
  assert.equal(ids.length, 1);
  assert.notEqual(ids[0], old.id);
  assert.deepEqual(readTask(f.store, old.id), old);
});

const historyCases = [
  ['尚未开始', { status: 'prepared' }],
  ['等待处理', { status: 'awaiting_user' }],
  ['保存不确定', { status: 'uncertain', goodsId: '1010000000123', saveAttemptedAt: savedAt }],
  ['失败但尝试过保存', { status: 'failed', saveAttemptedAt: savedAt }],
  ['已清理', { status: 'awaiting_user', clearedAt: savedAt }],
];
for (const [name, overrides] of historyCases) {
  test(`${name}的历史不阻止独立的新执行，原状态与草稿编号保留`, async (t) => {
    const f = await fixture(t);
    const old = taskFor(f.products[0], f.shop, overrides);
    f.store.saveTasks([old]);
    const ids = prepareTasks(f.store, inputFor(f));
    assert.equal(ids.length, 1);
    const created = readTask(f.store, ids[0]);
    assert.notEqual(created.id, old.id);
    assert.equal(created.status, 'prepared');
    assert.equal(created.goodsId, undefined);
    assert.equal(created.saveAttemptedAt, undefined);
    assert.equal(created.clearedAt, undefined);
    assert.deepEqual(readTask(f.store, old.id), old);
  });
}

const blockedCases = [
  ['正在执行', { status: 'running' }, /正在执行/],
  [
    '成功记录仍在运行 Agent',
    { status: 'succeeded', agentDiagnosis: { status: 'running' } },
    /Agent 正在处理/,
  ],
  [
    '失败记录仍在运行 Agent',
    { status: 'failed', agentDiagnosis: { status: 'running' } },
    /Agent 正在处理/,
  ],
];

for (const [name, overrides, message] of blockedCases) {
  test(`${name}的原任务阻止重复创建，数据库保持不变`, async (t) => {
    const f = await fixture(t);
    f.store.saveTasks([taskFor(f.products[0], f.shop, overrides)]);
    const before = f.store.all('tasks');
    assert.throws(() => prepareTasks(f.store, inputFor(f)), message);
    assert.deepEqual(f.store.all('tasks'), before);
  });
}

test('批次后面的商品正在执行时，前面的商品也不会部分写入', async (t) => {
  const f = await fixture(t, ['BATCH-FREE', 'BATCH-BLOCKED']);
  f.store.saveTasks([taskFor(f.products[1], f.shop, { status: 'running' })]);
  const before = f.store.all('tasks');
  assert.throws(() => prepareTasks(f.store, inputFor(f)), /BATCH-BLOCKED/);
  assert.deepEqual(f.store.all('tasks'), before);
});

test('存在待执行历史仍可再次选择相同商品，生成两个独立任务', async (t) => {
  const f = await fixture(t);
  const ids = prepareTasks(f.store, inputFor(f));
  const before = f.store.all('tasks');
  assert.equal(before[0].id, ids[0]);
  const repeated = prepareTasks(f.store, inputFor(f));
  assert.notEqual(repeated[0], ids[0]);
  assert.deepEqual(readTask(f.store, ids[0]), before[0]);
  assert.equal(f.store.all('tasks').length, 2);
});

test('其他店铺同编码和本店其他编码的待执行记录不阻止本次创建', async (t) => {
  const f = await fixture(t, ['CURRENT', 'OTHER']);
  const otherShop = { ...f.shop, id: randomUUID() };
  const unrelated = [
    taskFor(f.products[0], otherShop, { status: 'prepared' }),
    taskFor(f.products[1], f.shop, { status: 'prepared' }),
  ];
  f.store.saveTasks(unrelated);
  const ids = prepareTasks(f.store, { shopId: f.shop.id, productIds: [f.products[0].id] });
  assert.equal(ids.length, 1);
  assert.ok(unrelated.every((task) => !ids.includes(task.id)));
  for (const old of unrelated) assert.deepEqual(readTask(f.store, old.id), old);
});

test('更新原失败任务可排除自身，成功历史不阻止采用新版商品资料', async (t) => {
  const f = await fixture(t);
  const old = succeededTask(f.products[0], f.shop);
  const current = taskFor(f.products[0], f.shop, {
    error: { code: 'invalid_product', recovery: 'edit_product', message: '请修改资料' },
  });
  f.store.saveTasks([old, current]);
  const updatedProduct = {
    ...f.products[0],
    title: '新款可折叠泡脚桶',
    savedAt: '2026-10-04T01:00:00.000Z',
  };
  f.store.saveProducts([updatedProduct]);
  const runner = new TaskRunner(f.store, f.directory, browserForbidden);
  runner.updateProduct(current.id);
  const updated = readTask(f.store, current.id);
  assert.deepEqual(updated.productSnapshot, updatedProduct);
  assert.equal(updated.title, updatedProduct.title);
  assert.equal(updated.id, current.id);
  assert.equal(updated.status, current.status);
  assert.equal(updated.revision, current.revision + 1);
  assert.equal(updated.error, undefined);
  assert.deepEqual(readTask(f.store, old.id), old);
  assert.equal(f.store.all('tasks').length, 2);
});

for (const [name, overrides, message] of blockedCases) {
  test(`更新任务资料也受${name}的其他任务约束，失败时不修改快照`, async (t) => {
    const f = await fixture(t);
    const current = taskFor(f.products[0], f.shop);
    const blocker = taskFor(f.products[0], f.shop, overrides);
    f.store.saveTasks([current, blocker]);
    f.store.saveProducts([{ ...f.products[0], title: '修改后的泡脚桶' }]);
    const before = f.store.all('tasks');
    const runner = new TaskRunner(f.store, f.directory, browserForbidden);
    assert.throws(() => runner.updateProduct(current.id), message);
    assert.deepEqual(f.store.all('tasks'), before);
  });
}

for (const [name, overrides] of historyCases) {
  test(`更新原任务资料不受${name}的历史影响`, async (t) => {
    const f = await fixture(t);
    const current = taskFor(f.products[0], f.shop);
    const history = taskFor(f.products[0], f.shop, overrides);
    f.store.saveTasks([current, history]);
    const changed = { ...f.products[0], title: '已更新的泡脚桶' };
    f.store.saveProducts([changed]);
    new TaskRunner(f.store, f.directory, browserForbidden).updateProduct(current.id);
    assert.deepEqual(readTask(f.store, current.id).productSnapshot, changed);
    assert.deepEqual(readTask(f.store, history.id), history);
  });
}

test('单条与批量清理可持久化、恢复，完整保留商品店铺和草稿证据', async (t) => {
  const f = await fixture(t, ['CLEAR-001', 'CLEAR-002']);
  const history = [
    succeededTask(f.products[0], f.shop),
    taskFor(f.products[1], f.shop, {
      status: 'uncertain',
      goodsId: '1010000000002',
      saveAttemptedAt: savedAt,
      error: { code: 'save_uncertain', message: '保存响应超时', recovery: 'readback' },
    }),
  ];
  f.store.saveTasks(history);
  const productsBefore = f.store.all('products'),
    shopsBefore = f.store.all('shops');
  const events = [];
  f.store.onTaskChanged((task) => events.push(task));
  const runner = new TaskRunner(f.store, f.directory, browserForbidden);
  runner.clearRecords([history[0].id], true);
  runner.clearRecords(
    history.map((task) => task.id),
    true,
  );
  for (const original of history) {
    const cleaned = readTask(f.store, original.id);
    assert.ok(cleaned.clearedAt);
    assert.equal(cleaned.revision, original.revision + 1, '重复清理不改动原清理时间或版本');
    const { clearedAt, revision, ...contents } = cleaned;
    const { revision: oldRevision, ...expected } = original;
    assert.deepEqual(contents, expected, '清理只改变显示状态，结果与证据全部保留');
  }
  const reopened = await Store.open(f.directory);
  assert.ok(reopened.all('tasks').every((task) => task.clearedAt));
  reopened.close();
  assert.throws(() => runner.start([history[1].id]), /已清理/);
  runner.clearRecords(
    history.map((task) => task.id),
    false,
  );
  assert.equal(events.length, 4);
  assert.ok(events.slice(2).every((task) => task.clearedAt === null));
  for (const original of history) {
    const restored = readTask(f.store, original.id);
    assert.equal(restored.clearedAt, null);
    assert.equal(restored.revision, original.revision + 2);
    assert.equal(restored.goodsId, original.goodsId);
    assert.equal(restored.status, original.status);
  }
  assert.deepEqual(f.store.all('products'), productsBefore);
  assert.deepEqual(f.store.all('shops'), shopsBefore);
});

for (const overrides of [{ status: 'running' }, { agentDiagnosis: { status: 'running' } }]) {
  test(`批量包含活跃任务时整批拒绝清理：${JSON.stringify(overrides)}`, async (t) => {
    const f = await fixture(t);
    const stopped = succeededTask(f.products[0], f.shop);
    const active = taskFor(f.products[0], f.shop, overrides);
    f.store.saveTasks([stopped, active]);
    const before = f.store.all('tasks');
    assert.throws(
      () =>
        new TaskRunner(f.store, f.directory, browserForbidden).clearRecords(
          [stopped.id, active.id],
          true,
        ),
      /正在执行或诊断/,
    );
    assert.deepEqual(f.store.all('tasks'), before);
  });
}

test('无效记录选择不产生部分清理；空列表、重复ID和不存在ID均被拒绝', async (t) => {
  const f = await fixture(t);
  const history = succeededTask(f.products[0], f.shop);
  f.store.saveTasks([history]);
  for (const ids of [[], [history.id, history.id], [history.id, 'missing'], [history.id, 42]]) {
    assert.throws(() => f.store.setTasksCleared(ids, true), /请选择有效|记录已变化/);
    assert.deepEqual(readTask(f.store, history.id), history);
  }
});

test('运行中的队列保护尚未开始的后续商品，暂停请求也须等当前操作退出', async (t) => {
  const f = await fixture(t, ['QUEUE-001', 'QUEUE-002']);
  fs.mkdirSync(path.join(f.directory, 'assets'));
  fs.writeFileSync(
    path.join(f.directory, 'assets', f.products[0].images['主图.png'].id),
    'isolated asset',
  );
  const ids = prepareTasks(f.store, inputFor(f));
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  let completed;
  const done = new Promise((resolve) => {
    completed = resolve;
  });
  f.store.onTaskChanged((task) => {
    if (task.id === ids[0] && task.completedAt) completed();
  });
  const runner = new TaskRunner(f.store, f.directory, {
    execute: async (task, shop, context) => {
      await gate;
      context.patch({ status: 'succeeded' });
    },
  });
  runner.start(ids);
  assert.equal(runner.isActive, true);
  assert.equal(readTask(f.store, ids[1]).status, 'prepared');
  assert.throws(() => runner.clearRecords([ids[1]], true), /当前执行结束/);
  runner.stop();
  assert.throws(() => runner.clearRecords([ids[1]], true), /当前执行结束/);
  finish();
  await done;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.isActive, false);
  runner.clearRecords([ids[1]], true);
  assert.ok(readTask(f.store, ids[1]).clearedAt);
});

test('已清理的异常记录不允许 Agent 诊断或自动恢复', async (t) => {
  const { allowedActions, taskFingerprint } = require('../dist-electron/electron/agent-service.js');
  const f = await fixture(t);
  const history = taskFor(f.products[0], f.shop, {
    status: 'awaiting_user',
    error: { code: 'platform_changed', message: '页面变化', recovery: 'retry' },
  });
  assert.ok(allowedActions(history, true).includes('resume'));
  const cleared = { ...history, clearedAt: savedAt };
  assert.deepEqual(allowedActions(cleared, true), []);
  assert.notEqual(taskFingerprint(cleared), taskFingerprint(history));
});

test('规格错误的易读提示与完整诊断分别持久化，详情不会被500字截断', async (t) => {
  const { ExecutionError } = require('../dist-electron/electron/execution');
  const f = await fixture(t);
  fs.mkdirSync(path.join(f.directory, 'assets'));
  fs.writeFileSync(
    path.join(f.directory, 'assets', f.products[0].images['主图.png'].id),
    'isolated asset',
  );
  const ids = prepareTasks(f.store, inputFor(f));
  const details = {
    source: 'spec_confirmation',
    expected: { name: '容量', value: '30L' },
    observed: { controls: Array.from({ length: 20 }, (_, i) => ({ index: i, value: `规格${i}` })) },
  };
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  f.store.onTaskChanged((task) => {
    if (task.id === ids[0] && task.completedAt) finish();
  });
  const runner = new TaskRunner(f.store, f.directory, {
    execute: async () => {
      throw new ExecutionError(
        'platform_changed',
        '容量 / 30L 未确认',
        'inspect_form',
        true,
        details,
      );
    },
  });
  runner.start(ids);
  await done;
  await new Promise((resolve) => setImmediate(resolve));
  const task = readTask(f.store, ids[0]);
  assert.equal(task.error.message, '容量 / 30L 未确认');
  assert.deepEqual(task.error.details, details);
  assert.ok(task.logs.some((log) => log.message.includes('规格19')));
  assert.equal(task.saveAttemptedAt, undefined);
});

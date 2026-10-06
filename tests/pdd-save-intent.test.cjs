const test = require('node:test');
const assert = require('node:assert/strict');
const { PddAdapter } = require('../dist-electron/electron/platforms/pdd-adapter');
const { ExecutionError } = require('../dist-electron/electron/execution');

function fixture(options = {}) {
  const adapter = new PddAdapter('/unused', async () =>
    assert.fail('save flow must not decrypt credentials'),
  );
  const task = {
    id: 'original-task',
    goodsId: 'original-goods',
    productSnapshot: { category: '原类目' },
    formUrl: 'https://mms.pinduoduo.com/goods/goods_add/index?goods_id=original-goods',
  };
  const calls = [];
  let dispatched = false,
    readbacks = 0,
    paused = false;
  const save = { role: 'button', name: '保存草稿', ref: 'resolved-draft-button' };
  const publish = { role: 'button', name: '提交并上架', ref: 'must-never-click-publish' };
  adapter.bridge = {
    eval: async () => ({ id: task.goodsId, category: true, input: true }),
    async snapshot() {
      calls.push('snapshot');
      if (options.pauseAfterResolve) paused = true;
      if (dispatched) return { url: task.formUrl, tree: [{ name: '保存成功!' }] };
      return { url: options.url || task.formUrl, tree: options.buttons || [publish, save] };
    },
    async call(action, args) {
      assert.equal(action, 'click');
      assert.equal(args.selector, save.ref);
      assert.ok(task.saveAttemptedAt, 'save intent must be persisted before dispatch');
      calls.push(['dispatch', args.selector]);
      dispatched = true;
      if (options.dispatchError) throw new Error('connection lost after dispatch');
    },
    async clickName(role, name) {
      assert.equal(role, 'button');
      assert.equal(name, '确定', 'draft dispatch must use its already resolved ref');
      calls.push('acknowledge');
    },
    async wait(check) {
      if (options.confirmationTimeout)
        throw new ExecutionError('page_timeout', 'save outcome unknown');
      const value = await check();
      assert.ok(value);
      return value;
    },
    async navigate() {
      assert.fail('save failure must not navigate away from the unsaved original page');
    },
  };
  adapter.images = async () => {};
  adapter.readback = async () => {
    readbacks++;
    calls.push('readback');
  };
  const context = {
    guard() {
      if (paused) throw new ExecutionError('paused', 'paused after resolving button');
    },
    patch(values) {
      calls.push(['patch', Object.keys(values)]);
      Object.assign(task, values);
    },
    async step(name, work) {
      if (name === '保存草稿并等待确认') return work();
    },
  };
  return {
    adapter,
    task,
    context,
    calls,
    options,
    save,
    publish,
    readbacks: () => readbacks,
    run: () => adapter.execute(task, {}, context),
  };
}

test('missing or ambiguous draft button never records save intent or clicks the publish button', async () => {
  for (const buttons of [
    [],
    [{ role: 'button', name: '提交并上架', ref: 'publish' }],
    [
      { role: 'button', name: '保存草稿', ref: 'one' },
      { role: 'button', name: '保存草稿', ref: 'two' },
    ],
  ]) {
    const f = fixture({ buttons });
    await assert.rejects(
      f.run(),
      (error) => error.code === 'platform_changed' && /尚未尝试保存/.test(error.message),
    );
    assert.equal(f.task.saveAttemptedAt, undefined);
    assert.equal(
      f.calls.some((call) => Array.isArray(call) && call[0] === 'dispatch'),
      false,
    );
    assert.equal(f.readbacks(), 0);
    assert.equal(f.task.goodsId, 'original-goods');
  }
});

test('a later retry can save the same original product after a pre-dispatch locator failure', async () => {
  const f = fixture({ buttons: [] });
  await assert.rejects(f.run(), /尚未尝试保存/);
  f.options.buttons = [f.publish, f.save];
  await f.run();
  assert.equal(f.calls.filter((call) => Array.isArray(call) && call[0] === 'dispatch').length, 1);
  assert.ok(f.task.saveAttemptedAt);
  assert.equal(f.readbacks(), 1);
  assert.equal(f.task.goodsId, 'original-goods');
  const dispatchIndex = f.calls.findIndex((call) => Array.isArray(call) && call[0] === 'dispatch');
  assert.deepEqual(
    f.calls[dispatchIndex - 1],
    ['patch', ['phase', 'saveAttemptedAt']],
    'no second lookup occurs between intent and dispatch',
  );
});

test('different goods ID or non-PDD page cannot receive save intent or a click', async () => {
  for (const url of [
    'https://mms.pinduoduo.com/goods/goods_add/index?goods_id=another-goods',
    'https://example.com/?goods_id=original-goods',
    'invalid',
  ]) {
    const f = fixture({ url });
    await assert.rejects(f.run(), /不是该任务的原商品/);
    assert.equal(f.task.saveAttemptedAt, undefined);
    assert.equal(f.readbacks(), 0);
  }
});

test('pause after locating the save button leaves the original form resumable without a save marker', async () => {
  const f = fixture({ pauseAfterResolve: true });
  await assert.rejects(f.run(), (error) => error.code === 'paused');
  assert.equal(f.task.saveAttemptedAt, undefined);
  assert.equal(f.readbacks(), 0);
});

test('uncertain dispatch or confirmation preserves save intent and a retry only reads back the original goods ID', async () => {
  for (const options of [{ dispatchError: true }, { confirmationTimeout: true }]) {
    const f = fixture(options);
    await assert.rejects(f.run(), /connection lost|save outcome unknown/);
    const marker = f.task.saveAttemptedAt;
    assert.ok(marker);
    await f.run();
    assert.equal(f.task.saveAttemptedAt, marker);
    assert.equal(f.task.goodsId, 'original-goods');
    assert.equal(f.calls.filter((call) => Array.isArray(call) && call[0] === 'dispatch').length, 1);
    assert.equal(f.readbacks(), 1);
  }
});

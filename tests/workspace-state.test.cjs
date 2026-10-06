const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeWorkspace, applyTaskUpdate } = require('../dist-electron/src/workspace-state');
const state = (tasks) => ({
  tasks,
  products: [],
  shops: [],
  version: '0.1.45',
  encryptionAvailable: false,
});
test('stale full loads cannot overwrite newer task events and snapshots remain attached', () => {
  const snapshot = { code: 'ORIGINAL' };
  const previous = state([
    { id: 'task', revision: 5, status: 'running', productSnapshot: snapshot },
  ]);
  const incoming = state([
    { id: 'task', revision: 2, status: 'prepared', productSnapshot: { code: 'OLD' } },
  ]);
  const result = mergeWorkspace(
    previous,
    incoming,
    new Map([['task', { id: 'task', revision: 6, status: 'succeeded' }]]),
  );
  assert.equal(result.tasks[0].revision, 6);
  assert.equal(result.tasks[0].status, 'succeeded');
  assert.equal(result.tasks[0].productSnapshot, snapshot);
  assert.equal(previous.tasks[0].status, 'running');
  assert.equal(mergeWorkspace(previous, state([]), new Map()).tasks.length, 0);
});
test('late or unknown task events do not resurrect records or rerender unchanged state', () => {
  const original = state([
    { id: 'task', revision: 5, status: 'succeeded', productSnapshot: { code: 'CODE' } },
  ]);
  for (const update of [
    { id: 'task', revision: 4, status: 'running' },
    { id: 'task', revision: 5, status: 'running' },
    { id: 'deleted', revision: 20 },
  ])
    assert.equal(applyTaskUpdate(original, update), original);
  const updated = applyTaskUpdate(original, { id: 'task', revision: 6, clearedAt: 'now' });
  assert.equal(updated.tasks[0].clearedAt, 'now');
  assert.equal(updated.tasks[0].productSnapshot, original.tasks[0].productSnapshot);
});

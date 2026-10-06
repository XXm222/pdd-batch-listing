const test = require('node:test');
const assert = require('node:assert/strict');
const {
  batchProgress,
  continuationIds,
  stepProgress,
  taskIsHistory,
} = require('../dist-electron/src/task-progress');
const task = (id, status, extra = {}) => ({ id, shopId: 'shop', status, ...extra });

test('homepage progress excludes unrelated history and retains the requested batch order', () => {
  const all = [
    task('old-failure', 'awaiting_user'),
    task('second', 'prepared'),
    task('first', 'running'),
  ];
  const result = batchProgress(all, ['first', 'second']);
  assert.deepEqual(
    result.tasks.map((t) => t.id),
    ['first', 'second'],
  );
  assert.equal(result.current.id, 'first');
  assert.equal(result.completed, 0);
});

test('second product automatically becomes current after first draft succeeds', () => {
  const result = batchProgress(
    [task('first', 'succeeded'), task('second', 'running')],
    ['first', 'second'],
  );
  assert.equal(result.current.id, 'second');
  assert.equal(result.completed, 1);
  assert.equal(result.finished, false);
});

test('a stopped batch shows its failed product and continues only that product and its pending successors', () => {
  const all = [
    task('first', 'succeeded'),
    task('second', 'awaiting_user'),
    task('third', 'prepared'),
    task('other', 'prepared', { shopId: 'other' }),
  ];
  const result = batchProgress(
    all,
    all.map((t) => t.id),
  );
  assert.equal(result.current.id, 'second');
  assert.deepEqual(continuationIds(result.tasks, result.current), ['second', 'third']);
  assert.deepEqual(continuationIds(result.tasks, all[0]), []);
});

test('only confirmed draft success counts as saved; interrupted or uncertain saves remain pending', () => {
  for (const status of ['uncertain', 'failed', 'awaiting_user', 'prepared']) {
    const result = batchProgress([task('a', 'succeeded'), task('b', status)], ['a', 'b']);
    assert.equal(result.completed, 1);
    assert.equal(result.finished, false);
  }
});

test('latest step attempt and automatic diagnosis are shown without promoting an older completed step', () => {
  const t = task('a', 'awaiting_user', {
    agentDiagnosis: { status: 'running' },
    timings: [
      { step: 'skus', attempt: 1, status: 'done' },
      { step: 'skus', attempt: 2, status: 'failed' },
    ],
  });
  assert.equal(stepProgress(t, 'skus').status, 'failed');
  assert.equal(batchProgress([t], ['a']).active.id, 'a');
});

test('cleared and deleted records cannot become resumable homepage tasks', () => {
  const t = task('cleared', 'awaiting_user', { clearedAt: '2026-10-05T00:00:00Z' });
  assert.deepEqual(batchProgress([t], ['cleared', 'deleted', 'cleared']).tasks, []);
  assert.deepEqual(continuationIds([t], t), []);
});

test('history excludes queued, executing and automatically recovering tasks but retains stopped outcomes', () => {
  assert.equal(taskIsHistory(task('queued', 'prepared')), false);
  assert.equal(taskIsHistory(task('active', 'running')), false);
  assert.equal(
    taskIsHistory(task('recovering', 'awaiting_user', { agentDiagnosis: { status: 'running' } })),
    false,
  );
  for (const status of ['succeeded', 'failed', 'awaiting_user', 'uncertain'])
    assert.equal(taskIsHistory(task('ended', status)), true);
});

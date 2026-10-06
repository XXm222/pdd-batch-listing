const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {
  errorDiagnostics,
  recordError,
  writeDiagnostic,
} = require('../dist-electron/electron/error-diagnostics');
const { ModelClient } = require('../dist-electron/electron/model-client');
test('error diagnostics retain bounded OS causes without messages, URLs, credentials or arbitrary fields', () => {
  const cause = Object.assign(new Error('SECRET https://user:password@provider.example'), {
    code: 'ECONNREFUSED',
    headers: { Authorization: 'SECRET' },
  });
  const error = new TypeError('raw SECRET', { cause });
  cause.cause = error;
  assert.deepEqual(errorDiagnostics(error), [
    { name: 'TypeError' },
    { name: 'Error', code: 'ECONNREFUSED' },
  ]);
  assert.equal(
    JSON.stringify(
      errorDiagnostics({ name: 'SECRET', code: 'SECRET', message: 'SECRET' }),
    ).includes('SECRET'),
    false,
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goods-errors-'));
  try {
    const file = path.join(dir, 'diagnostics.jsonl');
    recordError(file, 'model connection', error);
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /SECRET|password|provider\.example|Authorization/);
    assert.equal(JSON.parse(text).error[1].code, 'ECONNREFUSED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('diagnostic write failure cannot replace the result of a committed business operation', () => {
  const append = fs.appendFileSync,
    write = process.stderr.write;
  let fallback = '';
  fs.appendFileSync = () => {
    throw Object.assign(new Error('private file path'), { code: 'ENOSPC' });
  };
  process.stderr.write = (text) => {
    fallback += text;
    return true;
  };
  try {
    assert.doesNotThrow(() =>
      writeDiagnostic('/unused', {
        name: 'save',
        startedAt: 'now',
        endedAt: 'now',
        durationMs: 1,
        status: 'done',
      }),
    );
    assert.match(fallback, /ENOSPC/);
    assert.doesNotMatch(fallback, /private file path/);
  } finally {
    fs.appendFileSync = append;
    process.stderr.write = write;
  }
});
test('model network failures preserve an internal cause while keeping the public message free of provider details', async () => {
  const original = global.fetch;
  const cause = new TypeError('provider SECRET', {
    cause: Object.assign(new Error('url SECRET'), { code: 'ECONNRESET' }),
  });
  global.fetch = async () => {
    throw cause;
  };
  try {
    const client = new ModelClient({
      baseUrl: 'https://provider.example',
      model: 'demo',
      apiKey: 'SECRET',
    });
    await assert.rejects(
      client.complete([]),
      (error) =>
        error.cause === cause &&
        !error.message.includes('SECRET') &&
        errorDiagnostics(error).some((e) => e.code === 'ECONNRESET'),
    );
  } finally {
    global.fetch = original;
  }
});

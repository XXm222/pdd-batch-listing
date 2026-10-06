const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const { BridgeSetup } = require('../dist-electron/electron/bridge-setup');

const ready = {
  running: true,
  port: 10086,
  version: 'v2.0.22',
  extension_connected: true,
  extension_version: '2.0.13',
};

async function scenario(options, run) {
  const calls = [];
  const original = {
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    execFile: childProcess.execFile,
    fetch: global.fetch,
  };
  let started = false;
  fs.existsSync = (file) =>
    String(file).includes('bridge-runtime') ? options.binary !== false : original.existsSync(file);
  fs.readFileSync = (file, ...args) => {
    if (String(file).endsWith('daemon.addr')) {
      if (options.address === null)
        throw Object.assign(new Error('Missing record'), { code: 'ENOENT' });
      return options.address || '127.0.0.1:10086';
    }
    return original.readFileSync(file, ...args);
  };
  childProcess.execFile = (file, args, settings, callback) => {
    calls.push({ command: args[0], args, file });
    if (args[0] === 'start') {
      started = true;
      callback(options.startError || null, 'Listening on 127.0.0.1:10086');
    } else
      callback(null, JSON.stringify(options.cli || (started ? ready : options.status || ready)));
  };
  global.fetch = async (url, settings) => {
    calls.push({ url, redirect: settings.redirect });
    if (options.unavailable && !started) throw new Error('Connection refused');
    return {
      ok: true,
      json: async () =>
        options.afterStart && started ? options.afterStart : options.status || ready,
    };
  };
  try {
    await run(new BridgeSetup('/App/resources'), calls);
  } finally {
    Object.assign(fs, { existsSync: original.existsSync, readFileSync: original.readFileSync });
    childProcess.execFile = original.execFile;
    global.fetch = original.fetch;
  }
}

test('same major.minor accepts different patch versions and never starts a running service', async () => {
  await scenario({}, async (setup, calls) => {
    const result = await setup.start();
    assert.equal(result.state, 'ready');
    assert.equal(result.serviceVersion, 'v2.0.22');
    assert.equal(result.extensionVersion, '2.0.13');
    assert.equal(result.wsAddress, 'ws://127.0.0.1:10086/ws');
    assert.equal(
      calls.some((call) => call.command === 'start'),
      false,
    );
  });
});

test('disconnected extension is not reported as uninstalled or restarted', async () => {
  await scenario(
    { status: { ...ready, extension_connected: false, extension_version: '' } },
    async (setup, calls) => {
      const result = await setup.start();
      assert.equal(result.state, 'extension_disconnected');
      assert.doesNotMatch(result.message, /未安装/);
      assert.equal(
        calls.some((call) => call.command === 'start'),
        false,
      );
    },
  );
});

test('major.minor mismatch returns official suggested command without executing it', async () => {
  const mismatch = {
    ...ready,
    extension_version: '2.1.0',
    version_mismatch: { command: 'kimi-webbridge upgrade 2.1.0' },
  };
  await scenario({ status: mismatch }, async (setup, calls) => {
    const result = await setup.start();
    assert.equal(result.state, 'version_mismatch');
    assert.equal(result.suggestedCommand, mismatch.version_mismatch.command);
    assert.deepEqual(
      calls.filter((call) => call.command),
      [],
    );
  });
});

test('legacy status without extension version cannot falsely confirm compatibility', async () => {
  const legacy = { ...ready, version: '1.9.0' };
  delete legacy.extension_version;
  await scenario({ status: legacy }, async (setup) =>
    assert.equal((await setup.check()).state, 'version_mismatch'),
  );
});

test('reads moved daemon runtime record without requiring installed bundled CLI', async () => {
  await scenario({ binary: false, address: 'localhost:12086' }, async (setup, calls) => {
    const result = await setup.check();
    assert.equal(result.state, 'ready');
    assert.equal(result.httpAddress, 'http://127.0.0.1:12086');
    assert.deepEqual(calls, [{ url: 'http://127.0.0.1:12086/status', redirect: 'error' }]);
  });
});

test('missing service only invokes official start on the configured loopback address', async () => {
  await scenario(
    { unavailable: true, cli: { running: false, addr: '127.0.0.1:12086' } },
    async (setup, calls) => {
      assert.equal((await setup.start()).state, 'ready');
      assert.deepEqual(calls.find((call) => call.command === 'start').args, [
        'start',
        '--addr',
        '127.0.0.1:12086',
      ]);
      assert.equal(
        calls.some((call) => ['stop', 'restart', 'upgrade'].includes(call.command)),
        false,
      );
    },
  );
});

test('foreign or unrecognized HTTP service is not treated as connected', async () => {
  await scenario({ status: { running: true } }, async (setup) =>
    assert.equal((await setup.check()).state, 'service_unavailable'),
  );
});

test('unsafe runtime addresses do not trigger any CLI or HTTP calls', async () => {
  for (const address of [
    '0.0.0.0:10086',
    '[::1]:10086',
    'https://127.0.0.1:10086',
    'example.com:10086',
    '127.0.0.1:70000',
  ]) {
    await scenario({ address }, async (setup, calls) => {
      assert.equal((await setup.start()).state, 'service_unavailable');
      assert.deepEqual(calls, []);
    });
  }
});

test('absent bundled binary still permits read-only detection, but never starts an absent service', async () => {
  await scenario({ binary: false, unavailable: true }, async (setup, calls) => {
    const result = await setup.start();
    assert.equal(result.state, 'service_unavailable');
    assert.match(result.message, /文件缺失/);
    assert.equal(
      calls.some((call) => call.command),
      false,
    );
  });
});

test('concurrent checks and starts share a probe and at most one start command', async () => {
  await scenario(
    { unavailable: true, cli: { running: false, addr: '127.0.0.1:10086' } },
    async (setup, calls) => {
      const results = await Promise.all([setup.start(), setup.start(), setup.start()]);
      assert.equal(
        results.every((result) => result.state === 'ready'),
        true,
      );
      assert.equal(calls.filter((call) => call.command === 'start').length, 1);
      calls.length = 0;
      await Promise.all([setup.check(), setup.check(), setup.check()]);
      assert.equal(calls.filter((call) => call.url).length, 1);
    },
  );
});

const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const {
  AppUpdater,
  newerVersion,
  updateRelease,
} = require('../dist-electron/electron/app-updater');
test('updates enforce platform, version, HTTPS, package digest and complete download before installation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'goods-updates-'));
  const bytes = Buffer.from('installer-fixture'),
    sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const feed = 'https://example.test/goods-updates/latest.json';
  let corrupt = false,
    slow = false;
  const manifest = {
    version: '0.1.47',
    notes: '导出含图片 Excel',
    files: [
      {
        platform: 'darwin',
        arch: 'arm64',
        url: 'releases/0.1.47/app.dmg',
        size: bytes.length,
        sha256,
      },
    ],
  };
  const request = async (url, options) => {
    if (url === feed) return new Response(JSON.stringify(manifest));
    if (slow) {
      await new Promise((resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        }),
      );
    }
    return new Response(corrupt ? Buffer.alloc(bytes.length, 2) : bytes, {
      headers: { 'content-length': String(bytes.length) },
    });
  };
  const seen = [],
    updater = new AppUpdater(
      '0.1.46',
      directory,
      (s) => seen.push(s),
      feed,
      'darwin',
      'arm64',
      request,
    );
  try {
    assert.equal(newerVersion('0.1.100', '0.1.99'), true);
    assert.equal(newerVersion('0.1.47', '0.1.47'), false);
    for (const url of [
      'http://example.test/goods-updates/a.dmg',
      'https://evil.test/app.dmg',
      '../app.dmg',
      'releases/app.exe',
    ])
      assert.throws(() =>
        updateRelease(
          { ...manifest, files: [{ ...manifest.files[0], url }] },
          feed,
          'darwin',
          'arm64',
        ),
      );
    assert.throws(() => updateRelease(manifest, feed, 'win32', 'x64'));
    assert.equal((await updater.check()).status, 'available');
    assert.equal((await updater.download()).status, 'ready');
    const file = await updater.installationPath();
    assert.deepEqual(await fs.readFile(file), bytes);
    await fs.writeFile(file, Buffer.alloc(bytes.length, 3));
    await assert.rejects(updater.installationPath(), /变化/);
    corrupt = true;
    await updater.check();
    assert.equal((await updater.download()).status, 'error');
    await assert.rejects(updater.installationPath());
    assert.equal(
      (await fs.readdir(directory)).some((f) => f.endsWith('.part')),
      false,
    );
    corrupt = false;
    slow = true;
    await updater.check();
    const download = updater.download();
    while (updater.state.status !== 'downloading') await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    updater.cancel();
    assert.equal((await download).status, 'error');
    assert.ok(seen.some((s) => s.status === 'downloading'));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

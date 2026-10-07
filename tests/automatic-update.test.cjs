const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { AppUpdater } = require('../dist-electron/electron/app-updater');
const {
  releasePayload,
  verifyReleaseSignature,
} = require('../dist-electron/electron/update-signature');
const {
  prepareAutomaticInstall,
  acknowledgeAutomaticInstall,
} = require('../dist-electron/electron/auto-install');

test('automatic updates require authenticated release and unchanged package, then only the expected app/version can acknowledge restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goods-auto-update-'));
  const keys = crypto.generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const bytes = Buffer.from('isolated-installer');
  const raw = {
    version: '0.1.52',
    notes: '自动更新',
    files: [
      {
        platform: 'darwin',
        arch: 'arm64',
        url: 'releases/0.1.52/App.dmg',
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      },
    ],
  };
  raw.signature = crypto.sign(null, releasePayload(raw), keys.privateKey).toString('base64');
  assert.doesNotThrow(() => verifyReleaseSignature(raw, publicKey));
  for (const changed of [
    { ...raw, version: '9.9.9' },
    { ...raw, notes: 'changed' },
    { ...raw, signature: '' },
    { ...raw, files: [{ ...raw.files[0], url: 'releases/evil.dmg' }] },
  ])
    assert.throws(() => verifyReleaseSignature(changed, publicKey));
  const feed = 'https://example.test/updates/latest.json';
  const updater = new AppUpdater(
    '0.1.51',
    dir,
    () => {},
    feed,
    'darwin',
    'arm64',
    async (url) => new Response(url === feed ? JSON.stringify(raw) : bytes),
    publicKey,
  );
  try {
    assert.equal((await updater.check()).status, 'available');
    assert.equal((await updater.download()).status, 'ready');
    assert.equal((await updater.automaticInstallation()).release.signatureVerified, true);
    await fs.writeFile(await updater.installationPath(), Buffer.from('changed'));
    await assert.rejects(updater.automaticInstallation(), /变化/);
    await assert.rejects(
      prepareAutomaticInstall(
        '/not-read',
        { version: '0.1.52', file: raw.files[0] },
        '/not-read',
        dir,
        dir,
      ),
      /签名/,
    );
    const exe = path.join(dir, 'App');
    await fs.writeFile(exe, 'isolated-app');
    const token = crypto.randomUUID();
    await fs.writeFile(
      path.join(dir, 'install-request.json'),
      JSON.stringify({ token, exe: await fs.realpath(exe), version: '0.1.52' }),
    );
    await acknowledgeAutomaticInstall(dir, '0.1.51', exe);
    await assert.rejects(fs.stat(path.join(dir, token + '.ready')));
    await acknowledgeAutomaticInstall(dir, '0.1.52', exe);
    assert.equal(await fs.readFile(path.join(dir, token + '.ready'), 'utf8'), '0.1.52');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

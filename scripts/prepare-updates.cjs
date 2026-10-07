const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const pkg = require('../package.json');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'),
  release = path.join(root, pkg.build.directories.output);
const output = path.join(release, 'online'),
  version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('请使用稳定版版本号发布更新');
for (const bundle of ['mac-arm64/商品运营台.app/Contents/Resources', 'win-unpacked/resources'])
  execFileSync(
    process.execPath,
    [path.join(__dirname, 'verify-package.cjs'), path.join(release, bundle)],
    { cwd: root, stdio: 'inherit' },
  );
const files = [];
for (const name of fs.readdirSync(release)) {
  const platform = name.endsWith('.dmg') ? 'darwin' : name.endsWith('.exe') ? 'win32' : null;
  if (!platform || !name.includes(version)) continue;
  const arch = name.includes('arm64') ? 'arm64' : name.includes('x64') ? 'x64' : null;
  if (!arch) throw Error(`安装包文件名须包含架构：${name}`);
  if (files.some((f) => f.platform === platform && f.arch === arch))
    throw Error('同平台架构存在多份安装包');
  const source = path.join(release, name),
    raw = fs.readFileSync(source);
  if (!raw.length || raw.length > 1024 * 1024 * 1024) throw Error('安装包大小无效');
  const target = path.join(output, 'releases', version, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  files.push({
    platform,
    arch,
    url: `releases/${version}/${name}`,
    size: raw.length,
    sha256: crypto.createHash('sha256').update(raw).digest('hex'),
  });
}
if (
  !files.some((f) => f.platform === 'darwin' && f.arch === 'arm64') ||
  !files.some((f) => f.platform === 'win32' && f.arch === 'x64')
)
  throw Error('请先生成 Mac arm64 DMG 与 Windows x64 Setup，不能发布缺少平台的更新');
const notes = fs.readFileSync(path.join(root, 'resources/release-notes.txt'), 'utf8').trim();
if (!notes || notes.length > 10000) throw Error('请填写更新说明');
const { releasePayload } = require('../dist-electron/electron/update-signature');
const signingKey =
  process.env.GOODS_UPDATE_SIGNING_KEY ||
  path.join(require('node:os').homedir(), '.config/goods-workspace-updates/release-private.pem');
const manifest = { version, notes, files };
const privateKey = fs.readFileSync(signingKey);
const publicKey = fs.readFileSync(path.join(root, 'resources/updates/release-public.pem'));
manifest.signature = crypto.sign(null, releasePayload(manifest), privateKey).toString('base64');
if (
  !crypto.verify(
    null,
    releasePayload(manifest),
    publicKey,
    Buffer.from(manifest.signature, 'base64'),
  )
)
  throw Error('发布签名密钥与客户端校验文件不匹配');
fs.writeFileSync(path.join(output, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`更新目录已生成：${output}`);

const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const pkg = require('../package.json'),
  host = process.argv[2] || 'jst';
if (!/^[a-zA-Z0-9_.-]+$/.test(host)) throw Error('SSH 主机名无效');
const root = path.resolve(__dirname, '..'),
  directory = path.join(root, pkg.build.directories.output, 'online');
execFileSync(process.execPath, [path.join(__dirname, 'prepare-updates.cjs')], { stdio: 'inherit' });
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'latest.json'), 'utf8'));
const remote = '/srv/goods-workspace-updates',
  temporary = `.latest-${crypto.randomUUID()}.json`;
const ssh = (command) =>
  execFileSync('ssh', ['-o', 'BatchMode=yes', host, command], { stdio: 'inherit' });
ssh(`test -d ${remote}/releases && test ! -e ${remote}/releases/${manifest.version}`);
execFileSync(
  'scp',
  ['-r', path.join(directory, 'releases', manifest.version), `${host}:${remote}/releases/`],
  { stdio: 'inherit' },
);
// Package bytes go first. Verify all remote files before atomically switching the feed.
const checks =
  manifest.files
    .map((f) => {
      const name = path.basename(f.url);
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw Error('安装包文件名无效');
      return `${f.sha256}  ${remote}/releases/${manifest.version}/${name}`;
    })
    .join('\n') + '\n';
execFileSync('ssh', ['-o', 'BatchMode=yes', host, 'sha256sum -c -'], {
  input: checks,
  stdio: ['pipe', 'inherit', 'inherit'],
});
execFileSync('scp', [path.join(directory, 'latest.json'), `${host}:${remote}/${temporary}`], {
  stdio: 'inherit',
});
for (const file of manifest.files) {
  const extension = file.platform === 'darwin' ? '.dmg' : '.exe';
  const latest = `latest-${file.platform === 'darwin' ? 'mac' : file.platform}-${file.arch}${extension}`;
  const link = `.link-${crypto.randomUUID()}`;
  ssh(`ln -s ${file.url} ${remote}/${link} && mv -Tf ${remote}/${link} ${remote}/${latest}`);
}
ssh(
  `chmod -R a+rX ${remote}/releases/${manifest.version} && chmod 644 ${remote}/${temporary} && mv ${remote}/${temporary} ${remote}/latest.json`,
);
console.log(`已发布 ${manifest.version}：https://www.mandla.cn/goods-updates/latest.json`);

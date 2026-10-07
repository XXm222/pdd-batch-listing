import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { UpdateRelease } from '../src/types';

const run = promisify(execFile);
const bundleId = 'com.goodsworkspace.desktop';
type InstallRequest = {
  token: string;
  pid: number;
  exe: string;
  version: string;
  file: string;
  sha256: string;
  stage?: string;
  target?: string;
  backup?: string;
};

export async function prepareAutomaticInstall(
  file: string,
  release: UpdateRelease,
  exe: string,
  directory: string,
  resources: string,
): Promise<() => Promise<void>> {
  if (!release.signatureVerified || !/^\d+\.\d+\.\d+$/.test(release.version))
    throw Error('此更新包未通过可信签名校验');
  const request: InstallRequest = {
    token: randomUUID(),
    pid: process.pid,
    exe: await fs.realpath(exe),
    version: release.version,
    file,
    sha256: release.file.sha256,
  };
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (release.file.platform === 'darwin') {
    const target = path.dirname(path.dirname(path.dirname(request.exe)));
    if (!target.endsWith('.app') || !request.exe.startsWith(path.join(target, 'Contents/MacOS/')))
      throw Error('请先将 App 安装到电脑后再使用自动更新');
    const parent = path.dirname(target);
    try {
      await fs.access(parent, constants.W_OK);
    } catch {
      throw Error('当前安装位置不可写，请移到可写位置或使用手动安装');
    }
    const stage = await fs.mkdtemp(path.join(parent, '.goods-update-'));
    await fs.chmod(stage, 0o700);
    const mount = path.join(stage, 'mount');
    await fs.mkdir(mount);
    let mounted = false;
    try {
      await run(
        '/usr/bin/hdiutil',
        ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, file],
        { timeout: 60000 },
      );
      mounted = true;
      const source = path.join(mount, '商品运营台.app');
      const info = path.join(source, 'Contents/Info.plist');
      const plist = async (key: string) =>
        (await run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, info])).stdout.trim();
      if (
        (await plist('CFBundleIdentifier')) !== bundleId ||
        (await plist('CFBundleShortVersionString')) !== release.version ||
        (await plist('CFBundleExecutable')) !== path.basename(request.exe)
      )
        throw Error('更新包中的 App 名称或版本不匹配');
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source], {
        timeout: 60000,
      });
      const size = Number((await run('/usr/bin/du', ['-sk', source])).stdout.split(/\s/)[0]) * 1024;
      const available = await fs.statfs(parent);
      if (
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        available.bavail * available.bsize < size + 20 * 1024 * 1024
      )
        throw Error('磁盘空间不足，请清理空间后再更新');
      const staged = path.join(stage, '商品运营台.app');
      await run('/usr/bin/ditto', [source, staged], { timeout: 180000 });
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged], {
        timeout: 60000,
      });
      const backup = path.join(parent, '.商品运营台.update-backup.app');
      if (
        await fs.lstat(backup).then(
          () => true,
          () => false,
        )
      ) {
        if (
          (
            await run('/usr/libexec/PlistBuddy', [
              '-c',
              'Print :CFBundleIdentifier',
              path.join(backup, 'Contents/Info.plist'),
            ])
          ).stdout.trim() !== bundleId
        )
          throw Error('更新恢复目录已被其他文件占用，请使用手动安装');
        await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', backup], {
          timeout: 60000,
        });
        await fs.rm(backup, { recursive: true });
      }
      Object.assign(request, { stage, target, backup });
    } catch (e) {
      if (mounted) await run('/usr/bin/hdiutil', ['detach', mount]).catch(() => {});
      await fs.rm(stage, { recursive: true, force: true });
      throw e;
    }
    await run('/usr/bin/hdiutil', ['detach', mount]);
  } else if (release.file.platform !== 'win32') throw Error('这台电脑暂不支持自动安装');
  const requestFile = path.join(directory, 'install-request.json');
  await fs.writeFile(requestFile, JSON.stringify(request), { mode: 0o600 });
  await fs.rm(path.join(directory, 'install-result.json'), { force: true });
  const script =
    release.file.platform === 'darwin'
      ? path.join(directory, `install-${request.token}.sh`)
      : path.join(resources, 'install-windows.ps1');
  if (release.file.platform === 'darwin')
    await fs.copyFile(path.join(resources, 'install-mac.sh'), script);
  return async () => {
    const mac = release.file.platform === 'darwin';
    const args = mac
      ? [
          script,
          String(request.pid),
          request.target!,
          path.join(request.stage!, '商品运营台.app'),
          request.backup!,
          directory,
          request.token,
          request.stage!,
          path.basename(request.exe),
        ]
      : [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(await fs.readFile(script, 'utf8'), 'utf16le').toString('base64'),
        ];
    const child = spawn(mac ? '/bin/sh' : 'powershell.exe', args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: directory,
      env: { ...process.env, GOODS_UPDATE_REQUEST: requestFile },
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  };
}

export async function acknowledgeAutomaticInstall(
  directory: string,
  version: string,
  exe: string,
  ready = true,
): Promise<void> {
  try {
    const raw = await fs.readFile(path.join(directory, 'install-request.json'), 'utf8');
    if (raw.length > 10000) return;
    const request = JSON.parse(raw) as InstallRequest;
    if (!/^[a-f0-9-]{36}$/i.test(request.token) || request.version !== version) return;
    const current = await fs.realpath(exe);
    if (
      process.platform === 'win32'
        ? current.toLowerCase() !== request.exe.toLowerCase()
        : current !== request.exe
    )
      return;
    await fs.writeFile(
      path.join(directory, `${request.token}.${ready ? 'ready' : 'pid'}`),
      ready ? version : String(process.pid),
      { mode: 0o600 },
    );
  } catch {
    /* Normal starts have no automatic installation request. */
  }
}

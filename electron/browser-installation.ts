import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';

// Keep unpacked extensions outside the App bundle: browsers need this folder after every restart.
export async function exportBrowserExtension(resourcesRoot: string, documents: string) {
  const archive = await fs.readFile(
    path.join(resourcesRoot, 'browser-extension/kimi-browser-extension.zip'),
  );
  const source = JSON.parse(
    await fs.readFile(path.join(resourcesRoot, 'browser-extension/source.json'), 'utf8'),
  );
  const hash = createHash('sha256').update(archive).digest('hex');
  if (
    source.files?.find(
      (file: { path: string }) => file.path === 'browser-extension/kimi-browser-extension.zip',
    )?.sha256 !== hash
  )
    throw new Error('内置扩展安装包校验失败，请重新安装商品运营台');
  const zip = await JSZip.loadAsync(archive, { checkCRC32: true });
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
  if (
    manifest.manifest_version !== 3 ||
    manifest.version !== source.version ||
    !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version)
  )
    throw new Error('内置扩展版本信息不正确');
  const parent = path.join(documents, '商品运营台浏览器扩展');
  let directory = path.join(parent, `Kimi-${manifest.version}-${hash.slice(0, 8)}`);
  try {
    if ((await fs.readFile(path.join(directory, '.source-sha256'), 'utf8')).trim() === hash) {
      const folder = path.join(directory, 'Kimi浏览器扩展');
      const zipPath = path.join(directory, 'Kimi浏览器扩展.zip');
      if (!(await fs.readFile(zipPath)).equals(archive)) throw new Error('Export is incomplete');
      for (const entry of Object.values(zip.files))
        if (
          !entry.dir &&
          !(await fs.readFile(path.join(folder, entry.name))).equals(
            await entry.async('nodebuffer'),
          )
        )
          throw new Error('Export is incomplete');
      await fs.copyFile(
        path.join(resourcesRoot, 'browser-extension/安装指南.html'),
        path.join(directory, '安装指南.html'),
      );
      return { folder, zip: zipPath };
    }
  } catch {
    // Missing, incomplete or modified exports are preserved; create a new copy below.
  }
  await fs.mkdir(parent, { recursive: true });
  // Preserve any incomplete or user-modified export; prepare a fresh permanent folder beside it.
  try {
    await fs.access(directory);
    directory += `-${randomUUID().slice(0, 8)}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('无法访问浏览器扩展目录，请检查文件权限', { cause: error });
  }
  const folder = path.join(directory, 'Kimi浏览器扩展');
  const zipPath = path.join(directory, 'Kimi浏览器扩展.zip');
  const staging = await fs.mkdtemp(path.join(parent, '.install-'));
  try {
    for (const entry of Object.values(zip.files)) {
      const original =
        (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName || entry.name;
      if (
        original !== entry.name ||
        path.posix.isAbsolute(original) ||
        original.split('/').includes('..') ||
        original.includes('\\') ||
        original.includes(':') ||
        original.includes('\0') ||
        ((Number(entry.unixPermissions) || 0) & 0o170000) === 0o120000
      )
        throw new Error('内置扩展安装包包含无效路径');
      const target = path.join(staging, 'Kimi浏览器扩展', entry.name);
      if (entry.dir) {
        await fs.mkdir(target, { recursive: true });
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, await entry.async('nodebuffer'));
    }
    await fs.writeFile(path.join(staging, 'Kimi浏览器扩展.zip'), archive);
    await fs.copyFile(
      path.join(resourcesRoot, 'browser-extension/安装指南.html'),
      path.join(staging, '安装指南.html'),
    );
    await fs.writeFile(path.join(staging, '.source-sha256'), hash);
    await fs.rename(staging, directory);
    return { folder, zip: zipPath };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

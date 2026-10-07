import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { UpdateState, UpdateRelease, UpdateFile } from '../src/types';
import { verifyReleaseSignature } from './update-signature';

export const UPDATE_FEED = 'https://www.mandla.cn/goods-updates/latest.json';
const maxSize = 1024 * 1024 * 1024;
const versionParts = (version: unknown) => {
  if (typeof version !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version))
    throw Error('更新版本号无效');
  return version.split('.').map(Number);
};
export function newerVersion(candidate: string, current: string) {
  const a = versionParts(candidate),
    b = versionParts(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export function updateRelease(
  raw: any,
  feed: string,
  platform: string,
  arch: string,
): UpdateRelease {
  versionParts(raw?.version);
  if (
    !Array.isArray(raw.files) ||
    raw.files.length > 12 ||
    typeof raw.notes !== 'string' ||
    raw.notes.length > 10000
  )
    throw Error('服务器更新说明格式不正确');
  const candidates = raw.files.filter((f: any) => f?.platform === platform && f?.arch === arch);
  if (candidates.length > 1) throw Error('服务器存在重复的同平台更新包');
  const file = candidates[0];
  if (!file) throw Error('服务器暂未提供这台电脑对应的更新包');
  const base = new URL(feed),
    url = new URL(file.url, base);
  const extension = platform === 'darwin' ? '.dmg' : platform === 'win32' ? '.exe' : '';
  if (
    base.protocol !== 'https:' ||
    url.protocol !== 'https:' ||
    url.origin !== base.origin ||
    !url.pathname.startsWith(new URL('.', base).pathname) ||
    url.username ||
    url.password ||
    url.hash ||
    !extension ||
    !url.pathname.endsWith(extension) ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size > maxSize ||
    typeof file.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(file.sha256)
  )
    throw Error('更新包地址、大小或校验信息不正确');
  return {
    version: raw.version,
    notes: raw.notes,
    file: { platform, arch, url: url.href, size: file.size, sha256: file.sha256 },
  };
}
async function hashFile(file: string) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('更新文件无效，请重新下载');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { size: stat.size, sha256: hash.digest('hex') };
}
export class AppUpdater {
  state: UpdateState;
  private controller?: AbortController;
  private downloaded?: { release: UpdateRelease; path: string };
  constructor(
    private version: string,
    private directory: string,
    private emit: (state: UpdateState) => void,
    private feed = UPDATE_FEED,
    private platform = process.platform,
    private arch = process.arch,
    private request: typeof fetch = fetch,
    private publicKey?: string,
    currentNotes = '',
  ) {
    this.state = {
      status: 'idle',
      currentVersion: version,
      feedUrl: feed,
      received: 0,
      currentNotes,
    };
  }
  private patch(change: Partial<UpdateState>) {
    this.state = { ...this.state, ...change };
    this.emit(this.state);
    return this.state;
  }
  private busy() {
    return ['checking', 'downloading'].includes(this.state.status);
  }
  async check() {
    if (this.busy()) return this.state;
    this.patch({ status: 'checking', message: undefined });
    this.controller = new AbortController();
    const timer = setTimeout(() => this.controller?.abort(), 20000);
    try {
      const response = await this.request(this.feed, {
        signal: this.controller.signal,
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!response.ok) throw Error(`更新服务器暂时不可用（${response.status}），请稍后重试`);
      const reader = response.body?.getReader();
      if (!reader) throw Error('服务器未返回更新信息');
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 128 * 1024) {
          await reader.cancel();
          throw Error('更新说明过大');
        }
        chunks.push(value);
      }
      const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      versionParts(raw?.version);
      if (!newerVersion(raw.version, this.version))
        return this.patch({ status: 'latest', release: undefined, received: 0 });
      if (this.publicKey) verifyReleaseSignature(raw, this.publicKey);
      const release = updateRelease(raw, this.feed, this.platform, this.arch);
      release.signatureVerified = !!this.publicKey;
      this.downloaded = undefined;
      return this.patch({ status: 'available', release, received: 0 });
    } catch (error) {
      return this.patch({
        status: 'error',
        message:
          (error as Error).name === 'AbortError'
            ? '检查更新超时，请稍后重试'
            : (error as Error).message,
      });
    } finally {
      clearTimeout(timer);
      this.controller = undefined;
    }
  }
  async download() {
    if (this.busy()) throw Error('更新正在处理中');
    const release = this.state.release;
    if (!release) throw Error('请先检查更新');
    const file: UpdateFile = release.file;
    const target = path.join(
      this.directory,
      `${release.version}-${file.platform}-${file.arch}${file.platform === 'darwin' ? '.dmg' : '.exe'}`,
    );
    const temporary = `${target}.${randomUUID()}.part`;
    this.patch({ status: 'downloading', received: 0, message: undefined });
    this.controller = new AbortController();
    const timer = setTimeout(() => this.controller?.abort(), 30 * 60 * 1000);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (this.controller.signal.aborted) throw Error('下载已取消');
      const response = await this.request(file.url, {
        signal: this.controller.signal,
        redirect: 'error',
        credentials: 'omit',
      });
      if (!response.ok || !response.body) throw Error('更新包下载失败，请重试');
      const length = response.headers.get('content-length');
      if (length !== null && Number(length) !== file.size)
        throw Error('更新包大小与服务器说明不同');
      handle = await fs.open(temporary, 'wx', 0o600);
      const hash = createHash('sha256');
      let received = 0,
        last = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.length;
        if (received > file.size) throw Error('更新包大小超过声明值');
        hash.update(chunk);
        await handle.writeFile(chunk);
        if (Date.now() - last > 200) {
          this.patch({ received });
          last = Date.now();
        }
      }
      if (received !== file.size || hash.digest('hex') !== file.sha256)
        throw Error('更新包校验未通过，请重新下载');
      await handle.sync();
      await handle.close();
      handle = undefined;
      // Only a verified complete download becomes installable.
      await fs.rename(temporary, target);
      this.downloaded = { release, path: target };
      return this.patch({ status: 'ready', received });
    } catch (error) {
      this.downloaded = undefined;
      return this.patch({
        status: 'error',
        message: this.controller.signal.aborted
          ? '下载已取消，可重新下载'
          : (error as Error).message,
      });
    } finally {
      clearTimeout(timer);
      await handle?.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
      this.controller = undefined;
    }
  }
  cancel() {
    this.controller?.abort();
  }
  async installationPath() {
    if (this.state.status !== 'ready' || !this.downloaded) throw Error('请先下载并校验更新包');
    const found = await hashFile(this.downloaded.path),
      expected = this.downloaded.release.file;
    if (found.size !== expected.size || found.sha256 !== expected.sha256) {
      this.downloaded = undefined;
      this.patch({ status: 'error', message: '更新文件已变化，请重新下载' });
      throw Error('更新文件已变化，请重新下载');
    }
    return this.downloaded.path;
  }
  async automaticInstallation() {
    const file = await this.installationPath();
    if (!this.downloaded?.release.signatureVerified)
      throw Error('此更新包没有可信签名，请使用手动安装');
    return { file, release: this.downloaded.release };
  }
}

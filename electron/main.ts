import { recordError, writeDiagnostic } from './error-diagnostics';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  safeStorage,
  shell,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Store } from './store';
import { prepareTasks, TaskRunner } from './task-runner';
import { PlatformRegistry } from './platforms/registry';
import { ShopLoginError } from './platforms/shop-login';
import { ExecutionError } from './execution';
import {
  DEFAULT_PLATFORM,
  normalizePlatform,
  platformMeta,
  requireEnabledPlatform,
} from '../src/platforms';
import { sanitizeProducts } from './product-service';
import { ShopService } from './shop-service';
import { AgentService } from './agent-service';
import { BridgeSetup, ensureBrowserReady } from './bridge-setup';
import { exportBrowserExtension } from './browser-installation';
import { exportProductWorkbook } from './workbook-export';
import { ShopCollector } from './shop-collector';
import { AppUpdater } from './app-updater';
import { prepareAutomaticInstall, acknowledgeAutomaticInstall } from './auto-install';
import { isTaobaoProduct, safeImageName } from '../src/domain';
import type {
  AgentConfigInput,
  Asset,
  Product,
  Shop,
  ShopInput,
  ShopLoginResult,
  Task,
  Workspace,
} from '../src/types';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);
app.setName('商品运营台');
const apiDraftPreview =
  app.isPackaged &&
  JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'))
    .goodsApiDraftPreview === true;
if (process.env.GOODS_WORKSPACE_DATA_DIR)
  app.setPath('userData', path.resolve(process.env.GOODS_WORKSPACE_DATA_DIR));
else if (apiDraftPreview)
  app.setPath('userData', path.join(app.getPath('appData'), '商品运营台-API试用'));
let window: BrowserWindow | null = null;
let store: Store;
let encryptionAvailable = false;
let importing = false;
let exporting = false;
let installingUpdate = false;
let updater: AppUpdater;
let updateTimer: NodeJS.Timeout | undefined;
let serial = Promise.resolve();
let runner: TaskRunner;
let agent: AgentService;
let shopLoginBusy = false;
let lastLoginShopId = '';
let collector: ShopCollector;
const root = () => app.getAppPath();
const resource = (...segments: string[]) =>
  path.join(
    app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'resources')
      : path.join(root(), 'resources'),
    ...segments,
  );
const assetsDir = () => path.join(app.getPath('userData'), 'assets');
const workspace = (): Workspace => ({
  products: store
    .all<Product>('products')
    .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || '')),
  shops: store.all<Shop>('shops').sort((a, b) => a.name.localeCompare(b.name)),
  tasks: store.all<Task>('tasks').sort((a, b) => b.time.localeCompare(a.time)),
  version: app.getVersion(),
  encryptionAvailable,
});
const assetId = /^[a-f0-9]{64}$/;
async function measureLocal<T>(name: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now(),
    startedAt = new Date().toISOString();
  let status: 'done' | 'failed' = 'done';
  try {
    return await work();
  } catch (error) {
    status = 'failed';
    throw error;
  } finally {
    writeDiagnostic(path.join(app.getPath('userData'), 'operation-timings.jsonl'), {
      name,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - start),
      status,
    });
  }
}

async function encrypt(password: string) {
  const asyncStorage = safeStorage as typeof safeStorage & {
    isAsyncEncryptionAvailable?: () => Promise<boolean>;
    encryptStringAsync?: (value: string) => Promise<Buffer>;
  };
  if (
    !asyncStorage.encryptStringAsync ||
    !asyncStorage.isAsyncEncryptionAvailable ||
    !(await asyncStorage.isAsyncEncryptionAvailable())
  )
    throw new Error('系统加密服务不可用，无法保存密码');
  return (await asyncStorage.encryptStringAsync(password)).toString('base64');
}
function timedEncryption(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('系统凭据授权尚未完成，请完成系统提示后重试。资料未保存。')),
      45000,
    );
    encrypt(password).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
function workerImport(data: {
  files?: string[];
  folder?: string;
  withImages: boolean;
}): Promise<{ products: Product[]; assets: Asset[] }> {
  return new Promise((resolve, reject) => {
    const workerRoot = app.isPackaged
      ? __dirname.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
      : __dirname;
    const worker = new Worker(path.join(workerRoot, 'import-worker.js'), {
      workerData: { ...data, assetsDir: assetsDir() },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('资料识别超时，请缩小文件夹后重试'));
    }, 45000);
    worker.once('message', (message) => {
      clearTimeout(timer);
      void worker.terminate();
      message.ok ? resolve(message.data) : reject(new Error(message.error));
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error('资料识别线程失败，请检查文件后重试', { cause: error }));
    });
    worker.once('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        reject(new Error('资料识别已中断'));
      }
    });
  });
}
function handler(name: string, fn: (input: any) => any, mutation = false) {
  ipcMain.handle(name, async (event, input) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      return { ok: false, error: '调用来源不正确' };
    const run = async () => {
      try {
        if (installingUpdate) throw Error('正在打开更新安装包，请稍候');
        return { ok: true, data: await fn(input) };
      } catch (error) {
        recordError(
          path.join(app.getPath('userData'), 'operation-timings.jsonl'),
          `IPC:${name}`,
          error,
        );
        return {
          ok: false,
          error: error instanceof Error ? error.message : '操作失败，请重试',
          imageIssues: (error as { imageIssues?: string[] })?.imageIssues,
        };
      }
    };
    if (!mutation) return run();
    const next = serial.then(run);
    serial = next.then(() => {});
    return next;
  });
}
async function createWindow() {
  window = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: apiDraftPreview ? '商品运营台 · API试用版' : '商品运营台',
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (apiDraftPreview) window.on('page-title-updated', (event) => event.preventDefault());
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  if (process.env.GOODS_DEV_URL === 'http://127.0.0.1:5178')
    await window.loadURL(process.env.GOODS_DEV_URL);
  else await window.loadFile(path.join(root(), 'dist', 'index.html'));
  window.on('closed', () => {
    window = null;
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      await acknowledgeAutomaticInstall(
        path.join(app.getPath('userData'), 'updates'),
        app.getVersion(),
        app.getPath('exe'),
        false,
      );
      store = await Store.open(app.getPath('userData'));
      const bridgeSetup = new BridgeSetup(resource());
      const requireBrowser = async (platform: unknown = DEFAULT_PLATFORM) => {
        const meta = requireEnabledPlatform(platform);
        const status = await ensureBrowserReady(bridgeSetup, () => shell.openExternal(meta.portal));
        if (status.state !== 'ready')
          throw new Error(
            `浏览器连接未就绪：${status.message}。请打开“浏览器连接”查看安装教程并重新检测`,
          );
      };
      const platformForTasks = (ids: unknown) => {
        const task = store
          .all<Task>('tasks')
          .find((t) => Array.isArray(ids) && t.id === (ids as string[])[0]);
        return (
          task?.platform ?? store.all<Shop>('shops').find((s) => s.id === task?.shopId)?.platform
        );
      };
      const decryptShopPassword = async (shop: Shop) => {
        const secret = store.secret(shop.id);
        if (!secret) throw new Error('店铺密码未保存，请到店铺管理补充');
        const decrypted = await safeStorage.decryptStringAsync(Buffer.from(secret, 'base64'));
        if (decrypted.shouldReEncrypt)
          store.saveShop(shop, await timedEncryption(decrypted.result));
        return decrypted.result;
      };
      const platforms = new PlatformRegistry(app.getPath('userData'), decryptShopPassword);
      runner = new TaskRunner(
        store,
        app.getPath('userData'),
        (shop) => platforms.adapterFor(shop),
        (error) => {
          recordError(
            path.join(app.getPath('userData'), 'operation-timings.jsonl'),
            '任务状态保存失败',
            error,
          );
          dialog.showErrorBox(
            '执行已停止',
            '本机任务状态无法保存，请保留应用数据并检查磁盘空间或文件权限。已尝试保存的商品须先核对原草稿。',
          );
        },
        (id, remaining) =>
          agent.handleFailure(
            id,
            (id) =>
              runner.start([
                id,
                ...remaining.filter((id) =>
                  store.all<Task>('tasks').some((t) => t.id === id && t.status === 'prepared'),
                ),
              ]),
            () => !runner.isStopping,
          ),
      );
      runner.recover();
      agent = new AgentService(
        store,
        timedEncryption,
        async (secret) =>
          (await safeStorage.decryptStringAsync(Buffer.from(secret, 'base64'))).result,
        () => runner.isActive || shopLoginBusy || collector?.busy,
        (t, s) => platforms.forShop(s).inspectDiagnosis(t, s),
        (t, s, name) => platforms.forShop(s).recoverPage(t, s, name),
      );
      agent.recover();
      updater = new AppUpdater(
        app.getVersion(),
        path.join(app.getPath('userData'), 'updates'),
        (state) => {
          if (window && !window.isDestroyed()) window.webContents.send('updates:changed', state);
        },
        undefined,
        undefined,
        undefined,
        undefined,
        fs.readFileSync(resource('updates', 'release-public.pem'), 'utf8'),
        fs.readFileSync(resource('release-notes.txt'), 'utf8').trim(),
      );
      handler('updates:state', () => updater.state);
      handler('updates:check', () => updater.check());
      handler('updates:download', () => updater.download());
      handler('updates:cancel', () => updater.cancel());
      const guardUpdate = () => {
        if (
          runner.isActive ||
          agent.busy ||
          shopLoginBusy ||
          importing ||
          exporting ||
          collector?.busy
        )
          throw Error('请等待商品任务、登录及资料处理结束后再更新');
      };
      handler('updates:install', async () => {
        guardUpdate();
        if (updater.state.status !== 'ready') {
          const state = await updater.download();
          if (state.status !== 'ready') throw Error(state.message || '更新包未下载完成');
        }
        guardUpdate();
        const { file, release } = await updater.automaticInstallation();
        installingUpdate = true;
        try {
          const launch = await prepareAutomaticInstall(
            file,
            release,
            app.getPath('exe'),
            path.join(app.getPath('userData'), 'updates'),
            resource('updates'),
          );
          await launch();
          app.quit();
        } catch (error) {
          installingUpdate = false;
          throw error;
        }
      });
      handler('updates:manual', async () => {
        guardUpdate();
        const file = await updater.installationPath();
        guardUpdate();
        installingUpdate = true;
        try {
          const error = await shell.openPath(file);
          if (error) throw Error('无法打开安装包，请重新下载后重试');
          app.quit();
        } catch (error) {
          installingUpdate = false;
          throw error;
        }
      });
      handler('products:export', async (raw: unknown) => {
        if (exporting) throw Error('正在生成 Excel，请稍候');
        exporting = true;
        try {
          const [p] = sanitizeProducts(store, [raw]);
          const original = raw as Product;
          if (isTaobaoProduct(p)) {
            if (typeof original.outerId !== 'string' && original.outerId !== undefined)
              throw Error('商家编码格式不正确');
            p.outerId = original.outerId || '';
            if (p.outerId.length > 2000) throw Error('商家编码过长');
            if (!original.taobao || typeof original.taobao !== 'object')
              throw Error('淘宝发品设置尚未填写');
            p.taobao = { ...original.taobao };
            for (const key of [
              'originProvince',
              'originCity',
              'extractWay',
              'freightBearer',
              'deliveryTime',
              'shelfTime',
              'auctionPoint',
            ] as const)
              if (typeof p.taobao[key] !== 'string' || p.taobao[key].length > 200)
                throw Error('淘宝发品设置格式不正确');
            const known = new Map(store.all<Asset>('assets').map((a) => [a.id, a]));
            for (const key of ['threeToFour', 'whiteBg', 'usp'] as const) {
              const names = original[key] || [];
              if (
                !Array.isArray(names) ||
                names.length > 5 ||
                names.some((name) => !safeImageName(name))
              )
                throw Error('图片清单格式不正确');
              p[key] = [...names];
              for (const name of names) {
                const id = original.images?.[name]?.id;
                if (id && known.has(id)) p.images[name] = { ...known.get(id)!, name };
              }
            }
          }
          const selected = await dialog.showSaveDialog(window!, {
            title: '导出含图片 Excel',
            defaultPath: path.join(
              app.getPath('documents'),
              `${p.code.replace(/[\\/:*?"<>|]/g, '-')}-含图片.xlsx`,
            ),
            filters: [{ name: 'Excel 商品资料', extensions: ['xlsx'] }],
          });
          if (selected.canceled || !selected.filePath) return null;
          const bytes = await measureLocal('生成含图片 Excel', () =>
            exportProductWorkbook(
              p,
              resource(
                'templates',
                isTaobaoProduct(p) ? '淘宝商品资料模板.xlsx' : '商品资料模板.xlsx',
              ),
              assetsDir(),
            ),
          );
          // Construct the complete file before replacing the operator's selected destination.
          const temporary = `${selected.filePath}.${randomUUID()}.tmp`;
          try {
            await fs.promises.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
            await fs.promises.rename(temporary, selected.filePath);
          } finally {
            await fs.promises.rm(temporary, { force: true }).catch(() => {});
          }
          shell.showItemInFolder(selected.filePath);
          return selected.filePath;
        } finally {
          exporting = false;
        }
      });
      store.onTaskChanged((task) => {
        if (window && !window.isDestroyed()) window.webContents.send('tasks:changed', task);
      });
      const shopService = new ShopService(store, timedEncryption, (id) =>
        store.all<Task>('tasks').some((t) => t.shopId === id && t.status === 'running'),
      );
      // Check provider support here; accessing the Keychain can require user authorization.
      // Only request the actual key while saving credentials, after the window is visible.
      const asyncStorage = safeStorage as typeof safeStorage & {
        encryptStringAsync?: (value: string) => Promise<Buffer>;
      };
      encryptionAvailable =
        ['darwin', 'win32'].includes(process.platform) &&
        typeof asyncStorage.encryptStringAsync === 'function';
      protocol.handle('media', (request) => {
        const url = new URL(request.url);
        const id = url.pathname.slice(1);
        if (
          url.hostname !== 'asset' ||
          !assetId.test(id) ||
          !store.all<Asset>('assets').some((a) => a.id === id)
        )
          return new Response('Not found', { status: 404 });
        return net.fetch(pathToFileURL(path.join(assetsDir(), id)).toString());
      });
      handler('workspace:load', workspace);
      handler('browser:connection', () => bridgeSetup.start());
      handler(
        'browser:export-extension',
        async () => {
          const result = await exportBrowserExtension(resource(), app.getPath('documents'));
          shell.showItemInFolder(result.folder);
          return result;
        },
        true,
      );
      handler(
        'browser:copy-extension-path',
        async () => {
          const result = await exportBrowserExtension(resource(), app.getPath('documents'));
          clipboard.writeText(result.folder);
          return result;
        },
        true,
      );
      handler('browser:guide', async () => {
        const error = await shell.openPath(resource('browser-extension', '安装指南.html'));
        if (error) throw new Error('教程未能打开，请查看 App 内的安装步骤');
      });
      handler('browser:help', () =>
        shell.openExternal('https://www.kimi.com/help/kimi-webbridge/kimi-webbridge-introduction'),
      );
      handler('browser:copy-address', async () => {
        const status = await bridgeSetup.check();
        clipboard.writeText(status.wsAddress);
      });
      handler('browser:copy-extension-page', (browser: string) => {
        if (!['chrome', 'edge'].includes(browser)) throw new Error('请选择 Chrome 或 Edge');
        clipboard.writeText(`${browser}://extensions/`);
      });
      handler('products:import', async (kind: string) => {
        if (importing) throw new Error('正在读取资料，请稍候');
        if (!['excel', 'folder', 'example'].includes(kind)) throw new Error('导入类型不正确');
        importing = true;
        try {
          let data: { files?: string[]; folder?: string; withImages: boolean };
          if (kind === 'example')
            data = {
              files: [
                resource('templates', '泡脚桶示例.xlsx'),
                resource('assets', 'foot-bath-main.png'),
                resource('assets', 'foot-bath-scene.png'),
              ],
              withImages: true,
            };
          else {
            const result = await dialog.showOpenDialog(window!, {
              title: kind === 'excel' ? '选择商品 Excel' : '选择商品资料文件夹',
              properties: kind === 'excel' ? ['openFile', 'multiSelections'] : ['openDirectory'],
              filters:
                kind === 'excel' ? [{ name: 'Excel 商品资料', extensions: ['xlsx'] }] : undefined,
            });
            if (result.canceled) return null;
            data =
              kind === 'excel'
                ? { files: result.filePaths, withImages: false }
                : { folder: result.filePaths[0], withImages: true };
          }
          const result = await measureLocal('Excel识别及图片提取', async () => {
            const r = await workerImport(data);
            store.saveAssets(r.assets);
            return r;
          });
          if (kind === 'example')
            for (const p of result.products)
              if (workspace().products.some((existing) => existing.code === p.code))
                p.code = `DEMO-FB-${Date.now().toString().slice(-8)}`;
          return result.products;
        } finally {
          importing = false;
        }
      });
      handler('products:supplement', async () => {
        const selected = await dialog.showOpenDialog(window!, {
          title: '补充商品图片',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: '商品图片', extensions: ['png', 'jpg', 'jpeg'] }],
        });
        if (selected.canceled) return null;
        if (selected.filePaths.length > 60) throw new Error('每次最多补充 60 张图片');
        const { saveImage } = await import('./importer');
        const assets: Asset[] = [];
        const imageIssues: string[] = [];
        for (const file of selected.filePaths) {
          try {
            assets.push(await saveImage(file, assetsDir()));
          } catch (error) {
            imageIssues.push((error as Error).message);
          }
        }
        if (imageIssues.length)
          throw Object.assign(
            new Error(`所选图片未添加，${imageIssues.length} 张图片无法读取，请查看完整列表`),
            { imageIssues },
          );
        store.saveAssets(assets);
        return assets;
      });
      const guardAgent = () => {
        if (collector?.busy) throw new Error('正在采集店铺商品，请等待采集结束或停止采集');
        if (shopLoginBusy) throw new Error('正在登录并核对店铺，请等待登录结束');
        if (agent.busy) throw new Error('Agent 正在读取和诊断任务，请等待诊断结束');
      };
      collector = new ShopCollector(
        path.join(app.getPath('userData'), 'collection-cache'),
        resource('templates', '商品资料模板.xlsx'),
        decryptShopPassword,
        (state) => {
          if (window && !window.isDestroyed()) window.webContents.send('collection:changed', state);
        },
        (shop) =>
          store
            .all<Shop>('shops')
            .some(
              (current) =>
                current.id === shop.id &&
                current.updatedAt === shop.updatedAt &&
                normalizePlatform(current.platform) === 'pdd',
            ),
      );
      handler('collection:state', () => collector.state);
      handler('collection:cancel', () => collector.cancel());
      handler(
        'collection:list',
        async (id: unknown) => {
          guardAgent();
          if (runner.isActive) throw Error('请等待当前商品任务结束，再采集店铺');
          const shop = store.all<Shop>('shops').find((s) => s.id === id);
          if (!shop?.credentialsSaved) throw Error('请先到店铺管理保存账号密码');
          requireEnabledPlatform(shop.platform);
          return collector.list(shop);
        },
        true,
      );
      handler(
        'collection:export',
        async (ids: unknown) => {
          guardAgent();
          if (runner.isActive) throw Error('请等待当前商品任务结束，再导出店铺商品');
          if (
            !Array.isArray(ids) ||
            !ids.length ||
            ids.length > 50 ||
            ids.some((id) => typeof id !== 'string') ||
            new Set(ids).size !== ids.length
          )
            throw Error('一次请选择 1 至 50 件商品导出');
          if (ids.some((id) => !collector.state.goods.some((g) => g.goodsId === id)))
            throw Error('所选商品不在当前店铺列表');
          const single = ids.length === 1;
          const name = collector.state.shopName.replace(/[\\/:*?"<>|]/g, '-').slice(0, 40);
          const selected = await dialog.showSaveDialog(window!, {
            title: single ? '保存商品 Excel' : '保存商品 Excel 压缩包',
            defaultPath: path.join(
              app.getPath('documents'),
              `${name}-${single ? ids[0] : '商品资料'}-${Date.now()}.${single ? 'xlsx' : 'zip'}`,
            ),
            filters: [
              {
                name: single ? '含图片 Excel' : 'Excel 压缩包',
                extensions: [single ? 'xlsx' : 'zip'],
              },
            ],
          });
          if (selected.canceled || !selected.filePath) return null;
          guardAgent();
          return collector.export(ids, selected.filePath);
        },
        true,
      );
      handler('collection:folder', () => {
        if (collector.state.outputPath && fs.existsSync(collector.state.outputPath))
          shell.showItemInFolder(collector.state.outputPath);
      });
      handler(
        'products:save',
        (input: unknown) =>
          measureLocal('保存本机商品资料', async () => {
            guardAgent();
            store.saveProducts(sanitizeProducts(store, input));
            return workspace();
          }),
        true,
      );
      handler(
        'shops:save',
        async (raw: ShopInput) => {
          guardAgent();
          await shopService.save(raw);
          return workspace();
        },
        true,
      );
      handler(
        'shops:login',
        async (input: { id: string; mode: 'relogin' | 'check' }) => {
          guardAgent();
          if (runner.isActive) throw new Error('请先停止商品任务，再切换登录账号');
          if (!input || typeof input.id !== 'string' || !['relogin', 'check'].includes(input.mode))
            throw new Error('登录参数不正确');
          const shop = store.all<Shop>('shops').find((s) => s.id === input.id);
          if (!shop?.credentialsSaved) throw new Error('请先保存店铺账号密码');
          requireEnabledPlatform(shop.platform);
          if (input.mode === 'check' && lastLoginShopId !== shop.id)
            throw new Error('请先开始该店铺的重新登录');
          await requireBrowser(shop.platform);
          guardAgent();
          if (runner.isActive) throw new Error('请先停止商品任务，再切换登录账号');
          // Recheck after connection detection, then reserve the browser before login work.
          shopLoginBusy = true;
          lastLoginShopId = shop.id;
          const start = performance.now();
          const result: ShopLoginResult = {
            shopId: shop.id,
            status: 'running',
            message: '正在连接浏览器',
            startedAt: new Date().toISOString(),
            events: [],
          };
          const emit = () => {
            if (window && !window.isDestroyed())
              window.webContents.send('shops:login-changed', result);
          };
          emit();
          try {
            await platforms.forShop(shop).verifyLogin(shop, input.mode, (event) => {
              const index = result.events.findIndex(
                (e) => e.name === event.name && e.startedAt === event.startedAt,
              );
              if (index < 0) result.events.push(event);
              else result.events[index] = event;
              result.message = event.name;
              emit();
            });
            result.status = 'succeeded';
            result.message =
              normalizePlatform(shop.platform) === 'taobao'
                ? `已登录千牛并核对店铺“${shop.name}”`
                : shop.account.includes(':')
                  ? `已登录并核对“${shop.name}”及子账号`
                  : `已登录并核对“${shop.name}”；后台未提供可完整核对的登录账号`;
          } catch (error) {
            result.status = error instanceof ShopLoginError ? error.loginStatus : 'failed';
            result.errorCode = error instanceof ExecutionError ? error.code : undefined;
            result.message =
              error instanceof ExecutionError
                ? error.message
                : '登录操作未完成，请检查已连接浏览器和扩展连接后重试';
          } finally {
            result.durationMs = Math.round(performance.now() - start);
            shopLoginBusy = false;
            emit();
          }
          // Only status and step durations are recorded; credentials never leave the main process.
          fs.mkdirSync(path.join(app.getPath('userData'), 'login-records'), { recursive: true });
          fs.writeFileSync(
            path.join(app.getPath('userData'), 'login-records', `${Date.now()}.json`),
            JSON.stringify(result, null, 2),
            { mode: 0o600 },
          );
          return result;
        },
        true,
      );
      handler(
        'tasks:prepare',
        (input: { shopId: string; productIds: string[] }) =>
          measureLocal('选择店铺并建立任务', async () => {
            guardAgent();
            if (runner.isActive) throw new Error('已连接浏览器正在执行，请等待当前任务结束');
            await requireBrowser(
              store.all<Shop>('shops').find((s) => s.id === input?.shopId)?.platform,
            );
            guardAgent();
            if (runner.isActive) throw new Error('已连接浏览器正在执行，请等待当前任务结束');
            const taskIds = prepareTasks(store, input);
            return { workspace: workspace(), taskIds };
          }),
        true,
      );
      handler(
        'tasks:run',
        async (ids: string[]) => {
          guardAgent();
          await requireBrowser(platformForTasks(ids));
          guardAgent();
          runner.start(ids);
          return workspace();
        },
        true,
      );
      handler(
        'tasks:resume',
        async (id: string) => {
          guardAgent();
          await requireBrowser(platformForTasks([id]));
          guardAgent();
          runner.start([id]);
          return workspace();
        },
        true,
      );
      handler(
        'tasks:restart',
        async (id: string) => {
          guardAgent();
          await requireBrowser(platformForTasks([id]));
          guardAgent();
          runner.start([id], true);
          return workspace();
        },
        true,
      );
      handler(
        'tasks:confirm-shop',
        (id: string) => {
          guardAgent();
          runner.confirmShop(id);
          return workspace();
        },
        true,
      );
      handler(
        'tasks:update-product',
        (id: string) => {
          guardAgent();
          runner.updateProduct(id);
          return workspace();
        },
        true,
      );
      handler(
        'tasks:stop',
        () => {
          runner.stop();
          return workspace();
        },
        true,
      );
      handler(
        'tasks:clear-records',
        (ids: string[]) => {
          guardAgent();
          runner.clearRecords(ids, true);
          return workspace();
        },
        true,
      );
      handler(
        'tasks:restore-records',
        (ids: string[]) => {
          guardAgent();
          runner.clearRecords(ids, false);
          return workspace();
        },
        true,
      );
      handler('agent:config', () => agent.config());
      handler('agent:save', (input: AgentConfigInput) => agent.save(input), true);
      handler('agent:test', (input: AgentConfigInput) => agent.test(input));
      handler('agent:diagnose', async (input: { id: string; includePage: boolean }) => {
        if (!input || typeof input.id !== 'string' || typeof input.includePage !== 'boolean')
          throw new Error('诊断参数不正确');
        await agent.diagnose(input.id, input.includePage);
        return workspace();
      });
      handler(
        'agent:confirm',
        (input: { id: string; diagnosisId: string; proposalIndex: number }) => {
          guardAgent();
          if (!input || typeof input.id !== 'string' || typeof input.diagnosisId !== 'string')
            throw new Error('确认参数不正确');
          const proposal = agent.proposal(input.id, input.diagnosisId, input.proposalIndex);
          if (proposal.action !== 'resume' && proposal.action !== 'readback')
            throw new Error('请在商品资料或已连接浏览器中核对并修改');
          const t = store.all<Task>('tasks').find((t) => t.id === input.id)!;
          t.logs = [
            ...(t.logs || []),
            {
              time: new Date().toISOString(),
              message: `运营确认 Agent 建议：${proposal.action === 'readback' ? '核对原草稿' : '继续原任务'}`,
            },
          ];
          store.updateTask(t);
          runner.start([input.id]);
          return workspace();
        },
        true,
      );
      handler('tasks:evidence', async (id: string) => {
        const t = store.all<Task>('tasks').find((t) => t.id === id);
        if (!t?.evidence) throw new Error('尚无草稿保存截图');
        await shell.openPath(t.evidence);
      });
      handler(
        'template:download',
        async (input: { kind?: 'blank' | 'example'; platform?: unknown } = {}) => {
          const kind = input?.kind === 'example' ? 'example' : 'blank';
          const platform = normalizePlatform(input?.platform);
          requireEnabledPlatform(platform);
          // 拼多多与天猫的发品表单字段不同，模板不能通用，各带一份。
          const names: Record<string, { blank: string; example: string }> = {
            pdd: { blank: '商品资料模板.xlsx', example: '商品资料示例.xlsx' },
            taobao: { blank: '淘宝商品资料模板.xlsx', example: '淘宝商品资料示例.xlsx' },
          };
          const name = (names[platform] || names.pdd)[kind];
          const label = platformMeta(platform).label;
          const result = await dialog.showSaveDialog(window!, {
            title: kind === 'example' ? `保存${label}商品资料示例` : `保存${label}商品资料模板`,
            defaultPath: path.join(app.getPath('downloads'), name),
            filters: [{ name: 'Excel', extensions: ['xlsx'] }],
          });
          if (result.canceled || !result.filePath) return false;
          const source = resource('templates', name);
          if (!fs.existsSync(source)) throw new Error(`安装包缺少${label}模板文件：${name}`);
          fs.copyFileSync(source, result.filePath);
          return true;
        },
      );
      handler('workspace:folder', async () => {
        await shell.openPath(app.getPath('userData'));
      });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          ...(process.platform === 'darwin'
            ? [
                {
                  label: '商品运营台',
                  submenu: [
                    { role: 'about' as const },
                    { type: 'separator' as const },
                    { role: 'quit' as const },
                  ],
                },
              ]
            : []),
          {
            label: '编辑',
            submenu: [
              { role: 'undo' },
              { role: 'redo' },
              { type: 'separator' },
              { role: 'cut' },
              { role: 'copy' },
              { role: 'paste' },
              { role: 'selectAll' },
            ],
          },
          {
            label: '显示',
            submenu: [
              { role: 'reload' },
              { role: 'resetZoom' },
              { role: 'zoomIn' },
              { role: 'zoomOut' },
              { role: 'togglefullscreen' },
            ],
          },
        ]),
      );
      await createWindow();
      await acknowledgeAutomaticInstall(
        path.join(app.getPath('userData'), 'updates'),
        app.getVersion(),
        app.getPath('exe'),
      );
      try {
        const resultFile = path.join(app.getPath('userData'), 'updates/install-result.json');
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, ''));
        if (result.status === 'error') {
          fs.renameSync(resultFile, `${resultFile}.${Date.now()}.handled`);
          void dialog.showMessageBox(window!, {
            type: 'error',
            title: '自动更新未完成',
            message: '请重试更新或选择手动安装，已保存的商品与店铺数据保留。',
          });
        }
      } catch {
        /* No previous installation failure. */
      }
      void updater.check();
      updateTimer = setInterval(
        () => {
          if (
            !installingUpdate &&
            !['ready', 'downloading', 'checking'].includes(updater.state.status)
          )
            void updater.check();
        },
        30 * 60 * 1000,
      );
      updateTimer.unref();
      app.on('activate', () => {
        if (!window) void createWindow();
      });
    })
    .catch(() => {
      dialog.showErrorBox(
        '启动失败',
        '本机资料库无法打开。请保留应用数据并检查磁盘空间或文件权限。',
      );
      app.quit();
    });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    collector?.cancel();
    if (updateTimer) clearInterval(updateTimer);
    updater?.cancel();
    store?.close();
  });
}

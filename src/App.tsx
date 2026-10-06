import { useDeferredValue, useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArrowRight,
  Boxes,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  Download,
  FileSpreadsheet,
  FolderOpen,
  Globe,
  HardDrive,
  Inbox,
  LoaderCircle,
  Plus,
  Search,
  SlidersHorizontal,
  Store,
  Upload,
  X,
} from 'lucide-react';
import type { BrowserConnectionStatus, Product, Shop, TaskUpdate, Workspace } from './types';
import { TaskRecords } from './TaskRecords';
import { TaskProgress } from './TaskProgress';
import { batchProgress, taskIsHistory } from './task-progress';
import { AgentSettings } from './AgentSettings';
import { ShopLogin } from './ShopLogin';
import { BrowserSetup } from './BrowserSetup';
import { lowestPrice, problems } from './domain';
import { productList } from './product-list';
import { mergeWorkspace, applyTaskUpdate } from './workspace-state';
import { TemplateDownload } from './TemplateDownload';
import { Modal, Recognition, ShopEditor, ShopManagement, ShopPicker, Status } from './components';

type Page = 'products' | 'shops' | 'tasks';
const pages: Record<Page, string> = { products: '商品资料', shops: '店铺管理', tasks: '执行记录' };
const initial: Workspace = {
  products: [],
  shops: [],
  tasks: [],
  version: '',
  encryptionAvailable: false,
};
const progressStorage = 'goods-execution-progress-v1';
function savedProgressIds(): string[] {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(progressStorage) || '[]');
    return Array.isArray(ids) && ids.length <= 200 && ids.every((id) => typeof id === 'string')
      ? [...new Set(ids)]
      : [];
  } catch {
    return [];
  }
}
export default function App() {
  const [data, setData] = useState(initial);
  const [page, setPage] = useState<Page>('products');
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(new Set<string>());
  const [pending, setPending] = useState<Product[] | null>(null);
  const [activeShopId, setActiveShopId] = useState('');
  const [loginShop, setLoginShop] = useState<Shop | null>(null);
  const [browserStatus, setBrowserStatus] = useState<BrowserConnectionStatus | null>(null);
  const [browserSetup, setBrowserSetup] = useState(false);
  const [checkingBrowser, setCheckingBrowser] = useState(false);
  const [agentSettings, setAgentSettings] = useState(false);
  const [shopEditor, setShopEditor] = useState<Shop | 'new' | null>(null);
  const [picking, setPicking] = useState(false);
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [fatal, setFatal] = useState('');
  const [listPage, setListPage] = useState(0);
  const [savingTemplate, setSavingTemplate] = useState<'blank' | 'example' | null>(null);
  const [folderPending, setFolderPending] = useState(false);
  const [progressIds, setProgressIds] = useState(savedProgressIds);
  const [progressOpen, setProgressOpen] = useState(false);
  const restoredProgress = useRef(false);
  const latestUpdates = useRef(new Map<string, TaskUpdate>());
  const browserCheck = useRef<Promise<BrowserConnectionStatus> | null>(null);
  const checkBrowser = async (showMissing = false, silent = false) => {
    if (!silent) setCheckingBrowser(true);
    const request = browserCheck.current || window.desktop.browserConnection();
    browserCheck.current = request;
    try {
      const status = await request;
      setBrowserStatus(status);
      if (showMissing && status.state !== 'ready') setBrowserSetup(true);
    } catch {
      setBrowserStatus({
        state: 'service_unavailable',
        message: '连接检测未完成，请重新检测。',
        httpAddress: 'http://127.0.0.1:10086',
        wsAddress: 'ws://127.0.0.1:10086/ws',
      });
      if (showMissing) setBrowserSetup(true);
    } finally {
      if (browserCheck.current === request) browserCheck.current = null;
      if (!silent) setCheckingBrowser(false);
    }
  };
  const showBrowserSetup = () => {
    setBrowserSetup(true);
    void checkBrowser();
  };
  const acceptWorkspace = (incoming: Workspace) =>
    setData((previous) => mergeWorkspace(previous, incoming, latestUpdates.current));
  const refresh = async () => {
    const workspace = await window.desktop.load();
    acceptWorkspace(workspace);
    return workspace;
  };
  useEffect(() => {
    if (!window.desktop) {
      setFatal('请从商品运营台桌面应用打开，此页面需要本机文件与数据服务。');
      setLoading(false);
      return;
    }
    let alive = true;
    const unsubscribe = window.desktop.onTaskChanged((update) => {
      const last = latestUpdates.current.get(update.id);
      if (last && (last.revision || 0) >= (update.revision || 0)) return;
      latestUpdates.current.set(update.id, update);
      if (
        alive &&
        (update.error?.code === 'browser_unavailable' ||
          update.error?.message.includes('浏览器连接已断开')) &&
        update.error?.message !== last?.error?.message
      )
        void checkBrowser(true);
      if (alive) setData((previous) => applyTaskUpdate(previous, update));
    });
    void window.desktop
      .load()
      .then((d) => {
        if (alive) acceptWorkspace(d);
      })
      .catch((e) => {
        if (alive) setFatal(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    void checkBrowser(true);
    const refreshConnection = () => {
      if (alive && document.visibilityState === 'visible') void checkBrowser(false, true);
    };
    window.addEventListener('focus', refreshConnection);
    const connectionTimer = window.setInterval(refreshConnection, 15000);
    return () => {
      alive = false;
      unsubscribe();
      window.removeEventListener('focus', refreshConnection);
      window.clearInterval(connectionTimer);
    };
  }, []);
  const running = data.tasks.some(
    (t) => t.status === 'running' || t.agentDiagnosis?.status === 'running',
  );
  const progress = batchProgress(data.tasks, progressIds);
  const openProgress = (ids: string[]) => {
    setProgressIds(ids);
    setProgressOpen(true);
    setPage('products');
    try {
      localStorage.setItem(progressStorage, JSON.stringify(ids));
    } catch {
      /* In-memory progress remains available. */
    }
  };
  useEffect(() => {
    if (loading || restoredProgress.current) return;
    restoredProgress.current = true;
    if (progress.active) setProgressOpen(true);
  }, [loading, !!progress.active]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    setListPage(0);
  }, [filter, deferred]);
  const { readyCount, visible, pageCount, currentPage, rows, readyRows, chosen } = productList(
    data.products,
    deferred,
    filter,
    listPage,
    selected,
  );
  const importData = async (kind: 'excel' | 'folder') => {
    if (busy) return;
    setBusy(true);
    try {
      const products = await window.desktop.importData(kind);
      if (products) setPending(products);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string, checked: boolean) =>
    setSelected((old) => {
      const next = new Set(old);
      checked ? next.add(id) : next.delete(id);
      return next;
    });
  const download = async (kind: 'blank' | 'example') => {
    if (savingTemplate) return;
    setSavingTemplate(kind);
    try {
      if (await window.desktop.downloadTemplate(kind))
        setNotice(
          kind === 'example'
            ? '填写示例已保存，内含示例数据和图片，供填写时参考'
            : '空白 Excel 模板已保存，填写后可从“上传 Excel”导入',
        );
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setSavingTemplate(null);
    }
  };
  const downloadButtons = (
    <div className="button-group">
      <button
        className="button"
        disabled={!!savingTemplate || loading || !!fatal}
        aria-busy={savingTemplate === 'blank'}
        onClick={() => download('blank')}
      >
        <Download size={16} aria-hidden="true" />
        {savingTemplate === 'blank' ? '正在保存模板…' : '下载 Excel 模板'}
      </button>
      <button
        className="button"
        disabled={!!savingTemplate || loading || !!fatal}
        aria-busy={savingTemplate === 'example'}
        onClick={() => download('example')}
      >
        <Download size={16} aria-hidden="true" />
        {savingTemplate === 'example' ? '正在保存示例…' : '下载填写示例'}
      </button>
    </div>
  );
  const startProducts = async (shopId: string) => {
    try {
      const prepared = await window.desktop.prepareTasks({
        shopId,
        productIds: chosen.map((p) => p.id),
      });
      acceptWorkspace(prepared.workspace);
      setPicking(false);
      setSelected(new Set());
      openProgress(prepared.taskIds);
      try {
        acceptWorkspace(await window.desktop.runTasks(prepared.taskIds));
        setNotice('已开始在已连接浏览器填写商品并保存草稿');
      } catch (e) {
        setNotice((e as Error).message);
        if ((e as Error).message.includes('浏览器连接未就绪')) await checkBrowser(true);
      }
    } catch (e) {
      if ((e as Error).message.includes('浏览器连接未就绪')) await checkBrowser(true);
      throw e;
    }
  };
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Boxes size={22} />
          </span>
          <div>
            <strong>商品运营台</strong>
            <span>GOODS WORKSPACE</span>
          </div>
        </div>
        <div className="workspace-label">工作空间</div>
        <nav aria-label="主导航">
          {(
            [
              { id: 'products', Icon: Boxes },
              { id: 'shops', Icon: Store },
              { id: 'tasks', Icon: ClipboardList },
            ] as const
          ).map(({ id, Icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? 'active' : ''}`}
              aria-current={page === id ? 'page' : undefined}
              onClick={() => setPage(id)}
            >
              <Icon size={19} />
              <span>{pages[id]}</span>
              {id === 'products' && data.products.length ? (
                <span className="nav-count">{data.products.length}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-local">
            <div className="local-status">
              <span className="dot" aria-hidden="true" />
              本机工作空间
            </div>
            <p>资料保存在这台电脑</p>
          </div>
          <div className="sidebar-tools">
            <button className="sidebar-link" onClick={showBrowserSetup}>
              <Globe size={14} aria-hidden="true" />
              {checkingBrowser
                ? '检测浏览器连接…'
                : browserStatus?.state === 'ready'
                  ? '浏览器已连接'
                  : '浏览器连接 · 安装教程'}
            </button>
            <button
              className="sidebar-link"
              disabled={loading || !!fatal || running}
              onClick={() => setAgentSettings(true)}
            >
              <SlidersHorizontal size={14} aria-hidden="true" />
              Agent 模型设置
            </button>
            <button
              className="sidebar-link"
              onClick={() => {
                if (window.desktop)
                  void window.desktop.showDataFolder().catch((e) => setNotice(e.message));
              }}
            >
              <FolderOpen size={14} aria-hidden="true" />
              打开资料目录
            </button>
          </div>
        </div>
      </aside>
      <div className="shell">
        <header className="topbar">
          <span>
            工作空间 <ChevronRight size={13} /> <strong>{pages[page]}</strong>
          </span>
          <span className="draft-mode">
            <Archive size={14} />
            草稿模式
          </span>
        </header>
        <main>
          {fatal ? (
            <div className="error-message" role="alert">
              {fatal}
            </div>
          ) : null}
          {loading ? (
            <div className="loading">
              <LoaderCircle size={22} className="spin" />
              正在打开本机资料库…
            </div>
          ) : null}
          {page === 'products' ? (
            <>
              <div className="page-heading">
                <div>
                  <h1>商品资料</h1>
                  <p>导入、确认、保存，然后选择你的店铺。</p>
                </div>
                <button className="button" onClick={() => setHelp(true)}>
                  <CircleHelp size={16} />
                  模板下载
                </button>
              </div>
              {progress.tasks.length ? (
                <section className="execution-banner" aria-label="商品执行进度入口">
                  <div>
                    <strong>
                      {progress.active
                        ? '商品正在执行'
                        : progress.finished
                          ? '本次草稿已保存'
                          : '本次执行需要继续处理'}
                    </strong>
                    <p>
                      {progress.tasks[0].shopName} · 已保存 {progress.completed} /{' '}
                      {progress.tasks.length} 件
                      {progress.active ? ` · ${progress.active.phase || '正在执行'}` : ''}
                    </p>
                  </div>
                  <button className="button" onClick={() => setProgressOpen(true)}>
                    查看执行进度
                  </button>
                </section>
              ) : null}
              <ol className="steps">
                {['导入资料', '确认识别结果', '保存商品资料', '选择店铺'].map((step, i) => (
                  <li
                    key={step}
                    className={i === (pending ? 1 : data.products.length ? 2 : 0) ? 'current' : ''}
                  >
                    <span>{i + 1}</span>
                    {step}
                    {i < 3 ? <div className="step-line" /> : null}
                  </li>
                ))}
              </ol>
              <section className={`import-panel ${busy ? 'busy' : ''}`} aria-label="导入商品资料">
                <div className="import-header">
                  <span className="import-symbol">
                    <Upload size={23} />
                  </span>
                  <div>
                    <h2>让商品资料就位</h2>
                    <p>一个 Excel，带齐商品资料和图片。</p>
                  </div>
                </div>
                <div className="import-options">
                  <button
                    className="import-option"
                    disabled={busy || !!fatal || loading}
                    onClick={() => importData('excel')}
                  >
                    <span className="file-symbol">
                      <FileSpreadsheet size={25} />
                    </span>
                    <div>
                      <strong>上传 Excel</strong>
                      <span>读取商品、规格和内嵌图片</span>
                    </div>
                    <ArrowRight size={18} />
                  </button>
                  <button
                    className="import-option"
                    disabled={busy || !!fatal || loading}
                    onClick={() => setFolderPending(true)}
                  >
                    <span className="file-symbol folder">
                      <FolderOpen size={25} />
                    </span>
                    <div>
                      <strong>选择文件夹</strong>
                      <span>一起匹配表格、主图和详情图</span>
                    </div>
                    <ArrowRight size={18} />
                  </button>
                </div>
                <div className="import-bottom">
                  <span>
                    {busy ? (
                      <>
                        <LoaderCircle size={14} className="spin" />
                        正在识别资料，请稍候…
                      </>
                    ) : (
                      '支持单规格、多规格 .xlsx · 内嵌图片按用途和顺序自动识别'
                    )}
                  </span>
                  {downloadButtons}
                </div>
              </section>
              <section className="library" aria-label="已保存商品">
                <div className="library-heading">
                  <div>
                    <h2>
                      已保存商品 <span className="count-pill">{data.products.length}</span>
                    </h2>
                    <p>核对资料后，勾选商品并选择目标店铺。</p>
                  </div>
                  <label className="search">
                    <Search size={17} />
                    <input
                      aria-label="搜索商品"
                      placeholder="搜索商品名称或编码"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    {search ? (
                      <button
                        className="icon-button small"
                        aria-label="清空搜索"
                        onClick={() => setSearch('')}
                      >
                        <X size={14} />
                      </button>
                    ) : null}
                  </label>
                </div>
                <div className="filters" aria-label="商品筛选">
                  {[
                    ['all', '全部商品', data.products.length],
                    ['ready', '本机检查通过', readyCount],
                    ['incomplete', '待补充', data.products.length - readyCount],
                  ].map(([key, label, n]) => (
                    <button
                      key={key}
                      aria-pressed={filter === key}
                      className={filter === key ? 'active' : ''}
                      onClick={() => setFilter(String(key))}
                    >
                      {label}
                      <span>{n}</span>
                    </button>
                  ))}
                </div>
                {rows.length ? (
                  <div className="table-scroll">
                    <table className="products-table">
                      <thead>
                        <tr>
                          <th className="check-cell">
                            <input
                              type="checkbox"
                              aria-label="选择本页本机检查通过的商品"
                              checked={
                                readyRows.length > 0 && readyRows.every((p) => selected.has(p.id))
                              }
                              disabled={!readyRows.length}
                              onChange={(e) => {
                                const check = e.target.checked;
                                setSelected((old) => {
                                  const next = new Set(old);
                                  readyRows.forEach((p) =>
                                    check ? next.add(p.id) : next.delete(p.id),
                                  );
                                  return next;
                                });
                              }}
                            />
                          </th>
                          <th>商品</th>
                          <th>规格与价格</th>
                          <th>资料状态</th>
                          <th className="align-right">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((p) => {
                          const issues = problems(p);
                          const image = p.images[p.main[0]];
                          return (
                            <tr key={p.id}>
                              <td className="check-cell">
                                <input
                                  type="checkbox"
                                  aria-label={`选择 ${p.title || p.code}`}
                                  checked={selected.has(p.id) && !issues.length}
                                  disabled={!!issues.length}
                                  onChange={(e) => toggle(p.id, e.target.checked)}
                                />
                              </td>
                              <td>
                                <div className="product-info">
                                  {image ? (
                                    <img src={image.url} alt={p.title} width={54} height={54} />
                                  ) : (
                                    <span className="product-placeholder">
                                      <Boxes size={21} />
                                    </span>
                                  )}
                                  <div>
                                    <strong>{p.title || '商品标题待补充'}</strong>
                                    <span>{p.code}</span>
                                  </div>
                                </div>
                              </td>
                              <td>
                                <div className="price">
                                  {lowestPrice(p)}
                                  <span>{p.skus.length} 个规格</span>
                                </div>
                              </td>
                              <td>
                                <Status complete={!issues.length} />
                                <span className="cell-detail">
                                  {issues.length
                                    ? `${issues.length} 项待处理`
                                    : `${p.main.length} 张主图 · ${p.detail.length} 张详情图`}
                                </span>
                              </td>
                              <td className="align-right">
                                <button
                                  className="text-button"
                                  onClick={() => setPending([structuredClone(p)])}
                                >
                                  编辑资料
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="empty">
                    <span className="empty-symbol">
                      <Inbox size={34} />
                    </span>
                    <h3>{data.products.length ? '没有匹配的商品' : '第一件商品，从这里开始'}</h3>
                    <p>
                      {data.products.length
                        ? '调整搜索或筛选，查看已保存资料。'
                        : '导入资料后确认保存，商品会显示在这里。'}
                    </p>
                  </div>
                )}
                {pageCount > 1 ? (
                  <div className="pagination">
                    <span>
                      第 {currentPage + 1} / {pageCount} 页
                    </span>
                    <button
                      className="icon-button"
                      aria-label="上一页"
                      disabled={!currentPage}
                      onClick={() => setListPage((p) => p - 1)}
                    >
                      <ChevronLeft size={17} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="下一页"
                      disabled={currentPage === pageCount - 1}
                      onClick={() => setListPage((p) => p + 1)}
                    >
                      <ChevronRight size={17} />
                    </button>
                  </div>
                ) : null}
              </section>
              <div className="batch-bar">
                <div>
                  <strong>已选择 {chosen.length} 件商品</strong>
                  <span>
                    {chosen.length
                      ? '选择目标店铺，在已连接浏览器填写并保存草稿。'
                      : '勾选本机检查通过的商品后，继续下一步。'}
                  </span>
                </div>
                <button
                  className="button primary"
                  disabled={!chosen.length || running}
                  onClick={() => setPicking(true)}
                >
                  选择店铺 <ArrowRight size={16} />
                </button>
              </div>
            </>
          ) : null}
          {page === 'shops' ? (
            <ShopManagement
              shops={data.shops}
              selectedId={activeShopId}
              onSelect={setActiveShopId}
              onAdd={() => setShopEditor('new')}
              onEdit={setShopEditor}
              onLogin={setLoginShop}
              disabled={!!fatal || loading || running}
            />
          ) : null}
          {page === 'tasks' ? (
            <>
              <div className="page-heading">
                <div>
                  <h1>执行记录</h1>
                  <p>查看历史结果、失败原因和处理过程，历史记录不影响重新执行。</p>
                </div>
                <span className="count-pill">
                  {data.tasks.filter((t) => !t.clearedAt && taskIsHistory(t)).length} 条记录
                </span>
              </div>
              {data.tasks.length ? (
                <TaskRecords
                  data={data}
                  onWorkspace={acceptWorkspace}
                  onNotice={setNotice}
                  onOpenProgress={(id) =>
                    openProgress(progressIds.includes(id) ? progressIds : [id])
                  }
                />
              ) : (
                <div className="empty page-empty">
                  <span className="empty-symbol">
                    <ClipboardList size={34} />
                  </span>
                  <h3>还没有执行记录</h3>
                  <p>保存商品资料、选择店铺后，历史结果会显示在这里。</p>
                  <button className="text-button" onClick={() => setPage('products')}>
                    去导入商品 <ArrowRight size={14} />
                  </button>
                </div>
              )}
            </>
          ) : null}
        </main>
        <footer className="statusbar">
          <span>
            <HardDrive size={13} />
            本机资料库 <span className="status-divider">·</span> 桌面版 {data.version}
          </span>
          <span>
            {data.tasks.some((t) => t.agentDiagnosis?.status === 'running')
              ? 'Agent 正在处理页面异常'
              : running
                ? '已连接浏览器执行中'
                : '保存到拼多多草稿箱'}
          </span>
        </footer>
      </div>
      {loginShop ? (
        <ShopLogin
          shop={loginShop}
          onClose={() => setLoginShop(null)}
          onEdit={() => {
            setShopEditor(loginShop);
            setLoginShop(null);
          }}
          onBrowserSetup={showBrowserSetup}
        />
      ) : null}
      {agentSettings ? <AgentSettings onClose={() => setAgentSettings(false)} /> : null}
      {notice ? (
        <div className="toast" role="status">
          <CircleHelp size={16} />
          <span>{notice}</span>
          <button aria-label="关闭提示" className="icon-button small" onClick={() => setNotice('')}>
            <X size={14} />
          </button>
        </div>
      ) : null}
      {pending ? (
        <Recognition
          initial={pending}
          existing={data.products}
          onClose={() => setPending(null)}
          onSaved={async () => {
            await refresh();
            setPage('products');
            setNotice('商品资料已保存');
          }}
        />
      ) : null}
      {shopEditor ? (
        <ShopEditor
          initial={shopEditor === 'new' ? undefined : shopEditor}
          encryptionAvailable={data.encryptionAvailable}
          onClose={() => setShopEditor(null)}
          onSaved={async (shopId) => {
            await refresh();
            setActiveShopId(shopId);
            setNotice('店铺登录信息已保存');
          }}
        />
      ) : null}
      {picking ? (
        <ShopPicker
          shops={data.shops}
          count={chosen.length}
          encryptionAvailable={data.encryptionAvailable}
          onShopSaved={async (shopId) => {
            await refresh();
            setActiveShopId(shopId);
            setNotice('店铺已保存并选中');
          }}
          onClose={() => setPicking(false)}
          onPrepared={startProducts}
        />
      ) : null}
      {progressOpen ? (
        <TaskProgress
          data={data}
          ids={progressIds}
          onClose={() => setProgressOpen(false)}
          onWorkspace={acceptWorkspace}
          onNotice={setNotice}
          onEditProduct={(p) => {
            setProgressOpen(false);
            setPending([structuredClone(p)]);
          }}
          onConfigureAgent={() => {
            setProgressOpen(false);
            setAgentSettings(true);
          }}
          onBrowserSetup={showBrowserSetup}
        />
      ) : null}
      {browserSetup ? (
        <BrowserSetup
          status={browserStatus}
          checking={checkingBrowser}
          onCheck={() => checkBrowser()}
          onClose={() => setBrowserSetup(false)}
        />
      ) : null}
      {folderPending ? (
        <Modal
          title="待开发"
          onClose={() => setFolderPending(false)}
          footer={
            <button
              className="button primary"
              data-autofocus
              onClick={() => setFolderPending(false)}
            >
              知道了
            </button>
          }
        >
          <div className="modal-body">
            <p>选择文件夹功能待开发，请先使用“上传 Excel”导入商品资料。</p>
          </div>
        </Modal>
      ) : null}
      {help ? <TemplateDownload onClose={() => setHelp(false)} actions={downloadButtons} /> : null}
    </div>
  );
}

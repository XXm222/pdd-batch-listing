import { useDeferredValue, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  Plus,
  X,
  Download,
  FolderOpen,
  Image,
  LoaderCircle,
  RefreshCw,
  Search,
  Square,
  Store,
} from 'lucide-react';
import { Modal } from './components';
import { normalizePlatform } from './platforms';
import type { CollectionState, Shop } from './types';

const empty: CollectionState = {
  shopId: '',
  shopName: '',
  status: 'idle',
  message: '',
  goods: [],
  completeList: false,
  completed: 0,
  total: 0,
};
export function ShopCollection({
  shops,
  disabled,
  onAdd,
  onBrowserSetup,
}: {
  shops: Shop[];
  disabled: boolean;
  onAdd: () => void;
  onBrowserSetup: () => void;
}) {
  const [state, setState] = useState(empty);
  const [selected, setSelected] = useState(new Set<string>());
  const [query, setQuery] = useState('');
  const search = useDeferredValue(query.trim().toLowerCase());
  const [page, setPage] = useState(0);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(false);
  const previous = useRef(empty);
  useEffect(() => {
    let alive = true;
    const accept = (next: CollectionState) => {
      if (!alive) return;
      if (
        next.shopId !== previous.current.shopId ||
        (next.status === 'listing' && previous.current.status !== 'listing')
      ) {
        setSelected(new Set());
        setPage(0);
        setQuery('');
      }
      if (next.status === 'exporting' && previous.current.status !== 'exporting') setProgress(true);
      previous.current = next;
      setState(next);
    };
    const off = window.desktop.onCollectionChanged(accept);
    void window.desktop
      .collectionState()
      .then(accept)
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
      off();
    };
  }, []);
  const active = ['listing', 'exporting'].includes(state.status),
    busy = active || requesting;
  const choices = shops.filter((s) => normalizePlatform(s.platform) === 'pdd');
  const filtered = state.goods.filter(
    (g) => !search || g.title.toLowerCase().includes(search) || g.goodsId.includes(search),
  );
  const lastPage = Math.max(0, Math.ceil(filtered.length / 50) - 1),
    current = Math.min(page, lastPage);
  const rows = filtered.slice(current * 50, current * 50 + 50);
  const allChecked = !!rows.length && rows.every((g) => selected.has(g.goodsId));
  const toggle = (ids: string[], checked: boolean) =>
    setSelected((old) => {
      const next = new Set(old);
      for (const id of ids) checked ? next.add(id) : next.delete(id);
      return next;
    });
  const load = async (id: string) => {
    if (!id) return;
    setError('');
    setSelected(new Set());
    setPage(0);
    setQuery('');
    setRequesting(true);
    try {
      const next = await window.desktop.collectShop(id);
      previous.current = next;
      setState(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRequesting(false);
    }
  };
  const exportGoods = async (ids: string[]) => {
    setError('');
    setRequesting(true);
    try {
      const result = await window.desktop.exportShopGoods(ids);
      if (result) {
        previous.current = result;
        setState(result);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRequesting(false);
    }
  };
  const failed = state.goods.filter((g) => g.status === 'failed').map((g) => g.goodsId);
  const queue = state.goods.filter((g) => state.exportIds?.includes(g.goodsId));
  const cancel = () => {
    void window.desktop.cancelCollection().catch((e) => setError(e.message));
  };
  const reading = state.status === 'listing';
  const hasGoods = state.goods.length > 0;
  const failure =
    error || (state.status === 'error' ? state.message || '商品列表未能读取，请重试。' : '');
  const partial = hasGoods && !state.completeList && !reading;
  const emptyFailure = !hasGoods && failure;
  return (
    <div className="collection-page">
      <div className="page-heading collection-heading">
        <div>
          <h1>店铺商品导出</h1>
          <p>选择店铺，勾选在售商品，导出自带图片的 Excel。</p>
        </div>
        <span className="collection-format">
          <FileSpreadsheet size={17} aria-hidden="true" />
          含图 Excel <span aria-hidden="true">·</span> 多件 ZIP
        </span>
      </div>
      <div className="collection-workspace">
        <section className="collection-controls" aria-label="选择来源店铺">
          <span className="collection-source-icon" aria-hidden="true">
            <Store size={22} />
          </span>
          <div className="collection-shop-field">
            <label htmlFor="collection-shop">来源店铺</label>
            <select
              id="collection-shop"
              value={state.shopId}
              disabled={busy || disabled || !choices.length}
              onChange={(e) => void load(e.target.value)}
            >
              <option value="">
                {choices.length ? '选择要导出的拼多多店铺' : '请先添加拼多多店铺'}
              </option>
              {choices.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="collection-source-actions">
            <button
              className="button"
              disabled={!state.shopId || busy || disabled}
              onClick={() => void load(state.shopId)}
            >
              <RefreshCw size={16} className={reading ? 'spin' : undefined} aria-hidden="true" />
              {reading ? '正在读取' : '重新读取'}
            </button>
            <button className="button" disabled={busy || disabled} onClick={onAdd}>
              <Plus size={16} aria-hidden="true" />
              添加店铺
            </button>
          </div>
        </section>
        <section className="collection-list" aria-label="在售商品列表" aria-busy={reading}>
          <div className="collection-list-heading">
            <div className="collection-list-title">
              <h2>在售商品</h2>
              {hasGoods || state.completeList ? (
                <span className="collection-count">{state.goods.length} 件</span>
              ) : null}
              <span
                className={`collection-list-state ${emptyFailure ? 'failed' : partial ? 'partial' : ''}`}
              >
                {reading
                  ? '读取中'
                  : emptyFailure
                    ? '读取失败'
                    : partial
                      ? '列表未完整'
                      : state.completeList
                        ? '列表已读取'
                        : '待读取'}
              </span>
            </div>
            <div className="search collection-search" role="search">
              <Search size={17} aria-hidden="true" />
              <input
                aria-label="搜索店铺商品"
                placeholder="搜索商品标题或编号"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(0);
                }}
                disabled={busy || !hasGoods}
              />
              {query ? (
                <button
                  className="icon-button small"
                  aria-label="清除搜索"
                  disabled={busy}
                  onClick={() => {
                    setQuery('');
                    setPage(0);
                  }}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </div>
          {reading && hasGoods ? (
            <div className="collection-notice" role="status">
              <LoaderCircle size={16} className="spin" aria-hidden="true" />
              <span>{state.message}</span>
              <button className="text-button" onClick={cancel}>
                停止读取
              </button>
            </div>
          ) : null}
          {failure && hasGoods ? (
            <div className="collection-notice error" role="alert">
              <AlertCircle size={17} aria-hidden="true" />
              <span>{failure}</span>
              <button className="text-button" onClick={onBrowserSetup}>
                检查浏览器连接
              </button>
            </div>
          ) : null}
          {!reading &&
          (state.status === 'exporting' ||
            (state.total > 0 && ['done', 'cancelled'].includes(state.status))) ? (
            <div className={`collection-notice ${state.status === 'done' ? 'success' : ''}`}>
              {state.status === 'exporting' ? (
                <LoaderCircle size={17} className="spin" aria-hidden="true" />
              ) : state.status === 'done' ? (
                <CheckCircle2 size={17} aria-hidden="true" />
              ) : (
                <Square size={16} aria-hidden="true" />
              )}
              <span role="status">{state.message}</span>
              {state.status === 'exporting' ? (
                <>
                  <button className="text-button" onClick={() => setProgress(true)}>
                    查看进度
                  </button>
                  <button className="text-button" onClick={cancel}>
                    停止导出
                  </button>
                </>
              ) : state.outputPath ? (
                <button
                  className="text-button"
                  onClick={() => void window.desktop.showCollectionFile()}
                >
                  <FolderOpen size={15} aria-hidden="true" />
                  查看文件
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="collection-list-body">
            {hasGoods && rows.length ? (
              <div className="collection-table-wrap">
                <table className="collection-table">
                  <thead>
                    <tr>
                      <th>
                        <label className="collection-check">
                          <input
                            type="checkbox"
                            aria-label="选择当前页全部商品"
                            checked={allChecked}
                            disabled={busy}
                            ref={(node) => {
                              if (node)
                                node.indeterminate =
                                  !allChecked && rows.some((g) => selected.has(g.goodsId));
                            }}
                            onChange={(e) =>
                              toggle(
                                rows.map((g) => g.goodsId),
                                e.target.checked,
                              )
                            }
                          />
                        </label>
                      </th>
                      <th>商品信息</th>
                      <th>后台显示价格</th>
                      <th>导出状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((g) => (
                      <tr
                        key={g.goodsId}
                        className={selected.has(g.goodsId) ? 'is-selected' : undefined}
                      >
                        <td>
                          <label className="collection-check">
                            <input
                              type="checkbox"
                              aria-label={`选择商品 ${g.goodsId}`}
                              checked={selected.has(g.goodsId)}
                              disabled={busy}
                              onChange={(e) => toggle([g.goodsId], e.target.checked)}
                            />
                          </label>
                        </td>
                        <td>
                          <div className="collection-product">
                            <span className="collection-thumbnail">
                              <Image size={22} aria-hidden="true" />
                              {g.thumbnail ? (
                                <img
                                  key={g.thumbnail}
                                  src={g.thumbnail}
                                  alt=""
                                  loading="lazy"
                                  decoding="async"
                                  onLoad={(e) => {
                                    e.currentTarget.dataset.loaded = 'true';
                                  }}
                                  onError={(e) => {
                                    delete e.currentTarget.dataset.loaded;
                                    e.currentTarget.style.display = 'none';
                                  }}
                                />
                              ) : null}
                            </span>
                            <div>
                              <strong title={g.title}>{g.title}</strong>
                              <small>商品编号 {g.goodsId}</small>
                            </div>
                          </div>
                        </td>
                        <td className="collection-price">
                          {g.price ? (
                            <span className="collection-price-value" title={g.price}>
                              {g.price}
                            </span>
                          ) : (
                            <span>导出时读取</span>
                          )}
                        </td>
                        <td>
                          <span className={`collection-status ${g.status || ''}`}>
                            {g.status === 'reading' ? (
                              <LoaderCircle size={13} className="spin" aria-hidden="true" />
                            ) : g.status === 'done' ? (
                              <CheckCircle2 size={13} aria-hidden="true" />
                            ) : g.status === 'failed' ? (
                              <AlertCircle size={13} aria-hidden="true" />
                            ) : null}
                            {g.status
                              ? (
                                  {
                                    waiting: '等待导出',
                                    reading: '正在读取',
                                    done: '已生成 Excel',
                                    failed: '导出失败',
                                    stopped: '已停止',
                                  } as const
                                )[g.status]
                              : '未导出'}
                          </span>
                          {g.message ? (
                            <small className="collection-row-message">{g.message}</small>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : reading ? (
              <div className="collection-loading">
                <div className="collection-skeleton" aria-hidden="true">
                  {[0, 1, 2].map((i) => (
                    <div key={i}>
                      <span />
                      <div>
                        <i />
                        <i />
                      </div>
                      <i />
                    </div>
                  ))}
                </div>
                <div className="collection-loading-copy">
                  <p role="status">{state.message || '正在读取店铺商品…'}</p>
                  <button className="text-button" onClick={cancel}>
                    停止读取
                  </button>
                </div>
              </div>
            ) : (
              <div className={`collection-empty ${emptyFailure ? 'has-error' : ''}`}>
                <span className="collection-empty-symbol" aria-hidden="true">
                  {emptyFailure ? (
                    <AlertCircle size={28} />
                  ) : hasGoods ? (
                    <Search size={28} />
                  ) : (
                    <Store size={28} />
                  )}
                </span>
                <h3>
                  {emptyFailure
                    ? '暂时无法读取商品'
                    : hasGoods
                      ? '没有匹配的商品'
                      : state.completeList
                        ? '这家店铺还没有在售商品'
                        : choices.length
                          ? '选择店铺，开始整理商品'
                          : '添加店铺，开始导出商品'}
                </h3>
                <p role={emptyFailure ? 'alert' : undefined}>
                  {emptyFailure ||
                    (hasGoods
                      ? '试试其他标题或商品编号，已勾选的商品会保留。'
                      : state.completeList
                        ? '可以重新读取，或切换另一家来源店铺。'
                        : choices.length
                          ? '在上方选择来源店铺，读取在售商品后，勾选需要导出的商品。'
                          : '先在店铺管理中保存拼多多账号，再选择商品导出。')}
                </p>
                <div className="collection-empty-actions">
                  {emptyFailure ? (
                    <>
                      <button
                        className="button"
                        disabled={!state.shopId || busy || disabled}
                        onClick={() => void load(state.shopId)}
                      >
                        <RefreshCw size={15} aria-hidden="true" />
                        重新读取
                      </button>
                      <button className="text-button" onClick={onBrowserSetup}>
                        检查浏览器连接
                      </button>
                    </>
                  ) : hasGoods ? (
                    <button
                      className="button"
                      onClick={() => {
                        setQuery('');
                        setPage(0);
                      }}
                    >
                      清除搜索条件
                    </button>
                  ) : !choices.length ? (
                    <button className="button primary" disabled={busy || disabled} onClick={onAdd}>
                      <Plus size={16} aria-hidden="true" />
                      添加拼多多店铺
                    </button>
                  ) : null}
                </div>
                {!emptyFailure && !hasGoods ? (
                  <div className="collection-empty-note">
                    <FileSpreadsheet size={15} aria-hidden="true" />
                    图片、价格与逐规格库存，一起保存在 Excel 中
                  </div>
                ) : null}
              </div>
            )}
          </div>
          {hasGoods && filtered.length ? (
            <div className="collection-pagination">
              <span>
                {search ? `找到 ${filtered.length} 件商品` : `共 ${state.goods.length} 件商品`}
                {lastPage > 0 ? ' · 勾选跨页保留' : ''}
              </span>
              {lastPage > 0 ? (
                <div>
                  <button
                    className="icon-button"
                    aria-label="上一页商品"
                    disabled={busy || !current}
                    onClick={() => setPage(current - 1)}
                  >
                    <ChevronLeft size={17} aria-hidden="true" />
                  </button>
                  <span>
                    {current + 1} / {lastPage + 1}
                  </span>
                  <button
                    className="icon-button"
                    aria-label="下一页商品"
                    disabled={busy || current === lastPage}
                    onClick={() => setPage(current + 1)}
                  >
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
        <div className="collection-batch-bar">
          <div className="collection-selection">
            <strong>
              {selected.size ? (
                <>
                  已选择 <b>{selected.size}</b> 件商品
                </>
              ) : (
                '勾选商品后，即可导出'
              )}
            </strong>
            <span
              className={selected.size > 50 ? 'collection-limit' : undefined}
              role={selected.size > 50 ? 'alert' : undefined}
            >
              {selected.size > 50
                ? '一次最多导出 50 件，请减少勾选数量。'
                : '每件一份含图 Excel，多件自动打包为 ZIP。'}
            </span>
          </div>
          <div className="collection-actions">
            {selected.size ? (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => setSelected(new Set())}
              >
                清空选择
              </button>
            ) : null}
            {failed.length ? (
              <button
                className="button"
                disabled={busy || disabled || failed.length > 50}
                onClick={() => void exportGoods(failed)}
              >
                重试失败商品
              </button>
            ) : null}
            <button
              className="button primary"
              disabled={busy || disabled || !selected.size || selected.size > 50}
              onClick={() => void exportGoods([...selected])}
            >
              <Download size={16} aria-hidden="true" />
              {selected.size ? `导出 ${selected.size} 件商品` : '导出所选商品'}
            </button>
          </div>
        </div>
      </div>
      {progress ? (
        <Modal
          className="collection-modal"
          title="商品导出进度"
          subtitle={`${state.shopName} · 已处理 ${state.completed} / ${state.total} 件`}
          onClose={() => setProgress(false)}
          wide
          footer={
            <>
              <span>{state.message}</span>
              <div>
                {active ? (
                  <button className="button" onClick={cancel}>
                    停止导出
                  </button>
                ) : state.outputPath ? (
                  <button
                    className="button"
                    onClick={() => void window.desktop.showCollectionFile()}
                  >
                    查看导出文件
                  </button>
                ) : null}
                <button className="button" onClick={() => setProgress(false)}>
                  {active ? '收起进度' : '关闭'}
                </button>
              </div>
            </>
          }
        >
          <div className="modal-body collection-progress">
            <p role="status">{state.message}</p>
            <progress
              value={state.completed}
              max={state.total || 1}
              aria-label="商品导出完成进度"
            />
            <ul>
              {queue.map((g) => (
                <li key={g.goodsId}>
                  <strong>{g.title}</strong>
                  <small>{g.goodsId}</small>
                  <span className={`collection-status ${g.status}`}>
                    {g.status === 'reading'
                      ? '正在读取'
                      : g.status === 'done'
                        ? '已生成 Excel'
                        : g.status === 'failed'
                          ? '导出失败'
                          : g.status === 'stopped'
                            ? '已停止'
                            : '等待导出'}
                  </span>
                  {g.message ? <p>{g.message}</p> : null}
                </li>
              ))}
            </ul>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

import { useDeferredValue, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
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
  return (
    <div className="collection-page">
      <div className="page-heading">
        <div>
          <h1>店铺商品导出</h1>
          <p>选择店铺，勾选在售商品，导出自带图片的 Excel。</p>
        </div>
      </div>
      <section className="collection-controls" aria-label="选择来源店铺">
        <div className="collection-shop-field">
          <label htmlFor="collection-shop">来源店铺</label>
          <select
            id="collection-shop"
            value={state.shopId}
            disabled={busy || disabled}
            onChange={(e) => void load(e.target.value)}
          >
            <option value="">选择已保存的拼多多店铺</option>
            {choices.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <button
          className="button"
          disabled={!state.shopId || busy || disabled}
          onClick={() => void load(state.shopId)}
        >
          <RefreshCw size={16} aria-hidden="true" />
          重新读取
        </button>
        <button className="text-button" disabled={busy || disabled} onClick={onAdd}>
          添加店铺
        </button>
      </section>
      {error || state.status === 'error' ? (
        <div className="error-message" role="alert">
          {error || state.message}
          <button className="text-button" onClick={onBrowserSetup}>
            检查浏览器连接
          </button>
        </div>
      ) : null}
      {active || (state.total && state.status !== 'ready') ? (
        <section className="execution-banner" aria-label="采集进度">
          <div>
            <strong>
              {state.status === 'listing'
                ? '正在读取在售商品'
                : state.status === 'exporting'
                  ? '正在导出商品'
                  : state.message}
            </strong>
            <p role="status">
              {active ? state.message : `本次已处理 ${state.completed} / ${state.total} 件商品`}
            </p>
          </div>
          {state.status === 'exporting' ? (
            <button className="button" onClick={() => setProgress(true)}>
              查看导出进度
            </button>
          ) : null}
          {active ? (
            <button className="button" onClick={cancel}>
              <Square size={14} aria-hidden="true" />
              停止
            </button>
          ) : state.outputPath ? (
            <button className="button" onClick={() => void window.desktop.showCollectionFile()}>
              <FolderOpen size={16} aria-hidden="true" />
              查看导出文件
            </button>
          ) : null}
        </section>
      ) : null}
      <section className="collection-list" aria-label="在售商品列表">
        <div className="section-heading">
          <div>
            <h2>在售商品{state.shopName ? ` · ${state.shopName}` : ''}</h2>
            <p>
              {state.goods.length
                ? `已读取 ${state.goods.length} 件${state.completeList ? '' : '，列表尚未读取完整'}，每件商品导出一份 Excel。`
                : '选定店铺后，系统自动登录并读取在售商品列表。'}
            </p>
          </div>
          <label className="search">
            <Search size={17} aria-hidden="true" />
            <input
              aria-label="搜索店铺商品"
              placeholder="搜索商品标题或编号"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
              disabled={busy}
            />
          </label>
        </div>
        {state.goods.length ? (
          <>
            <div className="collection-table-wrap">
              <table className="collection-table">
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        aria-label="选择当前页全部商品"
                        checked={allChecked}
                        disabled={busy}
                        onChange={(e) =>
                          toggle(
                            rows.map((g) => g.goodsId),
                            e.target.checked,
                          )
                        }
                      />
                    </th>
                    <th>商品</th>
                    <th>后台显示价格</th>
                    <th>导出状态</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((g) => (
                    <tr key={g.goodsId}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`选择商品 ${g.goodsId}`}
                          checked={selected.has(g.goodsId)}
                          disabled={busy}
                          onChange={(e) => toggle([g.goodsId], e.target.checked)}
                        />
                      </td>
                      <td>
                        <div className="collection-product">
                          <span className="collection-thumbnail">
                            {g.thumbnail ? (
                              <img
                                src={g.thumbnail}
                                alt=""
                                loading="lazy"
                                onError={(e) => {
                                  e.currentTarget.style.display = 'none';
                                }}
                              />
                            ) : (
                              <Image size={22} aria-hidden="true" />
                            )}
                          </span>
                          <div>
                            <strong>{g.title}</strong>
                            <small>商品编号 {g.goodsId}</small>
                          </div>
                        </div>
                      </td>
                      <td>{g.price || '导出时读取'}</td>
                      <td>
                        <span className={`collection-status ${g.status || ''}`}>
                          {g.status === 'reading' ? (
                            <LoaderCircle size={14} className="spin" aria-hidden="true" />
                          ) : g.status === 'done' ? (
                            <CheckCircle2 size={14} aria-hidden="true" />
                          ) : null}
                          {
                            (
                              {
                                waiting: '等待导出',
                                reading: '正在读取',
                                done: '已生成 Excel',
                                failed: '导出失败',
                                stopped: '已停止',
                              } as const
                            )[g.status || 'waiting']
                          }
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
            {!filtered.length ? (
              <div className="empty-state">
                <Search size={25} />
                <h3>没有匹配的商品</h3>
                <p>试试其他商品标题或编号。</p>
              </div>
            ) : null}
            {lastPage > 0 ? (
              <div className="pagination">
                <span>
                  第 {current + 1} / {lastPage + 1} 页 · 勾选跨页保留
                </span>
                <button
                  className="button"
                  disabled={busy || !current}
                  onClick={() => setPage(current - 1)}
                >
                  上一页
                </button>
                <button
                  className="button"
                  disabled={busy || current === lastPage}
                  onClick={() => setPage(current + 1)}
                >
                  下一页
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="empty-state">
            {state.status === 'listing' ? (
              <LoaderCircle size={28} className="spin" />
            ) : (
              <Store size={28} />
            )}
            <h3>
              {state.status === 'listing'
                ? '正在读取店铺商品'
                : state.status === 'error'
                  ? '商品列表读取失败'
                  : state.completeList
                    ? '这家店铺当前没有在售商品'
                    : '先选择来源店铺'}
            </h3>
            <p>
              {state.status === 'listing'
                ? state.message
                : state.status === 'error'
                  ? '核对来源店铺后，点击“重新读取”重试。'
                  : !choices.length
                    ? '到店铺管理保存账号密码后，就能在这里选择。'
                    : '系统将使用已连接的浏览器读取商品。'}
            </p>
            {!choices.length ? (
              <button className="button" onClick={onAdd}>
                添加拼多多店铺
              </button>
            ) : null}
          </div>
        )}
      </section>
      <div className="batch-bar">
        <div>
          <strong>已选择 {selected.size} 件商品</strong>
          <span>
            {selected.size > 50
              ? '一次最多导出 50 件，请减少勾选数量。'
              : '每份 Excel 自带图片和逐规格库存；多件商品打包为 ZIP。'}
          </span>
        </div>
        <div className="collection-actions">
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
            导出所选商品
          </button>
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

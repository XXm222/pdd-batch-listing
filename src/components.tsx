import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  X,
  CheckCircle2,
  AlertCircle,
  ImagePlus,
  Plus,
  Trash2,
  ChevronDown,
  Store,
  Search,
  ShieldCheck,
  LogIn,
  Pencil,
} from 'lucide-react';
import type { Asset, ImageTarget, Product, Shop, ShopInput } from './types';
import {
  applyImages,
  extraFields,
  fields,
  freightOptions,
  problems,
  productChanges,
  resolveShopName,
  shopNameFromAccount,
  isStructuredProduct,
  missingSkuImages,
} from './domain';
import { PictureEditor, SkuEditor } from './ProductEditors';
import {
  DEFAULT_PLATFORM,
  PLATFORMS,
  PLATFORM_ORDER,
  normalizePlatform,
  platformMeta,
  type PlatformId,
} from './platforms';

export function Modal({
  title,
  subtitle,
  children,
  footer,
  onClose,
  wide = false,
  busy = false,
  role = 'dialog',
  className = '',
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  busy?: boolean;
  role?: 'dialog' | 'alertdialog';
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const subtitleId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    const d = ref.current!;
    d.showModal();
    d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      if (d.open) d.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      role={role}
      className={`${wide ? 'modal wide' : 'modal'} ${className}`.trim()}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      aria-labelledby={titleId}
      aria-describedby={subtitle ? subtitleId : undefined}
    >
      <header className="modal-head">
        <div>
          <h2 id={titleId}>{title}</h2>
          {subtitle ? <p id={subtitleId}>{subtitle}</p> : null}
        </div>
        <button
          className="icon-button"
          aria-label={`关闭${title}`}
          onClick={onClose}
          disabled={busy}
        >
          <X size={20} />
        </button>
      </header>
      {children}
      {footer ? <footer className="modal-foot">{footer}</footer> : null}
    </dialog>
  );
}
export function Status({
  complete,
  count,
  note,
}: {
  complete: boolean;
  count?: number;
  note?: string;
}) {
  return (
    <span className={`status ${complete ? 'ready' : 'warning'}`}>
      {complete ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}{' '}
      {note || (complete ? '本机检查通过' : count ? `${count} 项待补充` : '待补充')}
    </span>
  );
}
export function Recognition({
  initial,
  existing,
  onClose,
  onSaved,
}: {
  initial: Product[];
  existing: Product[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [products, setProducts] = useState(initial);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [exported, setExported] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [exportError, setExportError] = useState('');
  const [imageError, setImageError] = useState('');
  const [imageIssues, setImageIssues] = useState<string[]>([]);
  const [showImageIssues, setShowImageIssues] = useState(false);
  const p = products[index];
  const [reviewIssues, setReviewIssues] = useState(false);
  const [closing, setClosing] = useState(false);
  const [reviewUpdates, setReviewUpdates] = useState(false);
  const [choices, setChoices] = useState<
    Record<string, { existingId: string; action: 'update' | 'skip' }>
  >({});
  const [preview, setPreview] = useState<Asset | null>(null);
  const [originalSize, setOriginalSize] = useState(false);
  const conflicts = products.flatMap((product, index) => {
    const found = existing.find(
      (item) => item.code.trim() === product.code.trim() && item.id !== product.id,
    );
    return found ? [{ product, existing: found, index }] : [];
  });
  const choiceFor = (product: Product) => {
    const conflict = conflicts.find((c) => c.product.id === product.id);
    const choice = choices[product.id];
    return conflict && choice?.existingId === conflict.existing.id ? choice.action : undefined;
  };
  const kept = products.filter((product) => choiceFor(product) !== 'skip');
  const missingImageCount = kept.reduce(
    (count, product) => count + missingSkuImages(product).length,
    0,
  );
  const reports = products
    .map((product, index) => ({ product, index, issues: problems(product) }))
    .filter((report) => choiceFor(report.product) !== 'skip' && report.issues.length);
  const issues = reports.find((report) => report.index === index)?.issues || [];
  const incomplete = reports.length;
  const issueCount = reports.reduce((count, report) => count + report.issues.length, 0);
  const update = (fn: (p: Product) => Product) => {
    setExported(false);
    setExportError('');
    setImageError('');
    setImageIssues([]);
    setProducts((all) => all.map((item, i) => (i === index ? fn(item) : item)));
  };
  const field = (key: keyof Product, value: string) => update((p) => ({ ...p, [key]: value }));
  const dirty = JSON.stringify(products) !== JSON.stringify(initial);
  const requestClose = () => {
    if (!busy) dirty ? setClosing(true) : onClose();
  };
  const supplement = async (target: ImageTarget) => {
    setBusy(true);
    setError('');
    setImageError('');
    setImageIssues([]);
    try {
      const assets = await window.desktop.supplement();
      if (!assets) return;
      const next = applyImages(p, assets, target);
      update(() => next);
    } catch (e) {
      setImageError((e as Error).message);
      const all = (e as Error & { imageIssues?: unknown }).imageIssues;
      setImageIssues(
        Array.isArray(all) && all.every((s) => typeof s === 'string')
          ? all
          : [(e as Error).message],
      );
    } finally {
      setBusy(false);
    }
  };
  const exportExcel = async () => {
    if (busy) return;
    setBusy(true);
    setExportingExcel(true);
    setExportError('');
    setImageError('');
    setError('');
    setExported(false);
    try {
      const match = conflicts.find((c) => c.product.id === p.id);
      if (match && !choiceFor(p)) throw Error('请先核对重复商品，选择更新或跳过');
      const product = match ? { ...p, id: match.existing.id, savedAt: match.existing.savedAt } : p;
      if (await window.desktop.exportProduct(product)) setExported(true);
    } catch (e) {
      setExportError((e as Error).message);
    } finally {
      setExportingExcel(false);
      setBusy(false);
    }
  };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setExported(false);
    setExportError('');
    setImageError('');
    setError('');
    try {
      const codes = kept.map((product) => product.code.trim());
      if (new Set(codes).size !== codes.length)
        throw Error('本次资料中有重复商品编码，请先修改编码');
      if (conflicts.some((c) => !choiceFor(c.product)))
        throw Error('请先核对重复商品，选择更新或跳过');
      const records = kept.map((product) => {
        const match = conflicts.find((c) => c.product.id === product.id);
        return match
          ? { ...product, id: match.existing.id, savedAt: match.existing.savedAt }
          : product;
      });
      if (!records.length) {
        onClose();
        return;
      }
      await window.desktop.saveProducts(records);
      await onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const continueSave = () => {
    setClosing(false);
    setReviewUpdates(false);
    if (incomplete) setReviewIssues(true);
    else void save();
  };
  const requestSave = () => {
    if (busy) return;
    setError('');
    setClosing(false);
    if (conflicts.length) setReviewUpdates(true);
    else continueSave();
  };
  const returnToEdit = (productIndex = reports[0]?.index ?? index) => {
    setIndex(productIndex);
    setReviewIssues(false);
    setError('');
  };
  return (
    <>
      <Modal
        title="确认商品资料"
        subtitle={`${products.length} 件商品 · ${products.reduce((n, p) => n + p.skus.length, 0)} 个组合${incomplete ? ` · ${incomplete} 件待补充` : missingImageCount ? ` · ${missingImageCount} 个组合未添加规格图` : ' · 本机检查通过'}`}
        wide
        onClose={requestClose}
        busy={busy}
        footer={
          <>
            <div className="footer-note">
              {exportingExcel ? (
                <span role="status">正在导出含图 Excel…</span>
              ) : exportError || imageError ? (
                <span className="footer-export-error" role="alert">
                  {exportError || imageError}
                  {imageError && imageIssues.length ? (
                    <button className="text-button" onClick={() => setShowImageIssues(true)}>
                      查看全部问题（{imageIssues.length}）
                    </button>
                  ) : null}
                </span>
              ) : exported ? (
                <span role="status">含图 Excel 已导出，图片已嵌入，可直接分享。</span>
              ) : incomplete ? (
                <span className="pending-summary">
                  <AlertCircle size={15} />
                  {incomplete} 件商品 · {issueCount} 项待补充
                  <button
                    className="text-button"
                    onClick={() => {
                      setError('');
                      setReviewIssues(true);
                    }}
                    disabled={busy}
                  >
                    查看问题
                  </button>
                </span>
              ) : missingImageCount ? (
                <span className="pending-summary" role="status">
                  <AlertCircle size={15} />
                  {missingImageCount} 个组合未添加规格图，请在资料中核对；是否必填按后台类目要求。
                </span>
              ) : (
                '保存到本机资料库，再选择执行店铺。'
              )}
            </div>
            <div className="button-group">
              <button
                className="button"
                onClick={() => void exportExcel()}
                disabled={busy || choiceFor(p) === 'skip'}
              >
                {exportingExcel ? '正在导出…' : '导出当前商品 Excel'}
              </button>
              <button className="button" onClick={requestClose} disabled={busy}>
                取消
              </button>
              <button className="button primary" onClick={requestSave} disabled={busy}>
                {busy && !exportingExcel ? '正在处理…' : '保存商品资料'}
              </button>
            </div>
          </>
        }
      >
        <div className="recognition-layout">
          <aside className="recognition-list" aria-label="识别商品列表">
            {products.map((item, i) => (
              <button
                key={item.id}
                className={`recognition-item ${i === index ? 'active' : ''}`}
                onClick={() => {
                  setIndex(i);
                  setExported(false);
                  setExportError('');
                  setImageError('');
                }}
                disabled={busy}
                aria-pressed={i === index}
              >
                <strong>{item.title || '商品标题待填写'}</strong>
                <span>{item.code || '商品编码待填写'}</span>
                <Status
                  complete={!problems(item).length && !missingSkuImages(item).length}
                  note={
                    !problems(item).length && missingSkuImages(item).length
                      ? '规格图待确认'
                      : undefined
                  }
                />
              </button>
            ))}
          </aside>
          <fieldset className="editor" disabled={busy}>
            {exported ? (
              <p className="success-message" role="status">
                含图 Excel 已导出。图片已嵌入，发给同事即可直接导入。
              </p>
            ) : null}
            {error ? (
              <div className="error-message" role="alert">
                {error}
              </div>
            ) : null}
            {conflicts.length ? (
              <div className="duplicate-banner">
                <div>
                  <strong>发现 {conflicts.length} 件同编码商品</strong>
                  <p>可核对变化后更新已有资料，或跳过本次导入。</p>
                </div>
                <button className="button" disabled={busy} onClick={() => setReviewUpdates(true)}>
                  核对重复商品
                </button>
              </div>
            ) : null}
            <div className="section-title">
              <h3>基本资料</h3>
              <span>{p.source}</span>
            </div>
            <div className="field-grid">
              {fields.map(([key, label]) => (
                <label key={key} className={key === 'title' || key === 'category' ? 'full' : ''}>
                  {key === 'brand' ? '商品品牌' : label}
                  <input
                    value={p[key]}
                    onChange={(e) => field(key, e.target.value)}
                    aria-invalid={['code', 'title', 'category'].includes(key) && !p[key].trim()}
                    maxLength={key === 'title' ? 80 : 200}
                    placeholder={key === 'category' ? '例如：足浴盆/足浴桶' : undefined}
                  />
                  {key === 'brand' ? (
                    <p className="quiet-note">可留空，选店后确认品牌及资质。</p>
                  ) : null}
                  {key === 'category' ? (
                    <p className="quiet-note">
                      只需填写最后一级类目；填写完整路径时，也按最后一级匹配。
                    </p>
                  ) : null}
                </label>
              ))}
            </div>
            <div className="section-title">
              <h3>规格、价格与库存</h3>
              <button
                className="text-button"
                disabled={busy || p.skus.length >= 100}
                onClick={() =>
                  update((p) => ({
                    ...p,
                    skus: [
                      ...p.skus,
                      {
                        spec: isStructuredProduct(p) ? '默认规格' : '',
                        group: '',
                        single: '',
                        stock: '',
                        code: '',
                        image: '',
                        options: [],
                      },
                    ],
                  }))
                }
              >
                <Plus size={15} />
                添加规格组合
              </button>
            </div>
            {isStructuredProduct(p) ? (
              <SkuEditor
                product={p}
                disabled={busy}
                onChange={(skus) => update((p) => ({ ...p, skus }))}
                onImage={(target) => void supplement(target)}
                onPreview={(asset) => {
                  setOriginalSize(false);
                  setPreview(asset);
                }}
              />
            ) : (
              <div className="table-scroll">
                <table className="sku-table">
                  <thead>
                    <tr>
                      <th>规格</th>
                      <th>拼单价（元）</th>
                      <th>单买价（元）</th>
                      <th>库存</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {p.skus.map((sku, n) => (
                      <tr key={n}>
                        {(['spec', 'group', 'single', 'stock'] as const).map((key, col) => (
                          <td key={key}>
                            <input
                              disabled={busy}
                              aria-label={`第 ${n + 1} 个规格${['名称', '拼单价', '单买价', '库存'][col]}`}
                              value={sku[key]}
                              inputMode={
                                key === 'spec' ? 'text' : key === 'stock' ? 'numeric' : 'decimal'
                              }
                              onChange={(e) =>
                                update((p) => ({
                                  ...p,
                                  skus: p.skus.map((s, i) =>
                                    i === n ? { ...s, [key]: e.target.value } : s,
                                  ),
                                }))
                              }
                            />
                          </td>
                        ))}
                        <td>
                          <button
                            className="icon-button small"
                            aria-label={`删除第 ${n + 1} 个规格`}
                            disabled={busy || p.skus.length === 1}
                            onClick={() =>
                              update((p) => ({ ...p, skus: p.skus.filter((_, i) => i !== n) }))
                            }
                          >
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {isStructuredProduct(p) ? (
              <>
                <div className="section-title">
                  <h3>其他类目属性</h3>
                  <button
                    className="text-button"
                    disabled={busy || (p.attributes?.length || 0) >= 50}
                    onClick={() =>
                      update((p) => ({
                        ...p,
                        attributes: [
                          ...(p.attributes || []),
                          { name: '', value: '', required: false },
                        ],
                      }))
                    }
                  >
                    <Plus size={15} />
                    添加属性
                  </button>
                </div>
                {(p.attributes || []).map((a, n) => (
                  <div className="attribute-row" key={n}>
                    <input
                      aria-label={`属性 ${n + 1} 名称`}
                      placeholder="后台属性名称"
                      value={a.name}
                      onChange={(e) =>
                        update((p) => ({
                          ...p,
                          attributes: p.attributes?.map((x, i) =>
                            i === n ? { ...x, name: e.target.value } : x,
                          ),
                        }))
                      }
                    />
                    <input
                      aria-label={`属性 ${n + 1} 值`}
                      placeholder="对应可选值"
                      value={a.value}
                      onChange={(e) =>
                        update((p) => ({
                          ...p,
                          attributes: p.attributes?.map((x, i) =>
                            i === n ? { ...x, value: e.target.value } : x,
                          ),
                        }))
                      }
                    />
                    <label>
                      <input
                        type="checkbox"
                        checked={a.required}
                        onChange={(e) =>
                          update((p) => ({
                            ...p,
                            attributes: p.attributes?.map((x, i) =>
                              i === n ? { ...x, required: e.target.checked } : x,
                            ),
                          }))
                        }
                      />
                      后台必填
                    </label>
                    <button
                      className="icon-button small"
                      aria-label={`删除属性 ${n + 1}`}
                      onClick={() =>
                        update((p) => ({
                          ...p,
                          attributes: p.attributes?.filter((_, i) => i !== n),
                        }))
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
                <p className="quiet-note">
                  属性名称与值按当前类目填写；“后台必填”以该类目实际要求为准，不由运营自行决定。后台要求在执行前核验。
                </p>
                <div className="section-title">
                  <h3>服务与承诺</h3>
                </div>
                <div className="field-grid">
                  {(
                    [
                      ['sevenDay', '7天无理由退货'],
                      ['invoice', '正品发票'],
                      ['authenticity', '假一赔十'],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <select
                        value={p.services?.[key] ?? (key === 'sevenDay' ? '按平台规则' : '否')}
                        onChange={(e) =>
                          update((p) => ({
                            ...p,
                            services: {
                              sevenDay: '按平台规则',
                              invoice: '否',
                              authenticity: '否',
                              ...p.services,
                              [key]: e.target.value,
                            },
                          }))
                        }
                      >
                        {p.services?.[key] === '' ? <option value="">未读取，请确认</option> : null}
                        {['是', '否', '按平台规则'].map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </>
            ) : null}
            <div className="section-title">
              <h3>商品图片</h3>
            </div>
            <p className="quiet-note">
              可批量添加轮播图和详情图，无需先插进 Excel。核对顺序后，点击“导出当前商品
              Excel”，系统会自动嵌入图片。
            </p>
            <PictureEditor
              product={p}
              disabled={busy}
              onChange={(key, names) => update((p) => ({ ...p, [key]: names }))}
              onImage={(target) => void supplement(target)}
              onPreview={(asset) => {
                setOriginalSize(false);
                setPreview(asset);
              }}
            />
            <details className="extra-fields">
              <summary>
                其他商品设置 <ChevronDown size={15} />
              </summary>
              <div className="field-grid">
                {extraFields
                  .filter(([key]) => !isStructuredProduct(p) || key !== 'skuCode')
                  .map(([key, label]) => (
                    <label key={key}>
                      {key === 'skuCode' ? '规格编码（选填）' : label}
                      <>
                        {key === 'freight' ? (
                          <select
                            aria-label="运费模板"
                            value={p.freight}
                            onChange={(e) => field('freight', e.target.value)}
                          >
                            <option value="">选店后确认</option>
                            {freightOptions(p.freight, existing).map((value) => (
                              <option key={value} value={value}>
                                {value}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            value={p[key]}
                            placeholder={key === 'discount' ? '留空，选店后确认' : undefined}
                            onChange={(e) => field(key, e.target.value)}
                          />
                        )}
                      </>
                      {key === 'freight' ? (
                        <p className="quiet-note">
                          可选择常用模板；导入或已保存的其他模板会保留，执行时按目标店铺核对。
                        </p>
                      ) : key === 'discount' ? (
                        <p className="quiet-note">留空时待选店后确认，不自动确定值。</p>
                      ) : null}
                    </label>
                  ))}
              </div>
            </details>
            {!issues.length && !missingSkuImages(p).length ? (
              <div className="complete-note">
                <CheckCircle2 size={16} />
                本机检查通过，保存后可选择店铺；后台规则仍需核验。
              </div>
            ) : null}
          </fieldset>
        </div>
      </Modal>
      {showImageIssues ? (
        <Modal
          title="图片校验问题"
          subtitle={`${imageIssues.length} 项，请核对后重新选择图片`}
          onClose={() => setShowImageIssues(false)}
          footer={
            <button className="button primary" onClick={() => setShowImageIssues(false)}>
              返回选图
            </button>
          }
        >
          <div className="modal-body image-issues-list">
            <p>本次选择的图片未加入商品，原有图片保持不变。</p>
            <ul>
              {imageIssues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          </div>
        </Modal>
      ) : null}
      {reviewIssues ? (
        <Modal
          title="商品资料还需补充"
          subtitle={`${incomplete} 件商品，共 ${issueCount} 项。请核对以下问题后继续。`}
          role="alertdialog"
          onClose={() => returnToEdit()}
          busy={busy}
          footer={
            <div className="issue-actions">
              <button
                className="button"
                data-autofocus
                onClick={() => returnToEdit()}
                disabled={busy}
              >
                返回修改
              </button>
              <button
                className="button primary"
                onClick={() => {
                  if (conflicts.some((c) => !choiceFor(c.product))) {
                    setReviewIssues(false);
                    setReviewUpdates(true);
                  } else void save();
                }}
                disabled={busy}
              >
                {busy ? '正在保存…' : '仍保存为待补充'}
              </button>
            </div>
          }
        >
          <div className="modal-body issue-review">
            {error ? (
              <div className="error-message" role="alert">
                {error}
              </div>
            ) : null}
            <p className="issue-guidance">
              可先保存到本机资料库。待补充商品完善后，才能选择店铺执行。
            </p>
            {reports.map((report) => (
              <section className="issue-product" key={report.product.id}>
                <div className="issue-product-heading">
                  <div>
                    <h3>{report.product.title || '商品标题待填写'}</h3>
                    <p>{report.product.code || '商品编码待填写'}</p>
                  </div>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => returnToEdit(report.index)}
                  >
                    修改此商品
                  </button>
                </div>
                <ul>
                  {report.issues.map((issue) => (
                    <li key={issue}>
                      <AlertCircle size={15} />
                      <span>{issue}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </Modal>
      ) : null}
      {closing ? (
        <Modal
          title="有修改尚未保存"
          role="alertdialog"
          onClose={() => setClosing(false)}
          footer={
            <div className="close-actions">
              <button className="button" data-autofocus onClick={() => setClosing(false)}>
                继续编辑
              </button>
              <button className="button danger-text" onClick={onClose}>
                放弃修改
              </button>
              <button className="button primary" onClick={requestSave}>
                保存资料
              </button>
            </div>
          }
        >
          <div className="modal-body">
            <p>关闭后，本次修改将丢失。可以先保存资料，也可以返回继续编辑。</p>
          </div>
        </Modal>
      ) : null}
      {reviewUpdates ? (
        <Modal
          title="核对重复商品"
          subtitle="按商品编码匹配。确认更新后，本次整份资料将替换已有商品资料，包括留空字段。"
          wide
          onClose={() => setReviewUpdates(false)}
          busy={busy}
          footer={
            <>
              <span className="footer-note">已有待执行任务保留创建时的商品资料版本。</span>
              <div className="button-group">
                <button className="button" data-autofocus onClick={() => setReviewUpdates(false)}>
                  返回编辑
                </button>
                <button
                  className="button primary"
                  disabled={busy || conflicts.some((c) => !choiceFor(c.product))}
                  onClick={continueSave}
                >
                  {kept.length ? '确认并继续保存' : '全部跳过并关闭'}
                </button>
              </div>
            </>
          }
        >
          <div className="modal-body update-review">
            {conflicts.map((conflict) => (
              <section className="update-product" key={conflict.product.id}>
                <h3>{conflict.product.title || '商品标题待填写'}</h3>
                <p>
                  {conflict.product.code} · 已有资料保存于{' '}
                  {conflict.existing.savedAt
                    ? new Date(conflict.existing.savedAt).toLocaleString('zh-CN')
                    : '之前'}
                </p>
                <div className="update-choices">
                  {(['update', 'skip'] as const).map((action) => (
                    <label key={action}>
                      <input
                        type="radio"
                        name={`duplicate-${conflict.product.id}`}
                        checked={choiceFor(conflict.product) === action}
                        onChange={() =>
                          setChoices((old) => ({
                            ...old,
                            [conflict.product.id]: { existingId: conflict.existing.id, action },
                          }))
                        }
                      />
                      {action === 'update' ? '更新已有商品资料' : '跳过这件商品'}
                    </label>
                  ))}
                </div>
                {productChanges(conflict.existing, conflict.product).length ? (
                  <table className="changes-table">
                    <thead>
                      <tr>
                        <th>变化项目</th>
                        <th>已有资料</th>
                        <th>本次资料</th>
                      </tr>
                    </thead>
                    <tbody>
                      {productChanges(conflict.existing, conflict.product).map((change) => (
                        <tr key={change.label}>
                          <th>{change.label}</th>
                          <td>{change.before}</td>
                          <td>{change.after}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="quiet-note">内容相同，建议选择跳过。</p>
                )}
              </section>
            ))}
          </div>
        </Modal>
      ) : null}
      {preview ? (
        <Modal
          title="查看商品图片"
          subtitle={`${preview.width} × ${preview.height} 像素 · ${(preview.bytes / 1024 / 1024).toFixed(2)} MB`}
          wide
          onClose={() => setPreview(null)}
          footer={
            <>
              <span className="footer-note">
                {originalSize ? '原始尺寸，可滚动查看完整图片。' : '已按窗口缩放，原图不会改变。'}
              </span>
              <div className="button-group">
                <button className="button" onClick={() => setOriginalSize((value) => !value)}>
                  {originalSize ? '适应窗口' : '查看原始尺寸'}
                </button>
                <button className="button primary" data-autofocus onClick={() => setPreview(null)}>
                  返回编辑
                </button>
              </div>
            </>
          }
        >
          <div className={`modal-body image-viewer ${originalSize ? 'original' : ''}`}>
            <img
              src={preview.url}
              alt="商品图片"
              style={originalSize ? { width: preview.width, height: preview.height } : undefined}
            />
          </div>
        </Modal>
      ) : null}
    </>
  );
}
export function ShopManagement({
  shops,
  selectedId,
  onSelect,
  onAdd,
  onEdit,
  onLogin,
  disabled,
}: {
  shops: Shop[];
  selectedId: string;
  onSelect: (id: string) => void;
  onAdd: (platform: PlatformId) => void;
  onEdit: (shop: Shop) => void;
  onLogin: (shop: Shop) => void;
  disabled: boolean;
}) {
  const [search, setSearch] = useState('');
  const [platform, setPlatform] = useState<PlatformId>(() =>
    normalizePlatform(shops.find((shop) => shop.id === selectedId)?.platform),
  );
  // 选中店铺变化时（含刚在另一平台新增店铺）跟随切换到对应平台。
  useEffect(() => {
    const shop = shops.find((s) => s.id === selectedId);
    if (shop) setPlatform(normalizePlatform(shop.platform));
  }, [selectedId, shops]);
  const meta = platformMeta(platform);
  const all = shops.filter((shop) => normalizePlatform(shop.platform) === platform);
  const visible = all.filter((shop) =>
    `${shop.name} ${shop.account}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const current = visible.find((shop) => shop.id === selectedId) || visible[0];
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>店铺管理</h1>
          <p>选择平台，在这里维护店铺的登录信息。</p>
        </div>
      </div>
      <div className="platform-workspace">
        <aside className="platform-panel" aria-label="店铺平台">
          <h2>平台</h2>
          {PLATFORM_ORDER.map((id) => {
            const item = PLATFORMS[id];
            const count = shops.filter((shop) => normalizePlatform(shop.platform) === id).length;
            return (
              <button
                key={id}
                className={`platform-entry ${platform === id ? 'active' : ''}`}
                aria-current={platform === id ? 'true' : undefined}
                disabled={disabled}
                onClick={() => {
                  setPlatform(id);
                  setSearch('');
                }}
              >
                <span className="platform-icon">
                  <Store size={19} />
                </span>
                <span>
                  <strong>{item.label}</strong>
                  <small>
                    {!item.enabled
                      ? '暂未开放'
                      : count
                        ? `已保存 ${count} 家店铺`
                        : item.draftPublishing
                          ? '尚未保存店铺'
                          : '适配中：仅登录与核对'}
                  </small>
                </span>
              </button>
            );
          })}
          <p>按平台管理店铺，商品保存后再选择目标店铺。</p>
        </aside>
        <section className="account-panel" aria-label={`${meta.label}店铺`}>
          <header className="account-panel-head">
            <h2>
              {meta.label}店铺 <span className="count-pill">{all.length}</span>
            </h2>
            <div className="button-group">
              <button
                className="button"
                disabled={!current?.credentialsSaved || disabled || !meta.enabled}
                onClick={() => current && onLogin(current)}
              >
                <LogIn size={15} />
                登录与核对
              </button>
              <button
                className="button"
                disabled={!current || disabled || !meta.enabled}
                onClick={() => current && onEdit(current)}
              >
                <Pencil size={15} />
                编辑登录信息
              </button>
              <button
                className="button primary"
                disabled={disabled || !meta.enabled}
                onClick={() => {
                  setSearch('');
                  onAdd(platform);
                }}
              >
                <Plus size={16} />
                添加店铺
              </button>
            </div>
          </header>
          {!meta.enabled || !meta.draftPublishing ? (
            <div className="connection-note" role="status">
              <AlertCircle size={16} />
              <p>
                {!meta.enabled
                  ? `${meta.label}暂未开放，已有资料保留；目前仅支持拼多多。`
                  : meta.draftPendingMessage}
              </p>
            </div>
          ) : null}
          <div className="account-toolbar">
            <span>{search ? `找到 ${visible.length} 家店铺` : `共 ${all.length} 家店铺`}</span>
            <label className="search">
              <Search size={16} />
              <input
                aria-label="搜索店铺"
                value={search}
                placeholder="搜索店铺名称或账号"
                onChange={(e) => setSearch(e.target.value)}
              />
              {search ? (
                <button
                  className="icon-button small"
                  aria-label="清空店铺搜索"
                  onClick={() => setSearch('')}
                >
                  <X size={14} />
                </button>
              ) : null}
            </label>
          </div>
          {visible.length ? (
            <div className="account-table-scroll">
              <table className="account-table">
                <thead>
                  <tr>
                    <th className="check-cell" />
                    <th>店铺名称</th>
                    <th>登录账号</th>
                    <th>登录信息</th>
                    <th className="align-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((shop) => (
                    <tr key={shop.id} className={current?.id === shop.id ? 'selected' : ''}>
                      <td className="check-cell">
                        <input
                          type="radio"
                          name="managed-shop"
                          aria-label={`选择店铺 ${shop.name}`}
                          checked={current?.id === shop.id}
                          onChange={() => onSelect(shop.id)}
                        />
                      </td>
                      <td>
                        <button className="shop-name-button" onClick={() => onSelect(shop.id)}>
                          {shop.name}
                        </button>
                      </td>
                      <td>
                        <span className="shop-account" title={maskAccount(shop.account)}>
                          {maskAccount(shop.account)}
                        </span>
                      </td>
                      <td>
                        <span className="saved-credential">
                          <ShieldCheck size={13} />
                          {shop.credentialsSaved ? '密码已保存' : '待补充密码'}
                        </span>
                      </td>
                      <td className="align-right">
                        <button
                          className="text-button"
                          disabled={disabled || !meta.enabled}
                          onClick={() => {
                            onSelect(shop.id);
                            onEdit(shop);
                          }}
                        >
                          编辑
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty account-empty">
              <span className="empty-symbol">
                <Store size={31} />
              </span>
              <h3>
                {!meta.enabled
                  ? `${meta.label}暂未开放`
                  : all.length
                    ? '没有匹配的店铺'
                    : `添加你的第一家${meta.label}店铺`}
              </h3>
              <p>
                {!meta.enabled
                  ? '目前仅支持拼多多，已有店铺资料仍保存在本机。'
                  : all.length
                    ? '试试其他店铺名称或登录账号。'
                    : meta.derivesNameFromAccount
                      ? '填写店铺名:子账号和密码，店铺名称会自动生成。'
                      : `填写${meta.label}店铺名称、${meta.accountExample}和密码。`}
              </p>
              {!all.length && meta.enabled ? (
                <button className="button" disabled={disabled} onClick={() => onAdd(platform)}>
                  <Plus size={16} />
                  添加店铺
                </button>
              ) : null}
            </div>
          )}
          <footer className="account-panel-foot">
            <p>
              <ShieldCheck size={15} />
              账号密码加密保存在本机。
            </p>
            <span className="quiet-note">选店执行时核对登录身份</span>
          </footer>
        </section>
      </div>
      <div className="connection-note">
        <AlertCircle size={16} />
        <p>
          执行时使用已连接 Kimi
          扩展的浏览器。若要使用系统默认浏览器，请先在该浏览器连接扩展。账号与目标店铺不一致时，会使用这里保存的账号密码登录并核对身份。
        </p>
      </div>
    </>
  );
}
export function ShopEditor({
  initial,
  platform = DEFAULT_PLATFORM,
  onClose,
  onSaved,
  encryptionAvailable,
}: {
  initial?: Shop;
  /** 新增店铺时的默认平台；已有店铺固定沿用自身平台。 */
  platform?: PlatformId;
  onClose: () => void;
  onSaved: (shopId: string) => Promise<void>;
  encryptionAvailable: boolean;
}) {
  const [chosenPlatform, setChosenPlatform] = useState<PlatformId>(() =>
    normalizePlatform(initial?.platform ?? platform),
  );
  const meta = platformMeta(chosenPlatform);
  const [form, setForm] = useState<ShopInput>({
    id: initial?.id,
    name: initial?.name || '',
    account: initial?.account || '',
    password: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const dirty =
    form.name !== (initial?.name || '') ||
    form.account !== (initial?.account || '') ||
    !!form.password;
  const requestClose = () => {
    if (!busy) dirty ? setClosing(true) : onClose();
  };
  // 拼多多的店铺名由「店铺名:子账号」推导；淘宝账号是会员名或手机号，名称须手填。
  const nameEditable = !!initial || !meta.derivesNameFromAccount;
  const shopName = nameEditable ? form.name : shopNameFromAccount(form.account);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const name = resolveShopName(form.name, form.account, !initial, chosenPlatform);
      const workspace = await window.desktop.saveShop({
        ...form,
        name,
        platform: chosenPlatform,
      });
      setForm((f) => ({ ...f, password: '' }));
      const saved = workspace.shops.find((shop) => shop.account === form.account.trim());
      if (!saved) throw Error('店铺已保存，请重新打开店铺管理核对');
      await onSaved(saved.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Modal title={initial ? '编辑店铺' : '添加店铺'} onClose={requestClose} busy={busy}>
        <form ref={formRef} onSubmit={submit}>
          <div className="modal-body shop-form compact-shop-form">
            <div className="shop-form-platform">
              <span className="platform-icon">
                <Store size={18} />
              </span>
              <h3>{meta.label}店铺</h3>
            </div>
            {!initial ? (
              <div className="platform-choice" role="radiogroup" aria-label="店铺平台">
                {PLATFORM_ORDER.map((id) => (
                  <button
                    type="button"
                    key={id}
                    role="radio"
                    aria-checked={chosenPlatform === id}
                    className={`platform-option ${chosenPlatform === id ? 'active' : ''}`}
                    disabled={busy || !PLATFORMS[id].enabled}
                    onClick={() => setChosenPlatform(id)}
                  >
                    <strong>{PLATFORMS[id].label}</strong>
                    <small>
                      {!PLATFORMS[id].enabled
                        ? '暂未开放'
                        : PLATFORMS[id].draftPublishing
                          ? '可保存商品草稿'
                          : '适配中：仅登录与核对'}
                    </small>
                  </button>
                ))}
              </div>
            ) : null}
            {!meta.enabled || !meta.draftPublishing ? (
              <p className="quiet-note">
                {!meta.enabled ? `${meta.label}暂未开放` : meta.draftPendingMessage}
              </p>
            ) : null}
            {error ? (
              <div className="error-message" role="alert">
                {error}
              </div>
            ) : null}
            <fieldset disabled={busy || !meta.enabled}>
              <label>
                店铺名称
                <input
                  data-autofocus={nameEditable ? '' : undefined}
                  value={shopName}
                  readOnly={!nameEditable}
                  required={nameEditable}
                  maxLength={50}
                  placeholder={
                    initial ? '填写与后台一致的店铺名称' : '由登录账号中冒号前的店铺名自动生成'
                  }
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
              </label>
              <label>
                登录账号
                <input
                  data-autofocus={initial ? undefined : ''}
                  value={form.account}
                  required
                  maxLength={100}
                  autoComplete="username"
                  aria-describedby={!initial ? 'account-format' : undefined}
                  placeholder={meta.accountExample}
                  onChange={(e) => setForm((f) => ({ ...f, account: e.target.value }))}
                />
              </label>
              <label>
                登录密码
                <input
                  value={form.password}
                  type="password"
                  required={!initial || initial.account !== form.account}
                  maxLength={256}
                  autoComplete="new-password"
                  placeholder={initial ? '留空保留已保存密码' : '填写该账号的登录密码'}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                />
              </label>
            </fieldset>
            {!initial ? (
              <p className="quiet-note" id="account-format">
                {meta.accountHint}
              </p>
            ) : null}
            <p className="quiet-note">
              {encryptionAvailable
                ? initial
                  ? '密码由系统加密保存；留空保留原密码，更换账号需重填。'
                  : '密码由系统加密保存在本机，列表中不会显示。'
                : '系统加密服务不可用，暂时无法保存新密码。'}
            </p>
          </div>
          <footer className="modal-foot">
            <span />
            <div className="button-group">
              <button type="button" className="button" onClick={requestClose} disabled={busy}>
                取消
              </button>
              <button
                className="button primary"
                type="submit"
                disabled={busy || !meta.enabled || (!encryptionAvailable && !!form.password)}
              >
                {busy ? '保存中…' : '保存店铺'}
              </button>
            </div>
          </footer>
        </form>
      </Modal>
      {closing ? (
        <Modal
          title="店铺信息尚未保存"
          role="alertdialog"
          onClose={() => setClosing(false)}
          footer={
            <div className="close-actions">
              <button className="button" data-autofocus onClick={() => setClosing(false)}>
                继续填写
              </button>
              <button className="button danger-text" onClick={onClose}>
                放弃修改
              </button>
              <button
                className="button primary"
                onClick={() => {
                  setClosing(false);
                  formRef.current?.requestSubmit();
                }}
              >
                保存店铺
              </button>
            </div>
          }
        >
          <div className="modal-body">
            <p>关闭将丢失本次填写的账号和密码。可以保存店铺，或返回继续填写。</p>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
export function ShopPicker({
  shops,
  count,
  onClose,
  onPrepared,
  encryptionAvailable,
  onShopSaved,
}: {
  shops: Shop[];
  count: number;
  onClose: () => void;
  onPrepared: (id: string) => Promise<void>;
  encryptionAvailable: boolean;
  onShopSaved: (id: string) => Promise<void>;
}) {
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const chosenMeta = platformMeta(shops.find((shop) => shop.id === chosen)?.platform);
  return (
    <>
      <Modal
        title="选择目标店铺"
        subtitle={`已保存 ${count} 件商品，请选择目标店铺。`}
        onClose={onClose}
        busy={busy || adding}
        footer={
          <>
            <span className="footer-note">
              {chosen && (!chosenMeta.enabled || !chosenMeta.draftPublishing)
                ? !chosenMeta.enabled
                  ? `${chosenMeta.label}暂未开放`
                  : chosenMeta.draftPendingMessage
                : '在已连接浏览器中填写，保存到后台草稿箱'}
            </span>
            <button
              className="button primary"
              disabled={
                !chosen || busy || adding || !chosenMeta.enabled || !chosenMeta.draftPublishing
              }
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await onPrepared(chosen);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? '启动中…' : '开始填写并保存草稿'}
            </button>
          </>
        }
      >
        <div className="modal-body">
          {error ? (
            <div className="error-message" role="alert">
              {error}
            </div>
          ) : null}
          <div className="picker-heading">
            <span>{shops.length ? `已保存 ${shops.length} 家店铺` : '还没有保存店铺'}</span>
            <button className="text-button" disabled={busy} onClick={() => setAdding(true)}>
              <Plus size={16} />
              添加店铺
            </button>
          </div>
          {shops.length ? (
            <div className="shop-options">
              {shops.map((shop) => {
                const shopMeta = platformMeta(shop.platform);
                return (
                  <label
                    className={`shop-option ${chosen === shop.id ? 'selected' : ''}`}
                    key={shop.id}
                  >
                    <input
                      type="radio"
                      name="target-shop"
                      value={shop.id}
                      checked={chosen === shop.id}
                      disabled={busy || !shopMeta.enabled || !shopMeta.draftPublishing}
                      onChange={() => setChosen(shop.id)}
                    />
                    <div>
                      <strong>
                        {shop.name} <span className="status neutral">{shopMeta.label}</span>
                      </strong>
                      <span>{maskAccount(shop.account)}</span>
                    </div>
                    <span className="status neutral">
                      {!shopMeta.enabled
                        ? '暂未开放'
                        : shopMeta.draftPublishing
                          ? '密码已保存'
                          : '仅登录与核对'}
                    </span>
                  </label>
                );
              })}
            </div>
          ) : (
            <p>点击“添加店铺”保存账号密码，完成后会回到这里并选中新店铺。</p>
          )}
          <div className="connection-note">
            <AlertCircle size={16} />
            <p>
              使用已连接 Kimi
              扩展的浏览器。已有正确登录状态时直接继续；需要切店时使用保存的账号密码，验证码需人工完成。
            </p>
          </div>
          {chosen && chosenMeta.enabled && chosenMeta.draftPublishing ? (
            <section className="preflight-note">
              <strong>所选店铺执行前还需核验</strong>
              <ul>
                <li>店铺登录身份与品牌可选项</li>
                <li>类目属性、规格选项与图片要求</li>
                <li>该店铺的运费模板、发货与售后承诺</li>
                <li>满件折扣及折后价格</li>
              </ul>
              <p>
                执行时逐项核对后台资料；品牌资质与最终发布审核不在草稿核验范围。运费模板须确认；折扣留空时沿用后台设置。
              </p>
            </section>
          ) : null}
        </div>
      </Modal>
      {adding ? (
        <ShopEditor
          encryptionAvailable={encryptionAvailable}
          onClose={() => setAdding(false)}
          onSaved={async (id) => {
            await onShopSaved(id);
            setChosen(id);
          }}
        />
      ) : null}
    </>
  );
}
export const maskAccount = (account: string) =>
  /^\d{11}$/.test(account) ? `${account.slice(0, 3)}****${account.slice(-4)}` : account;

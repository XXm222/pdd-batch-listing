import { Fragment } from 'react';
import { ArrowLeft, ArrowRight, ImagePlus, Trash2 } from 'lucide-react';
import type { Asset, ImageTarget, Product, Sku } from './types';

export function SkuEditor({ product, disabled, onChange, onImage, onPreview }: {
  product: Product; disabled: boolean; onChange: (skus: Sku[]) => void;
  onImage: (target: ImageTarget) => void; onPreview: (asset: Asset) => void;
}) {
  const change = (n: number, patch: Partial<Sku>) => onChange(product.skus.map((sku, i) => i === n ? { ...sku, ...patch } : sku));
  const option = (n: number, position: number, key: 'name' | 'value', value: string) => {
    const sku = product.skus[n];
    const options = [0, 1].map(i => ({ name: sku.options?.[i]?.name || '', value: sku.options?.[i]?.value || '' }));
    options[position] = { ...options[position], [key]: value };
    while (options.length && !options[options.length - 1].name.trim() && !options[options.length - 1].value.trim()) options.pop();
    change(n, { options, spec: options.length ? options.map(o => `${o.name}:${o.value}`).join(' / ') : '默认规格' });
  };
  return <>
    <p className="sku-guidance">一行填一种，比如“紫色＋大号”。左边填按什么区分（如颜色），右边填具体选项（如紫色）。只有颜色可选时，第二组留空；商品没有可选款式时，两组都可留空。</p>
    <div className="table-scroll"><table className="sku-table compact-skus"><thead><tr><th>规格组合</th><th>拼单价（元）</th><th>单买价（元）</th><th>库存</th><th><span className="sr-only">操作</span></th></tr></thead>
      <tbody>{product.skus.map((sku, n) => <Fragment key={n}><tr>
        <td><span className="sku-row-label">组合 {n + 1}</span>{[0, 1].map(position => <div className="spec-pair" key={position}>
          <input disabled={disabled} aria-label={`组合 ${n + 1} 区分方式${position + 1}`} maxLength={50} placeholder={position ? '区分方式2，如尺寸' : '区分方式1，如颜色'} value={sku.options?.[position]?.name || ''} onChange={e => option(n, position, 'name', e.target.value)}/>
          <input disabled={disabled} aria-label={`组合 ${n + 1} 具体选项${position + 1}`} maxLength={100} placeholder={position ? '具体选项2，如大号' : '具体选项1，如紫色'} value={sku.options?.[position]?.value || ''} onChange={e => option(n, position, 'value', e.target.value)}/>
        </div>)}</td>
        {(['group', 'single', 'stock'] as const).map(key => <td key={key}><input disabled={disabled} aria-label={`组合 ${n + 1} ${{ group: '拼单价', single: '单买价', stock: '库存' }[key]}`} value={sku[key]} maxLength={20} inputMode={key === 'stock' ? 'numeric' : 'decimal'} onChange={e => change(n, { [key]: e.target.value })}/></td>)}
        <td><button className="icon-button small" disabled={disabled || product.skus.length === 1} aria-label={`删除组合 ${n + 1}`} onClick={() => onChange(product.skus.filter((_, i) => i !== n))}><Trash2 size={15}/></button></td>
      </tr><tr className="sku-optional-row"><td colSpan={5}><details><summary>组合 {n + 1} 的编码与图片（选填）</summary><div className="sku-optional-fields">
        <label>规格编码<input disabled={disabled} aria-label={`组合 ${n + 1} 规格编码`} value={sku.code || ''} maxLength={250} onChange={e => change(n, { code: e.target.value })}/></label>
        <div className="sku-image-field"><span>规格图</span>{sku.image && product.images[sku.image] ? <button className="sku-preview" aria-label={`预览组合 ${n + 1} 规格图`} onClick={() => onPreview(product.images[sku.image!])}><img src={product.images[sku.image].url} alt={`组合 ${n + 1} 规格图`}/></button> : <span className="quiet-note">未添加</span>}
          <button className="text-button" disabled={disabled} onClick={() => onImage({ kind: 'sku', index: n })}><ImagePlus size={15}/>{sku.image ? '替换规格图' : '添加规格图'}</button>
          {sku.image ? <button className="text-button" disabled={disabled} onClick={() => change(n, { image: '' })}>移除</button> : null}
        </div>
      </div></details></td></tr></Fragment>)}</tbody></table></div>
  </>;
}

export function PictureEditor({ product, disabled, onChange, onImage, onPreview }: {
  product: Product; disabled: boolean; onChange: (key: 'main' | 'detail', names: string[]) => void;
  onImage: (target: ImageTarget) => void; onPreview: (asset: Asset) => void;
}) {
  const move = (key: 'main' | 'detail', from: number, to: number) => {
    const names = [...product[key]]; names.splice(to, 0, names.splice(from, 1)[0]); onChange(key, names);
  };
  return <>{(['main', 'detail'] as const).map(key => <section className="picture-section" key={key}>
    <div className="picture-heading"><h4>{key === 'main' ? '轮播图' : '详情图（选填）'} <span>{product[key].length} / {key === 'main' ? 10 : 50}</span></h4>
      <button className="text-button" disabled={disabled || product[key].length >= (key === 'main' ? 10 : 50)} onClick={() => onImage({ kind: key })}><ImagePlus size={16}/>添加{key === 'main' ? '轮播图' : '详情图'}</button></div>
    <p className="quiet-note">{key === 'main' ? '第一张为主图。点击图片查看大图，使用箭头调整顺序。' : '支持长图。使用箭头调整详情图的展示顺序。'}</p>
    <div className="image-grid editable-images">{product[key].length ? product[key].map((name, n) => <div className="image-item" key={`${name}-${n}`}>
      <button className="image-preview" disabled={!product.images[name]} aria-label={`预览${key === 'main' ? '轮播图' : '详情图'}第 ${n + 1} 张`} onClick={() => onPreview(product.images[name])}>{product.images[name] ? <img src={product.images[name].url} alt={`${key === 'main' ? '轮播图' : '详情图'}第 ${n + 1} 张`}/> : <div className="missing-image"><ImagePlus size={22}/><span>未匹配</span></div>}</button>
      <strong>{key === 'main' && n === 0 ? '主图' : `第 ${n + 1} 张`}</strong>
      <div className="image-order"><button className="icon-button small" disabled={disabled || n === 0} aria-label={`${key === 'main' ? '轮播图' : '详情图'}第 ${n + 1} 张前移`} onClick={() => move(key, n, n - 1)}><ArrowLeft size={15}/></button>
        <button className="icon-button small" disabled={disabled || n === product[key].length - 1} aria-label={`${key === 'main' ? '轮播图' : '详情图'}第 ${n + 1} 张后移`} onClick={() => move(key, n, n + 1)}><ArrowRight size={15}/></button>
        <button className="icon-button small" disabled={disabled} aria-label={`移除${key === 'main' ? '轮播图' : '详情图'}第 ${n + 1} 张`} onClick={() => onChange(key, product[key].filter((_, i) => i !== n))}><Trash2 size={15}/></button></div>
      {key === 'main' && n > 0 ? <button className="text-button image-set-main" disabled={disabled} onClick={() => move(key, n, 0)}>设为主图</button> : null}
      <button className="text-button image-replace" disabled={disabled} onClick={() => onImage({ kind: key, index: n })}>替换图片</button>
    </div>) : <p className="image-empty">{key === 'main' ? '请添加商品轮播图，第一张将作为主图。' : '有详情图时可直接添加，也可从 Excel 内识别。'}</p>}</div>
  </section>)}</>;
}

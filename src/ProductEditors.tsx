import { Fragment, useId } from 'react';
import { ArrowLeft, ArrowRight, ImagePlus, Trash2 } from 'lucide-react';
import type { Asset, ImageTarget, Product, Sku } from './types';
import { imageSizeText, isTaobaoProduct } from './domain';

export function SkuEditor({
  product,
  disabled,
  onChange,
  onImage,
  onPreview,
}: {
  product: Product;
  disabled: boolean;
  onChange: (skus: Sku[]) => void;
  onImage: (target: ImageTarget) => void;
  onPreview: (asset: Asset) => void;
}) {
  const helpId = useId();
  const priceFields: { key: 'group' | 'single' | 'stock'; label: string; hint: string }[] = [
    ...(isTaobaoProduct(product)
      ? [
          {
            key: 'single' as const,
            label: '一口价（元）',
            hint: '这个组合每件的售价，最多两位小数。',
          },
        ]
      : [
          {
            key: 'group' as const,
            label: '拼单价（元）',
            hint: '参与拼单时的每件价格，不能高于单买价。',
          },
          {
            key: 'single' as const,
            label: '单买价（元）',
            hint: '不参与拼单，单独购买时的每件价格。',
          },
        ]),
    { key: 'stock', label: '库存（件）', hint: '这个组合可售的件数，填整数；0 表示暂无可售库存。' },
  ];
  const change = (n: number, patch: Partial<Sku>) =>
    onChange(product.skus.map((sku, i) => (i === n ? { ...sku, ...patch } : sku)));
  const option = (n: number, position: number, key: 'name' | 'value', value: string) => {
    const sku = product.skus[n];
    const options = [0, 1].map((i) => ({
      name: sku.options?.[i]?.name || '',
      value: sku.options?.[i]?.value || '',
    }));
    options[position] = { ...options[position], [key]: value };
    while (
      options.length &&
      !options[options.length - 1].name.trim() &&
      !options[options.length - 1].value.trim()
    )
      options.pop();
    change(n, {
      options,
      spec: options.length ? options.map((o) => `${o.name}:${o.value}`).join(' / ') : '默认规格',
    });
  };
  return (
    <>
      <div className="sku-guidance" id={helpId}>
        <p>
          <strong>一个组合就是一种可购买的款式。</strong>
          例如“颜色：紫色”＋“容量：10L”，共同组成“紫色＋10L”这一款。
          两组规格共用一套价格和库存；其他颜色或容量另点“添加规格组合”填写。
        </p>
        <p>
          只有颜色可选时，第二组两格都留空；没有可选款式时，两组都留空。所有组合的区分方式和顺序要一致，例如第一组都填颜色、第二组都填容量。
        </p>
      </div>
      <div className="table-scroll">
        <table className="sku-table compact-skus">
          <thead>
            <tr>
              <th>规格组合</th>
              {priceFields.map(({ key, label }) => (
                <th key={key}>{label}</th>
              ))}
              <th>
                <span className="sr-only">操作</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {product.skus.map((sku, n) => (
              <Fragment key={n}>
                <tr className="sku-heading-row">
                  <td>
                    <span className="sku-row-label">组合 {n + 1}</span>
                    <span className="spec-group-title">第一组规格</span>
                  </td>
                  <td className="sku-price-heading" colSpan={priceFields.length}>
                    本组合价格和库存（两组规格共用）
                  </td>
                  <td />
                </tr>
                <tr>
                  <td>
                    {[0, 1].map((position) => (
                      <div className="spec-group" key={position}>
                        {position ? (
                          <span className="spec-group-title">第二组规格（选填）</span>
                        ) : null}
                        <div className="spec-pair">
                          <label>
                            按什么区分
                            <input
                              disabled={disabled}
                              aria-label={`组合 ${n + 1} 第${position ? '二' : '一'}组 按什么区分`}
                              aria-describedby={helpId}
                              maxLength={50}
                              placeholder={position ? '如：容量、尺寸' : '如：颜色'}
                              value={sku.options?.[position]?.name || ''}
                              onChange={(e) => option(n, position, 'name', e.target.value)}
                            />
                          </label>
                          <label>
                            具体选项
                            <input
                              disabled={disabled}
                              aria-label={`组合 ${n + 1} 第${position ? '二' : '一'}组 具体选项`}
                              aria-describedby={helpId}
                              maxLength={100}
                              placeholder={position ? '如：10L、大号' : '如：紫色'}
                              value={sku.options?.[position]?.value || ''}
                              onChange={(e) => option(n, position, 'value', e.target.value)}
                            />
                          </label>
                        </div>
                      </div>
                    ))}
                    <p className="sku-combination-note">
                      以上两组共同确定组合 {n + 1}，右侧价格和库存只填一次。
                    </p>
                  </td>
                  {priceFields.map(({ key, label, hint }) => (
                    <td key={key} className="sku-price-cell">
                      <label className="sku-price-field">
                        {label}
                        <input
                          disabled={disabled}
                          aria-label={`组合 ${n + 1} ${label}`}
                          aria-describedby={`${helpId}-${n}-${key}`}
                          value={sku[key]}
                          maxLength={20}
                          inputMode={key === 'stock' ? 'numeric' : 'decimal'}
                          onChange={(e) => change(n, { [key]: e.target.value })}
                        />
                      </label>
                      <p className="sku-field-hint" id={`${helpId}-${n}-${key}`}>
                        {hint}
                      </p>
                    </td>
                  ))}
                  <td>
                    <button
                      className="icon-button small"
                      disabled={disabled || product.skus.length === 1}
                      aria-label={`删除组合 ${n + 1}`}
                      onClick={() => onChange(product.skus.filter((_, i) => i !== n))}
                    >
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
                <tr className="sku-optional-row">
                  <td colSpan={priceFields.length + 2}>
                    <details>
                      <summary>组合 {n + 1} 的编码与图片（选填）</summary>
                      <div className="sku-optional-fields">
                        <label>
                          规格编码
                          <input
                            disabled={disabled}
                            aria-label={`组合 ${n + 1} 规格编码`}
                            value={sku.code || ''}
                            maxLength={250}
                            onChange={(e) => change(n, { code: e.target.value })}
                          />
                          <span className="sku-field-hint">
                            这个组合的内部货号，用于识别不同款式，可留空。
                          </span>
                        </label>
                        <div className="sku-image-field">
                          <span>规格图</span>
                          <span className="sku-field-hint">
                            展示这个组合颜色或款式的图片，可不添加。
                          </span>
                          {sku.image && product.images[sku.image] ? (
                            <button
                              className="sku-preview"
                              aria-label={`预览组合 ${n + 1} 规格图`}
                              onClick={() => onPreview(product.images[sku.image!])}
                            >
                              <img
                                src={product.images[sku.image].url}
                                alt={`组合 ${n + 1} 规格图`}
                              />
                            </button>
                          ) : (
                            <span className="quiet-note">未添加</span>
                          )}
                          <button
                            className="text-button"
                            disabled={disabled}
                            onClick={() => onImage({ kind: 'sku', index: n })}
                          >
                            <ImagePlus size={15} />
                            {sku.image ? '替换规格图' : '添加规格图'}
                          </button>
                          {sku.image ? (
                            <button
                              className="text-button"
                              disabled={disabled}
                              onClick={() => change(n, { image: '' })}
                            >
                              移除
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </details>
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function PictureEditor({
  product,
  disabled,
  onChange,
  onImage,
  onPreview,
}: {
  product: Product;
  disabled: boolean;
  onChange: (key: 'main' | 'detail', names: string[]) => void;
  onImage: (target: ImageTarget) => void;
  onPreview: (asset: Asset) => void;
}) {
  const move = (key: 'main' | 'detail', from: number, to: number) => {
    const names = [...product[key]];
    names.splice(to, 0, names.splice(from, 1)[0]);
    onChange(key, names);
  };
  return (
    <>
      {(['main', 'detail'] as const).map((key) => (
        <section className="picture-section" key={key}>
          <div className="picture-heading">
            <h4>
              {key === 'main' ? '轮播图' : '详情图（选填）'}{' '}
              <span>
                {product[key].length} / {key === 'main' ? 10 : 50}
              </span>
            </h4>
            <button
              className="text-button"
              disabled={disabled || product[key].length >= (key === 'main' ? 10 : 50)}
              onClick={() => onImage({ kind: key })}
            >
              <ImagePlus size={16} />
              批量添加{key === 'main' ? '轮播图' : '详情图'}
            </button>
          </div>
          <p className="quiet-note">
            {key === 'main'
              ? '第一张为主图。点击图片查看大图，使用箭头调整顺序。'
              : '支持长图。使用箭头调整详情图的展示顺序。'}
          </p>
          <p className="quiet-note">
            {key === 'main'
              ? '主图须小于 3MB，比例与尺寸按所选平台核验。'
              : '本机单张读取上限 20MB；详情图上传大小按后台实际要求核验。'}
          </p>
          <div className="image-grid editable-images">
            {product[key].length ? (
              product[key].map((name, n) => (
                <div className="image-item" key={`${name}-${n}`}>
                  <button
                    className="image-preview"
                    disabled={!product.images[name]}
                    aria-label={`预览${key === 'main' ? '轮播图' : '详情图'}第 ${n + 1} 张`}
                    onClick={() => onPreview(product.images[name])}
                  >
                    {product.images[name] ? (
                      <img
                        src={product.images[name].url}
                        alt={`${key === 'main' ? '轮播图' : '详情图'}第 ${n + 1} 张`}
                      />
                    ) : (
                      <div className="missing-image">
                        <ImagePlus size={22} />
                        <span>未匹配</span>
                      </div>
                    )}
                  </button>
                  <strong>{key === 'main' && n === 0 ? '主图' : `第 ${n + 1} 张`}</strong>
                  {product.images[name] ? (
                    <span className="image-file-info">
                      {imageSizeText(product.images[name].bytes)} · {product.images[name].width}×
                      {product.images[name].height}
                    </span>
                  ) : null}
                  <div className="image-order">
                    <button
                      className="icon-button small"
                      disabled={disabled || n === 0}
                      aria-label={`${key === 'main' ? '轮播图' : '详情图'}第 ${n + 1} 张前移`}
                      onClick={() => move(key, n, n - 1)}
                    >
                      <ArrowLeft size={15} />
                    </button>
                    <button
                      className="icon-button small"
                      disabled={disabled || n === product[key].length - 1}
                      aria-label={`${key === 'main' ? '轮播图' : '详情图'}第 ${n + 1} 张后移`}
                      onClick={() => move(key, n, n + 1)}
                    >
                      <ArrowRight size={15} />
                    </button>
                    <button
                      className="icon-button small"
                      disabled={disabled}
                      aria-label={`移除${key === 'main' ? '轮播图' : '详情图'}第 ${n + 1} 张`}
                      onClick={() =>
                        onChange(
                          key,
                          product[key].filter((_, i) => i !== n),
                        )
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  {key === 'main' && n > 0 ? (
                    <button
                      className="text-button image-set-main"
                      disabled={disabled}
                      onClick={() => move(key, n, 0)}
                    >
                      设为主图
                    </button>
                  ) : null}
                  <button
                    className="text-button image-replace"
                    disabled={disabled}
                    onClick={() => onImage({ kind: key, index: n })}
                  >
                    替换图片
                  </button>
                </div>
              ))
            ) : (
              <p className="image-empty">
                {key === 'main'
                  ? '请添加商品轮播图，第一张将作为主图。'
                  : '有详情图时可直接添加，也可从 Excel 内识别。'}
              </p>
            )}
          </div>
        </section>
      ))}
    </>
  );
}

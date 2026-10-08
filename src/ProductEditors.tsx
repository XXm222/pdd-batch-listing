import { useId, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, ImagePlus, Trash2 } from 'lucide-react';
import type { Asset, ImageTarget, Product, Sku } from './types';
import { imageSizeText, isTaobaoProduct, missingSkuImages, withSkuOptions } from './domain';

export function SkuEditor({
  product,
  disabled,
  onChange,
  onImage,
  onPreview,
  pricingFields,
}: {
  product: Product;
  disabled: boolean;
  onChange: (skus: Sku[]) => void;
  onImage: (target: ImageTarget) => void;
  onPreview: (asset: Asset) => void;
  pricingFields?: ReactNode;
}) {
  const helpId = useId();
  const missingImages = missingSkuImages(product);
  const taobao = isTaobaoProduct(product);
  const names = [0, 1].map((i) => product.skus[0]?.options?.[i]?.name || '');
  const optionsFor = (sku: Sku) =>
    Array.from({ length: Math.max(2, sku.options?.length || 0) }, (_, i) => ({
      name: sku.options?.[i]?.name || '',
      value: sku.options?.[i]?.value || '',
    }));
  const rename = (position: number, name: string) =>
    onChange(
      product.skus.map((sku) =>
        withSkuOptions(
          sku,
          optionsFor(sku).map((option, i) => (i === position ? { ...option, name } : option)),
        ),
      ),
    );
  const option = (index: number, position: number, value: string) =>
    onChange(
      product.skus.map((sku, i) =>
        i === index
          ? withSkuOptions(
              sku,
              optionsFor(sku).map((option, n) => (n === position ? { ...option, value } : option)),
            )
          : sku,
      ),
    );
  const change = (index: number, patch: Partial<Sku>) =>
    onChange(product.skus.map((sku, i) => (i === index ? { ...sku, ...patch } : sku)));
  const dimensionsDiffer = product.skus.some((sku) =>
    [0, 1].some((i) => (sku.options?.[i]?.name || '') !== names[i]),
  );
  const prices: { key: 'group' | 'single' | 'stock'; label: string }[] = [
    ...(taobao
      ? [{ key: 'single' as const, label: '一口价（元）' }]
      : [
          { key: 'group' as const, label: '拼单价（元）' },
          { key: 'single' as const, label: '单买价（元）' },
        ]),
    { key: 'stock', label: '库存（件）' },
  ];
  return (
    <>
      <div className="sku-dimensions">
        {[0, 1].map((position) => (
          <label key={position}>
            规格{position ? '二' : '一'}名称{position ? '（选填）' : ''}
            <input
              aria-label={`规格${position ? '二' : '一'}名称`}
              disabled={disabled}
              maxLength={50}
              value={names[position]}
              placeholder={position ? '如容量、套餐；不用时留空' : '如颜色、款式；单规格可留空'}
              onChange={(e) => rename(position, e.target.value)}
            />
          </label>
        ))}
        {pricingFields}
        <details className="sku-help">
          <summary>填写说明</summary>
          <div id={helpId}>
            <p>
              每行是一种可购买组合，如“紫色＋10L”，分别填写价格与库存。规格名称对所有组合统一生效。
            </p>
            <p>
              只有一种区分方式时，规格二名称和选项都留空；无可选款式时，两组均留空。库存可填
              0，拼单价不能高于单买价。
            </p>
            <p>规格图按目标店铺类目要求核对，可在表格内直接添加。规格编码可留空。</p>
          </div>
        </details>
      </div>
      {dimensionsDiffer ? (
        <p className="sku-image-warning" role="status">
          各组合的规格名称不一致，请先核对；修改上方名称会统一所有组合的名称，并保留每行选项。
        </p>
      ) : null}
      {missingImages.length ? (
        <p className="sku-image-warning" role="status">
          {missingImages.length} 个组合未添加规格图，请在对应行添加；是否必填按后台类目要求。
        </p>
      ) : null}
      <div className="table-scroll sku-grid-scroll">
        <table className="sku-grid">
          <thead>
            <tr>
              <th className="sku-number-col">组合</th>
              <th className="sku-image-col">规格图</th>
              <th>{names[0] || '规格一选项'}</th>
              <th>{names[1] || '规格二选项'}</th>
              {prices.map((price) => (
                <th key={price.key}>{price.label}</th>
              ))}
              <th>规格编码</th>
              <th className="sku-actions-col">
                <span className="sr-only">操作</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {product.skus.map((sku, index) => (
              <tr key={index}>
                <td className="sku-row-number">{index + 1}</td>
                <td className="sku-image-cell">
                  {sku.image && product.images[sku.image] ? (
                    <div className="sku-image-controls">
                      <button
                        className="sku-preview"
                        disabled={disabled}
                        aria-label={`预览组合 ${index + 1} 规格图`}
                        onClick={() => onPreview(product.images[sku.image!])}
                      >
                        <img src={product.images[sku.image].url} alt={`组合 ${index + 1} 规格图`} />
                      </button>
                      <div>
                        <button
                          className="text-button"
                          disabled={disabled}
                          aria-label={`替换组合 ${index + 1} 规格图`}
                          onClick={() => onImage({ kind: 'sku', index })}
                        >
                          替换
                        </button>
                        <button
                          className="text-button"
                          disabled={disabled}
                          aria-label={`移除组合 ${index + 1} 规格图`}
                          onClick={() => change(index, { image: '' })}
                        >
                          移除
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className={`sku-add-image ${missingImages.includes(index) ? 'is-missing' : ''}`}
                      disabled={disabled}
                      aria-label={`添加组合 ${index + 1} 规格图`}
                      onClick={() => onImage({ kind: 'sku', index })}
                    >
                      <ImagePlus size={17} />
                      <span>添加图片</span>
                    </button>
                  )}
                </td>
                {[0, 1].map((position) => (
                  <td key={position}>
                    <input
                      disabled={disabled}
                      aria-label={`组合 ${index + 1} 第${position ? '二' : '一'}组 具体选项`}
                      maxLength={100}
                      value={sku.options?.[position]?.value || ''}
                      placeholder={position ? '可留空' : '如紫色'}
                      onChange={(e) => option(index, position, e.target.value)}
                    />
                  </td>
                ))}
                {prices.map(({ key, label }) => (
                  <td key={key}>
                    <input
                      disabled={disabled}
                      aria-label={`组合 ${index + 1} ${label}`}
                      value={sku[key]}
                      maxLength={20}
                      inputMode={key === 'stock' ? 'numeric' : 'decimal'}
                      onChange={(e) => change(index, { [key]: e.target.value })}
                    />
                  </td>
                ))}
                <td>
                  <input
                    disabled={disabled}
                    aria-label={`组合 ${index + 1} 规格编码`}
                    value={sku.code || ''}
                    maxLength={250}
                    placeholder="选填"
                    onChange={(e) => change(index, { code: e.target.value })}
                  />
                </td>
                <td>
                  <button
                    className="icon-button small"
                    disabled={disabled || product.skus.length === 1}
                    aria-label={`删除组合 ${index + 1}`}
                    onClick={() => onChange(product.skus.filter((_, i) => i !== index))}
                  >
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
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

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { BrowserBridge, flatten } from './browser-bridge';
import { PddLogin } from './platforms/pdd-login';
import {
  readSkuTable,
  readRemoteImages,
  readSavedSettings,
  parseSkuTable,
  isRecord,
  type SkuTable,
} from './platforms/pdd-page-scripts';
import { exportProductWorkbook } from './workbook-export';
import { saveImage } from './importer';
import { newProduct } from '../src/domain';
import { normalizePlatform } from '../src/platforms';
import type { CollectionState, Product, Shop, ShopGoods } from '../src/types';

const ORIGIN = 'https://mms.pinduoduo.com';
const LIST = `${ORIGIN}/goods/goods_list?msfrom=mms_sidenav`;
const saleLabel = /^(?:在售(?:中|商品)?|出售中)(?:[(（]?\d+\+?[)）]?)?$/;
const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 70);
export function imageUrl(value: string): string {
  const u = new URL(value);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.port ||
    !['pddpic.com', 'yangkeduo.com'].some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))
  )
    throw Error('图片地址不是已支持的拼多多图片地址');
  return u.href;
}

// Serialized into the user's browser. Only inspect the list; do not change goods.
export function saleListEntry() {
  const sale = /^(?:在售(?:中|商品)?|出售中)(?:[(（]?\d+\+?[)）]?)?$/;
  const entries = [
    ...document.querySelectorAll<HTMLElement>(
      '[data-testid="beast-core-tab-itemLabel"],[role="tab"]',
    ),
  ].filter((e) => e.getClientRects().length && sale.test(e.innerText.replace(/\s/g, '')));
  if (entries.length !== 1) return { count: entries.length };
  for (const old of document.querySelectorAll('[data-goods-sale-tab]'))
    old.removeAttribute('data-goods-sale-tab');
  entries[0].setAttribute('data-goods-sale-tab', 'true');
  return { count: 1, selector: '[data-goods-sale-tab="true"]' };
}

export function readSalePage() {
  const visible = (e: Element) => !!e.getClientRects().length;
  const text = (e: Element | null) => ((e as HTMLElement)?.innerText || '').trim();
  const sale = /^(?:在售(?:中|商品)?|出售中)(?:[(（]?\d+\+?[)）]?)?$/;
  const selected = [
    ...document.querySelectorAll(
      '[aria-selected="true"],[data-state="active"],[class*="active"],[class*="selected"]',
    ),
  ]
    .filter(visible)
    .some((e) => sale.test(text(e).replace(/\s/g, '')));
  const tables = [...document.querySelectorAll<HTMLTableElement>('table')].filter(
    (e) => visible(e) && /商品/.test(text(e.tHead)) && /价格|库存|操作/.test(text(e.tHead)),
  );
  if (tables.length !== 1) return { ready: false, reason: '未找到唯一的商品列表' };
  const table = tables[0],
    headers = [...(table.tHead?.rows || [])].at(-1)?.cells;
  const labels = [...(headers || [])].map((e) => text(e).replace(/\s/g, ''));
  // The current PDD table puts its sticky header and body in separate tables.
  const container = table.closest('[data-testid="beast-core-table"]') || table;
  const bodies =
    container === table
      ? [table]
      : [...container.querySelectorAll<HTMLTableElement>('table')].filter(visible);
  const goods = bodies
    .flatMap((t) => [...t.tBodies])
    .flatMap((b) => [...b.rows])
    .filter((r) => r.cells.length > 1)
    .map((r) => {
      const cells = [...r.cells];
      const column = (pattern: RegExp) => cells[labels.findIndex((h) => pattern.test(h))];
      const info =
        column(/商品信息|商品名称|商品$/) ||
        cells.find((c) => /商品(?:ID|编号)\s*[:：]/i.test(text(c)));
      const editLinks = [...r.querySelectorAll<HTMLAnchorElement>('a[href]')].filter((a) =>
        /^编辑(?:商品)?$/.test(text(a)),
      );
      const editUrl = editLinks.length === 1 ? editLinks[0].href : '';
      const linkedId = editUrl ? new URL(editUrl).searchParams.get('goods_id') || '' : '';
      const goodsId =
        text(info || r).match(/(?:商品(?:ID|编号)|\bID)\s*[:：]\s*(\d+)/i)?.[1] || linkedId;
      const links = [...(info || r).querySelectorAll<HTMLAnchorElement>('a')].filter(
        (a) => text(a).length > 3 && !/^(编辑|查看|商品ID)/i.test(text(a)),
      );
      const lines = text(info || cells[1] || r)
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !/^(商品(?:ID|编号)|商家编码|货号|复制|查看|编辑)/i.test(s));
      const titleNode = (info || r).querySelector<HTMLElement>(
        '[data-tracking-click-viewid="ele_blue_title"],.goods-name',
      );
      const title =
        text(titleNode) ||
        links[0]?.getAttribute('title') ||
        (links[0] ? text(links[0]) : '') ||
        lines[0] ||
        '';
      const img = (info || r).querySelector<HTMLImageElement>('img');
      return {
        goodsId,
        title,
        editUrl,
        thumbnail: img?.currentSrc || img?.src || '',
        price: text(column(/拼单价|价格/)),
        rowText: text(r).slice(0, 1000),
      };
    });
  const active =
    selected || (goods.length > 0 && goods.every((g) => /在售|出售中|销售中/.test(g.rowText)));
  const nexts = [
    ...document.querySelectorAll<HTMLElement>(
      'button,[role=button],a,[data-testid="beast-core-pagination-next"]',
    ),
  ].filter(
    (e) =>
      visible(e) &&
      (e.getAttribute('data-testid') === 'beast-core-pagination-next' ||
        /下一页/.test(e.getAttribute('aria-label') || '') ||
        /^下一页$/.test(text(e)) ||
        /pagination.*next|next.*pagination/i.test(e.className)),
  );
  const next = nexts.length === 1 ? nexts[0] : null;
  const hasNext =
    !!next &&
    !(next as HTMLButtonElement).disabled &&
    next.getAttribute('aria-disabled') !== 'true' &&
    !/disabled/.test(next.className);
  for (const old of document.querySelectorAll('[data-goods-sale-next]'))
    old.removeAttribute('data-goods-sale-next');
  if (next) next.setAttribute('data-goods-sale-next', 'true');
  const pagination = [
    ...document.querySelectorAll<HTMLElement>('[data-testid="beast-core-pagination"]'),
  ].filter(visible);
  const total =
    pagination.length === 1 ? text(pagination[0]).match(/共有\s*(\d+)\s*条/)?.[1] : undefined;
  const empty = /共有\s*0\s*条|暂无(?:商品|数据)/.test(text(container)) || total === '0';
  return {
    ready: true,
    active,
    goods,
    hasNext,
    total: total === undefined ? undefined : Number(total),
    paginationKnown:
      nexts.length === 1 || /共有\s*0\s*条|暂无(?:商品|数据)/.test(document.body.innerText),
    empty,
  };
}

export function parseSalePage(raw: unknown): { goods: ShopGoods[]; hasNext: boolean } {
  if (!isRecord(raw) || raw.ready !== true || raw.active !== true || !Array.isArray(raw.goods))
    throw Error('在售商品列表尚未确认，请在浏览器核对“在售”标签后重新读取');
  if (!raw.paginationKnown) throw Error('后台分页控件未识别，不能确认是否已读取全部商品');
  const ids = new Set<string>();
  const goods = raw.goods.map((g): ShopGoods => {
    if (
      !isRecord(g) ||
      typeof g.goodsId !== 'string' ||
      !/^\d{1,30}$/.test(g.goodsId) ||
      ids.has(g.goodsId) ||
      typeof g.title !== 'string' ||
      !g.title ||
      g.title.length > 2000
    )
      throw Error('商品编号或标题未能唯一读取，请核对后台商品列表');
    ids.add(g.goodsId);
    let editUrl: string | undefined;
    if (g.editUrl) {
      const u = new URL(String(g.editUrl));
      if (
        u.origin !== ORIGIN ||
        u.username ||
        u.password ||
        u.searchParams.get('goods_id') !== g.goodsId ||
        !u.pathname.startsWith('/goods/')
      )
        throw Error('商品编辑地址与商品编号不一致');
      editUrl = u.href;
    }
    let thumbnail = '';
    try {
      if (typeof g.thumbnail === 'string' && g.thumbnail) thumbnail = imageUrl(g.thumbnail);
    } catch {
      /* List may use a preview placeholder. */
    }
    return {
      goodsId: g.goodsId,
      title: g.title,
      editUrl,
      thumbnail,
      price: typeof g.price === 'string' ? g.price.slice(0, 100) : '',
    };
  });
  if (!goods.length && raw.empty !== true) throw Error('商品列表为空，后台尚未明确显示无商品');
  return { goods, hasNext: raw.hasNext === true };
}

export function readProductFacts() {
  const value = (selector: string) =>
    document.querySelector<HTMLInputElement>(selector)?.value || '';
  const fields = [
    ...document.querySelectorAll<HTMLElement>('[data-testid="beast-core-form-item"]'),
  ].map((e) => ({
    id: e.id,
    label: (e.querySelector('label')?.innerText || '').replace(/重要|\*/g, '').trim(),
    value:
      e.querySelector<HTMLInputElement>('input:not([type=password]):not([type=file])')?.value || '',
    text: e.innerText.trim(),
    required: !!e.querySelector('[class*=required]'),
    selected: [...e.querySelectorAll<HTMLElement>('label[data-checked="true"]')].map((e) =>
      e.innerText.trim(),
    ),
  }));
  const attrs = fields
    .filter((e) => e.id.startsWith('basic.propertys'))
    .map((e) => ({ name: e.label, value: e.value, required: e.required }));
  const category = fields.find((e) => /^(商品分类|商品类目|类目)$/.test(e.label));
  const code = fields.filter((e) => e.label === '商品编码');
  const selected = (name: RegExp) => fields.find((e) => name.test(e.label))?.selected[0] || '';
  return {
    url: location.href,
    title: value('[data-tracking-click-viewid="title_input_area"]'),
    code: code.length === 1 ? code[0].value : '',
    category:
      document.querySelector<HTMLElement>('.category-area .sort-name')?.innerText.trim() ||
      category?.text
        .replace(category.label, '')
        .replace(/修改类目|重新选择/g, '')
        .trim() ||
      '',
    attributes: attrs,
    specs: [...document.querySelectorAll('.goods-spec-row')]
      .map((e) => ({
        name: e.querySelector<HTMLInputElement>('input[placeholder^="规格类型"]')?.value || '',
      }))
      .filter((e) => e.name)
      .map((e) => e.name),
    skuImages: [] as string[],
    services: {
      sevenDay: selected(/7天无理由/),
      invoice: selected(/正品发票/),
      authenticity: selected(/假一赔十/),
    },
    discount: fields.find((e) => /满\s*2\s*件.*折/.test(e.label))?.value || '',
  };
}

export function readSkuPictureCells(selectors: string[]) {
  return selectors.map((selector) => {
    const cells = document.querySelectorAll(selector);
    if (cells.length !== 1) throw Error('规格图片格未能唯一读取');
    const cell = cells[0],
      img = cell.querySelector<HTMLImageElement>('img');
    return (
      img?.currentSrc ||
      img?.src ||
      [...cell.querySelectorAll<HTMLElement>('[style]')]
        .map((e) => e.style.backgroundImage.match(/^url\(["']?(https:[^"')]+)["']?\)$/)?.[1])
        .find(Boolean) ||
      ''
    );
  });
}

export function productFromPage(
  goods: ShopGoods,
  facts: any,
  table: SkuTable,
  saved: any,
  remote: any,
  commit?: unknown,
) {
  const u = new URL(facts.url);
  if (
    u.origin !== ORIGIN ||
    u.searchParams.get('goods_id') !== goods.goodsId ||
    !facts.title ||
    facts.title !== goods.title
  )
    throw Error('商品页面身份与所选商品不一致，已停止读取');
  if (
    !Array.isArray(facts.specs) ||
    facts.specs.length > 2 ||
    new Set(facts.specs).size !== facts.specs.length
  )
    throw Error('规格类型未能唯一读取，第一版支持最多两种区分方式');
  if (!table.rows.length || table.rows.length > 100)
    throw Error('规格数量未读取或超过当前 Excel 的 100 行上限');
  const col = (pattern: RegExp) => {
    const indexes = table.headers.flatMap((h, i) =>
      pattern.test(h.replace(/\s/g, '')) ? [i] : [],
    );
    if (indexes.length !== 1) throw Error('规格表价格或库存列未能唯一读取');
    return indexes[0];
  };
  const group = col(/^拼单价(?:[（(]元[）)])?$/),
    single = col(/^单买价(?:[（(]元[）)])?$/),
    stock = col(/^(?:当前)?库存(?:[（(]件[）)])?$/);
  const skuCode = table.headers.findIndex((h) =>
    /^(?:规格编码|SKU编码)$/.test(h.replace(/\s/g, '')),
  );
  const p = newProduct(facts.code || `PDD-${goods.goodsId}`, facts.title),
    warnings: string[] = [];
  p.templateFormat = '运营模板 v3';
  p.source = `拼多多采集：商品ID ${goods.goodsId}`;
  p.category = String(facts.category || '');
  p.reference = String(saved.reference || '');
  p.shipping = String(saved.shipping || '');
  p.freight = String(saved.freight || '');
  p.discount = String(facts.discount || '');
  p.attributes = facts.attributes.filter((a: any) => a.name && a.value);
  for (const [label, key] of [
    ['品牌', 'brand'],
    ['材质', 'material'],
    ['适用人群', 'audience'],
    ['是否可折叠', 'foldable'],
  ] as const) {
    p[key] = p.attributes?.find((a) => a.name === label)?.value || '';
  }
  p.attributes = (p.attributes || []).filter(
    (a) => !['品牌', '材质', '适用人群', '是否可折叠'].includes(a.name),
  );
  p.services = { sevenDay: '', invoice: '', authenticity: '' };
  for (const key of ['sevenDay', 'invoice', 'authenticity'] as const) {
    const original = facts.services?.[key];
    const v = original === '支持' ? '是' : original === '不支持' ? '否' : original;
    if (['是', '否', '按平台规则'].includes(v)) p.services[key] = v;
    else
      warnings.push(
        `${{ sevenDay: '7天无理由退货', invoice: '正品发票', authenticity: '假一赔十' }[key]}未读取，导入后须核对`,
      );
  }
  const number = (value: string, integer = false) => {
    if (
      !(integer ? /^\d+$/ : /^\d+(?:\.\d{1,2})?$/).test(value) ||
      !Number.isFinite(Number(value)) ||
      !Number.isSafeInteger(integer ? Number(value) : Math.round(Number(value) * 100))
    )
      throw Error(integer ? '实际库存未读取；空白不会作为零库存导出' : '规格价格未读取');
    return value;
  };
  const detail =
    isRecord(commit) && commit.success === true && isRecord(commit.result)
      ? commit.result
      : undefined;
  const captured =
    detail &&
    String(detail.goods_id) === goods.goodsId &&
    String(detail.id) === u.searchParams.get('id') &&
    detail.goods_name === facts.title &&
    Array.isArray(detail.sku)
      ? detail.sku
      : undefined;
  const combinations = new Set<string>();
  if (!captured) throw Error('未取得此商品实际库存与完整规格响应，未导出');
  if (captured.length !== table.rows.length)
    throw Error('后台响应与页面规格数量不同，规格未读取完整，未导出');
  if (captured && typeof detail!.out_goods_sn === 'string' && detail!.out_goods_sn.trim()) {
    if (facts.code && facts.code !== detail!.out_goods_sn)
      throw Error('来源商品编码与页面不一致，未导出');
    p.code = detail!.out_goods_sn;
  }
  p.skus = table.rows.map((row) => {
    const options = facts.specs.map((name: string) => {
      const indexes = table.headers.flatMap((h, i) => (h === name ? [i] : []));
      if (indexes.length !== 1 || !row.cells[indexes[0]].text) throw Error('规格组合未能完整读取');
      return { name, value: row.cells[indexes[0]].text };
    });
    const key = JSON.stringify(options);
    if (combinations.has(key)) throw Error('后台存在重复规格组合，未导出');
    combinations.add(key);
    const groupValue = number(row.cells[group].value),
      singleValue = number(row.cells[single].value);
    let stockValue = row.cells[stock].value;
    let capturedCode = '';
    if (captured) {
      const matches = captured.filter((s) => {
        if (!isRecord(s) || !Array.isArray(s.spec) || s.spec.length !== options.length)
          return false;
        const specs = s.spec;
        return options.every(
          (o: any) =>
            specs.filter((v: any) => v.parent_name === o.name && v.spec_name === o.value).length ===
            1,
        );
      });
      if (matches.length !== 1 || !isRecord(matches[0]))
        throw Error('库存响应与页面规格未能唯一对应');
      const c = matches[0];
      if (
        c.multi_price !== Math.round(Number(groupValue) * 100) ||
        c.price !== Math.round(Number(singleValue) * 100) ||
        !Number.isSafeInteger(c.quantity) ||
        Number(c.quantity) < 0
      )
        throw Error('商品响应与页面价格或实际库存不一致，未导出');
      stockValue = String(c.quantity);
      if (
        table.headers[stock].replace(/\s/g, '').startsWith('当前库存') &&
        row.cells[stock].text.trim() !== stockValue
      )
        throw Error('页面当前库存与此商品响应不一致，未导出');
      capturedCode = typeof c.out_sku_sn === 'string' ? c.out_sku_sn : '';
    }
    return {
      options,
      spec: options.map((o: any) => `${o.name}:${o.value}`).join(' / ') || '默认规格',
      group: groupValue,
      single: singleValue,
      stock: number(stockValue, true),
      code: (skuCode < 0 ? '' : row.cells[skuCode].value) || capturedCode,
    };
  });
  if (
    !remote ||
    !Array.isArray(remote.main) ||
    !remote.main.length ||
    !Array.isArray(remote.detail)
  )
    throw Error('商品图片未读取完整');
  if (remote.main.length > 10 || remote.detail.length > 50)
    throw Error('图片数量超过当前 Excel 模板上限');
  for (const [key, label] of [
    ['category', '类目'],
    ['brand', '品牌'],
    ['reference', '参考价'],
    ['shipping', '发货承诺'],
    ['freight', '运费模板'],
  ] as const)
    if (!p[key]) warnings.push(`${label}未读取，导入后须补充`);
  if (!facts.code && p.code === `PDD-${goods.goodsId}`)
    warnings.push('来源没有可用商品编码；软件编码使用 PDD-商品ID，复制前可修改');
  if (!remote.detail.length) warnings.push('未读取到详情图片，导入后须核对');
  return { product: p, warnings };
}

export class ShopCollector {
  state: CollectionState = {
    shopId: '',
    shopName: '',
    status: 'idle',
    message: '',
    goods: [],
    completeList: false,
    completed: 0,
    total: 0,
  };
  private controller?: AbortController;
  private bridge = new BrowserBridge(ORIGIN + '/home/');
  private shop?: Shop;
  get busy() {
    return !!this.controller;
  }
  constructor(
    private directory: string,
    private template: string,
    private decrypt: (shop: Shop) => Promise<string>,
    private emit: (state: CollectionState) => void,
    private validShop: (shop: Shop) => boolean,
  ) {}
  private update(patch: Partial<CollectionState>) {
    this.state = { ...this.state, ...patch };
    this.emit(this.state);
  }
  private guard() {
    if (this.controller?.signal.aborted) throw Error('已停止采集');
    if (this.shop && !this.validShop(this.shop)) throw Error('店铺资料已修改，请重新选择店铺');
  }
  cancel() {
    this.controller?.abort();
    if (this.busy) this.update({ message: '正在停止，已完成商品会保留' });
  }
  private begin() {
    if (this.busy) throw Error('正在读取店铺，请等待当前操作结束');
    this.controller = new AbortController();
  }
  private async login(shop: Shop) {
    this.guard();
    await this.bridge.connect();
    this.guard();
    await new PddLogin(
      this.bridge,
      this.decrypt,
      (e) => this.update({ message: e.name }),
      () => this.guard(),
    ).run(shop, 'reuse');
  }
  private async selectSaleList() {
    const ref = await this.bridge.wait(
      async () => {
        this.guard();
        const entry = await this.bridge.eval<{ count: number; selector?: string }>(
          `(${saleListEntry.toString()})()`,
        );
        if (entry.count > 0) return entry.count === 1 ? entry.selector : false;
        const tabs = flatten((await this.bridge.snapshot()).tree).filter(
          (n) => n.ref && saleLabel.test((n.name || '').replace(/\s/g, '')),
        );
        const candidates = tabs.filter((n) => ['tab', 'button', 'link'].includes(n.role || ''));
        const refs = [...new Set((candidates.length ? candidates : tabs).map((n) => n.ref!))];
        return refs.length === 1 ? refs[0] : false;
      },
      15000,
      '商品列表加载后仍未找到唯一的“在售”入口，请在后台核对当前列表后重试',
    );
    this.guard();
    await this.bridge.call('click', { selector: ref });
  }
  private async salePage() {
    return this.bridge.wait(
      async () => {
        this.guard();
        const raw = await this.bridge.eval<any>(`(${readSalePage.toString()})()`, 6000);
        return raw?.ready && raw?.active && raw?.paginationKnown && (raw.goods?.length || raw.empty)
          ? raw
          : false;
      },
      15000,
      '在售商品列表或分页尚未加载完整，请核对浏览器页面',
    );
  }
  async list(shop: Shop) {
    if (normalizePlatform(shop.platform) !== 'pdd') throw Error('当前仅支持采集拼多多店铺');
    this.begin();
    this.shop = { ...shop };
    this.update({
      shopId: shop.id,
      shopName: shop.name,
      status: 'listing',
      goods: [],
      completeList: false,
      completed: 0,
      total: 0,
      outputPath: undefined,
      message: '正在登录并核对店铺',
    });
    try {
      await this.login(shop);
      await this.bridge.navigate(LIST);
      await this.selectSaleList();
      const all = new Map<string, ShopGoods>();
      for (let page = 1; page <= 250; page++) {
        this.guard();
        const raw = await this.salePage();
        const current = parseSalePage(raw),
          before = all.size;
        for (const g of current.goods) all.set(g.goodsId, g);
        if (page > 1 && all.size === before)
          throw Error('翻页后商品列表未变化，已保留读取结果，请重新读取');
        this.update({
          goods: [...all.values()],
          message: `正在读取第 ${page} 页，已读取 ${all.size} 件在售商品`,
        });
        if (!current.hasNext) {
          if (Number.isSafeInteger(raw.total) && all.size !== raw.total)
            throw Error(`已读取 ${all.size} 件商品，与后台总数 ${raw.total} 不一致，请重新读取`);
          this.update({
            completeList: true,
            status: 'ready',
            message: `已读取 ${all.size} 件在售商品`,
          });
          return this.state;
        }
        if (all.size > 5000 || page === 250)
          throw Error('商品数量超过第一版读取范围，请分店铺或缩小后台筛选范围');
        await this.nextPage();
        const signature = current.goods.map((g) => g.goodsId).join(',');
        await this.bridge.wait(
          async () => {
            this.guard();
            const r = await this.bridge.eval<any>(`(${readSalePage.toString()})()`, 6000);
            return r?.ready && r.goods?.map((g: any) => g.goodsId).join(',') !== signature
              ? true
              : false;
          },
          15000,
          '后台翻页未完成',
        );
      }
    } catch (e) {
      this.update({
        status: this.controller?.signal.aborted ? 'cancelled' : 'error',
        message: (e as Error).message,
      });
      return this.state;
    } finally {
      this.controller = undefined;
    }
    return this.state;
  }
  private async nextPage() {
    this.guard();
    const native = await this.bridge.eval<number>(
      'document.querySelectorAll(\'[data-goods-sale-next="true"]\').length',
    );
    if (native === 1) {
      await this.bridge.call('click', { selector: '[data-goods-sale-next="true"]' });
      return;
    }
    const buttons = flatten((await this.bridge.snapshot()).tree).filter(
      (n) => n.ref && /^(下一页|next)$/i.test(n.name || ''),
    );
    if (buttons.length !== 1) throw Error('下一页按钮未能唯一定位，已保留读取结果');
    await this.bridge.call('click', { selector: buttons[0].ref });
  }
  private async openGoods(g: ShopGoods) {
    this.guard();
    if (g.editUrl) {
      await this.bridge.navigate(g.editUrl);
      return;
    }
    await this.bridge.navigate(LIST);
    await this.selectSaleList();
    // Prefer the actual link captured from the list, never construct a guessed editor URL.
    for (let page = 0; page < 250; page++) {
      const current = parseSalePage(await this.salePage());
      const snapshot = await this.bridge.snapshot();
      const rows = flatten(snapshot.tree).filter(
        (n) =>
          n.role === 'row' &&
          new RegExp(`(?:(?:商品(?:ID|编号)|\\bID)\\s*[:：]\\s*)${g.goodsId}(?!\\d)`, 'i').test(
            n.name ||
              flatten(n.children || [])
                .map((c) => c.name || '')
                .join(' '),
          ),
      );
      if (rows.length === 1) {
        const edit = flatten(rows[0].children || []).filter(
          (n) => n.ref && /^编辑(?:商品)?$/.test(n.name || ''),
        );
        if (edit.length !== 1) throw Error('该商品的编辑入口未能唯一定位');
        await this.bridge.call('click', { selector: edit[0].ref });
        // PDD opens the real editor in a new foreground tab. Borrow it only
        // after checking its origin and this exact goods ID.
        await this.bridge.wait(
          async () => {
            this.guard();
            const matches = (value: string) => {
              const url = new URL(value);
              return (
                url.origin === ORIGIN &&
                url.pathname.startsWith('/goods/') &&
                url.searchParams.get('goods_id') === g.goodsId
              );
            };
            if (matches(await this.bridge.eval<string>('location.href'))) return true;
            try {
              const tab = await this.bridge.call<{ url: string }>('find_tab', {
                url: ORIGIN,
                active: true,
              });
              return matches(tab.url);
            } catch (error) {
              if (/^find_tab.*no (?:foreground )?tab matching/.test((error as Error).message))
                return false;
              throw error;
            }
          },
          15000,
          '商品编辑页在新标签页打开，但未能核对商品编号，请在后台打开所选商品后重试',
        );
        return;
      }
      if (!current.hasNext) break;
      await this.nextPage();
      const signature = current.goods.map((g) => g.goodsId).join(',');
      await this.bridge.wait(
        async () => {
          this.guard();
          const r = await this.bridge.eval<any>(`(${readSalePage.toString()})()`, 6000);
          return r?.ready && r.goods?.map((g: any) => g.goodsId).join(',') !== signature;
        },
        15000,
        '查找商品翻页未完成',
      );
    }
    throw Error('来源商品已不在当前在售列表，请刷新列表后重新选择');
  }
  private async capturedCommit(facts: any) {
    const id = new URL(facts.url).searchParams.get('id');
    if (!id) return;
    const list = await this.bridge.call<any>('network', {
      cmd: 'list',
      filter: '/glide/v2/mms/query/commit/detail',
    });
    for (const r of [...(list.requests || [])].reverse()) {
      if (
        r.url !== ORIGIN + '/glide/v2/mms/query/commit/detail' ||
        !r.completed ||
        r.status !== 200
      )
        continue;
      const d = await this.bridge.call<any>('network', { cmd: 'detail', requestId: r.requestId });
      const input = typeof d.requestBody === 'string' ? JSON.parse(d.requestBody) : d.requestBody;
      if (String(input?.goods_commit_id) !== id) continue;
      return typeof d.body === 'string' ? JSON.parse(d.body) : d.body;
    }
  }
  private async download(url: string, file: string) {
    this.guard();
    const signal = AbortSignal.any([this.controller!.signal, AbortSignal.timeout(20000)]);
    let target = imageUrl(url),
      res: Response | undefined;
    for (let i = 0; i < 4; i++) {
      res = await fetch(target, { redirect: 'manual', signal });
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location) throw Error('图片跳转地址缺失');
      target = imageUrl(new URL(location, target).href);
    }
    if (!res?.ok || !res.body) throw Error(`图片下载未完成（${res?.status || '无响应'}）`);
    if (Number(res.headers.get('content-length') || 0) > 20 * 1024 * 1024) {
      await res.body.cancel();
      throw Error('图片超过 20MB 本机读取上限');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body as any) {
      this.guard();
      size += chunk.length;
      if (size > 20 * 1024 * 1024) {
        await res.body.cancel().catch(() => {});
        throw Error('图片超过 20MB 本机读取上限');
      }
      chunks.push(chunk);
    }
    await fs.writeFile(file, Buffer.concat(chunks), { mode: 0o600 });
  }
  private async readGoods(g: ShopGoods, temporary: string) {
    await new PddLogin(
      this.bridge,
      this.decrypt,
      () => {},
      () => this.guard(),
    ).run(this.shop!, 'check');
    try {
      await this.openGoods(g);
      const editor = await this.bridge.eval<string>('location.href');
      const url = new URL(editor);
      if (url.origin !== ORIGIN || url.searchParams.get('goods_id') !== g.goodsId)
        throw Error('商品编辑页编号与所选商品不一致，已停止读取');
      // Capture this editor's own response, including when its tab was opened
      // by PDD rather than through our session's navigate command.
      await this.bridge.call('network', { cmd: 'start' });
      await this.bridge.navigate(editor);
      const facts = await this.bridge.wait(
        async () => {
          this.guard();
          const f = await this.bridge.eval<any>(`(${readProductFacts.toString()})()`, 6000);
          return f?.title ? f : false;
        },
        15000,
        '商品编辑页未加载',
      );
      const table = parseSkuTable(await this.bridge.eval(`(${readSkuTable.toString()})()`));
      const imageColumns = table.headers.flatMap((h, i) => (/预览图|规格图/.test(h) ? [i] : []));
      facts.skuImages =
        imageColumns.length === 1
          ? await this.bridge.eval(
              `(${readSkuPictureCells.toString()})(${JSON.stringify(table.rows.map((row) => row.cells[imageColumns[0]].selector))})`,
            )
          : [];
      const remote = await this.bridge.eval<any>(`(${readRemoteImages.toString()})()`);
      const settings = await this.bridge.eval(`(${readSavedSettings.toString()})()`);
      const { product: p, warnings } = productFromPage(
        g,
        facts,
        table,
        settings,
        remote,
        await this.capturedCommit(facts),
      );
      p.source = `拼多多采集：${this.shop!.name}；商品ID ${g.goodsId}；北京时间 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`;
      const downloaded = new Map<string, Awaited<ReturnType<typeof saveImage>>>();
      let imageBytes = 0;
      const attach = async (url: string, name: string) => {
        const validated = imageUrl(url);
        let asset = downloaded.get(validated);
        if (!asset) {
          const file = path.join(temporary, randomUUID());
          await this.download(validated, file);
          asset = await saveImage(file, temporary);
          await fs.rm(file);
          imageBytes += asset.bytes;
          if (imageBytes > 75 * 1024 * 1024)
            throw Error('此商品图片总大小超过当前 Excel 的 75MB 上限');
          downloaded.set(validated, asset);
        }
        p.images[name] = { ...asset, name };
        return name;
      };
      for (const [kind, urls] of [
        ['main', remote.main],
        ['detail', remote.detail],
      ] as const)
        for (const [i, url] of (urls as string[]).entries()) {
          this.update({
            message: `正在下载“${g.title}”的${kind === 'main' ? '轮播图' : '详情图'} ${i + 1}/${urls.length}`,
          });
          p[kind].push(await attach(url, `${kind}-${i + 1}.png`));
        }
      if (facts.skuImages.length && facts.skuImages.length !== p.skus.length)
        warnings.push('规格图行数未能与规格对应，未自动分配规格图');
      else
        for (const [i, url] of facts.skuImages.entries())
          if (url) p.skus[i].image = await attach(url, `sku-${i + 1}.png`);
      this.guard();
      return { bytes: await exportProductWorkbook(p, this.template, temporary), warnings };
    } finally {
      await this.bridge.call('network', { cmd: 'stop' }).catch(() => {});
    }
  }
  async export(ids: string[], destination: string) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 50 ||
      ids.some((id) => typeof id !== 'string') ||
      new Set(ids).size !== ids.length
    )
      throw Error('请选择 1 至 50 件商品导出');
    const goods = ids.map((id) => this.state.goods.find((g) => g.goodsId === id));
    if (!this.shop || goods.some((g) => !g)) throw Error('所选商品不在当前店铺列表，请重新读取');
    this.begin();
    this.update({
      status: 'exporting',
      exportIds: [...ids],
      completed: 0,
      total: ids.length,
      outputPath: undefined,
      message: '正在核对来源店铺',
      goods: this.state.goods.map((g) =>
        ids.includes(g.goodsId) ? { ...g, status: 'waiting', message: '' } : g,
      ),
    });
    let temporary = '',
      outputTemporary = '';
    const zip = new JSZip(),
      report: string[] = [
        `来源店铺：${this.shop.name}`,
        `采集时间：${new Date().toISOString()}`,
        '库存保留逐规格实际读取值；未读取字段需在导入后核对。',
      ];
    let size = 0,
      success = 0,
      single: Buffer | undefined;
    const mark = (id: string, status: ShopGoods['status'], message: string) =>
      this.update({
        goods: this.state.goods.map((g) => (g.goodsId === id ? { ...g, status, message } : g)),
      });
    const persist = async (stopped = false) => {
      zip.file('导出结果.txt', report.join('\r\n'));
      const bytes =
        ids.length === 1
          ? single!
          : await zip.generateAsync({
              type: 'nodebuffer',
              compression: 'DEFLATE',
              compressionOptions: { level: 1 },
            });
      if (!stopped) this.guard();
      if (outputTemporary) await fs.rm(outputTemporary, { force: true });
      outputTemporary = `${destination}.${randomUUID()}.tmp`;
      await fs.writeFile(outputTemporary, bytes, { flag: 'wx', mode: 0o600 });
      if (!stopped) this.guard();
      await fs.rename(outputTemporary, destination);
      outputTemporary = '';
    };
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      temporary = await fs.mkdtemp(path.join(this.directory, 'collection-'));
      await this.login(this.shop);
      for (const g of goods as ShopGoods[]) {
        this.guard();
        mark(g.goodsId, 'reading', '正在读取规格和图片');
        try {
          const result = await this.readGoods(g, temporary);
          this.guard();
          if (size + result.bytes.length > 500 * 1024 * 1024)
            throw Error('本次图片总大小超过 500MB，请减少勾选商品后导出');
          size += result.bytes.length;
          success++;
          single = result.bytes;
          zip.file(`${g.goodsId}-${safeName(g.title)}.xlsx`, result.bytes);
          const message = result.warnings.length
            ? `已生成 Excel；${result.warnings.join('；')}`
            : '已生成含图 Excel';
          mark(g.goodsId, 'done', message);
          report.push(`${g.goodsId} ${g.title}：${message}`);
        } catch (e) {
          this.guard();
          mark(g.goodsId, 'failed', (e as Error).message);
          report.push(`${g.goodsId} ${g.title}：失败，${(e as Error).message}`);
        }
        this.update({ completed: this.state.completed + 1 });
      }
      this.guard();
      if (!success) throw Error('所选商品均未导出，请查看每件商品的失败原因');
      this.update({ message: '正在保存导出文件' });
      await persist();
      const failed = ids.length - success;
      this.update({
        status: 'done',
        outputPath: destination,
        message: `已导出 ${success} 件商品${failed ? `，${failed} 件失败，可单独重试` : ''}`,
      });
    } catch (e) {
      const stopped = !!this.controller?.signal.aborted;
      this.update({
        goods: this.state.goods.map((g) =>
          ids.includes(g.goodsId) && ['waiting', 'reading'].includes(g.status || '')
            ? {
                ...g,
                status: stopped ? 'stopped' : 'failed',
                message: stopped ? '已停止，未导出此商品' : '未完成此商品导出',
              }
            : g,
        ),
      });
      if (stopped && success) {
        report.push(`已停止，保存已完成的 ${success} 件商品，其余未导出。`);
        this.update({ message: `正在保留已完成的 ${success} 件商品` });
        try {
          await persist(true);
          this.update({
            status: 'cancelled',
            outputPath: destination,
            message: `已停止，已保存 ${success} 件商品；其余商品可重新勾选导出`,
          });
          return this.state;
        } catch (saveError) {
          e = saveError;
        }
      }
      this.update({
        status: stopped && !success ? 'cancelled' : 'error',
        goods: this.state.goods.map((g) =>
          ids.includes(g.goodsId) && g.status === 'done'
            ? { ...g, status: 'failed', message: '导出文件未保存，请重新导出' }
            : g,
        ),
        message: (e as Error).message,
      });
    } finally {
      this.controller = undefined;
      if (temporary) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
      if (outputTemporary) await fs.rm(outputTemporary, { force: true }).catch(() => {});
    }
    return this.state;
  }
}

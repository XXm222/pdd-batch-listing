import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { BrowserBridge } from '../browser-bridge';
import { saveImage } from '../importer';
import { exportProductWorkbook } from '../workbook-export';
import { TAOBAO_LOGIN_URL, TAOBAO_WORKBENCH, TaobaoLogin } from './taobao-login';
import type { CollectionState, Product, Shop, ShopGoods } from '../../src/types';

/**
 * 淘宝店铺商品采集与导出。
 *
 * 与拼多多侧 `ShopCollector` 保持同一套语义：
 *   · `list()`  读「商品管理 › 出售中」整页列表，逐页读完并与后台「共 N 件商品」核对；
 *   · `export()` 对勾选的每个商品打开编辑页抽资料 → 图片下载落盘 →
 *     `exportProductWorkbook(淘宝模板)` 生成一份含图 Excel；
 *     多件时打包 zip 并附 `导出结果.txt`。
 *
 * 与拼多多的两处平台差异（都在内部消化，外部行为一致）：
 *   1. alicdn 图片无论 Accept 都返回 WEBP，而 Excel 只认 png/jpg —— 这里借页面里的
 *      canvas 把 WEBP 转成 JPEG（Electron 侧没有转码库，也不想加原生依赖）；
 *   2. 淘宝列表页支持 `?current=N` 翻页，比点「下一页」稳，但同样按总数校验完整性。
 */
const LIST_URL = 'https://myseller.taobao.com/home.htm/SellManage/on_sale';
const ITEM_URL = 'https://sell.publish.tmall.com/tmall/itemEdit.htm?itemId=';
const TRUSTED_ORIGINS = [
  TAOBAO_LOGIN_URL,
  'https://loginmyseller.taobao.com',
  'https://sell.publish.tmall.com',
];
const PAGE_SIZE = 20;

/** 页面侧可见性判定，所有脚本共用。 */
const SHOWN = `const shown=(e)=>{if(!e)return false;const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&getComputedStyle(e).visibility!=='hidden';};`;
const script = (body: string) => `(() => {${SHOWN}${body}})()`;

/** 读当前列表页的表格行与总数。 */
export const READ_LIST = script(
  `const t=(e)=>(e.innerText||'').replace(/\\s+/g,' ').trim();` +
    `const rows=[...document.querySelectorAll('tr')].filter(r=>shown(r)).map(r=>{const text=t(r);` +
    `const m=text.match(/ID:(\\d+)/);if(!m)return null;` +
    `const tds=[...r.querySelectorAll('td')].map(td=>t(td)).filter(Boolean);` +
    `const img=r.querySelector('img');` +
    `return {goodsId:m[1],title:text.split(' ID:')[0].trim(),cells:tds,thumbnail:img?img.src:''};}).filter(Boolean);` +
    `const total=(t(document.body).match(/共(\\d+)件商品/)||[])[1]||null;` +
    `const page=(t(document.body).match(/\\b(\\d+)\\s*\\/\\s*(\\d+)\\b/)||[]);` +
    `return {rows,total:total?Number(total):null,pages:page[2]?Number(page[2]):null,ready:rows.length>0||/共0件商品/.test(t(document.body))};`,
);

/** 抽取编辑页的商品资料（与 scripts/pull-item.mjs 同一套口径）。 */
export const READ_ITEM = script(
  `const read=(id)=>{const r=document.getElementById('sell-field-'+id);if(!r)return null;` +
    `const i=[...r.querySelectorAll('input,textarea')].find(x=>shown(x)&&!['checkbox','radio','file','hidden'].includes(x.type));` +
    `return i?i.value:null;};` +
    `const imgs=(id)=>{const r=document.getElementById('sell-field-'+id);if(!r)return [];` +
    `return [...r.querySelectorAll('img')].map(i=>i.src).filter(s=>s&&!s.endsWith('.svg'));};` +
    `const radio=(rootSel)=>{const r=document.querySelector(rootSel);if(!r)return null;` +
    `const on=[...r.querySelectorAll('input[type=radio]')].find(x=>x.checked);` +
    `if(!on)return null;const lab=on.closest('label')||on.parentElement;return (lab?(lab.innerText||''):'').replace(/\\s+/g,' ').trim();};` +
    `const radioIndex=(id)=>{const r=document.getElementById('sell-field-'+id);if(!r)return null;` +
    `const rs=[...r.querySelectorAll('input[type=radio]')];const i=rs.findIndex(x=>x.checked);return i<0?null:i;};` +
    `const trs=[...document.querySelectorAll('#sell-field-sku table tbody tr')];` +
    `return JSON.stringify({` +
    `title:read('title'),code:read('p-13021751'),outerId:read('outerId'),price:read('price'),quantity:read('quantity'),` +
    `category:(()=>{const r=document.getElementById('sell-field-category');return r?(r.innerText||'').replace(/\\s+/g,' ').trim():null;})(),` +
    `brand:(()=>{const r=document.getElementById('sell-field-p-20000');if(!r)return null;` +
    `const i=[...r.querySelectorAll('input')].filter(shown).find(x=>x.type==='text');return i?(i.value||'').trim()||null:null;})(),` +
    `main:imgs('mainImagesGroup'),threeToFour:imgs('threeToFourImages'),detail:imgs('descRepublicOfSell'),whiteBg:imgs('yinHeWhiteBgImage'),` +
    `extractWay:radioIndex('tmExtractWay'),deliveryTime:radioIndex('tmDeliveryTime'),shelfTime:radioIndex('shelfTime'),` +
    `location:(()=>{const r=document.getElementById('sell-field-location');if(!r)return null;` +
    `const t=(r.innerText||'').replace(/\\s+/g,' ').trim();` +
    `const m=t.match(/([^ ]+)\\s*\\/\\s*([^ ]+)\\s*$/);return m?{province:m[1],city:m[2]}:null;})(),` +
    `auctionPoint:read('auctionPoint'),` +
    `skus:trs.map(tr=>({props:[...tr.querySelectorAll('td.is-sale-prop')].map(td=>(td.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean),` +
    `price:tr.querySelector('td.sell-sku-cell-money input')?.value??null,` +
    `qty:tr.querySelector('td.sell-sku-cell-number input')?.value??null}))});`,
);

/** 把任意图片 URL 的字节转成 JPEG（借页面 canvas，绕开 alicdn 强制 webp）。 */
const TO_JPEG = (base64: string) =>
  `(async () => {const bin=atob(${JSON.stringify(base64)});const arr=new Uint8Array(bin.length);` +
  `for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);` +
  `const bmp=await createImageBitmap(new Blob([arr],{type:'image/webp'}));` +
  `const c=document.createElement('canvas');c.width=bmp.width;c.height=bmp.height;` +
  `c.getContext('2d').drawImage(bmp,0,0);return c.toDataURL('image/jpeg',0.92);})()`;

export class TaobaoCollector {
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
  private bridge = new BrowserBridge(TAOBAO_WORKBENCH, TRUSTED_ORIGINS);
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
    await new TaobaoLogin(
      this.bridge,
      this.decrypt,
      () => {},
      () => this.guard(),
    ).run(shop, 'reuse');
  }

  /** 读「出售中」整页列表，逐页读完并与后台总数核对。 */
  async list(shop: Shop): Promise<CollectionState> {
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
      await this.bridge.navigate(LIST_URL);
      const all = new Map<string, ShopGoods>();
      let total: number | null = null;
      for (let page = 1; page <= 250; page += 1) {
        this.guard();
        await this.bridge.navigate(`${LIST_URL}?current=${page}&pageSize=${PAGE_SIZE}`);
        const raw = await this.bridge.wait(
          async () =>
            await this.bridge.eval<{
              rows: { goodsId: string; title: string; cells: string[]; thumbnail: string }[];
              total: number | null;
              pages: number | null;
              ready: boolean;
            }>(READ_LIST),
          20000,
          '商品列表未加载',
        );
        if (raw.total !== null) {
          if (total !== null && raw.total !== total)
            throw Error('翻页过程中在售商品总数发生变化，请重新读取');
          total = raw.total;
        }
        for (const row of raw.rows) {
          all.set(row.goodsId, {
            goodsId: row.goodsId,
            title: row.title,
            thumbnail: row.thumbnail,
            price: row.cells[1] || '',
            editUrl: `${ITEM_URL}${row.goodsId}`,
          });
        }
        this.update({
          goods: [...all.values()],
          message: `正在读取第 ${page} 页，已读取 ${all.size} 件在售商品`,
        });
        // 页数按「总数 / 每页条数」算：页面上那个 "x / y" 容易被别的文案误匹配。
        const pages = raw.total !== null ? Math.ceil(raw.total / PAGE_SIZE) : raw.pages;
        if (!pages || page >= pages) break;
        if (all.size > 5000) throw Error('商品数量超过第一版读取范围，请分店铺读取');
      }
      if (total !== null && all.size !== total)
        throw Error(`已读取 ${all.size} 件商品，与后台总数 ${total} 不一致，请重新读取`);
      this.update({
        completeList: true,
        status: 'ready',
        message: `已读取 ${all.size} 件在售商品`,
      });
      return this.state;
    } catch (e) {
      this.update({
        status: this.controller?.signal.aborted ? 'cancelled' : 'error',
        message: (e as Error).message,
      });
      return this.state;
    } finally {
      this.controller = undefined;
    }
  }

  /** 下载图片并转成 JPEG，登记为可嵌入 Excel 的资产。 */
  private async fetchImage(
    url: string,
    name: string,
    assetsDir: string,
  ): Promise<{ name: string; asset: Awaited<ReturnType<typeof saveImage>> } | null> {
    const original = url.replace(/_\d+x\d+q\d+_\.webp$/, '');
    let bytes: Buffer;
    try {
      const res = await fetch(original);
      if (!res.ok) return null;
      bytes = Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
    if (bytes.length > 20 * 1024 * 1024) return null;
    // WEBP → JPEG：页面 canvas 转码，避免给 Electron 引入原生图片库。
    let jpeg = bytes;
    if (bytes.subarray(8, 12).toString() === 'WEBP') {
      try {
        const dataUrl = await this.bridge.eval<string>(TO_JPEG(bytes.toString('base64')), 60000);
        jpeg = Buffer.from(String(dataUrl).split(',')[1] || '', 'base64');
      } catch {
        return null;
      }
    }
    const file = path.join(assetsDir, `${randomUUID()}.jpg`);
    await fs.writeFile(file, jpeg, { mode: 0o600 });
    const asset = await saveImage(file, assetsDir);
    await fs.rm(file, { force: true });
    return { name, asset };
  }

  /** 打开编辑页把一个商品抽成 Product（含图片资产）。 */
  private async readGoods(goods: ShopGoods, assetsDir: string) {
    this.guard();
    await this.bridge.navigate(`${ITEM_URL}${goods.goodsId}`);
    const raw = await this.bridge.wait(
      async () => {
        this.guard();
        const value = await this.bridge.eval<string>(READ_ITEM);
        try {
          const p = JSON.parse(value || '{}');
          return p.title ? p : false;
        } catch {
          return false;
        }
      },
      30000,
      '商品编辑页未加载',
    );
    const warnings: string[] = [];
    const category = String(raw.category || '')
      .replace(/当前类目/g, '')
      .replace(/切换类目/g, '')
      .trim()
      .replace(/\s*>>\s*/g, ' > ');
    if (!category) warnings.push('类目未读取，导入后须补充');
    const parsedOrigin = raw.location as { province?: string; city?: string } | null;
    const province = parsedOrigin?.province || '广东';
    const city = parsedOrigin?.city || '深圳';
    if (!parsedOrigin) warnings.push('发货地未读取，已填默认「广东/深圳」，导入后须核对');
    // 三个单选按「选中下标」还原文字；顺序与后台一致。
    const SHELF = ['立刻上架', '定时上架', '放入仓库'];
    const DELIVERY = ['今日发', '48小时', '大于48小时'];
    const EXTRACT = ['电子交易凭证', '邮寄'];
    const pick = (index: unknown, table: string[], fallback: string, label: string) => {
      if (typeof index === 'number' && table[index]) return table[index];
      warnings.push(`${label}未读取，已填默认「${fallback}」，导入后须核对`);
      return fallback;
    };
    const shelfTime = pick(raw.shelfTime, SHELF, '放入仓库', '上架时间');
    const deliveryTime = pick(raw.deliveryTime, DELIVERY, '48小时', '发货时间');
    const extractWay = pick(raw.extractWay, EXTRACT, '邮寄', '提取方式');

    const product: Product = {
      id: randomUUID(),
      code: String(raw.code || goods.goodsId),
      outerId: String(raw.outerId || ''),
      title: String(raw.title || goods.title),
      category,
      brand: String(raw.brand || ''),
      material: '',
      audience: '',
      foldable: '',
      reference: '',
      skuCode: '',
      discount: '',
      shipping: '',
      freight: '',
      expectedShop: '',
      demo: false,
      source: `淘宝采集：${this.shop!.name}；商品ID ${goods.goodsId}`,
      templateFormat: '淘宝运营模板 v4',
      skus: (raw.skus as any[]).map((sku) => ({
        spec: (sku.props as string[]).join(' / ') || '默认规格',
        group: '',
        single: String(sku.price || ''),
        stock: String(sku.qty || '0'),
        code: '',
        image: '',
        options: (sku.props as string[]).map((value, i) => ({
          name: i === 0 ? '颜色' : `规格${i + 1}`,
          value,
        })),
      })),
      main: [],
      detail: [],
      threeToFour: [],
      whiteBg: [],
      usp: [],
      images: {},
      attributes: [],
      taobao: {
        originProvince: province,
        originCity: city,
        extractWay,
        freightBearer: '卖家承担',
        deliveryTime,
        shelfTime,
        auctionPoint: /^\d+(\.\d)?$/.test(String(raw.auctionPoint || ''))
          ? String(raw.auctionPoint)
          : '0.5',
      },
    };

    const plan: [
      keyof Pick<Product, 'main' | 'detail' | 'threeToFour' | 'whiteBg'>,
      string[],
      string,
    ][] = [
      ['main', raw.main as string[], '1:1主图'],
      ['detail', raw.detail as string[], '详情图'],
      ['threeToFour', raw.threeToFour as string[], '3:4主图'],
      ['whiteBg', raw.whiteBg as string[], '白底图'],
    ];
    for (const [key, urls, label] of plan) {
      const limit = key === 'detail' ? 20 : key === 'main' ? 5 : 1;
      for (const [i, url] of (urls || []).slice(0, limit).entries()) {
        this.update({ message: `正在下载「${product.title.slice(0, 12)}…」的${label} ${i + 1}` });
        const saved = await this.fetchImage(url, `${key}-${i + 1}.jpg`, assetsDir);
        if (!saved) {
          warnings.push(`${label}第 ${i + 1} 张下载失败`);
          continue;
        }
        product.images[saved.name] = { ...saved.asset, name: saved.name };
        (product[key] as string[]).push(saved.name);
      }
    }
    if (!product.main.length) throw Error('该商品没有读到 1:1 主图，未导出');
    if (!product.skus.length) throw Error('该商品没有读到 SKU，未导出');
    return { product, warnings };
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
    let assetsDir = '';
    let outputTemporary = '';
    const zip = new JSZip();
    const report = [
      `来源店铺：${this.shop.name}`,
      `采集时间：${new Date().toISOString()}`,
      '库存保留逐规格实际读取值；未读取字段需在导入后核对。',
    ];
    const mark = (id: string, status: ShopGoods['status'], message: string) =>
      this.update({
        goods: this.state.goods.map((g) => (g.goodsId === id ? { ...g, status, message } : g)),
      });
    let success = 0;
    let single: Buffer | undefined;
    let size = 0;
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      assetsDir = await fs.mkdtemp(path.join(this.directory, 'collection-'));
      await this.login(this.shop);
      for (const g of goods as ShopGoods[]) {
        this.guard();
        mark(g.goodsId, 'reading', '正在读取规格和图片');
        try {
          const { product, warnings } = await this.readGoods(g, assetsDir);
          this.guard();
          const bytes = await exportProductWorkbook(product, this.template, assetsDir);
          if (size + bytes.length > 500 * 1024 * 1024)
            throw Error('本次导出总大小超过 500MB，请减少勾选商品');
          size += bytes.length;
          success += 1;
          single = bytes;
          zip.file(
            `${g.goodsId}-${g.title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 40)}.xlsx`,
            bytes,
          );
          const message = warnings.length
            ? `已生成 Excel；${warnings.slice(0, 3).join('；')}`
            : '已生成含图 Excel';
          mark(g.goodsId, 'done', message);
          report.push(`${g.goodsId} ${g.title}：${message}`);
        } catch (e) {
          const message = (e as Error).message;
          mark(g.goodsId, 'failed', message);
          report.push(`${g.goodsId} ${g.title}：失败，${message}`);
        }
        this.update({ completed: this.state.completed + 1 });
      }
      this.guard();
      if (!success) throw Error('所选商品均未导出，请查看每件商品的失败原因');
      zip.file('导出结果.txt', report.join('\r\n'));
      const bytes =
        ids.length === 1
          ? single!
          : await zip.generateAsync({
              type: 'nodebuffer',
              compression: 'DEFLATE',
              compressionOptions: { level: 1 },
            });
      outputTemporary = `${destination}.${randomUUID()}.tmp`;
      await fs.writeFile(outputTemporary, bytes, { flag: 'wx', mode: 0o600 });
      await fs.rename(outputTemporary, destination);
      outputTemporary = '';
      const failed = ids.length - success;
      this.update({
        status: 'done',
        outputPath: destination,
        message: `已导出 ${success} 件商品${failed ? `，${failed} 件失败，可单独重试` : ''}`,
      });
      return this.state;
    } catch (e) {
      this.update({
        status: this.controller?.signal.aborted ? 'cancelled' : 'error',
        message: (e as Error).message,
      });
      return this.state;
    } finally {
      if (outputTemporary) await fs.rm(outputTemporary, { force: true }).catch(() => {});
      if (assetsDir) await fs.rm(assetsDir, { recursive: true, force: true }).catch(() => {});
      this.controller = undefined;
    }
  }
}

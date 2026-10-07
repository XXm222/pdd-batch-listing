/**
 * 淘宝/天猫「发布商品 → 保存草稿」流程。
 *
 * 全部步骤都在真实后台验证过（见 项目文档/25淘宝发品流程Workflow.md 与
 * verification/taobao-20261006/）。三条硬规则，改动前务必先读：
 *
 *  1. 控件定位必须过滤「可见且有尺寸」。页面保留同一套控件的多份实例，
 *     其中一份未布局（0×0），querySelector 命中的往往是隐藏副本 —— 往它填值
 *     页面上「看着生效」但 React 状态没变，按钮永远不可用。统一用 markVisible()。
 *  2. 文本输入必须走真实键盘事件。扩展的 fill（改 DOM value）不会更新受控组件，
 *     所以一律用 bridge.fill(selector, value, 'keyboard')。
 *  3. 残留的 .next-overlay-backdrop 是透明遮罩，会吃掉所有 CDP 真实鼠标点击；
 *     真实点击前先 closeOverlays()。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BrowserBridge, delay } from '../browser-bridge';
import { ExecutionError, type ExecutionContext } from '../execution';
import type { Product, Shop, Task, TaskStep } from '../../src/types';

// ─────────────────────────── 常量 ───────────────────────────

export const TAOBAO_PUBLISH_ENTRY = 'https://sell.publish.tmall.com/tmall/ai/category.htm';
export const TAOBAO_ITEM_EDIT = 'https://sell.publish.tmall.com/tmall/itemEdit.htm';
export const TAOBAO_DRAFT_LIST =
  'https://myseller.taobao.com/home.htm/SellManage/in_stock?current=1&pageSize=20';

/** 1:1 主图上限。超出部分会被系统分装到别的槽位，必须先裁到 5 张。 */
export const TAOBAO_MAIN_IMAGE_LIMIT = 5;
/** 宝贝详情图上限。 */
export const TAOBAO_DETAIL_IMAGE_LIMIT = 20;
/** 标题长度上限，汉字按 2 字符计。 */
export const TAOBAO_TITLE_LIMIT = 60;

/**
 * 发货地兜底值。只在商品资料没填时使用 —— 天猫必填且必须级联到市，
 * 正确来源是商品资料（淘宝模板 v4）的「发货地省份 / 发货地城市」。
 */
export const TAOBAO_DEFAULT_ORIGIN = { province: '广东', city: '深圳' };

/** 上架时间三个单选的顺序，与后台一致。 */
export const TAOBAO_SHELF_TIME_INDEX: Record<string, number> = {
  立刻上架: 0,
  定时上架: 1,
  放入仓库: 2,
};
/** 发货时间单选的顺序，与后台一致。 */
export const TAOBAO_DELIVERY_TIME_INDEX: Record<string, number> = {
  今日发: 0,
  '48小时': 1,
  大于48小时: 2,
};

/** 淘宝发品设置：优先取商品资料，缺失时退回后台默认值。 */
export function taobaoListingSettings(product: Pick<Product, 'taobao'>) {
  const t = product.taobao;
  const pick = (value: string | undefined, fallback: string) => (value || '').trim() || fallback;
  return {
    originProvince: pick(t?.originProvince, TAOBAO_DEFAULT_ORIGIN.province),
    originCity: pick(t?.originCity, TAOBAO_DEFAULT_ORIGIN.city),
    extractWay: pick(t?.extractWay, '邮寄'),
    freightBearer: pick(t?.freightBearer, '卖家承担'),
    deliveryTime: pick(t?.deliveryTime, '48小时'),
    shelfTime: pick(t?.shelfTime, '放入仓库'),
    auctionPoint: pick(t?.auctionPoint, '0.5'),
    /** 商品资料里是否真的填了发货地；没填时读回要给运营提示。 */
    originFromProduct: Boolean((t?.originProvince || '').trim() && (t?.originCity || '').trim()),
  };
}

/** 可见性判定片段，注入到每个页面脚本里。 */
export const TB_SHOWN =
  "const shown=e=>{if(!e)return false;const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&getComputedStyle(e).visibility!=='hidden';};";

/** 主图/详情图的槽位与期望数量，用于提交前的图片落位核对。 */
export const TAOBAO_IMAGE_SLOTS = [
  { id: 'mainImagesGroup', label: '1:1主图', expect: 'uploaded-main' },
  { id: 'descRepublicOfSell', label: '宝贝详情', expect: 'uploaded-detail' },
  { id: 'threeToFourImages', label: '3:4主图', expect: 0 },
  { id: 'diaopai', label: '吊牌图', expect: 0 },
  { id: 'yinHeWhiteBgImage', label: '白底图', expect: 0 },
  { id: 'uspImageV3', label: '卖点图', expect: 0 },
  { id: 'guideImageGroup', label: '导购素材·透明素材图', expect: 'platform-png' },
] as const;

// ─────────────────────── 纯函数（可单测） ───────────────────────

/** 天猫按汉字 2 字符、其余 1 字符计标题长度。 */
export function taobaoCharLength(text: string): number {
  let total = 0;
  for (const char of text) total += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(char) ? 2 : 1;
  return total;
}

/** 标题不合规时返回原因，合规返回 null。 */
export function taobaoTitleProblem(title: string): string | null {
  const text = (title || '').trim();
  if (!text) return '商品标题为空';
  const length = taobaoCharLength(text);
  if (length > TAOBAO_TITLE_LIMIT)
    return `商品标题超长：${length}/${TAOBAO_TITLE_LIMIT}（汉字按 2 字符计）`;
  return null;
}

/**
 * 图片落位计划。
 * 主图位上限 5，所以轮播图必须裁到 5 张；详情图取全部并受 20 张上限约束。
 * 超限不静默截断，交由调用方决定是报错还是裁剪。
 */
export function taobaoImagePlan(product: Pick<Product, 'main' | 'detail'>): {
  main: string[];
  detail: string[];
  overflow: { main: number; detail: number };
} {
  const main = (product.main || []).slice(0, TAOBAO_MAIN_IMAGE_LIMIT);
  const detail = (product.detail || []).slice(0, TAOBAO_DETAIL_IMAGE_LIMIT);
  return {
    main,
    detail,
    overflow: {
      main: Math.max(0, (product.main || []).length - TAOBAO_MAIN_IMAGE_LIMIT),
      detail: Math.max(0, (product.detail || []).length - TAOBAO_DETAIL_IMAGE_LIMIT),
    },
  };
}

/** 一口价：天猫只有一个价格，取第一个有库存 SKU 的「单买价」。 */
export function taobaoPrice(product: Pick<Product, 'skus'>): string | null {
  const skus = product.skus || [];
  const inStock = skus.filter((sku) => Number(sku.stock) > 0);
  const pool = inStock.length ? inStock : skus;
  for (const sku of pool) {
    const value = String(sku.single || '').trim();
    if (/^\d+(\.\d{1,2})?$/.test(value)) return value;
  }
  return null;
}

/** 商品数量：单规格手填总库存；多规格由表格自动汇总，这里给出期望值用于回读校验。 */
export function taobaoQuantity(product: Pick<Product, 'skus'>): number {
  return (product.skus || []).reduce((sum, sku) => sum + (Number(sku.stock) || 0), 0);
}

export type TaobaoAttributePlan = {
  /** 商品资料里的属性名，如「材质」。 */
  name: string;
  /** 要写入的值。 */
  value: string;
};

/**
 * 从商品资料整理出待填写的类目属性。
 * 只取「有值」的属性；能否真正填进去取决于后台该类目的选项，
 * 由 selectAttribute() 在真实页面上判断（选项没有就跳过并记录）。
 */
export function taobaoAttributePlan(
  product: Pick<Product, 'material' | 'audience' | 'foldable' | 'attributes'>,
): TaobaoAttributePlan[] {
  const plan: TaobaoAttributePlan[] = [];
  const push = (name: string, value: unknown) => {
    const text = String(value ?? '').trim();
    if (text && !plan.some((item) => item.name === name)) plan.push({ name, value: text });
  };
  push('材质', product.material);
  push('适用人群', product.audience);
  push('折叠功能', product.foldable);
  for (const attribute of product.attributes || []) push(attribute.name, attribute.value);
  return plan;
}

/**
 * 把商品资料的类目路径对到天猫 AI 给出的候选项上。
 * 商品资料用 `>` 分隔（拼多多口径），页面用 `>>`，只比对最后一级。
 * 返回候选项下标，找不到返回 -1 —— 找不到时必须停下来让运营确认，不能猜。
 */
export function matchTaobaoCategoryPath(candidates: string[], category: string): number {
  const leaf = (category || '')
    .split(/\s*>\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .pop();
  if (!leaf) return -1;
  const normalized = (value: string) => value.replace(/\s+/g, '');
  return candidates.findIndex((text) => normalized(text).includes(normalized(leaf)));
}

export type TaobaoSkuRow = { values: string[]; price: string; quantity: string };
export type TaobaoSkuDimension = { name: string; values: string[] };
export type TaobaoSkuPlan =
  | { kind: 'single' }
  | { kind: 'dimensions'; dimensions: TaobaoSkuDimension[]; rows: TaobaoSkuRow[] }
  | { kind: 'unsupported'; reason: string };

/**
 * 规格计划。
 *
 * 天猫的建规格抽屉（自定义填写规格）只按「值」建规格，不能命名维度；标准属性模式
 * 又依赖该类目是否下发该销售属性。因此本版只实现**单维度多值**（如容量 10L/20L），
 * 这正是泡脚桶一类商品的常规卖法。
 *
 * 多维度必须显式报错而不是硬塞 —— 旧实现会把 2 个 SKU 压成「一个价 + 总库存」，
 * 商品数据静默出错且上报 passed，这是审计里最严重的一条 P0。
 */
export function taobaoSkuPlan(product: Pick<Product, 'skus'>): TaobaoSkuPlan {
  const skus = product.skus || [];
  const names: string[] = [];
  for (const sku of skus)
    for (const option of sku.options || []) {
      const name = (option.name || '').trim();
      if (name && !names.includes(name)) names.push(name);
    }
  if (!names.length) {
    if (skus.length > 1)
      return {
        kind: 'unsupported',
        reason: `商品有 ${skus.length} 条 SKU 但没有填写「区分方式」，无法建规格；请在规格清单补上规格名称与值`,
      };
    return { kind: 'single' };
  }
  if (names.length > 2)
    return {
      kind: 'unsupported',
      reason: `天猫最多支持两个销售属性，本商品有 ${names.length} 个：${names.join('、')}`,
    };

  // 每个维度的取值按出现顺序去重
  const dimensions: TaobaoSkuDimension[] = names.map((name) => ({ name, values: [] }));
  const rows: TaobaoSkuRow[] = [];
  for (const sku of skus) {
    const values = dimensions.map((dimension) => {
      const hit = (sku.options || []).find(
        (option) => (option.name || '').trim() === dimension.name,
      );
      return (hit?.value || '').trim();
    });
    if (values.some((value) => !value)) continue;
    values.forEach((value, i) => {
      if (!dimensions[i].values.includes(value)) dimensions[i].values.push(value);
    });
    rows.push({
      values,
      price: (sku.single || '').trim(),
      quantity: (sku.stock || '').trim(),
    });
  }
  if (!dimensions.every((dimension) => dimension.values.length)) return { kind: 'single' };
  // 交叉组合必须齐全，否则后台生成的规格表与商品资料对不上
  const expected = dimensions.reduce((count, dimension) => count * dimension.values.length, 1);
  if (rows.length !== expected)
    return {
      kind: 'unsupported',
      reason: `规格组合不完整：${dimensions
        .map((d) => `${d.name}(${d.values.length})`)
        .join(' × ')} 共需 ${expected} 条，实际 ${rows.length} 条；请在规格清单补全全部组合`,
    };
  return { kind: 'dimensions', dimensions, rows };
}

/**
 * 图片落位核对：只对**我们能控制**的两个槽位下硬结论。
 *
 * 3:4主图 / 吊牌图 / 白底图 / 卖点图 / 导购素材都是平台可选位，平台自己会往里放图
 * —— 已实测「导购素材·透明素材图」会被自动生成一张抠好的 PNG。
 * 拿「这些槽位必须为空」去卡，会把平台的正常行为误判成串位并中断提交。
 */
export function taobaoImageProblems(
  slots: Record<string, { count: number; firstSrc?: string | null }>,
): string[] {
  const problems: string[] = [];
  const main = slots.mainImagesGroup;
  if (!main || main.count === 0) problems.push('1:1主图没有图片');
  else if (main.count > TAOBAO_MAIN_IMAGE_LIMIT)
    problems.push(`1:1主图 ${main.count} 张，超过 ${TAOBAO_MAIN_IMAGE_LIMIT} 张上限`);
  const detail = slots.descRepublicOfSell;
  if (!detail || detail.count === 0) problems.push('宝贝详情没有图片');
  return problems;
}

/** 各图片位的实际数量，写进检查项说明供运营核对；不作为失败条件。 */
export function taobaoImageSummary(
  slots: Record<string, { count: number; firstSrc?: string | null }>,
): string {
  return TAOBAO_IMAGE_SLOTS.map((slot) => `${slot.label} ${slots[slot.id]?.count ?? 0} 张`).join(
    '；',
  );
}

// ─────────────────────── 页面脚本 ───────────────────────

const script = (body: string) => `(() => {${TB_SHOWN}${body}})()`;

/** 「确认，下一步」是否可用。 */
export const TB_NEXT_READY = script(
  `const b=[...document.querySelectorAll('button')].filter(e=>shown(e)&&(e.innerText||'').trim()==='确认，下一步');return b.length===1&&!b[0].disabled;`,
);

/** 读取 AI 给出的类目候选（选中项没有 normal 类）。
 *  必须和下面的点击用同一套 shown 过滤 —— 页面存在未布局的重复副本，
 *  一边过滤一边不过滤会让下标错位，点到别的候选项上。 */
export const TB_CATEGORY_PATHS = script(
  `return [...document.querySelectorAll('.path-name')].filter(shown).map((e,i)=>({i,text:(e.innerText||'').trim(),selected:!String(e.className).includes('normal'),readonly:String(e.className).includes('readonly')}));`,
);

/** 标记某个文本输入为可见实例，返回其唯一选择器（供 bridge.fill 用）。 */
export const TB_MARK_TEXT_INPUT = (fieldId: string, attribute: string) =>
  script(
    `const want=${JSON.stringify(fieldId)};const root=document.getElementById('sell-field-'+want);if(!root)return '';` +
      `const e=[...root.querySelectorAll('input,textarea')].find(x=>shown(x)&&!['checkbox','radio','file','hidden'].includes(x.type));` +
      `if(!e)return '';e.setAttribute(${JSON.stringify(attribute)},'1');return '['+${JSON.stringify(attribute)}+']';`,
  );

/** 读取表单字段快照，用于提交前核对与失败诊断。 */
export const TB_FORM_SNAPSHOT = script(
  `const read=id=>{const r=document.getElementById('sell-field-'+id);if(!r)return null;const i=[...r.querySelectorAll('input,textarea')].find(x=>shown(x)&&!['checkbox','radio','file','hidden'].includes(x.type));return i?i.value:null;};` +
    `const count=id=>{const r=document.getElementById('sell-field-'+id);return r?r.querySelectorAll('img').length:null;};` +
    `const guide=document.querySelector('#sell-field-guideImageGroup img');` +
    `return {url:location.href,title:read('title'),outerId:read('outerId'),code:read('p-13021751'),price:read('price'),quantity:read('quantity'),` +
    `slots:Object.fromEntries(${JSON.stringify(TAOBAO_IMAGE_SLOTS.map((s) => s.id))}.map(id=>[id,{count:count(id)}])),` +
    `guideIsPng:guide?/\\.png/.test(guide.src):null};`,
);

/** 表单的错误面板与逐字段错误，用于提交被拦下时定位。 */
export const TB_FORM_ERRORS = script(
  `const text=(document.body.innerText||'');const total=(text.match(/错误 \\((\\d+)\\)/)||[])[1]||'0';` +
    `const fields=[];for(const root of document.querySelectorAll('[id^="sell-field-"]')){if(!shown(root))continue;const t=(root.innerText||'').replace(/\\s+/g,' ').trim();` +
    `if(/必填项未填|必填项不能为空|不合法/.test(t))fields.push(root.id.replace('sell-field-','')+'::'+t.slice(0,80));}` +
    `const dialogs=[...document.querySelectorAll('[role=dialog]')].filter(shown).map(d=>(d.innerText||'').replace(/\\s+/g,' ').trim().slice(0,120));` +
    `return {total:Number(total),fields,dialogs};`,
);

/** 从成功页 URL 取商品 ID；没到成功页返回 null。 */
export const TB_SUCCESS_ID = script(
  `const m=location.href.match(/success\\.htm\\?[^#]*primaryId=(\\d+)/);return m?{id:m[1],url:location.href}:null;`,
);

// ─────────────────────────── 流程 ───────────────────────────

export type TaobaoPublishDeps = {
  bridge: BrowserBridge;
  directory: string;
  patch(values: Partial<Task>, message?: string): void;
  step<T>(name: string, work: () => Promise<T>, step?: TaskStep): Promise<T>;
  guard(): void;
  /** 只上报后端检查结果，不抛错；由流程自己决定哪些问题必须中断。 */
  check(key: string, status: 'passed' | 'failed' | 'not_applicable', message: string): void;
};

/** 每个阶段名对应的 TaskStep，用于进度展示。 */
const STAGES: Record<string, TaskStep> = {
  打开发品页: 'resources',
  上传轮播图与详情图: 'images',
  核对类目与品牌: 'form',
  填写基础信息: 'basic',
  填写类目属性: 'basic',
  填写价格与库存: 'skus',
  填写物流与售后: 'services',
  核对图片落位: 'images',
  提交前校验: 'pre_save',
  提交保存草稿: 'save',
  读回草稿: 'draft_list',
};

export class TaobaoPublish {
  constructor(private deps: TaobaoPublishDeps) {}

  private get bridge() {
    return this.deps.bridge;
  }

  /** 标记可见元素并返回唯一选择器。所有点击/填写都必须经过这里。 */
  private async markVisible(markCode: string): Promise<string> {
    const attribute = `data-tb-${Math.random().toString(36).slice(2, 10)}`;
    const code = markCode.replace(/__ATTR__/g, attribute);
    let selector: string;
    try {
      selector = await this.bridge.eval<string>(code);
    } catch (error) {
      // 把脚本原文带出来：这类报错多半是表达式拼装问题，没有原文根本没法定位。
      throw new ExecutionError(
        'form_changed',
        `定位控件失败：${(error as Error).message}\n脚本：${code.slice(0, 600)}`,
        'inspect_form',
        true,
      );
    }
    if (!selector)
      throw new ExecutionError('form_changed', '没有找到可见的目标控件', 'inspect_form');
    return selector;
  }

  /**
   * 关掉残留的浮层遮罩。它是透明 backdrop，会把真实鼠标点击全部吃掉，
   * 表现为「点了没反应」，极易被误判成选择器写错。
   */
  private async closeOverlays() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      // 有打开着的浮层时，遮罩是它自己的，按 Escape 会把刚打开的抽屉/下拉关掉。
      // 只清理「没有任何可见浮层」的遗留遮罩。
      const state = await this.bridge.eval<string>(
        script(
          `const open=[...document.querySelectorAll('[role=dialog],.next-overlay-wrapper,.next-select-popup-wrap')].some(shown)` +
            `||[...document.querySelectorAll('.options-item')].some(shown);` +
            `return JSON.stringify({backdrops:document.querySelectorAll('.next-overlay-backdrop').length,open});`,
        ),
      );
      const { backdrops, open } = JSON.parse(state) as { backdrops: number; open: boolean };
      if (!backdrops || open) return;
      await this.bridge.call('cdp', {
        method: 'Input.dispatchKeyEvent',
        params: { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      });
      await this.bridge.call('cdp', {
        method: 'Input.dispatchKeyEvent',
        params: { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      });
      await delay(200);
    }
  }

  /**
   * 打开焦点模拟。后台标签页收不到 CDP 的鼠标/键盘事件，
   * 不开这个开关时真实点击会「静默失效」——页面毫无反应，极易误判成选择器写错。
   */
  private async focusEmulation() {
    await this.bridge.call('cdp', {
      method: 'Emulation.setFocusEmulationEnabled',
      params: { enabled: true },
    });
  }

  /** 真实鼠标点击：计算元素中心后派发 CDP 事件。 */
  private async realClick(selector: string) {
    await this.focusEmulation();
    await this.closeOverlays();
    const point = await this.bridge.eval<string>(
      script(
        `const e=document.querySelector(${JSON.stringify(selector)});if(!e)return '';e.scrollIntoView({block:'center'});` +
          `const b=e.getBoundingClientRect();return JSON.stringify({x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)});`,
      ),
    );
    if (!point) throw new ExecutionError('form_changed', '目标控件已离开页面', 'inspect_form');
    const { x, y } = JSON.parse(point) as { x: number; y: number };
    for (const [type, buttons] of [
      ['mouseMoved', 0],
      ['mousePressed', 1],
      ['mouseReleased', 0],
    ] as const) {
      await this.bridge.call('cdp', {
        method: 'Input.dispatchMouseEvent',
        params: { type, x, y, button: 'left', buttons, clickCount: 1 },
      });
    }
  }

  /**
   * el.click() 与真实鼠标各试一轮，直到条件成立。
   *
   * 每次尝试都**重新定位**：点一下常常触发组件重渲染，原来的元素被替换掉，
   * 沿用旧选择器会点空并报「目标控件已离开页面」。
   */
  private async clickUntil(markCode: string, condition: string, label: string, attempts = 5) {
    const settled = () => this.bridge.eval<boolean>(script(`return !!(${condition});`));
    const tick = async () => {
      for (let i = 0; i < 4; i += 1) {
        await delay(200);
        if (await settled()) return true;
      }
      return false;
    };
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await settled()) return;
      await this.bridge.call('click', { selector: await this.markVisible(markCode) });
      if (await tick()) return;
      try {
        await this.realClick(await this.markVisible(markCode));
      } catch (error) {
        // 重渲染期间元素短暂消失属正常，交给下一轮重试。
        if (!(error instanceof ExecutionError)) throw error;
      }
      if (await tick()) return;
    }
    throw new ExecutionError('form_changed', `页面操作未生效：${label}`, 'inspect_form');
  }

  private waitFor(condition: string, timeout: number, message: string) {
    return this.bridge.wait(
      async () => await this.bridge.eval<boolean>(script(`return !!(${condition});`)),
      timeout,
      message,
    );
  }

  /** 真实键盘写入；Tab 提交/失焦。 */
  private async typeInto(markCode: string, value: string) {
    // bridge.fill(…, 'keyboard') 结束时会把焦点模拟关掉（内部 finally 里 disable），
    // 所以每次输入前后都重新打开 —— 否则后续的 CDP 键盘/鼠标事件会静默失效。
    await this.focusEmulation();
    const selector = await this.markVisible(markCode);
    await this.bridge.fill(selector, value, 'keyboard');
    await this.focusEmulation();
  }

  /** 等到条件成立返回 true；超时返回 false，不抛错。 */
  private async softWait(condition: string, timeout: number) {
    try {
      await this.waitFor(condition, timeout, '条件未在预期时间内成立');
      return true;
    } catch (error) {
      if (error instanceof ExecutionError && error.code === 'page_timeout') return false;
      throw error;
    }
  }

  /** 打开某个 Select 并选中选项；值是否写入以「触发器文本变化」为准。 */
  private async selectOption(fieldId: string, value: string) {
    const trigger = `[...document.querySelectorAll('#sell-field-${fieldId} .next-select-trigger')].filter(shown).pop()`;
    const markTrigger = () =>
      script(
        `const e=${trigger};if(!e)return '';e.setAttribute('__ATTR__','1');return '[__ATTR__]';`,
      );

    await this.waitFor(`!!(${trigger})`, 20000, `类目属性 ${fieldId} 未渲染`);
    const triggerSelector = await this.markVisible(markTrigger());
    await this.clickUntil(
      markTrigger(),
      `(() => {const t=document.querySelector(${JSON.stringify(triggerSelector)});return !!t&&t.getAttribute('aria-expanded')==='true';})()`,
      `${fieldId} 下拉展开`,
    );

    const option = `[...document.querySelectorAll('.options-item')].filter(shown).find(e=>(e.getAttribute('title')||(e.innerText||'').trim())===${JSON.stringify(value)})`;
    if (!(await this.softWait(`!!(${option})`, 6000))) {
      // 类目没有这个选项（例如「防水布」在足浴桶类目不存在）：不猜、不乱填。
      await this.closeOverlays();
      return false;
    }
    await this.bridge.call('click', {
      selector: await this.markVisible(
        script(
          `const e=${option};if(!e)return '';e.setAttribute('__ATTR__','1');return '[__ATTR__]';`,
        ),
      ),
    });
    return await this.softWait(
      `(() => {const t=document.querySelector(${JSON.stringify(triggerSelector)});return !!t&&(t.innerText||'').includes(${JSON.stringify(value)});})()`,
      6000,
    );
  }

  /** 本机图片资源路径；缺图直接失败，不进入页面。 */
  private assetPath(product: Product, name: string): string {
    const asset = product.images?.[name];
    if (!asset) throw new ExecutionError('invalid_product', `商品图片缺失：${name}`);
    const file = path.join(this.deps.directory, 'assets', asset.id);
    if (!fs.existsSync(file))
      throw new ExecutionError('invalid_product', `商品图片缺失：${name}`, 'retry', true, { file });
    return file;
  }

  private check(key: string, status: 'passed' | 'failed' | 'not_applicable', message: string) {
    this.deps.check(key, status, message);
    if (status === 'failed')
      throw new ExecutionError('form_changed', message, 'inspect_form', true, { check: key });
  }

  /**
   * 执行一次「发布商品 → 保存草稿」。
   * 返回保存后的商品 ID；调用方负责把它写进任务。
   */
  async run(t: Task, _shop: Shop): Promise<{ goodsId: string; url: string }> {
    const product = t.productSnapshot;
    this.deps.guard();
    await this.focusEmulation();

    // 1) 本机资源与数据先校验，避免跑到一半才发现标题超长或缺图。
    const problem = taobaoTitleProblem(product.title);
    if (problem) throw new ExecutionError('invalid_product', problem, 'retry', true);
    const listing = taobaoListingSettings(product);
    if (!Object.hasOwn(TAOBAO_SHELF_TIME_INDEX, listing.shelfTime))
      throw new ExecutionError(
        'invalid_product',
        `不支持的上架时间：${listing.shelfTime}（可选 ${Object.keys(TAOBAO_SHELF_TIME_INDEX).join('、')}）`,
        'retry',
        true,
      );
    if (!Object.hasOwn(TAOBAO_DELIVERY_TIME_INDEX, listing.deliveryTime))
      throw new ExecutionError(
        'invalid_product',
        `不支持的发货时间：${listing.deliveryTime}（可选 ${Object.keys(TAOBAO_DELIVERY_TIME_INDEX).join('、')}）`,
        'retry',
        true,
      );
    const plan = taobaoImagePlan(product);
    if (!plan.main.length)
      throw new ExecutionError('invalid_product', '商品没有轮播图', 'retry', true);
    // 规格计划要在这里就定下来：不支持的多维度必须在动页面前失败，
    // 绝不能把多个 SKU 悄悄压成一条。
    const skuPlan = taobaoSkuPlan(product);
    if (skuPlan.kind === 'unsupported')
      throw new ExecutionError('invalid_product', skuPlan.reason, 'edit_product', true, {
        skuCount: product.skus?.length ?? 0,
      });
    const price = taobaoPrice(product);
    if (!price) throw new ExecutionError('invalid_product', '没有可用的单买价', 'retry', true);
    const mainFiles = plan.main.map((name) => this.assetPath(product, name));
    const detailFiles = plan.detail.map((name) => this.assetPath(product, name));

    // 2) 打开发品页并切到「以图发品」。
    await this.deps.step(
      '打开发品页',
      async () => {
        await this.bridge.navigate(TAOBAO_PUBLISH_ENTRY);
        await this.waitFor(
          `document.querySelectorAll('.item-tab').length>0`,
          30000,
          '发品页未打开',
        );
        await this.clickUntil(
          script(
            `const e=[...document.querySelectorAll('.item-tab')].find(x=>shown(x)&&(x.innerText||'').trim()==='以图发品');if(!e)return '';e.setAttribute('__ATTR__','1');return '[__ATTR__]';`,
          ),
          `[...document.querySelectorAll('input[type=file]')].length>0`,
          '切换到以图发品',
        );
      },
      STAGES['打开发品页'],
    );

    // 3) 一次多传：系统会「剪裁并分装归类」，主图进 1:1主图、其余进宝贝详情。
    //    只传一张会导致详情页只有一张图，所以这里必须一次把所有图传上去。
    await this.deps.step(
      '上传轮播图与详情图',
      async () => {
        const files = [...mainFiles, ...detailFiles].map((file) => ({
          path: file,
          name: path.basename(file),
        }));
        await this.bridge.uploadMany(TAOBAO_IMAGE_UPLOAD_SELECTOR, files);
        await this.waitFor(TB_NEXT_READY, 90000, '图片上传后「确认，下一步」未可用');
      },
      STAGES['上传轮播图与详情图'],
    );

    // 4) AI 确认页：类目 + 品牌 + 货号。
    await this.deps.step(
      '核对类目与品牌',
      async () => {
        await this.clickOnce(
          `[...document.querySelectorAll('button')].filter(e=>shown(e)).find(e=>(e.innerText||'').trim()==='确认，下一步')`,
          '进入 AI 确认页',
        );
        await this.waitFor(
          `document.querySelectorAll('.path-name').length>0`,
          40000,
          '类目候选未出现',
        );
        const candidates =
          await this.bridge.eval<{ text: string; selected: boolean; readonly: boolean }[]>(
            TB_CATEGORY_PATHS,
          );
        const index = matchTaobaoCategoryPath(
          candidates.map((c) => c.text),
          product.category,
        );
        if (index < 0)
          throw new ExecutionError(
            'form_changed',
            `后台类目候选中没有「${product.category}」，请人工确认类目`,
            'inspect_form',
            true,
            { candidates },
          );
        if (candidates[index]?.readonly)
          throw new ExecutionError(
            'form_changed',
            `类目「${candidates[index].text}」在后台不可选，请人工确认类目`,
            'inspect_form',
            true,
            { candidates },
          );
        if (!candidates[index].selected) {
          // 切换类目会弹确认框，而且会清空已填的货号 —— 顺序不能颠倒。
          await this.realClick(
            await this.markVisible(
              script(
                `const e=[...document.querySelectorAll('.path-name')].filter(shown)[${index}];if(!e)return '';e.setAttribute('__ATTR__','1');return '[__ATTR__]';`,
              ),
            ),
          );
          try {
            await this.waitFor(
              `[...document.querySelectorAll('button')].some(e=>shown(e)&&(e.innerText||'').trim()==='确定')`,
              8000,
              '切换类目确认框未出现',
            );
          } catch (error) {
            const now =
              await this.bridge.eval<{ text: string; selected: boolean }[]>(TB_CATEGORY_PATHS);
            throw new ExecutionError(
              'form_changed',
              '点击类目后没有出现「是否切换类目」确认框，可能在页面重渲染期间点空了',
              'inspect_form',
              true,
              { before: candidates, after: now },
            );
          }
          await this.clickOnce(
            `[...document.querySelectorAll('button')].filter(e=>shown(e)).find(e=>(e.innerText||'').trim()==='确定')`,
            '确认切换类目',
          );
        }
        // 品牌：该类目下通常只有一个授权品牌，但要写后回读，重渲染会把它清掉。
        const brand = await this.selectBrand();
        // 货号必须在类目切换之后填，并回读校验（切换类目会清空它）。
        await this.fillAndVerifyCode(product.code);
        try {
          await this.waitFor(TB_NEXT_READY, 40000, '「确认，下一步」未可用');
        } catch (error) {
          // 把确认页现场带出来：多半是品牌没选中或货号被重渲染清掉。
          const state = await this.bridge.eval<Record<string, unknown>>(
            script(
              `const text=e=>(e?.innerText||'').replace(/\s+/g,' ').trim();
             const brand=[...document.querySelectorAll('#struct-p-20000 .next-select-trigger')].find(shown);
             const code=[...document.querySelectorAll('input[name="p-13021751"]')].find(shown);
             const next=[...document.querySelectorAll('button')].filter(shown).find(e=>text(e)==='确认，下一步');
             return JSON.stringify({
               brand: brand ? text(brand) : null,
               brandExpanded: brand ? brand.getAttribute('aria-expanded') : null,
               code: code ? code.value : null,
               nextDisabled: next ? next.disabled : null,
               optionCount: [...document.querySelectorAll('.options-item')].filter(shown).length,
               backdrops: document.querySelectorAll('.next-overlay-backdrop').length,
             });`,
            ),
          );
          throw new ExecutionError(
            'form_changed',
            `「确认，下一步」未可用：${typeof state === 'string' ? state : JSON.stringify(state)}`,
            'inspect_form',
            true,
            { state },
          );
        }
        this.check('category', 'passed', `类目：${candidates[index].text}`);
        this.check('brand', 'passed', `品牌=${brand}（取自该类目的店铺授权项）`);
        await this.clickOnce(
          `[...document.querySelectorAll('button')].filter(e=>shown(e)).find(e=>(e.innerText||'').trim()==='确认，下一步')`,
          '进入商品表单',
        );
        await this.waitFor(
          `!!document.getElementById('sell-field-title')`,
          40000,
          '商品表单未打开',
        );
      },
      STAGES['核对类目与品牌'],
    );

    // 5) 基础信息。
    await this.deps.step(
      '填写基础信息',
      async () => {
        await this.typeInto(markInputScript('title'), product.title);
        await this.typeInto(markInputScript('outerId'), product.outerId?.trim() || product.code);
      },
      STAGES['填写基础信息'],
    );

    // 6) 类目属性：逐个按「属性名」在页面上找同名字段，再按选项选值。
    //    类目里没有该选项的值（例如「防水布」在足浴桶类目不存在）就跳过并上报，不猜值。
    await this.deps.step(
      '填写类目属性',
      async () => {
        const wanted = taobaoAttributePlan(product);
        if (!wanted.length) {
          this.check('attributes', 'not_applicable', '商品资料未提供类目属性');
          return;
        }
        const fields = await this.bridge.eval<{ id: string; label: string; value: string }[]>(
          TB_CATEGORY_ATTRIBUTE_FIELDS,
        );
        const filled: string[] = [];
        const missingField: string[] = [];
        const missingOption: string[] = [];
        for (const item of wanted) {
          // 精确匹配（去掉空白与必填标记）。原先用 startsWith，属性名互为前缀时
          // 会把值写进错误的字段，而且不会有任何提示。
          const normalize = (value: string) => (value || '').replace(/[\s*＊()（）【】]/g, '');
          const field = fields.find((f) => normalize(f.label) === normalize(item.name));
          if (!field) {
            missingField.push(item.name);
            continue;
          }
          if (field.value === item.value) {
            filled.push(`${item.name}=${item.value}`);
            continue;
          }
          const ok = await this.selectOption(field.id, item.value);
          if (ok) filled.push(`${item.name}=${item.value}`);
          else missingOption.push(`${item.name}=${item.value}`);
        }
        const notes = [
          filled.length ? `已填 ${filled.join('、')}` : '',
          missingOption.length ? `类目无此选项、已跳过 ${missingOption.join('、')}` : '',
          missingField.length ? `该类目无此属性 ${missingField.join('、')}` : '',
        ].filter(Boolean);
        this.check(
          'attributes',
          filled.length ? 'passed' : 'failed',
          notes.join('；') || '没有可填写的类目属性',
        );
      },
      STAGES['填写类目属性'],
    );

    // 7) 价格与库存。单规格需手填数量，且这个值会在后续操作里被重置，
    //    所以放在最后、并在提交前回读。
    await this.deps.step(
      '填写价格与库存',
      async () => {
        const multi = skuPlan.kind === 'dimensions';
        if (multi) {
          await this.createSkuSpecs(skuPlan.dimensions);
          await this.fillSkuRows(skuPlan.rows);
        }
        await this.typeInto(markInputScript('price'), price);
        // 多规格时「商品数量」由 SKU 表自动汇总，后台把它渲染成只读，写不进去也没必要写。
        if (multi) {
          const actual = await this.readFieldValue('quantity');
          if (Number(actual) !== taobaoQuantity(product))
            throw new ExecutionError(
              'form_changed',
              `多规格商品的商品数量未按 SKU 汇总：页面为 ${actual || '空'}，期望 ${taobaoQuantity(product)}`,
              'inspect_form',
              true,
            );
        } else {
          await this.typeInto(markInputScript('quantity'), String(taobaoQuantity(product)));
        }
        this.check(
          'skus',
          'passed',
          multi && skuPlan.kind === 'dimensions'
            ? `多规格 ${skuPlan.dimensions.map((d) => d.name).join(' × ')}：${skuPlan.rows
                .map((row) => `${row.values.join('/')} ¥${row.price} 库存 ${row.quantity}`)
                .join('；')}；一口价 ${price}`
            : `单规格：一口价 ${price}、商品数量 ${taobaoQuantity(product)}`,
        );
      },
      STAGES['填写价格与库存'],
    );

    // 8) 物流：提取方式、上架时间、发货时间、发货地。发货地必须级联到「市」。
    await this.deps.step(
      '填写物流与售后',
      async () => {
        const mail = listing.extractWay === '电子交易凭证' ? '电子交易凭证' : '邮寄';
        await this.clickUntil(
          script(
            `const e=[...document.querySelectorAll('#sell-field-tmExtractWay label')].filter(shown).find(x=>(x.innerText||'').trim()===${JSON.stringify(mail)});if(!e)return '';e.setAttribute('__ATTR__','1');return '[__ATTR__]';`,
          ),
          `(() => {const r=document.getElementById('sell-field-tmExtractWay');const l=[...r.querySelectorAll('label')].find(x=>(x.innerText||'').trim()===${JSON.stringify(mail)});const b=l&&l.querySelector('input[type=checkbox]');return !!(b&&b.checked);})()`,
          `提取方式=${mail}`,
        );
        await this.pickRadioByLabel('shelfTime', listing.shelfTime, TAOBAO_SHELF_TIME_INDEX);
        await this.pickRadioByLabel(
          'tmDeliveryTime',
          listing.deliveryTime,
          TAOBAO_DELIVERY_TIME_INDEX,
        );
        // 运费承担：勾选「邮寄」后这一组单选才会出现，默认选中「卖家承担」。
        // 不写的话资料里的「买家承担」会被静默忽略，商品按包邮提交。
        const freightBearer = await this.pickFreightBearer(listing.freightBearer);
        // 返点比例：必填，默认 0.5；资料填了就必须写进去，否则恒为 0.5。
        await this.typeInto(markInputScript('auctionPoint'), listing.auctionPoint);
        await this.selectShippingOrigin(listing.originProvince, listing.originCity);
        this.check(
          'shipping',
          'passed',
          `提取方式=${listing.extractWay}，上架时间=${listing.shelfTime}，发货时间=${listing.deliveryTime}，返点 ${listing.auctionPoint}%，发货地 ${listing.originProvince}/${listing.originCity}${
            listing.originFromProduct ? '' : '（商品资料未填，用了兜底值，请核对）'
          }`,
        );
        this.check(
          'freight',
          freightBearer.picked ? 'passed' : 'not_applicable',
          freightBearer.picked
            ? `运费承担=${listing.freightBearer}${
                listing.freightBearer === '买家承担'
                  ? '；运费模板需在后台人工确认，本版不自动选择'
                  : ''
              }`
            : `运费承担选项未在页面上找到，沿用后台默认；资料值=${listing.freightBearer}`,
        );
      },
      STAGES['填写物流与售后'],
    );

    // 9) 图片落位核对：这一步专门防「详情图被分装到别的槽位」。
    await this.deps.step(
      '核对图片落位',
      async () => {
        const snapshot = await this.bridge.eval<{
          slots: Record<string, { count: number }>;
          guideIsPng: boolean | null;
        }>(TB_FORM_SNAPSHOT);
        const problems = taobaoImageProblems(snapshot.slots);
        if (problems.length)
          throw new ExecutionError(
            'form_changed',
            `图片落位不正确：${problems.join('；')}`,
            'inspect_form',
            true,
            {
              slots: snapshot.slots,
            },
          );
        this.check('images', 'passed', taobaoImageSummary(snapshot.slots));
      },
      STAGES['核对图片落位'],
    );

    // 10) 提交。
    return await this.deps.step(
      '提交保存草稿',
      async () => {
        const errors = await this.bridge.eval<{
          total: number;
          fields: string[];
          dialogs: string[];
        }>(TB_FORM_ERRORS);
        if (errors.total > 0)
          throw new ExecutionError(
            'form_changed',
            `提交前仍有 ${errors.total} 个校验错误：${errors.fields.join('；') || errors.dialogs.join('；')}`,
            'inspect_form',
            true,
            errors,
          );
        await this.clickOnce(
          `[...document.querySelectorAll('button')].filter(e=>shown(e)).find(e=>(e.innerText||'').trim()==='提交')`,
          '提交',
        );
        const saved = await this.bridge.wait(
          async () => await this.bridge.eval<{ id: string; url: string } | null>(TB_SUCCESS_ID),
          40000,
          '提交后未进入成功页',
        );
        this.deps.patch({ goodsId: saved.id, formUrl: saved.url, phase: '已保存草稿' });
        return { goodsId: saved.id, url: saved.url };
      },
      STAGES['提交保存草稿'],
    );
  }

  /** 货号写入并回读校验；切换类目会清空它，所以允许重试。 */
  private async fillAndVerifyCode(code: string) {
    const read = script(
      `const e=[...document.querySelectorAll('input[name="p-13021751"]')].find(shown);return e?e.value:'';`,
    );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if ((await this.bridge.eval<string>(read)) === code) return;
      await this.typeInto(markCodeScript(), code);
      await delay(400);
    }
    const current = await this.bridge.eval<string>(read);
    if (current !== code)
      throw new ExecutionError(
        'form_changed',
        `货号写入失败：期望 ${code}，实际 ${current}`,
        'inspect_form',
      );
  }

  /**
   * 在「+ 创建规格」抽屉里建单维度多值规格。
   *
   * 交互机制（受控侦察实测，见 verification/taobao-20261006/publish-flow/多规格实跑记录.md）：
   *   · 自定义模式初始有 1 个「输入规格」框，此时「添加」按钮是 **disabled**；
   *   · 写入一个值并**按 Tab** 提交后，商品规格(N) +1，「添加」才变为 enabled；
   *   · 点「添加」会新增一个**空**输入框，按钮随即重新变 disabled；
   *   · 下一个值必须写进**新出现的那个输入框** —— 写回原来的框只会改掉上一个值，
   *     计数不会增加（这正是第一版实现踩的坑）。
   * 因此顺序固定为「提交上一个 → 等按钮可用 → 点添加 → 写进最后一个框」。
   */
  private async createSkuSpecs(dimensions: TaobaoSkuDimension[]) {
    // 用抽屉自己的类名定位，取**最后一个**实例：上一次运行可能留下没关的抽屉。
    const DRAWER = `[...document.querySelectorAll('.sku-decouple-drawer')].pop()`;
    await this.clickUntil(
      script(
        `const e=[...document.querySelectorAll('#sell-field-sku button')].filter(shown).find(x=>/创建规格/.test((x.innerText||'').trim()));if(!e)return '';e.setAttribute('__ATTR__','1');return '[__ATTR__]';`,
      ),
      `!!${DRAWER}`,
      '打开创建规格抽屉',
    );

    // 类目提供哪些标准销售属性（.prop-item），决定能不能用「分层展示」建多维度。
    const available = await this.bridge.eval<string[]>(
      script(
        `const d=${DRAWER};if(!d)return [];return [...d.querySelectorAll('.prop-item')].map(e=>(e.innerText||'').trim());`,
      ),
    );
    const missing = dimensions.map((d) => d.name).filter((name) => !available.includes(name));

    if (!missing.length) {
      await this.createSkuValuesInStandardMode(DRAWER, dimensions);
      return;
    }
    if (dimensions.length === 1) {
      // 单维度且类目没有同名标准属性（如「容量」）：走自定义填写规格，维度名由后台给。
      await this.createSkuValuesInCustomMode(DRAWER, dimensions[0].values);
      return;
    }
    throw new ExecutionError(
      'invalid_product',
      `类目没有提供销售属性：${missing.join('、')}（该类目可选 ${available.join('、') || '无'}）。` +
        `多维度规格必须使用类目的标准销售属性，请改用后台已有的属性名，或人工在后台建规格`,
      'edit_product',
      true,
      { available, wanted: dimensions.map((d) => d.name) },
    );
  }

  /**
   * 自定义填写规格（单维度）。受控侦察实测的交互：
   *   · 初始 1 个「输入规格」框，此时「添加」按钮是 **disabled**；
   *   · 写入一个值并**按 Tab** 提交后，商品规格(N) +1，「添加」才变为 enabled；
   *   · 点「添加」会新增一个**空**输入框，按钮随即重新变 disabled；
   *   · 下一个值必须写进**新出现的那个输入框** —— 写回原来的框只会改掉上一个值。
   * 因此顺序固定为「提交上一个 → 等按钮可用 → 点添加 → 写进最后一个框」。
   */
  private async createSkuValuesInCustomMode(DRAWER: string, values: string[]) {
    const valueInputs = `[...((${DRAWER}||{querySelectorAll:()=>[]}).querySelectorAll('input')||[])].filter(e=>shown(e)&&e.placeholder==='输入规格')`;
    const lastInput = `(() => {const e=${valueInputs};if(!e.length)return '';const t=e[e.length-1];t.setAttribute('__ATTR__','1');return '[__ATTR__]';})()`;
    const addButton = `[...((${DRAWER}||{querySelectorAll:()=>[]}).querySelectorAll('button.add')||[])].find(shown)`;
    const addEnabled = `(() => {const b=${addButton};return !!b&&!b.disabled;})()`;
    const specSnippet = `(() => {const d=${DRAWER};if(!d)return '';const t=d.innerText||'';const i=t.indexOf('商品规格(');return i<0?'':t.slice(i+5,i+10);})()`;
    const customReady = `(() => {const d=${DRAWER};if(!d)return false;const r=d.querySelectorAll('.select-mode input[type=radio]');if(!(r[0]&&r[0].checked))return false;return ${valueInputs}.length>0;})()`;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await this.bridge.eval<boolean>(script(`return ${customReady};`))) break;
      await this.clickUntil(
        script(
          `const e=${DRAWER}.querySelectorAll('.select-mode label')[0];if(!e)return '';e.setAttribute('__ATTR__','1');return '[__ATTR__]';`,
        ),
        customReady,
        '切到自定义填写规格',
      );
    }
    if (!(await this.bridge.eval<boolean>(script(`return ${customReady};`))))
      throw new ExecutionError(
        'form_changed',
        `未能切到「自定义填写规格」模式：${await this.drawerText(DRAWER)}`,
        'inspect_form',
        true,
      );

    for (const [index, value] of values.entries()) {
      if (index > 0) {
        if (!(await this.softWait(addEnabled, 8000)))
          throw new ExecutionError(
            'form_changed',
            `准备第 ${index + 1} 个规格值时「添加」按钮一直不可用，上一个值可能没提交成功`,
            'inspect_form',
            true,
          );
        // clickOnce 接的是**元素表达式**，不是「标记并返回选择器」的脚本 —— 传错会被再包一层。
        await this.clickOnce(addButton, `增加第 ${index + 1} 个规格值`);
        if (!(await this.softWait(`${valueInputs}.length===${index + 1}`, 8000)))
          throw new ExecutionError(
            'form_changed',
            `点「添加」后没有出现第 ${index + 1} 个规格值输入框`,
            'inspect_form',
            true,
          );
      }
      const before = await this.readSnippetNumber(specSnippet);
      await this.typeRaw(await this.markVisible(script(`return ${lastInput};`)), value);
      if (!(await this.waitForSnippetNumber(specSnippet, before + 1, 8000)))
        throw new ExecutionError(
          'form_changed',
          `规格值「${value}」没有提交：商品规格计数仍是 ${before}`,
          'inspect_form',
          true,
        );
    }
    await this.confirmSkuCreation(DRAWER, values.length);
  }

  /**
   * 选择标准属性构建规格（分层展示）。多维度走这条。
   *
   * 受控侦察实测（沐浴桶/沐浴盆类目，提供 颜色 + 适用体重 两个属性）：
   *   · `.prop-item` 是**多选开关**，勾几个就有几个维度；`属性 N/M` 是已选/可选数；
   *   · 每个已选属性在 `.sell-component-sale-props` 下有自己的 `.common-wrap`，
   *     里面有 `.props-label «颜色(0)»` 与值输入框（颜色是「主色(必选)」、适用体重是「规格」）；
   *   · 值同样是「写一个 + Tab 提交」，提交后该属性的 (N) 增加、其「添加」按钮才可用。
   */
  private async createSkuValuesInStandardMode(DRAWER: string, dimensions: TaobaoSkuDimension[]) {
    const standardReady = `(() => {const d=${DRAWER};if(!d)return false;const r=d.querySelectorAll('.select-mode input[type=radio]');return !!(r[1]&&r[1].checked);})()`;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await this.bridge.eval<boolean>(script(`return ${standardReady};`))) break;
      await this.clickUntil(
        script(
          `const e=${DRAWER}.querySelectorAll('.select-mode label')[1];if(!e)return '';e.setAttribute('__ATTR__','1');return '[__ATTR__]';`,
        ),
        standardReady,
        '切到选择标准属性构建规格',
      );
    }

    // 勾选每个维度对应的销售属性
    for (const dimension of dimensions) {
      const item = `[...${DRAWER}.querySelectorAll('.prop-item')].find(e=>(e.innerText||'').trim()===${JSON.stringify(dimension.name)})`;
      const selected = `(() => {const e=${item};return !!e&&String(e.className).includes('selected');})()`;
      if (await this.bridge.eval<boolean>(script(`return ${selected};`))) continue;
      await this.clickOnce(item, `勾选销售属性 ${dimension.name}`);
      if (!(await this.softWait(selected, 8000)))
        throw new ExecutionError(
          'form_changed',
          `销售属性「${dimension.name}」勾选失败：${await this.drawerText(DRAWER)}`,
          'inspect_form',
          true,
        );
    }
    await this.softWait(
      `[...${DRAWER}.querySelectorAll('.props-label')].length>=${dimensions.length}`,
      10000,
    );

    for (const dimension of dimensions) {
      const wrap = `(() => {const d=${DRAWER};if(!d)return null;const ws=[...d.querySelectorAll('.sell-component-sale-props .common-wrap')];return ws.find(w=>{const l=w.querySelector('.props-label');return !!l&&(l.innerText||'').trim().startsWith(${JSON.stringify(dimension.name)});})||null;})()`;
      const labelSnippet = `(() => {const w=${wrap};if(!w)return '';const l=w.querySelector('.props-label');if(!l)return '';const t=l.innerText||'';const i=t.indexOf('(');return i<0?'':t.slice(i+1,i+4);})()`;
      // 该属性的值输入框：可见、非复选/单选、且不是「备注」框
      const valueInputs = `[...((${wrap}||{querySelectorAll:()=>[]}).querySelectorAll('input')||[])].filter(e=>shown(e)&&!['checkbox','radio','file','hidden'].includes(e.type)&&!(e.placeholder||'').startsWith('备注'))`;
      const lastInput = `(() => {const e=${valueInputs};if(!e.length)return '';const t=e[e.length-1];t.setAttribute('__ATTR__','1');return '[__ATTR__]';})()`;
      const addButton = `[...((${wrap}||{querySelectorAll:()=>[]}).querySelectorAll('button.add')||[])].find(shown)`;
      const addEnabled = `(() => {const b=${addButton};return !!b&&!b.disabled;})()`;

      for (const [index, value] of dimension.values.entries()) {
        if (index > 0) {
          if (!(await this.softWait(addEnabled, 8000)))
            throw new ExecutionError(
              'form_changed',
              `属性「${dimension.name}」准备第 ${index + 1} 个值时「添加」不可用`,
              'inspect_form',
              true,
            );
          await this.clickOnce(addButton, `为 ${dimension.name} 增加第 ${index + 1} 个值`);
          if (!(await this.softWait(`${valueInputs}.length===${index + 1}`, 8000)))
            throw new ExecutionError(
              'form_changed',
              `属性「${dimension.name}」点「添加」后没有出现第 ${index + 1} 个值输入框`,
              'inspect_form',
              true,
            );
        }
        const before = await this.readSnippetNumber(labelSnippet);
        await this.typeRaw(await this.markVisible(script(`return ${lastInput};`)), value);
        if (!(await this.waitForSnippetNumber(labelSnippet, before + 1, 8000)))
          throw new ExecutionError(
            'form_changed',
            `属性「${dimension.name}」的值「${value}」没有提交（计数仍为 ${before}）`,
            'inspect_form',
            true,
          );
      }
    }

    const expected = dimensions.reduce((count, d) => count * d.values.length, 1);
    await this.confirmSkuCreation(DRAWER, expected);
  }

  /** 点「确认创建」并等 SKU 表按预期生成。 */
  private async confirmSkuCreation(DRAWER: string, expectedRows: number) {
    await this.clickOnce(
      `[...${DRAWER}.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='确认创建')`,
      '确认创建规格',
    );
    await this.waitFor(
      `document.querySelectorAll('#sell-field-sku table tbody tr').length===${expectedRows}`,
      30000,
      `规格表格未按预期生成（期望 ${expectedRows} 行）`,
    );
  }

  /** 抽屉的当前文案，用于失败诊断。 */
  private async drawerText(DRAWER: string): Promise<string> {
    return await this.bridge.eval<string>(
      script(
        `const d=${DRAWER};return d?(d.innerText||'').replace(/\\s+/g,' ').slice(0,160):'抽屉不存在';`,
      ),
    );
  }

  /** 读一个 sell-field 文本字段的当前值（可见实例）。 */
  private async readFieldValue(fieldId: string): Promise<string> {
    return await this.bridge.eval<string>(
      script(
        `const root=document.getElementById('sell-field-${fieldId}');if(!root)return '';` +
          `const e=[...root.querySelectorAll('input,textarea')].find(x=>shown(x)&&!['checkbox','radio','file','hidden'].includes(x.type));` +
          `return e?e.value:'';`,
      ),
    );
  }

  /** 读一段页面文本片段里的数字（片段在页面取、解析在 Node 侧做，避开多层转义）。 */
  private async readSnippetNumber(snippet: string): Promise<number> {
    const raw = await this.bridge.eval<string>(script(`return ${snippet};`));
    const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
    return Number.isFinite(parsed) ? parsed : -1;
  }

  /** 等某段页面文本里的数字达到期望值。 */
  private async waitForSnippetNumber(snippet: string, expected: number, timeout: number) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if ((await this.readSnippetNumber(snippet)) >= expected) return true;
      if (Date.now() > deadline) return false;
      await delay(200);
    }
  }

  /**
   * 规格值输入框专用输入：聚焦 → CDP insertText → Tab。
   *
   * 不用 `bridge.fill(…, 'keyboard')`：那套事务式输入在抽屉里会失败
   * （实测报 `e.setAttribute is not a function`）。这里用的是受控探针里
   * 逐步验证过的路径，写入后由调用方回读计数确认已提交。
   */
  private async typeRaw(selector: string, value: string) {
    await this.focusEmulation();
    const focused = await this.bridge.eval<boolean>(
      script(
        `const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;` +
          `e.scrollIntoView({block:'center'});e.focus();` +
          `if(typeof e.setSelectionRange==='function')e.setSelectionRange(0,e.value.length);` +
          `return document.activeElement===e;`,
      ),
    );
    if (!focused)
      throw new ExecutionError('form_changed', '规格值输入框无法聚焦', 'inspect_form', true);
    await this.bridge.call('cdp', { method: 'Input.insertText', params: { text: value } });
    await delay(300);
    for (const type of ['keyDown', 'keyUp'])
      await this.bridge.call('cdp', {
        method: 'Input.dispatchKeyEvent',
        params: { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
      });
    await delay(300);
  }

  /** 逐行填 SKU 表的价格与数量（td2=价格、td3=数量）。 */
  private async fillSkuRows(rows: TaobaoSkuRow[]) {
    const cell = (row: number, column: number) =>
      script(
        `const e=[...document.querySelectorAll('#sell-field-sku table tbody tr')][${row}]` +
          `?.querySelectorAll('td')[${column}]?.querySelector('input');` +
          `if(!e)return '';e.setAttribute('__ATTR__','1');return '[__ATTR__]';`,
      );
    for (const [index, row] of rows.entries()) {
      await this.typeRaw(await this.markVisible(cell(index, 2)), row.price);
      await this.typeRaw(await this.markVisible(cell(index, 3)), row.quantity);
    }
  }

  /**
   * 选中品牌。该类目通常只有一个授权品牌，但选择动作偶发不生效
   * （页面重渲染会把已选值清掉），所以必须「写后回读 + 重试」。
   */
  private async selectBrand(): Promise<string> {
    const trigger = `[...document.querySelectorAll('#struct-p-20000 .next-select-trigger')].find(shown)`;
    const triggerValue = script(`const e=${trigger};return e?(e.innerText||'').trim():'';`);
    const picked = (value: string) => Boolean(value) && value !== '请选择';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (picked(await this.bridge.eval<string>(triggerValue)))
        return await this.bridge.eval<string>(triggerValue);
      try {
        await this.clickUntil(
          script(
            `const e=${trigger};if(!e)return '';e.setAttribute('__ATTR__','1');return '[__ATTR__]';`,
          ),
          `(() => {const t=${trigger};return !!t&&t.getAttribute('aria-expanded')==='true';})()`,
          '品牌下拉展开',
        );
        await this.waitFor(
          `[...document.querySelectorAll('.options-item')].some(shown)`,
          8000,
          '品牌选项',
        );
        await this.clickOnce(
          `[...document.querySelectorAll('.options-item')].filter(e=>shown(e))[0]`,
          '选择品牌',
        );
        await this.waitFor(
          `(() => {const t=${trigger};return !!t&&(t.innerText||'').trim()&&(t.innerText||'').trim()!=='请选择';})()`,
          8000,
          '品牌写入',
        );
        return await this.bridge.eval<string>(triggerValue);
      } catch (error) {
        if (attempt === 3) throw error;
        await delay(400);
      }
    }
    throw new ExecutionError(
      'form_changed',
      '品牌未能选中，请人工确认该类目的授权品牌',
      'inspect_form',
    );
  }

  /**
   * 运费承担：按文案选中「卖家承担」或「买家承担」。
   * 这一组单选只在勾选「邮寄」后才渲染，所以不用固定下标，避免依赖选项顺序。
   */
  private async pickFreightBearer(bearer: string): Promise<{ picked: boolean }> {
    const wanted = bearer === '买家承担' ? '买家承担' : '卖家承担';
    const label = (text: string) =>
      `[...document.querySelectorAll('#sell-field-tmExtractWay label')].filter(shown).find(x=>(x.innerText||'').trim().startsWith(${JSON.stringify(text)}))`;
    const target = label(wanted);
    const checked = `(() => {const l=${target};const b=l&&l.querySelector('input');return !!(b&&(b.checked||b.type==='radio'));})()`;
    // 已经在目标状态就直接过（后台默认就是卖家承担）。
    if ((await this.bridge.eval<boolean>(script(`return ${checked};`))) === true)
      return { picked: true };
    try {
      await this.clickUntil(
        script(
          `const e=${target};if(!e)return '';e.setAttribute('__ATTR__','1');return '[__ATTR__]';`,
        ),
        `(() => {const l=${target};if(!l)return false;const b=l.querySelector('input');if(!b)return false;return b.checked||document.querySelectorAll('#sell-field-tmExtractWay input:checked').length>0;})()`,
        `运费承担=${wanted}`,
      );
      return { picked: true };
    } catch (error) {
      if (error instanceof ExecutionError && error.code === 'form_changed')
        return { picked: false };
      throw error;
    }
  }

  /** 按后台单选顺序勾选一个 radio 组（上架时间 / 发货时间）。 */
  private async pickRadioByLabel(fieldId: string, label: string, index: Record<string, number>) {
    const position = index[label];
    const radio = `[...document.querySelectorAll('#sell-field-${fieldId} input[type=radio]')][${position}]`;
    await this.clickUntil(
      script(
        `const e=${radio};if(!e)return '';const l=e.closest('label')||e;l.setAttribute('__ATTR__','1');return '[__ATTR__]';`,
      ),
      `(() => {const r=${radio};return !!r&&r.checked;})()`,
      `${fieldId}=${label}`,
    );
  }

  /** 发货地：大陆及港澳台 → 单一发货地 → 省 → 市（少一级都会报「必填项未填」）。 */
  private async selectShippingOrigin(province: string, city: string) {
    await this.clickUntil(
      script(
        `const e=[...document.querySelectorAll('#sell-field-location label')].filter(shown).find(x=>(x.innerText||'').trim()==='单一发货地');if(!e)return '';e.setAttribute('__ATTR__','1');return '[__ATTR__]';`,
      ),
      `[...document.querySelectorAll('#sell-field-location .next-select-trigger')].some(shown)`,
      '单一发货地',
    );
    const trigger = `[...document.querySelectorAll('#sell-field-location .next-select-trigger')].find(shown)`;
    await this.clickUntil(
      script(
        `const e=${trigger};if(!e)return '';e.setAttribute('__ATTR__','1');return '[__ATTR__]';`,
      ),
      `(() => {const t=${trigger};return !!t&&t.getAttribute('aria-expanded')==='true';})()`,
      '发货地下拉展开',
    );
    for (const name of [province, city]) {
      const option = `[...document.querySelectorAll('li,[role=option],.options-item')].filter(e=>shown(e)&&(e.innerText||'').trim()===${JSON.stringify(name)}).pop()`;
      await this.waitFor(`!!(${option})`, 8000, `发货地选项 ${name} 未出现`);
      await this.realClick(
        await this.markVisible(
          script(
            `const e=${option};if(!e)return '';e.setAttribute('__ATTR__','1');return '[__ATTR__]';`,
          ),
        ),
      );
      await delay(300);
    }
    await this.waitFor(
      `[...document.querySelectorAll('#sell-field-location .next-select-trigger')].some(e=>shown(e)&&(e.innerText||'').includes(${JSON.stringify(city)}))`,
      10000,
      '发货地未写入',
    );
  }

  /** 单个按钮/元素点击（先 el.click()，失败再真实鼠标）。 */
  private async clickOnce(expr: string, label: string) {
    const selector = await this.markVisible(
      script(`const e=${expr};if(!e)return '';e.setAttribute('__ATTR__','1');return '[__ATTR__]';`),
    );
    try {
      await this.bridge.call('click', { selector });
    } catch {
      await this.realClick(selector);
      return;
    }
    await delay(200);
    void label;
  }
}

/** 上传控件的选择器：AI 发品页只有一个接受图片的多选 file input。 */
export const TAOBAO_IMAGE_UPLOAD_SELECTOR =
  'input[type=file][accept="image/jpg, image/bmp, image/png, image/jpeg"]';

const markInputScript = (fieldId: string) => TB_MARK_TEXT_INPUT(fieldId, '__ATTR__');

const markCodeScript = () =>
  script(
    `const e=[...document.querySelectorAll('input[name="p-13021751"]')].find(shown);if(!e)return '';e.setAttribute('__ATTR__','1');return '[__ATTR__]';`,
  );

/** 类目属性字段清单：id / 标签 / 当前值。 */
export const TB_CATEGORY_ATTRIBUTE_FIELDS = script(
  `const text=e=>(e.innerText||e.textContent||'').replace(/\\s+/g,' ').trim();const out=[];` +
    `for(const root of document.querySelectorAll('[id^="sell-field-p-"]')){if(!shown(root))continue;` +
    `const label=text(root.querySelector('.sell-component-info-wrapper-label')||{});if(!label)continue;` +
    `const trigger=[...root.querySelectorAll('.next-select-trigger')].filter(shown).pop();` +
    `const input=[...root.querySelectorAll('input,textarea')].find(e=>shown(e)&&!['checkbox','radio','file','hidden'].includes(e.type));` +
    `out.push({id:root.id.replace('sell-field-',''),label,value:trigger?text(trigger):(input?input.value:'')});}` +
    `return out;`,
);

import fs from 'node:fs';
import path from 'node:path';
import type { BrowserBridge } from '../browser-bridge';
import { ExecutionError, type ExecutionContext } from '../execution';
import { validateLocalImageFiles } from '../importer';
import { isRecord, pddCategoryLeaf } from './pdd-page-scripts';
import { PDD_ANCHOR_READ, PDD_LOGIN_MATCH } from './pdd-identity';
import type { Product, Shop, Task, BackendCheck } from '../../src/types';
import { rimDiameterLabel } from '../../src/pdd-rim';

type Row = Record<string, unknown>;
type Category = { id: number; ids: number[]; cats: { cat_id: number; cat_name: string }[] };
type Upload = { url: string; width: number; height: number };
/**
 * 每个 SKU 的轮辋直径：导入时已经算好就直接用；
 * 没有（老资料、或表格里没填）就按规格选项与标题现场推一遍，保证永远能自动填。
 */
export const apiRim = (product: Product, sku: Product['skus'][number]): string => {
  if (!product.install) return '';
  if (sku.rim) return sku.rim;
  return rimDiameterLabel(...(sku.options || []).map((o) => o.value), product.title) || '';
};
/**
 * 读回时逐项核对安装设置：安装类型对应的模板 ID 必须写进去，
 * 且每个 SKU 的轮辋直径都要在 `sku_srv_templates` 里出现；
 * 以前只看售后承诺，安装整块丢了也会判定成功。
 */
export const apiInstallMatches = (
  product: Product,
  detail: Row,
  resolvedTemplate?: string,
): boolean => {
  if (!product.install) return true;
  const want = String(resolvedTemplate || '').trim();
  const attached = (
    Array.isArray(detail.goods_srv_templates) ? (detail.goods_srv_templates as Row[]) : []
  )
    .map((row) => String(row?.id ?? '').trim())
    .filter(Boolean);
  // 草稿详情里没有表单那个 srv_template_id_map，真正的落点是 goods_srv_templates 的 id；
  // 旧字段只在个别返回里出现，读到就一起认，读不到不据此判失败。
  const map = (detail.srv_template_id_map || {}) as Record<string, unknown>;
  const key = apiInstallType(product.install.delivery);
  const mapped = String(map[key] ?? '').trim();
  // 模板挂在哪个槽位（配送到店 type 8 / 配送到家 type 10）必须和资料选的一致：
  // 只比 id 集合的话，运营把「配送到店」选成「配送到家」照样过，后台实际挂到了另一类模板。
  const slot = product.install.delivery === 'home' ? 10 : 8;
  const typed = (
    Array.isArray(detail.goods_srv_templates) ? (detail.goods_srv_templates as Row[]) : []
  )
    .filter((row) => typeof row?.type === 'number')
    .map((row) => ({ type: Number(row.type), id: String(row.id ?? '').trim() }));
  if (typed.length) {
    const here = String(typed.find((row) => row.type === slot)?.id || '');
    const other = String(typed.find((row) => row.type !== slot)?.id || '');
    if (!here) return false;
    if (other) return false;
    if (want && here !== want) return false;
  }
  const saved = [...attached, mapped].filter(Boolean);
  if (!saved.length) return false;
  if (want && !saved.includes(want)) return false;
  const skus = Array.isArray(detail.sku) ? (detail.sku as Row[]) : [];
  if (skus.length !== product.skus.length) return false;
  const readRim = (row: Row | undefined) => {
    const raw = row?.sku_srv_templates;
    if (!raw) return '';
    if (typeof raw === 'object') return String((raw as Row).rimDiameter ?? '').trim();
    try {
      return String((JSON.parse(String(raw)) as Row).rimDiameter ?? '').trim();
    } catch {
      return '';
    }
  };
  // 轮辋直径必须和「同一个规格组合」一起核：以前按排序后的清单比，只要集合一致就过，
  // 红款 17 / 蓝款 18 被后台写成红款 18 / 蓝款 17 也照样判成功。
  // 这里复用 apiSkuMatches 的规格组合键（parent_name + spec_name），SKU 顺序变化不影响。
  const used = new Set<Row>();
  for (const sku of product.skus) {
    const want = apiRim(product, sku);
    if (!want) return false;
    const matches = skus.filter(
      (row) =>
        Array.isArray(row.spec) &&
        skuKey(
          rows(row.spec, '规格选项').map((v) => ({
            name: String(v.parent_name),
            value: String(v.spec_name),
          })),
        ) === skuKey(sku.options || []),
    );
    if (matches.length !== 1 || used.has(matches[0])) return false;
    used.add(matches[0]);
    if (readRim(matches[0]) !== want) return false;
  }
  return true;
};
type Services = { refund: number; invoice: number; authenticity: number };
// 页面守卫的输入形状：与主进程 LoginEvidence 一致，注入后由 PDD_LOGIN_MATCH 判定。
type GuardState = {
  trusted: boolean;
  names: string[];
  loginPage: boolean;
  form: boolean;
  rejected: boolean;
  challenge: boolean;
  structure?: { logoutDomPresent?: boolean; logoutTextPresent?: boolean };
  anchor?: unknown;
};
type GuardShop = { name: string; account: string; mallId?: number; userId?: number };
// 带绑定的整数进页面，页面守卫就能先比编号、再退回文字。
const guardShop = (shop: Shop): GuardShop => ({
  name: shop.name,
  account: shop.account,
  mallId: shop.mallId,
  userId: shop.userId,
});
const CREATE = '/glide/v2/mms/edit/commit/create_new';
const DETAIL = '/glide/v2/mms/query/commit/detail';
const SAVE = '/glide/mms/goodsCommit/action/edit';
const DECORATION = '/glide/forward/gorse/mms/goods/decoration/commit/';
const TEMPLATE = '/draco-ms/mms/template/mall';

function changed(message: string): never {
  throw new ExecutionError('platform_changed', message, 'inspect_form');
}
function record(value: unknown, label: string): Row {
  return isRecord(value) ? value : changed('接口返回结构变化：' + label);
}
function rows(value: unknown, label: string): Row[] {
  return Array.isArray(value) && value.every(isRecord)
    ? value
    : changed('接口列表结构变化：' + label);
}
function id(value: unknown): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : changed('接口未返回有效编号');
}
export function apiCents(value: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value))
    throw new ExecutionError('invalid_product', '价格须为非负数字，最多两位小数', 'edit_product');
  const [whole, fraction = ''] = value.split('.');
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(n)) throw new Error('价格超出可表示范围');
  return n;
}
// 类目是否提供正品发票：轮胎等类目的服务与承诺只有发货时间、7天无理由与假一赔十。
export function apiInvoice(
  wants: boolean,
  rules: Record<string, unknown>,
): { invoice: 0 | 1; offers: boolean } {
  const offers = [
    rules.authentic_invoice,
    rules.is_electronic_invoice,
    rules.is_paper_invoice,
    rules.allow_invoice_sub_type,
    rules.must_set_invoice,
  ].some((value) => value === true || (Array.isArray(value) && value.length > 0));
  return { invoice: wants && offers ? 1 : 0, offers };
}
// 到店安装：表单 `service.srv_template_id_map` 的键就是安装类型编号。
// 配送到店 = 2（已用真实草稿验证过），配送到家的编号后台未在提交里出现过，
// 先按 3 填；后台校验不通过时会明确报出来，不会静默写错。
// 到店安装模板必须是后台模板 ID。运营只知道名字（「到店模版1」），
// 所以允许填名字，由下面这段页面脚本去下拉里把 ID 挖出来：
// 下拉项本身不带 data-value，真实 value 只活在 React 组件的 props.option 里。
export const PDD_TEMPLATE_LOOKUP = (name: string) =>
  (async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (probe: () => boolean, timeout = 3000) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        if (probe()) return true;
        await sleep(150);
      }
      return probe();
    };
    // 后台的开关与复选框只认真实指针事件序列，单个 .click() 在部分组件上无效。
    const press = async (node: Element | null) => {
      if (!node) return false;
      const host = node as unknown as HTMLElement;
      if (typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'center' });
      if (typeof host.dispatchEvent === 'function' && typeof MouseEvent === 'function') {
        const rect =
          typeof host.getBoundingClientRect === 'function' ? host.getBoundingClientRect() : null;
        const view = typeof window !== 'undefined' ? window : undefined;
        const init = {
          bubbles: true,
          cancelable: true,
          view,
          clientX: rect ? rect.x + rect.width / 2 : 0,
          clientY: rect ? rect.y + rect.height / 2 : 0,
        };
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          host.dispatchEvent(new MouseEvent(type, init));
        }
        return true;
      }
      if (typeof host.click === 'function') {
        host.click();
        return true;
      }
      return false;
    };
    const norm = (text: unknown) =>
      String(text ?? '')
        .replace(/模板/g, '模版')
        .replace(/[\s（）()]/g, '')
        .toLowerCase();
    const want = norm(name);
    const textOf = (node: Element) => (node.textContent || '').replace(/\s/g, '');
    const findBox = () =>
      document.getElementById('service.srv_template_id_map.2') ||
      document.getElementById('service.srv_template_id_map.3');
    // 「到店安装」默认收在「更多服务 → 展开修改」里，没勾选就不会渲染模板下拉。
    const installCheckbox = () => {
      for (const label of [...document.querySelectorAll('label')]) {
        const text = textOf(label);
        if (!text.includes('到店安装') || text.includes('到店安装类型')) continue;
        const input = label.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
        if (input) return input;
      }
      return null;
    };
    // 「到店安装」默认收在「更多服务 → 展开修改」里。真实页面里「更多服务」是
    // .mui-form-group-label，展开开关是同一组里的 .bottom-switch；页面上有多处
    // 「展开修改」（商详装修等），所以必须先锁定分组再点，否则点半天也展不开。
    const expandServicePanel = async () => {
      const group = [...document.querySelectorAll('.mui-form-group-label')].find((node) =>
        textOf(node).includes('更多服务'),
      );
      let shell: Element | null = group ?? null;
      for (let depth = 0; depth < 4 && shell; depth += 1) {
        const toggle = (
          typeof shell.querySelector === 'function' ? shell.querySelector('.bottom-switch') : null
        ) as HTMLElement | null;
        if (toggle && typeof toggle.click === 'function') {
          await press(toggle);
          await waitFor(() => Boolean(findBox()) || Boolean(installCheckbox()), 3000);
          return true;
        }
        shell = shell.parentElement;
      }
      const fallback = [...document.querySelectorAll('button,a,span,div')].find(
        (node) => textOf(node) === '展开修改',
      ) as HTMLElement | undefined;
      if (fallback && typeof fallback.click === 'function') {
        await press(fallback);
        await waitFor(() => Boolean(findBox()) || Boolean(installCheckbox()), 3000);
        return true;
      }
      return false;
    };
    let box = findBox();
    if (!box) {
      await expandServicePanel();
      box = findBox();
    }
    let checkboxSeen = false;
    if (!box) {
      let input = installCheckbox();
      if (!input) {
        // 有的页面第一次展开只露出一层，再点一次才出现「到店安装」。
        await expandServicePanel();
        await waitFor(() => Boolean(installCheckbox()), 2000);
        input = installCheckbox();
      }
      if (input) {
        checkboxSeen = true;
        if (!input.checked) {
          const host = input.closest('label') || input;
          await press(host as HTMLElement);
          await waitFor(() => Boolean(findBox()), 3000);
        }
        box = findBox();
      }
    }
    const header =
      (box && box.querySelector('[data-testid="beast-core-select-header"]')) ||
      [...document.querySelectorAll('[data-testid="beast-core-select-header"]')].find((node) =>
        (node as HTMLElement).parentElement?.parentElement?.innerText.includes('配送到店模板'),
      ) ||
      null;
    if (!header)
      return {
        ok: false as const,
        reason: checkboxSeen
          ? '已勾选「到店安装」，但模板下拉还没出现（页面可能仍在加载），请稍后重试或在后台手动选一次模板'
          : '页面里找不到「到店安装」勾选项：该商品类目可能不支持到店安装，请核对后台「服务与承诺」区域',
      };
    await press(header as HTMLElement);
    await waitFor(() => document.querySelectorAll('li[role="option"]').length > 0, 2000);
    const seen = new Map<string, string>();
    const items = [...document.querySelectorAll('li[role="option"]')];
    const pick = (li: Element) => {
      let node = (li as unknown as Record<string, unknown>)[
        Object.keys(li).find((k) => k.startsWith('__reactInternalInstance')) || ''
      ] as Record<string, unknown> | undefined;
      for (let depth = 0; node && depth < 8; depth += 1) {
        const props = node.memoizedProps as Record<string, unknown> | undefined;
        const option = props?.option as { label?: string; value?: string } | undefined;
        if (option?.label && option.value)
          return { label: option.label, value: String(option.value) };
        node = node.return as typeof node;
      }
      return undefined;
    };
    for (const li of items) {
      const found = pick(li);
      if (found) seen.set(found.value, found.label);
      else if (li.textContent?.trim()) seen.set('', li.textContent.trim());
    }
    const options = [...seen.entries()].map(([value, label]) => ({ value, label }));
    const hit = options.find((option) => option.value && norm(option.label) === want);
    if (!hit) {
      (header as HTMLElement).click();
      return { ok: false as const, options, reason: '后台下拉里没有这个模板' };
    }
    const target = items.find((li) => pick(li)?.value === hit.value);
    if (target) {
      (target as HTMLElement).click();
      await sleep(300);
    }
    return { ok: true as const, id: hit.value, label: hit.label, options };
  })();
// 只读下拉里有哪些模板，供界面做成下拉框：不改任何值，读完把下拉点回去。
export const PDD_TEMPLATE_OPTIONS = () =>
  (async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (probe: () => boolean, timeout = 3000) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        if (probe()) return true;
        await sleep(150);
      }
      return probe();
    };
    // 后台的开关与复选框只认真实指针事件序列，单个 .click() 在部分组件上无效。
    const press = async (node: Element | null) => {
      if (!node) return false;
      const host = node as unknown as HTMLElement;
      if (typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'center' });
      if (typeof host.dispatchEvent === 'function' && typeof MouseEvent === 'function') {
        const rect =
          typeof host.getBoundingClientRect === 'function' ? host.getBoundingClientRect() : null;
        const view = typeof window !== 'undefined' ? window : undefined;
        const init = {
          bubbles: true,
          cancelable: true,
          view,
          clientX: rect ? rect.x + rect.width / 2 : 0,
          clientY: rect ? rect.y + rect.height / 2 : 0,
        };
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          host.dispatchEvent(new MouseEvent(type, init));
        }
        return true;
      }
      if (typeof host.click === 'function') {
        host.click();
        return true;
      }
      return false;
    };
    const textOf = (node: Element) => (node.textContent || '').replace(/\s/g, '');
    const findBox = () =>
      document.getElementById('service.srv_template_id_map.2') ||
      document.getElementById('service.srv_template_id_map.3');
    const installCheckbox = () => {
      for (const label of [...document.querySelectorAll('label')]) {
        const text = textOf(label);
        if (!text.includes('到店安装') || text.includes('到店安装类型')) continue;
        const input = label.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
        if (input) return input;
      }
      return null;
    };
    const expandServices = async () => {
      const group = [...document.querySelectorAll('.mui-form-group-label')].find((node) =>
        textOf(node).includes('更多服务'),
      );
      let shell: Element | null = group ?? null;
      for (let depth = 0; depth < 4 && shell; depth += 1) {
        const toggle = (
          typeof shell.querySelector === 'function' ? shell.querySelector('.bottom-switch') : null
        ) as HTMLElement | null;
        if (toggle && typeof toggle.click === 'function') {
          await press(toggle);
          await waitFor(() => Boolean(findBox()) || Boolean(installCheckbox()), 3000);
          return true;
        }
        shell = shell.parentElement;
      }
      return false;
    };
    // 只读：不替运营勾「到店安装」（勾选等于替它同意服务条款，也会把编辑页改成脏状态）。
    let box = findBox();
    if (!box) {
      await expandServices();
      box = findBox();
    }
    if (!box) {
      let input = installCheckbox();
      if (!input) {
        await expandServices();
        await waitFor(() => Boolean(installCheckbox()), 2000);
        input = installCheckbox();
      }
      return {
        ok: false as const,
        options: [],
        reason: input
          ? '页面还没勾选「到店安装」，这里只读、不会替你勾选；请先在后台勾选并保存，再读取模板'
          : '页面里找不到「到店安装」勾选项，请先确认停在目标店铺的商品编辑页',
      };
    }
    const header =
      (box && box.querySelector('[data-testid="beast-core-select-header"]')) ||
      [...document.querySelectorAll('[data-testid="beast-core-select-header"]')].find((node) =>
        (node as HTMLElement).parentElement?.parentElement?.innerText.includes('配送到店模板'),
      ) ||
      null;
    if (!header)
      return { ok: false as const, options: [], reason: '页面里没出现「配送到店模板」下拉' };
    await press(header as HTMLElement);
    await waitFor(() => document.querySelectorAll('li[role="option"]').length > 0, 2000);
    const seen = new Map<string, string>();
    for (const li of [...document.querySelectorAll('li[role="option"]')]) {
      let node = (li as unknown as Record<string, unknown>)[
        Object.keys(li).find((k) => k.startsWith('__reactInternalInstance')) || ''
      ] as Record<string, unknown> | undefined;
      let found: { label: string; value: string } | undefined;
      for (let depth = 0; node && depth < 8; depth += 1) {
        const option = (node.memoizedProps as Record<string, unknown> | undefined)?.option as
          { label?: string; value?: string } | undefined;
        if (option?.label && option.value) {
          found = { label: option.label, value: String(option.value) };
          break;
        }
        node = node.return as typeof node;
      }
      if (found) seen.set(found.value, found.label);
    }
    (header as HTMLElement).click();
    const options = [...seen.entries()].map(([value, label]) => ({ value, label }));
    return options.length
      ? { ok: true as const, options }
      : {
          ok: false as const,
          options: [],
          reason: '后台下拉里一个模板也没有，请先到拼多多后台新建到店安装模板',
        };
  })();
export function apiInstallType(delivery: 'store' | 'home'): string {
  return delivery === 'store' ? '2' : '3';
}
// 拿到解析后的模板 ID 才算通过；名称留到页面里换 ID，见 PDD_TEMPLATE_LOOKUP。
export function apiInstallPair(
  delivery: 'store' | 'home',
  template: string,
): Record<string, string> {
  const value = String(template ?? '').trim();
  if (!/^SIST_[A-Za-z0-9_-]+$/.test(value))
    throw new ExecutionError(
      'invalid_product',
      '到店安装模板还没换成后台模板 ID（SIST_ 开头），请先在核对界面解析模板名称',
      'edit_product',
    );
  return { [apiInstallType(delivery)]: value };
}
/**
 * 真正落到草稿详情里的是 `goods_srv_templates` 的 id（`srv_template_id_map` 只是表单写法）。
 * 实测：只发 srv_template_id_map 时，读回的 goods_srv_templates 两个 id 都是空的，
 * 安装服务等于没绑上。type 8 = 配送到店，type 10 = 配送到家。
 */
export function apiSrvTemplates(
  delivery: 'store' | 'home',
  template: string,
): { type: number; id: string }[] {
  const value = String(template ?? '').trim();
  if (!/^SIST_[A-Za-z0-9_-]+$/.test(value))
    throw new ExecutionError(
      'invalid_product',
      '到店安装模板还没换成后台模板 ID（SIST_ 开头），请先在核对界面解析模板名称',
      'edit_product',
    );
  return [
    { type: 8, id: delivery === 'store' ? value : '' },
    { type: 10, id: delivery === 'home' ? value : '' },
  ];
}
function stock(value: string): number {
  // 后台的「*库存」是必填：留空在编辑页里就是一个空输入框，提交会被拦
  // 「请输入第 N 行规格的库存」，所以空值按 1 件上架；显式的 0 是真实库存，原样保留。
  const raw = String(value ?? '').trim();
  if (!raw) return 1;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new ExecutionError('invalid_product', '库存须为非负整数', 'edit_product');
  return Number(raw);
}
function skuKey(options: { name: string; value: string }[]) {
  return JSON.stringify(options.map(({ name, value }) => [name, value]).sort());
}
export function apiCategory(value: unknown, category: string): Category {
  const leaf = pddCategoryLeaf(category);
  const choices = rows(record(value, '类目').cat_info_v2_lists, '类目').filter((c) => {
    const last = [1, 2, 3, 4]
      .map((n) => c['cat_name_' + n])
      .filter(Boolean)
      .at(-1);
    return c.optional === true && last === leaf;
  });
  const unique = [
    ...new Map(
      choices.map((c) => [JSON.stringify([1, 2, 3, 4].map((n) => c['cat_id_' + n])), c]),
    ).values(),
  ];
  if (!leaf || unique.length !== 1)
    throw new ExecutionError(
      'invalid_product',
      '店铺没有唯一可用的末级类目：' + leaf,
      'edit_product',
    );
  const c = unique[0],
    cats = [1, 2, 3, 4]
      .filter((n) => c['cat_id_' + n])
      .map((n) => ({ cat_id: id(c['cat_id_' + n]), cat_name: String(c['cat_name_' + n]) }));
  return {
    id: cats.at(-1)!.cat_id,
    ids: [1, 2, 3, 4].map((n) => (c['cat_id_' + n] ? id(c['cat_id_' + n]) : 0)),
    cats,
  };
}
export function apiProperties(p: Product, template: Row): Row[] {
  const wanted = [
    ['品牌', p.brand],
    ['材质', p.material],
    ['适用人群', p.audience],
    ['是否可折叠', p.foldable],
    ...(p.attributes || []).map((a) => [a.name, a.value]),
  ].filter(([, v]) => v);
  const props: (Row & { module: number })[] = rows(template.modules, '属性模块').flatMap((m) =>
    rows(m.propertys, '属性').map((x) => ({ ...x, module: id(m.id) })),
  );
  const result: Row[] = [];
  for (const [name, value] of wanted) {
    const matches = props.filter((x) => x.name_alias === name);
    if (matches.length !== 1 || matches[0].control_type !== 1)
      throw new ExecutionError(
        'invalid_product',
        '当前API流程暂不能映射此类目属性：' + name,
        'edit_product',
      );
    const x = matches[0];
    const values = rows(record(x.values, '属性选项').content, '属性选项').filter(
      (v) => v.value === value,
    );
    if (values.length !== 1)
      throw new ExecutionError(
        'invalid_product',
        '属性选项未唯一确认：' + name + ' / ' + value,
        'edit_product',
      );
    result.push({
      template_pid: id(x.id),
      template_module_id: x.module,
      ref_pid: id(x.ref_pid),
      pid: id(x.pid),
      vid: id(values[0].vid),
      value: '',
      value_unit: x.value_unit || '',
      content: value,
    });
  }
  if (new Set(result.map((x) => x.template_pid)).size !== result.length)
    throw new ExecutionError('invalid_product', '资料包含重复的类目属性', 'edit_product');
  for (const x of props)
    if (x.required === true && !result.some((v) => v.template_pid === x.id))
      throw new ExecutionError(
        'invalid_product',
        '请补充当前类目的必填属性：' + x.name_alias,
        'edit_product',
      );
  return result;
}
export function assertApiMatrix(p: Product) {
  const names = (p.skus[0]?.options || []).map((x) => x.name);
  if (
    !p.skus.length ||
    names.length > 2 ||
    new Set(names).size !== names.length ||
    p.skus.some(
      (s) =>
        (s.options || []).length !== names.length ||
        (s.options || []).some((o, i) => !o.name || !o.value || o.name !== names[i]),
    )
  )
    throw new ExecutionError('invalid_product', '规格名称与选项不完整', 'edit_product');
  const expected = names.reduce(
    (n, _, i) => n * new Set(p.skus.map((s) => s.options![i].value)).size,
    1,
  );
  if (
    expected !== p.skus.length ||
    new Set(p.skus.map((s) => skuKey(s.options || []))).size !== expected
  )
    throw new ExecutionError(
      'invalid_product',
      '规格组合不完整或重复，不会增加可购买组合',
      'edit_product',
    );
  for (const s of p.skus) {
    if (apiCents(s.group) > apiCents(s.single))
      throw new ExecutionError('invalid_product', '拼单价不能高于单买价', 'edit_product');
    stock(s.stock);
  }
}

// Runs in the page's realm. Signing stays inside the site's normal client.
// 身份判定必须与主进程同一套：后台把子账号渲染成「主账号:子账号(真实姓名)」，
// 只比整行文字会永远判成换了账号（那正是 shop_changed 的来源）。
async function pageApi(
  input: { route: string; method: 'get' | 'post'; body: unknown; shop: GuardShop },
  matchesLogin: (state: GuardState, shop: GuardShop) => boolean,
  anchor: unknown,
) {
  const header = document.querySelector('header') || document.querySelector('[role=banner]');
  const names = ((header as HTMLElement | null)?.innerText || '').split('\n').map((s) => s.trim());
  const logout = (header?.textContent || '').includes('退出当前账号');
  const state: GuardState = {
    trusted: location.origin === 'https://mms.pinduoduo.com' && logout,
    names,
    loginPage: false,
    form: false,
    rejected: false,
    challenge: false,
    structure: { logoutTextPresent: logout },
    anchor,
  };
  if (!matchesLogin(state, input.shop)) return { ok: false, identity: true };
  const sdk = (
    window as unknown as {
      __mms?: { fetch?: Record<string, (...args: unknown[]) => Promise<unknown>> };
    }
  ).__mms?.fetch;
  if (typeof sdk?.[input.method] !== 'function') return { ok: false };
  try {
    return { ok: true, value: await sdk[input.method](input.route, input.body) };
  } catch {
    return { ok: false };
  }
}
async function pageUpload(
  input: { data: string; name: string; mime: string; shop: GuardShop },
  matchesLogin: (state: GuardState, shop: GuardShop) => boolean,
  anchor: unknown,
) {
  const header = (document.querySelector('header') ||
    document.querySelector('[role=banner]')) as HTMLElement | null;
  const names = (header?.innerText || '').split('\n').map((s) => s.trim());
  const logout = (header?.textContent || '').includes('退出当前账号');
  const state: GuardState = {
    trusted: location.origin === 'https://mms.pinduoduo.com' && logout,
    names,
    loginPage: false,
    form: false,
    rejected: false,
    challenge: false,
    structure: { logoutTextPresent: logout },
    anchor,
  };
  if (!matchesLogin(state, input.shop)) return { ok: false, identity: true };
  const sdk = (
    window as unknown as { __mms: { fetch: { post: (...args: unknown[]) => Promise<unknown> } } }
  ).__mms.fetch;
  try {
    const signature = (await sdk.post('/galerie/business/get_signature', {
      bucket_tag: 'pdd_mms',
    })) as { signature?: string };
    if (!signature?.signature) return { ok: false };
    const bytes = Uint8Array.from(atob(input.data), (c) => c.charCodeAt(0)),
      form = new FormData();
    form.append('upload_sign', signature.signature);
    form.append('image', new File([bytes], input.name, { type: input.mime }));
    form.append('forbid_override', 'false');
    const response = (await sdk.post('https://file.pinduoduo.com/v3/store_image', form, {
      dataType: 'file',
      transformResponse: (r: unknown) => r,
    })) as { success?: boolean; result?: unknown; url?: string; width?: number; height?: number };
    return { ok: true, value: response.success === true ? response.result : response };
  } catch {
    return { ok: false };
  }
}

// 页面里没有主进程的作用域，核对函数要随脚本一起注入。
export function pageApiScript(
  input: { route: string; method: 'get' | 'post'; body: unknown },
  shop: Shop,
): string {
  return (
    '(' +
    pageApi.toString() +
    ')(' +
    JSON.stringify({ ...input, shop: guardShop(shop) }) +
    ',' +
    PDD_LOGIN_MATCH +
    ',' +
    PDD_ANCHOR_READ +
    ')'
  );
}
export function pageUploadScript(
  input: { data: string; name: string; mime: string },
  shop: Shop,
): string {
  return (
    '(' +
    pageUpload.toString() +
    ')(' +
    JSON.stringify({ ...input, shop: guardShop(shop) }) +
    ',' +
    PDD_LOGIN_MATCH +
    ',' +
    PDD_ANCHOR_READ +
    ')'
  );
}

export function apiSkuMatches(
  p: Product,
  value: unknown,
  uploads: Record<string, Upload>,
): boolean {
  const actual = rows(value, '保存规格');
  if (actual.length !== p.skus.length) return false;
  const used = new Set<Row>();
  for (const s of p.skus) {
    const matches = actual.filter(
      (a) =>
        Array.isArray(a.spec) &&
        skuKey(
          rows(a.spec, '规格选项').map((v) => ({
            name: String(v.parent_name),
            value: String(v.spec_name),
          })),
        ) === skuKey(s.options || []),
    );
    if (matches.length !== 1 || used.has(matches[0])) return false;
    const a = matches[0];
    used.add(a);
    if (
      a.price !== apiCents(s.single) ||
      a.multi_price !== apiCents(s.group) ||
      a.quantity !== 0 ||
      a.quantity_delta !== stock(s.stock) ||
      (a.out_sku_sn || '') !== (s.code || '')
    )
      return false;
    if (s.image && a.thumb_url !== uploads[p.images[s.image].id]?.url) return false;
  }
  return true;
}

export class PddApiDraft {
  constructor(
    private bridge: BrowserBridge,
    private directory: string,
    private checkIdentity: () => Promise<void>,
  ) {}
  private async request(
    route: string,
    method: 'get' | 'post',
    body: unknown,
    shop: Shop,
    context: ExecutionContext,
  ): Promise<unknown> {
    context.guard();
    const result = await this.bridge.eval<{ ok: boolean; value?: unknown; identity?: boolean }>(
      pageApiScript({ route, method, body }, shop),
    );
    if (!result?.ok)
      throw new ExecutionError(
        result?.identity ? 'shop_changed' : 'platform_changed',
        'API请求未确认：' + route + '，请核对登录或当前接口',
        'inspect_form',
      );
    return result.value;
  }
  async execute(t: Task, shop: Shop, context: ExecutionContext) {
    const p = t.productSnapshot;
    const request = (route: string, body: unknown, method: 'get' | 'post' = 'post') =>
      this.request(route, method, body, shop, context);
    const patch = (values: NonNullable<Task['apiDraft']>) =>
      context.patch({ apiDraft: { ...t.apiDraft, ...values } });
    if (t.saveAttemptedAt) {
      await this.readback(t, shop, context);
      return;
    }
    await context.step(
      '检查API商品资料与图片',
      async () => {
        assertApiMatrix(p);
        apiCents(p.reference);
        await validateLocalImageFiles(p, path.join(this.directory, 'assets'));
      },
      'resources',
    );
    const category = apiCategory(
      await request(
        '/vodka/v2/mms/search/categories/v2',
        { keyword: pddCategoryLeaf(p.category) },
        'get',
      ),
      p.category,
    );
    if (t.apiDraft?.categoryId && t.apiDraft.categoryId !== category.id)
      throw new ExecutionError('form_lost', '原API任务类目已变化，未重新分配编号', 'inspect_form');
    patch({ categoryId: category.id });
    await context.step(
      'API创建或恢复原草稿编号',
      async () => {
        if (t.goodsId) {
          if (!t.apiDraft?.commitId) changed('API任务的原草稿编号缺失');
          return;
        }
        if (t.apiDraft?.createAttemptedAt)
          throw new ExecutionError(
            'form_lost',
            '分配编号的结果不明确，不会再次创建；请先核对后台记录',
            'inspect_form',
          );
        await this.checkIdentity();
        context.guard();
        patch({ createAttemptedAt: new Date().toISOString() });
        const allocated = record(await request(CREATE, {}), '新草稿编号');
        const goodsId = String(id(allocated.goods_id)),
          commitId = String(id(allocated.goods_commit_id));
        context.patch(
          {
            goodsId,
            formUrl:
              'https://mms.pinduoduo.com/goods/goods_add/index?id=' +
              commitId +
              '&goods_id=' +
              goodsId +
              '&type=edit',
            apiDraft: { ...t.apiDraft, commitId },
          },
          'API已分配原商品编号：' + goodsId,
        );
      },
      'form',
    );
    const ids = { goods_id: t.goodsId!, goods_commit_id: t.apiDraft!.commitId! };
    const initial = record(await request(DETAIL, ids), '原草稿');
    if (
      String(initial.goods_id) !== t.goodsId ||
      String(initial.id) !== ids.goods_commit_id ||
      (initial.out_goods_sn && initial.out_goods_sn !== p.code) ||
      rows(initial.sku, '初始规格').length
    )
      changed('原编号已有商品资料，未覆盖；请核对原API任务');
    const { template, properties } = await context.step(
      'API映射基本资料与类目属性',
      async () => {
        const template = record(
          await request(
            TEMPLATE,
            { catId: category.id, goodsCommitId: ids.goods_commit_id, goodsId: t.goodsId },
            'get',
          ),
          '类目模板',
        );
        if (Object.keys(record(template.spec_module, '类目规格模板')).length)
          changed('当前API流程暂不支持绑定类目属性的规格模板');
        const properties = apiProperties(p, template);
        return { template, properties };
      },
      'basic',
    );
    const specNames = rows(
      await request('/glide/v2/mms/query/spec/name/list', { cat_id: category.id }),
      '规格类型',
    );
    const specMap = new Map<string, Row>();
    await context.step(
      'API解析属性与规格选项',
      async () => {
        for (const s of p.skus)
          for (const option of s.options || []) {
            const key = skuKey([option]);
            if (specMap.has(key)) continue;
            let parents = specNames.filter((n) => n.value === option.name);
            if (parents.length > 1) parents = parents.filter((n) => n.is_recommended === true);
            if (parents.length !== 1) changed('规格类型未唯一确认：' + option.name);
            const parentId = id(parents[0].id),
              valueId = id(
                await request('/glide/v2/mms/query/spec/by/name', {
                  parent_id: parentId,
                  name: option.value,
                  cat_id: category.id,
                }),
              );
            specMap.set(key, {
              parent_id: parentId,
              parent_name: option.name,
              spec_id: valueId,
              spec_name: option.value,
              is_custom: 0,
            });
          }
        if (p.skus.length > Number(template.max_sku_num)) changed('组合数量超过当前类目限制');
      },
      'skus',
    );
    const { seconds, services } = await context.step(
      'API核对发货运费及承诺',
      async () => {
        const rules = record(
          await request('/glide/v2/mms/query/rules/limit/new', {
            ...ids,
            cat_id: category.id,
            goods_type: 1,
            goods_properties: properties,
            second_hand: 0,
            schedule_sale_type: 0,
          }),
          '类目规则',
        );
        // Ordinary shipping labels and units are verified against the current rule list.
        const seconds =
          p.shipping === '48小时发货及揽收'
            ? 172800
            : p.shipping === '24小时发货及揽收'
              ? 86400
              : undefined;
        if (
          seconds === undefined ||
          !Array.isArray(rules.shipment_limit_second) ||
          !rules.shipment_limit_second.includes(seconds)
        )
          changed('当前类目未确认此发货承诺：' + p.shipping);
        const custom = record(
          await request('/express_inf/cost_template/get_list', {
            goodsCatIdInfo: {
              catId1: category.ids[0],
              catId2: category.ids[1],
              catId3: category.ids[2],
              catId4: category.ids[3],
              goodsId: Number(t.goodsId),
            },
            sourceKey: 'BAPP_MMS_GOODS_PUBLISH',
            showSimpleList: true,
            pageSize: 2000,
            needReturnCurrentCostTemplate: 1,
          }),
          '店铺运费模板',
        );
        const platform = record(
          await request('/express_inf/cost_template/get_platform_template', {
            sourceKey: 'MMS_GOODS',
            requestScene: 'goodsPublish',
            platformTemplateType: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
          }),
          '平台运费模板',
        );
        const freight = [
          ...new Map(
            [...rows(custom.list, '运费模板'), ...rows(platform.list, '运费模板')]
              .filter((x) => x.costTemplateName === p.freight && x.enable !== false)
              .map((x) => [id(x.costTemplateId), x]),
          ).values(),
        ];
        if (freight.length !== 1) changed('运费模板未唯一确认：' + p.freight);
        if (
          !Array.isArray(rules.is_refundable) ||
          !rules.is_refundable.every((v) => v === 0 || v === 1)
        )
          changed('退货承诺规则未确认');
        const refund =
          p.services?.sevenDay === '是'
            ? 1
            : p.services?.sevenDay === '否'
              ? 0
              : rules.is_refundable.length === 1
                ? Number(rules.is_refundable[0])
                : Number(initial.is_refundable);
        if (!rules.is_refundable.includes(refund) || (rules.must_not_refundable === true && refund))
          changed('7天退货承诺与当前类目规则不同');
        const wantsInvoice = p.services?.invoice === '是';
        const invoice = apiInvoice(wantsInvoice, rules);
        const services: Services = {
          refund,
          invoice: invoice.invoice,
          authenticity:
            p.services?.authenticity === '按平台规则' || !p.services?.authenticity
              ? rules.is_must_fake_one_lose_ten === true
                ? 1
                : Number(initial.is_folt)
              : p.services.authenticity === '是'
                ? 1
                : 0,
        };
        // 资料里没填的服务项不替运营编一个「否」，按当前类目规则取默认并留下说明。
        const blank = [
          p.services?.sevenDay ? '' : '7天无理由退货',
          p.services?.invoice ? '' : '正品发票',
          p.services?.authenticity ? '' : '假一赔十',
        ].filter(Boolean);
        if (blank.length)
          context.patch(
            {},
            `资料里${blank.join('、')}没填，已按当前类目规则取默认值（没有替你填成"否"）`,
          );
        if (wantsInvoice && !invoice.offers)
          context.patch(
            {},
            '当前类目的服务与承诺不提供正品发票，资料“正品发票=是”按不勾选执行；页面只有发货时间、7天无理由与假一赔十',
          );
        else if (services.invoice)
          changed(
            '当前类目提供发票服务，但API流程尚未支持发票类型设置，请在后台手动选择发票类型后继续',
          );
        if (rules.must_set_invoice === true && !wantsInvoice)
          changed('当前类目要求提供正品发票，资料未勾选');
        if (rules.is_must_fake_one_lose_ten === true && !services.authenticity)
          changed('当前类目要求假一赔十，资料未勾选');
        let installTemplateId: string | undefined;
        if (p.install) {
          const typed = p.install.template.trim();
          if (!typed)
            changed(
              '这间店铺还没选到店安装模板：请在资料页点「读取后台模板」选一次（选中后会记在这家店上），或在资料「到店安装模板」里填 SIST_ 开头的模板 ID',
            );
          if (/^SIST_[A-Za-z0-9_-]+$/.test(typed)) installTemplateId = typed;
          else {
            const found = await this.bridge.eval<{
              ok: boolean;
              id?: string;
              reason?: string;
              options?: Array<{ label?: string; value?: string }>;
            }>(`(${PDD_TEMPLATE_LOOKUP.toString()})(${JSON.stringify(p.install.template)})`);
            if (!found?.ok || !found.id) {
              const names = (found?.options || []).map((option) => option.label).filter(Boolean);
              changed(
                `到店安装模板「${p.install.template}」在后台下拉里没找到（${found?.reason || '名称不一致'}）` +
                  (names.length ? `，现在有：${names.join('、')}` : '') +
                  '；请填写下拉里显示的名称，或直接填 SIST_ 开头的模板 ID',
              );
            }
            installTemplateId = found.id;
            context.patch({}, `到店安装模板「${p.install.template}」已换成后台模板 ${found.id}`);
          }
        }
        patch({
          freightId: id(freight[0].costTemplateId),
          services,
          ...(installTemplateId ? { installTemplateId } : {}),
        });
        return { seconds, services };
      },
      'services',
    );

    const uploaded = { ...t.apiDraft?.uploads };
    await context.step(
      'API上传主图详情图及规格图',
      async () => {
        const keys = [...p.main, ...p.detail, ...p.skus.flatMap((s) => (s.image ? [s.image] : []))];
        const assets = [...new Map(keys.map((k) => [p.images[k].id, p.images[k]])).values()];
        for (const [index, asset] of assets.entries()) {
          context.guard();
          if (uploaded[asset.id]) continue;
          await this.checkIdentity();
          const result = await this.bridge.eval<{
            ok: boolean;
            value?: unknown;
            identity?: boolean;
          }>(
            pageUploadScript(
              {
                data: fs
                  .readFileSync(path.join(this.directory, 'assets', asset.id))
                  .toString('base64'),
                name: asset.name,
                mime: asset.format === 'png' ? 'image/png' : 'image/jpeg',
              },
              shop,
            ),
          );
          if (!result?.ok) {
            if (result?.identity)
              throw new ExecutionError(
                'shop_changed',
                'API图片上传前核对登录身份未通过：' + asset.name + '，请核对当前登录的店铺与子账号',
                'inspect_form',
              );
            changed('API图片上传未确认：' + asset.name);
          }
          const image = record(result.value, '图片上传');
          const url = new URL(String(image.url));
          if (
            url.protocol !== 'https:' ||
            !/(^|\.)pddpic\.com$/.test(url.hostname) ||
            image.width !== asset.width ||
            image.height !== asset.height
          )
            changed('图片地址或尺寸与本机原图不一致');
          uploaded[asset.id] = { url: url.href, width: asset.width, height: asset.height };
          patch({ uploads: { ...uploaded } });
          context.patch({ phase: 'API图片上传 ' + (index + 1) + '/' + assets.length });
        }
      },
      'images',
    );
    const image = (key: string) => uploaded[p.images[key].id].url;
    const discount = p.discount ? Math.round(Number(p.discount) * 10) : undefined;
    const payload = {
      goods_id: Number(t.goodsId),
      goods_commit_id: ids.goods_commit_id,
      check_status: initial.check_status,
      goods_name: p.title,
      out_goods_sn: p.code,
      cat_id: category.id,
      cat_ids: category.ids,
      cats: category.cats,
      propertys_tid: id(template.id),
      goods_properties: properties,
      goods_property_group: null,
      is_draft: false,
      is_auto_save: false,
      goods_type: 1,
      is_shop: 0,
      goods_desc: '',
      oversea_goods: {},
      groups: initial.groups,
      cost_template_id: t.apiDraft!.freightId,
      shipment_limit_second: seconds,
      is_refundable: services.refund,
      invoice_status: services.invoice,
      is_folt: services.authenticity,
      market_price: apiCents(p.reference),
      market_price_in_yuan: p.reference,
      two_pieces_discount: discount,
      image_url: image(p.main[0]),
      is_size_spec_sync_detail: 1,
      ...(p.install
        ? {
            srv_template_id_map: apiInstallPair(
              p.install.delivery,
              t.apiDraft?.installTemplateId || p.install.template,
            ),
            goods_srv_templates: apiSrvTemplates(
              p.install.delivery,
              t.apiDraft?.installTemplateId || p.install.template,
            ),
          }
        : {}),
      skus: p.skus.map((s) => ({
        id: 0,
        limit_quantity: 0,
        out_sku_sn: s.code || '',
        is_onsale: 1,
        pre_sale_time: 0,
        multi_price: apiCents(s.group),
        multi_price_in_yuan: s.group,
        price: apiCents(s.single),
        price_in_yuan: s.single,
        quantity_delta: stock(s.stock),
        thumb_url: s.image ? image(s.image) : '',
        weight: 0,
        oversea_sku: {},
        length: null,
        sim_direct_ext_params: null,
        spec: (s.options || []).map((o) => specMap.get(skuKey([o]))!),
        sku_srv_templates: apiRim(p, s) ? JSON.stringify({ rimDiameter: apiRim(p, s) }) : '',
        shipment_limit_second_list: [],
        sku69_code: '',
      })),
      gallery: [
        ...p.main.map((k) => ({ url: image(k), type: 1, file_id: null })),
        ...p.detail.map((k) => ({ url: image(k), type: 2, file_id: null })),
      ],
    };
    await context.step(
      'API保存前核对原编号',
      async () => {
        await this.checkIdentity();
        const fresh = record(await request(DETAIL, ids), '保存前原编号');
        if (
          String(fresh.goods_id) !== t.goodsId ||
          String(fresh.id) !== ids.goods_commit_id ||
          fresh.out_goods_sn ||
          rows(fresh.sku, '保存前规格').length
        )
          changed('原草稿在准备期间已有其他资料，未覆盖');
      },
      'pre_save',
    );
    await context.step(
      'API保存商品与详情草稿',
      async () => {
        await this.checkIdentity();
        context.guard();
        context.patch(
          { saveAttemptedAt: new Date().toISOString(), phase: 'API保存草稿' },
          '已记录API保存意图，结果不明时仅回查原编号',
        );
        const rich = await request(DECORATION + 'save', {
          goods_id: Number(t.goodsId),
          goods_commit_id: Number(ids.goods_commit_id),
          decoration_floor_list: p.detail.map((k, index) => ({
            key: 'DecImage',
            type: 'image',
            priority: index,
            content_list: [
              {
                img_url: image(k),
                file_id: null,
                width: p.images[k].width,
                height: p.images[k].height,
              },
            ],
          })),
        });
        if (rich !== true) changed('详情保存响应未确认');
        if ((await request(SAVE, payload)) !== true) changed('商品保存响应未确认');
      },
      'save',
    );
    await this.readback(t, shop, context);
  }
  private async readback(t: Task, shop: Shop, context: ExecutionContext) {
    const p = t.productSnapshot,
      state = t.apiDraft;
    if (
      !t.goodsId ||
      !state?.commitId ||
      !state.categoryId ||
      !state.freightId ||
      !state.services ||
      !state.uploads
    )
      changed('API原编号或核验资料缺失，不会重新提交');
    await this.checkIdentity();
    await context.step(
      'API按原编号读回核对字段',
      async () => {
        const request = (route: string, body: unknown, method: 'get' | 'post' = 'post') =>
          this.request(route, method, body, shop, context);
        const ids = { goods_id: t.goodsId!, goods_commit_id: state.commitId! };
        const d = record(await request(DETAIL, ids), '保存商品');
        if (
          String(d.goods_id) !== t.goodsId ||
          String(d.id) !== state.commitId ||
          d.check_status !== 0
        )
          changed('原编号尚未确认保存为编辑中草稿');
        const template = record(
          await request(
            TEMPLATE,
            { catId: state.categoryId, goodsCommitId: state.commitId, goodsId: t.goodsId },
            'get',
          ),
          '保存属性',
        );
        const rich = record(await request(DECORATION + 'query/V2', ids), '保存详情');
        const expected = apiProperties(p, template);
        const props = rows(template.modules, '保存属性').flatMap((m) =>
          rows(m.propertys, '保存属性'),
        );
        const attrs = expected.every((x) =>
          props.some(
            (a) =>
              a.id === x.template_pid &&
              rows(a.goods_properties, '已选属性').some(
                (v) => v.vid === x.vid && v.v_value === x.content,
              ),
          ),
        );
        const images = rows(d.galleries, '保存图片');
        const imageMatch = (type: number, keys: string[]) => {
          const actual = images.filter((g) => g.type === type);
          return (
            actual.length === keys.length &&
            actual.every((g, i) =>
              [g.url, g.origin_url].includes(state.uploads![p.images[keys[i]].id]?.url),
            )
          );
        };
        const floors = rows(rich.floor_list, '详情楼层').filter((f) => f.type === 'image');
        const details = floors.flatMap((f) => rows(f.content_list, '详情图片'));
        const checks: [string, boolean, string][] = [
          ['basic', d.goods_name === p.title && d.out_goods_sn === p.code, '商品标题与编码'],
          ['category', d.cat_id === state.categoryId, '商品类目编号'],
          ['brand', attrs, '品牌选项'],
          ['attributes', attrs, '类目属性'],
          ['skus', apiSkuMatches(p, d.sku, state.uploads!), '规格、价格、库存、编码及规格图'],
          [
            'images',
            imageMatch(1, p.main) &&
              imageMatch(2, p.detail) &&
              details.length === p.detail.length &&
              details.every((v, i) => v.img_url === state.uploads![p.images[p.detail[i]].id]?.url),
            '主图、详情图地址和顺序',
          ],
          [
            'shipping',
            d.shipment_limit_second === (p.shipping.startsWith('48') ? 172800 : 86400),
            '发货承诺',
          ],
          ['freight', d.cost_template_id === state.freightId, '运费模板编号'],
          [
            'services',
            d.is_refundable === state.services!.refund &&
              d.invoice_status === state.services!.invoice &&
              d.is_folt === state.services!.authenticity,
            '售后承诺',
          ],
          [
            'install',
            apiInstallMatches(p, d as Row, state.installTemplateId),
            '到店安装类型、模板与轮辋直径',
          ],
          [
            'discount',
            d.market_price === apiCents(p.reference) &&
              (!p.discount || d.two_pieces_discount === Math.round(Number(p.discount) * 10)),
            '参考价与折扣',
          ],
        ];
        const now = new Date().toISOString();
        const updated = (t.backendChecks || []).map((c): BackendCheck => {
          const item = checks.find(([key]) => key === c.key);
          return item
            ? {
                ...c,
                status: item[1] ? 'passed' : 'failed',
                stage: 'saved',
                checkedAt: now,
                message: 'API读回：' + item[2] + (item[1] ? '一致' : '不一致'),
              }
            : c;
        });
        context.patch({ backendChecks: updated });
        if (checks.some(([, ok]) => !ok))
          changed(
            'API草稿读回不一致：' +
              checks
                .filter(([, ok]) => !ok)
                .map(([, , label]) => label)
                .join('、') +
              '；仅回查原编号，不会重试提交',
          );
        const evidence = path.join(this.directory, 'execution', t.id, 'API草稿核验.json');
        fs.mkdirSync(path.dirname(evidence), { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          evidence,
          JSON.stringify(
            {
              goodsId: t.goodsId,
              commitId: state.commitId,
              code: p.code,
              verifiedAt: now,
              checks: updated,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
      },
      'saved_fields',
    );
    await context.step(
      'API确认草稿箱唯一记录',
      async () => {
        await this.checkIdentity();
        await this.bridge.wait(
          async () => {
            const list = record(
              await this.request(
                '/glide/v2/mms/query/commit/list',
                'post',
                { check_status: 0, start: 0, length: 10, goods_id: t.goodsId },
                shop,
                context,
              ),
              '草稿箱',
            );
            const matches = rows(list.list, '草稿箱记录').filter(
              (r) =>
                String(r.goods_id) === t.goodsId &&
                String(r.id) === state.commitId &&
                r.check_status === 0 &&
                r.goods_name === p.title &&
                r.out_goods_sn === p.code,
            );
            if (list.total === 1 && matches.length === 1) return true;
            // The list index can lag a successful save. Repeat spaced reads only.
            await new Promise((resolve) => setTimeout(resolve, 1000));
            return false;
          },
          20000,
          '草稿箱原编号未唯一确认，仅回查原编号，不会重试提交',
        );
      },
      'draft_list',
    );
    const now = new Date().toISOString();
    context.patch(
      {
        status: 'succeeded',
        phase: 'API草稿已保存',
        completedAt: now,
        result: {
          goodsId: t.goodsId!,
          shopName: shop.name,
          title: p.title,
          status: '编辑中',
          verifiedAt: now,
        },
      },
      'API字段读回与草稿箱确认通过，仅保存草稿',
    );
  }
}

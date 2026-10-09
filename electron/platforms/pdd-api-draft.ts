import fs from 'node:fs';
import path from 'node:path';
import type { BrowserBridge } from '../browser-bridge';
import { ExecutionError, type ExecutionContext } from '../execution';
import { validateLocalImageFiles } from '../importer';
import { isRecord, pddCategoryLeaf } from './pdd-page-scripts';
import type { Product, Shop, Task, BackendCheck } from '../../src/types';

type Row = Record<string, unknown>;
type Category = { id: number; ids: number[]; cats: { cat_id: number; cat_name: string }[] };
type Upload = { url: string; width: number; height: number };
type Services = { refund: number; invoice: number; authenticity: number };
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
function stock(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new ExecutionError('invalid_product', '库存须为非负整数', 'edit_product');
  return Number(value);
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
async function pageApi(input: {
  route: string;
  method: 'get' | 'post';
  body: unknown;
  shop: { name: string; account: string };
}) {
  const header = document.querySelector('header') || document.querySelector('[role=banner]');
  const names = ((header as HTMLElement | null)?.innerText || '').split('\n').map((s) => s.trim());
  const text = header?.textContent || '';
  if (
    location.origin !== 'https://mms.pinduoduo.com' ||
    !text.includes('退出当前账号') ||
    !names.includes(input.shop.name) ||
    (input.shop.account.includes(':') && !names.includes(input.shop.account))
  )
    return { ok: false, identity: true };
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
async function pageUpload(input: {
  data: string;
  name: string;
  mime: string;
  shop: { name: string; account: string };
}) {
  const header = (document.querySelector('header') ||
    document.querySelector('[role=banner]')) as HTMLElement | null;
  const text = header?.textContent || '',
    names = (header?.innerText || '').split('\n').map((s) => s.trim());
  if (
    location.origin !== 'https://mms.pinduoduo.com' ||
    !text.includes('退出当前账号') ||
    !names.includes(input.shop.name) ||
    (input.shop.account.includes(':') && !names.includes(input.shop.account))
  )
    return { ok: false };
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
      '(' +
        pageApi.toString() +
        ')(' +
        JSON.stringify({ route, method, body, shop: { name: shop.name, account: shop.account } }) +
        ')',
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
        const services: Services = {
          refund,
          invoice: p.services?.invoice === '是' ? 1 : 0,
          authenticity:
            p.services?.authenticity === '按平台规则' || !p.services?.authenticity
              ? rules.is_must_fake_one_lose_ten === true
                ? 1
                : Number(initial.is_folt)
              : p.services.authenticity === '是'
                ? 1
                : 0,
        };
        if (services.invoice) changed('当前API流程暂未支持发票类型设置，请使用原执行方式');
        if (rules.is_must_fake_one_lose_ten === true && !services.authenticity)
          changed('当前类目要求假一赔十，资料未勾选');
        patch({ freightId: id(freight[0].costTemplateId), services });
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
          const result = await this.bridge.eval<{ ok: boolean; value?: unknown }>(
            '(' +
              pageUpload.toString() +
              ')(' +
              JSON.stringify({
                data: fs
                  .readFileSync(path.join(this.directory, 'assets', asset.id))
                  .toString('base64'),
                name: asset.name,
                mime: asset.format === 'png' ? 'image/png' : 'image/jpeg',
                shop: { name: shop.name, account: shop.account },
              }) +
              ')',
          );
          if (!result?.ok) changed('API图片上传未确认：' + asset.name);
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
        sku_srv_templates: '',
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

import {
  readSkuTable,
  readRemoteImages,
  readImageUploadFacts,
  readSavedSettings,
  pddCategoryLeaf,
  readPddCategoryLeaf,
  clickPddCategoryResult,
  parseSkuTable,
  parseRemoteImages,
  parseSavedSettings,
  isRecord,
  type SkuTable,
} from './pdd-page-scripts';
import fs from 'node:fs';
import path from 'node:path';
import { validateLocalImageFiles } from '../importer';
import { imageUploadSizeLimit, imageSizeText } from '../../src/domain';
import { LOGIN_STATE, PddLogin, shopIdentityMessage } from './pdd-login';
import {
  isPddLoginConfirmed,
  matchesPddIdentity,
  PDD_IDENTITY_MATCH,
  PDD_LOGIN_CONFIRMED,
} from './pdd-identity';
import { PDD_DISCOUNT_STATE, type DiscountPageFacts } from './pdd-discount';
import { BrowserBridge, flatten } from '../browser-bridge';
import { PddApiDraft } from './pdd-api-draft';
import { ExecutionError, type ExecutionContext } from '../execution';
import type { Product, Shop, Task, TaskStep, BackendCheck, ShopLoginEvent } from '../../src/types';
import type { LoginPageFacts, PageFacts, PageRecovery, RecoveryResult } from '../agent-service';
const DRAFTS = 'https://mms.pinduoduo.com/goods/goods_list?msfrom=mms_sidenav&activeKeyNew=key_7';
type SpecRowState = {
  name: string;
  values: string[];
  valueSelectors: string[];
  typeSelector: string;
  emptySelector: string | null;
  controls?: {
    placeholder: string;
    type?: string;
    readOnly: boolean;
    disabled: boolean;
    value: string;
    checked?: boolean | null;
  }[];
  buttons?: string[];
  choices?: {
    text: string;
    checked: string | null;
    selected: string | null;
    pressed: string | null;
  }[];
};
type SkuImageTarget = { image: string; combinations: string[] };
type SkuImageState = { remoteUrl: string; inputSelector: string | null };
// PDD renders a saved zero quantity_delta as an empty stock input. Only the
// editor's captured response for this exact commit may establish that zero.
export function confirmedDraftZeroStocks(body: unknown, t: Task, p: Product): number[] {
  if (!isRecord(body) || !isRecord(body.result)) return [];
  const d = body.result;
  const commitId = t.formUrl ? new URL(t.formUrl).searchParams.get('id') : null;
  if (
    !t.saveAttemptedAt ||
    body?.success !== true ||
    !commitId ||
    String(d?.id) !== commitId ||
    String(d?.goods_id) !== t.goodsId ||
    d.goods_name !== p.title ||
    d.out_goods_sn !== p.code ||
    !Array.isArray(d.sku) ||
    d.sku.length !== p.skus.length
  )
    return [];
  const capturedSkus: unknown[] = d.sku;
  const used = new Set<Record<string, unknown>>(),
    zeros: number[] = [];
  for (const [i, expected] of p.skus.entries()) {
    const matches = capturedSkus.filter((candidate): candidate is Record<string, unknown> => {
      if (!isRecord(candidate) || !Array.isArray(candidate.spec)) return false;
      const specs: unknown[] = candidate.spec;
      return (
        specs.length === (expected.options || []).length &&
        (expected.options || []).every(
          (option) =>
            specs.filter(
              (spec) =>
                isRecord(spec) &&
                spec.parent_name === option.name &&
                spec.spec_name === option.value,
            ).length === 1,
        )
      );
    });
    if (matches.length !== 1 || used.has(matches[0])) return [];
    const s = matches[0];
    used.add(s);
    if (
      typeof s.multi_price !== 'number' ||
      typeof s.price !== 'number' ||
      s.multi_price !== Math.round(Number(expected.group) * 100) ||
      s.price !== Math.round(Number(expected.single) * 100) ||
      (s.out_sku_sn || '') !== (expected.code || '')
    )
      return [];
    if (expected.stock === '0' && s.quantity === 0 && s.quantity_delta === 0) zeros.push(i);
  }
  return zeros;
}
export function specPrefixMatches(table: SkuTable, specs: { name: string; values: string[] }[]) {
  const dimensions = specs.filter((s) => s.name && s.values.length);
  if (!dimensions.length || dimensions.some((s) => !table.headers.includes(s.name))) return false;
  const combinations = dimensions.reduce<string[][]>(
    (rows, s) => rows.flatMap((row) => s.values.map((value) => [...row, value])),
    [[]],
  );
  const actual = table.rows.map((row) =>
    JSON.stringify(dimensions.map((s) => row.cells[table.headers.indexOf(s.name)]?.text)),
  );
  const expected = new Set(combinations.map((row) => JSON.stringify(row)));
  return (
    actual.length === expected.size &&
    new Set(actual).size === actual.length &&
    actual.every((row) => expected.has(row))
  );
}
class NeedsUser extends ExecutionError {
  constructor(message: string) {
    super('form_changed', message, 'inspect_form');
  }
}
const stages: Record<string, TaskStep> = {
  连接浏览器并打开后台: 'connect',
  复用已连接浏览器: 'connect',
  登录与核对店铺: 'login',
  检查本机图片资源: 'resources',
  核对后台图片上传要求: 'resources',
  选择类目并打开填写页: 'form',
  填写标题品牌及属性: 'basic',
  填写规格价格库存及折扣: 'skus',
  设置发货运费及承诺: 'services',
  等待轮播图及详情图上传完成: 'images',
  核对原图片上传结果: 'images',
  保存前核对商品资料: 'pre_save',
  保存草稿并等待确认: 'save',
  重新打开草稿核对保存字段: 'saved_fields',
  草稿箱查询并截图: 'draft_list',
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Asset-store paths have no extension. Build a named copy from the real bytes
// so the browser supplies a usable filename and image type to the upload control.
function imageExtension(file: string, label: string) {
  const head = Buffer.alloc(8);
  let length = 0;
  try {
    const handle = fs.openSync(file, 'r');
    try {
      length = fs.readSync(handle, head, 0, head.length, 0);
    } finally {
      fs.closeSync(handle);
    }
  } catch (error) {
    throw new Error(`无法读取本机图片，未上传：${label}`, { cause: error });
  }
  if (length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) return '.png';
  if (length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return '.jpg';
  throw new Error(`无法确认图片格式，未上传：${label}`);
}
export class PddAdapter {
  private bridge = new BrowserBridge('https://mms.pinduoduo.com/home/');
  private context!: ExecutionContext;
  private task!: Task;
  private captureSavedStock = false;
  private savedZeroStocks = new Set<number>();
  constructor(
    private directory: string,
    private decrypt: (shop: Shop) => Promise<string>,
  ) {}
  async inspectDiagnosis(t: Task, shop: Shop): Promise<PageFacts> {
    if (
      !t.shopSnapshot ||
      t.shopSnapshot.name !== shop.name ||
      t.shopSnapshot.account !== shop.account
    )
      return { available: false, reason: '当前店铺配置与任务不一致，未读取页面' };
    if (!t.goodsId) {
      if (t.error?.code === 'login_required' || t.checkpoint?.step === 'login')
        return this.inspectLoginDiagnosis(shop);
      return { available: false, reason: '任务尚未进入商品填写页或登录异常阶段' };
    }
    // Read only the already bound tab. Do not navigate, switch shops or open selects.
    return this.bridge.eval<PageFacts>(
      `(() => {
      if(location.origin!=='https://mms.pinduoduo.com'||new URL(location.href).searchParams.get('goods_id')!==${JSON.stringify(t.goodsId)})return {available:false,reason:'当前页面不是该任务的原商品填写页'};
      const loginState=${LOGIN_STATE};const header=loginState.names||[];const shop=${JSON.stringify({ name: shop.name, account: shop.account })};
      if(!(${PDD_LOGIN_CONFIRMED})(loginState,shop)||!(${PDD_IDENTITY_MATCH})(header,shop))return {available:false,reason:'后台店铺身份未核对，页面未读取'};
      const title=document.querySelector('[data-tracking-click-viewid="title_input_area"]');
      if(!title)return {available:false,reason:'未找到原商品填写表单'};
      const fields=[{name:'商品标题',value:title.value.slice(0,200)}];const errors=[];
      for(const item of [...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter(e=>e.id.startsWith('basic.propertys')).slice(0,35)){
        const name=(item.querySelector('label')?.innerText||'').replace(/重要|\\*/g,'').trim().slice(0,80);
        const value=(item.querySelector('input:not([type=password]):not([type=hidden])')?.value||'').slice(0,200);
        const options=[...item.querySelectorAll('[role=option]')].filter(e=>e.getClientRects().length).map(e=>e.textContent.trim().slice(0,150)).slice(0,30);
        if(name)fields.push({name,value,options});
        for(const e of item.querySelectorAll('[role=alert],[data-testid*="form-item-error"]'))if(e.getClientRects().length)errors.push(e.textContent.trim().slice(0,300));
      }
      const dialogs=[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getClientRects().length).slice(0,4).map(e=>({title:(e.querySelector('h1,h2,h3,[role=heading]')?.textContent||'').trim().slice(0,150),buttons:[...e.querySelectorAll('button,[role=button]')].filter(b=>b.getClientRects().length).map(b=>b.textContent.trim().slice(0,80)).slice(0,8)}));
      const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
      // Read existing controls only; do not call the writer's specRows/table
      // helpers, which assign selector attributes to the DOM.
      const dimensions=[...document.querySelectorAll('.goods-spec-row')].filter(visible).slice(0,2).map(row=>{
        const inputs=[...row.querySelectorAll('input[placeholder="请输入规格名称"]')].filter(visible);
        return {name:(row.querySelector('input[placeholder^="规格类型"]')?.value||'').slice(0,80),enteredValues:inputs.map(e=>(e.value||'').trim().slice(0,120)).filter(Boolean).slice(0,100),emptyValueInputs:inputs.filter(e=>!e.value&&!e.disabled&&!e.readOnly).length};
      });
      const tables=[...document.querySelectorAll('table')].filter(e=>visible(e)&&e.innerText.includes('拼单价')&&e.innerText.includes('库存'));
      const priceTable=tables.length===1?{available:true,candidateCount:1,headers:[...tables[0].querySelectorAll('thead th')].map(e=>e.innerText.replace(/\\*/g,'').trim().slice(0,80)).slice(0,30),rowCount:tables[0].querySelectorAll('tbody tr').length}:{available:false,candidateCount:tables.length,headers:[],rowCount:null,reason:'未唯一识别到页面价格库存表，不能据此判断资料错误'};
      const sku={source:'browser_dom',valueMeaning:'input_values_not_generated_skus',dimensions,priceTable};
      const discount=${PDD_DISCOUNT_STATE}(${JSON.stringify(t.productSnapshot?.discount || '')});
      return {available:true,capturedAt:new Date().toISOString(),fields,errors:errors.slice(0,20),dialogs,sku,discount};
    })()`,
      5000,
    );
  }
  private async inspectLoginDiagnosis(shop: Shop): Promise<PageFacts> {
    // Inspect only the task's bound tab. Names are compared inside the browser;
    // neither input values, raw header text, cookies nor page body are returned.
    const raw = await this.bridge.eval<Record<string, unknown>>(
      `(() => {
      if(location.origin!=='https://mms.pinduoduo.com')return {trustedOrigin:false};
      const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
      const loginState=${LOGIN_STATE};
      const header=document.querySelector('header')||document.querySelector('[role=banner]');
      const names=loginState.names||[];
      const shopName=${JSON.stringify(shop.name)},account=${JSON.stringify(shop.account)};
      const fold=s=>s.replace(/[A-Z]/g,c=>c.toLowerCase());
      const logoutPresent=!!(loginState.structure?.logoutDomPresent||loginState.structure?.logoutTextPresent);
      const logoutVisible=!!loginState.structure?.logoutVisible;
      const headerLoaded=names.some(s=>s!=='退出当前账号'&&!s.includes('*'));
      const text=document.body?.innerText||'';
      const security=/账号已被锁定|账号被锁定/.test(text)?'account_locked':/账号或密码错误|账户或密码错误|用户名或密码错误|密码不正确|密码错误|账号不存在|账户不存在/.test(text)?'credentials_rejected':/请输入短信验证码|短信验证/.test(text)?'sms':/请拖动滑块|拖动滑块完成|滑动完成验证|点击完成验证|请完成安全验证|请完成验证/.test(text)||[...document.querySelectorAll('iframe')].some(e=>visible(e)&&/captcha|verify|验证码|安全验证/i.test(e.title+' '+e.src))?'captcha':/无权限访问|没有访问权限|账号权限不足/.test(text)?'permission_required':'none';
      return {trustedOrigin:true,path:/^\\/login(?:\\/|$)/.test(location.pathname)?'/login':/^\\/home(?:\\/|$)/.test(location.pathname)?'/home':/^\\/goods(?:\\/|$)/.test(location.pathname)?'/goods':'other',headerPresent:!!header,headerLoaded,logoutPresent,logoutVisible,signedIn:(${PDD_LOGIN_CONFIRMED})(loginState,{name:shopName,account}),loginPage:!!loginState.loginPage,accountFormVisible:!!loginState.form,shopExact:names.includes(shopName),shopCaseOnly:!names.includes(shopName)&&names.some(n=>fold(n)===fold(shopName)),accountExact:names.includes(account),accountRequired:account.includes(':'),identityMatches:(${PDD_IDENTITY_MATCH})(names,{name:shopName,account}),security};
    })()`,
      5000,
    );
    const booleanKeys = [
      'trustedOrigin',
      'headerPresent',
      'headerLoaded',
      'logoutPresent',
      'logoutVisible',
      'signedIn',
      'loginPage',
      'accountFormVisible',
      'shopExact',
      'shopCaseOnly',
      'accountExact',
      'accountRequired',
      'identityMatches',
    ] as const;
    if (!raw || raw.trustedOrigin !== true)
      return { available: false, reason: '当前标签页不是受信任的拼多多后台，未读取登录状态' };
    if (
      booleanKeys.some((key) => typeof raw[key] !== 'boolean') ||
      !['/login', '/home', '/goods', 'other'].includes(String(raw.path)) ||
      ![
        'none',
        'captcha',
        'sms',
        'credentials_rejected',
        'account_locked',
        'permission_required',
      ].includes(String(raw.security))
    )
      return { available: false, reason: '登录页面结构状态未能确认' };
    const login = {
      ...Object.fromEntries(booleanKeys.map((key) => [key, raw[key]])),
      path: raw.path,
      security: raw.security,
    } as LoginPageFacts;
    return { available: true, login, capturedAt: new Date().toISOString() };
  }
  async recoverPage(t: Task, shop: Shop, action: PageRecovery): Promise<RecoveryResult> {
    if (t.saveAttemptedAt || !t.goodsId)
      return { ok: false, message: '已尝试保存或原编号缺失，只能核对原草稿，不能操作填写页' };
    if (action === 'restore_original_form')
      return {
        ok: false,
        message:
          '未保存的新增商品不能通过重新打开地址恢复；即使编号相同也可能清空已填资料。已保留原页面，未刷新或跳转',
      };
    const scope = await this.bridge.eval<boolean>(
      `(() => {
      if(location.origin!=='https://mms.pinduoduo.com')return false;
      const id=new URL(location.href).searchParams.get('goods_id');if(id&&id!==${JSON.stringify(t.goodsId)})return false;
      const loginState=${LOGIN_STATE};const shop=${JSON.stringify({ name: shop.name, account: shop.account })};
      return (${PDD_LOGIN_CONFIRMED})(loginState,shop)&&(${PDD_IDENTITY_MATCH})(loginState.names||[],shop);
    })()`,
      5000,
    );
    if (!scope) return { ok: false, message: '原店铺或原商品身份不能确认，未执行恢复操作' };
    const before = await this.inspectDiagnosis(t, shop);
    if (action === 'dismiss_notice') {
      if (!before.available) return { ok: false, message: '原填写页尚未核对，未关闭弹窗' };
      const closed = await this.bridge.eval<boolean>(
        `(() => {
        const ds=[...document.querySelectorAll('[role=dialog]')].filter(e=>e.getClientRects().length);
        const candidates=ds.filter(e=>{const title=(e.querySelector('h1,h2,h3,[role=heading]')?.textContent||'').trim();return /通知|温馨提示|新功能|活动提醒|消息提醒/.test(title)&&! /提交|上架|删除|账号|验证码|资质|运费|规格|价格|库存|保存|覆盖|授权|退款|扣款/.test(e.innerText);});
        const buttons=candidates.flatMap(e=>[...e.querySelectorAll('button,[role=button]')].filter(b=>b.getClientRects().length&&!b.disabled&&/^(知道了|我知道了|关闭|稍后再说|暂不)$/.test(b.textContent.trim())));
        if(buttons.length!==1)return false;buttons[0].click();return true;
      })()`,
        5000,
      );
      if (!closed)
        return { ok: false, message: '没有唯一可安全关闭的普通通知弹窗，未点击业务确认按钮' };
    } else if (action === 'wait_uploads') {
      const intent = t.uploadSubmission,
        p = t.productSnapshot;
      if (
        !intent ||
        intent.goodsId !== t.goodsId ||
        JSON.stringify(intent.main) !== JSON.stringify(p.main) ||
        JSON.stringify(intent.detail) !== JSON.stringify(p.detail)
      )
        return { ok: false, message: '没有该任务完整的上传提交记录，不能按数量认领现有图片' };
      await this.bridge.wait(
        async () => {
          if (!(await this.inspectDiagnosis(t, shop)).available) return false;
          const remote = await this.remoteImages();
          return remote.main.length === p.main.length && remote.detail.length === p.detail.length
            ? remote
            : false;
        },
        15000,
        '图片仍未全部上传，保留原填写页，未重复上传',
      );
      const remote = await this.remoteImages();
      if (remote.main.length !== p.main.length || remote.detail.length !== p.detail.length)
        return { ok: false, message: '图片状态再次变化，未恢复上传记录' };
      // These submissions originated from this task with an initially empty form.
      // Persist the completed manifest before returning control to the script.
      return {
        ok: true,
        message: '原任务图片提交与完成数量匹配，继续时复用原图片',
        uploadManifest: { goodsId: t.goodsId, ...remote },
      };
    }
    const stable = await this.waitForStableForm(t, shop, before);
    if (!stable)
      return {
        ok: false,
        message:
          '原填写页字段尚未稳定、尚未加载完整或已填字段发生变化；未刷新、未跳转，也未确认原错误已解决',
      };
    return {
      ok: true,
      message:
        action === 'dismiss_notice'
          ? '已关闭普通通知，原页字段稳定且已填内容仍保留；原脚本错误仍需核对'
          : '原页字段稳定可读且已填内容仍保留；仅确认页面状态，不代表原脚本定位或规格错误已解决',
      formState: JSON.stringify([stable.fields, stable.errors, stable.dialogs, stable.sku]),
    };
  }
  private formFieldsReady(t: Task, page: PageFacts, before: PageFacts) {
    if (!page.available || !page.fields) return false;
    const values = new Map(page.fields.map((f) => [f.name, f.value.trim()]));
    const p = t.productSnapshot,
      expected = [
        ['商品标题', p.title],
        ['品牌', p.brand],
        ['材质', p.material],
        ['适用人群', p.audience],
        ['是否可折叠', p.foldable],
        ...(p.attributes || []).map((a) => [a.name, a.value]),
      ];
    if (expected.some(([name, value]) => (name === '商品标题' || !!value) && !values.has(name)))
      return false;
    const basicCompleted =
      ['skus', 'services', 'images', 'pre_save', 'save', 'saved_fields', 'draft_list'].includes(
        t.checkpoint?.step || '',
      ) ||
      t.timings?.some(
        (s) => s.step === 'basic' && s.status === 'done' && s.attempt === (t.attempt || 1),
      );
    if (
      basicCompleted &&
      expected.some(([name, value]) => !!value && values.get(name) !== value.trim())
    )
      return false;
    return !(before.fields || []).some(
      (f) => f.value.trim() && values.get(f.name) !== f.value.trim(),
    );
  }
  private async waitForStableForm(t: Task, shop: Shop, before: PageFacts) {
    let signature = '',
      since = 0;
    try {
      await this.bridge.wait(
        async () => {
          const page = await this.inspectDiagnosis(t, shop);
          if (!this.formFieldsReady(t, page, before)) {
            signature = '';
            since = 0;
            return false;
          }
          const next = JSON.stringify([page.fields, page.errors, page.dialogs, page.sku]);
          if (next !== signature) {
            signature = next;
            since = Date.now();
            return false;
          }
          return Date.now() - since >= 600;
        },
        12000,
        '原填写页字段尚未稳定',
      );
      const final = await this.inspectDiagnosis(t, shop);
      return this.formFieldsReady(t, final, before) &&
        JSON.stringify([final.fields, final.errors, final.dialogs, final.sku]) === signature
        ? final
        : undefined;
    } catch {
      return undefined;
    }
  }
  private guard() {
    this.context.guard();
  }
  private patch(_t: Task, values: Partial<Task>, message?: string) {
    this.context.patch(values, message);
  }
  private timed<T>(_t: Task, name: string, work: () => Promise<T>) {
    return this.context.step(name, work, stages[name]);
  }
  private check(
    key: string,
    passed: boolean,
    message: string,
    stage: 'form' | 'saved' = 'form',
    status?: BackendCheck['status'],
    details?: Record<string, unknown>,
  ) {
    this.context.patch({
      backendChecks: this.task.backendChecks?.map((c) =>
        c.key === key
          ? {
              ...c,
              status: status || (passed ? 'passed' : 'failed'),
              message,
              stage,
              checkedAt: new Date().toISOString(),
            }
          : c,
      ),
    });
    if (!passed)
      throw new ExecutionError(
        'form_changed',
        message,
        stage === 'saved' ? 'readback' : 'inspect_form',
        true,
        details,
      );
  }
  private async checkIdentity(shop: Shop) {
    const state = await this.bridge.wait(
      async () => {
        const s = await this.bridge.eval<Parameters<typeof isPddLoginConfirmed>[0]>(
          LOGIN_STATE,
          5000,
        );
        return isPddLoginConfirmed(s, shop) ? s : false;
      },
      12000,
      '后台登录身份尚未加载，请稍后继续',
    );
    if (!matchesPddIdentity(state.names, shop))
      throw new NeedsUser(`后台登录店铺与所选店铺“${shop.name}”不一致，请核对后继续`);
    this.check('identity', true, shopIdentityMessage(shop));
  }
  async verifyLogin(
    shop: Shop,
    mode: 'relogin' | 'check',
    onEvent: (event: ShopLoginEvent) => void,
  ) {
    if (mode === 'relogin') {
      const startedAt = new Date().toISOString(),
        start = performance.now();
      onEvent({ name: '连接浏览器并打开后台', startedAt, status: 'running' });
      try {
        await this.bridge.connect();
        onEvent({
          name: '连接浏览器并打开后台',
          startedAt,
          status: 'done',
          durationMs: Math.round(performance.now() - start),
        });
      } catch (error) {
        onEvent({
          name: '连接浏览器并打开后台',
          startedAt,
          status: 'failed',
          durationMs: Math.round(performance.now() - start),
        });
        throw error;
      }
    }
    await new PddLogin(this.bridge, this.decrypt, onEvent).run(shop, mode);
  }
  private async login(shop: Shop, t: Task, checkOnly = false) {
    this.patch(t, { phase: '登录并核对店铺' }, '核对后台店铺身份');
    await new PddLogin(
      this.bridge,
      this.decrypt,
      (event) => {
        if (event.status === 'running') this.patch(t, { phase: event.name }, event.name);
      },
      () => this.guard(),
    ).run(shop, checkOnly ? 'check' : 'reuse');
    this.check('identity', true, shopIdentityMessage(shop));
  }
  private async selectCategory(category: string) {
    const leaf = pddCategoryLeaf(category);
    if (!leaf)
      throw new ExecutionError('invalid_product', '请填写最后一级商品类目', 'edit_product');
    const selector = 'input[placeholder="请输入关键词搜索分类"]';
    await this.bridge.wait(
      () =>
        this.bridge.eval<boolean>(
          `(() => {const es=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');return es.length===1;})()`,
        ),
      12000,
      '后台类目搜索框未加载，请核对分类页面',
    );
    await this.bridge.fill(selector, leaf, 'keyboard');
    // Keyboard fill leaves the field. PDD opens suggestions on mouse down,
    // so focus alone cannot reopen the search panel.
    const focused = await this.bridge.eval<boolean>(
      `(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.value!==${JSON.stringify(leaf)})return false;e.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));e.click();e.focus();return true;})()`,
    );
    if (!focused) throw new NeedsUser('类目搜索框内容已变化，请核对分类页面后继续');
    await this.bridge.wait(
      async () => {
        this.guard();
        const result = await this.bridge.eval<{ count: number; path?: string }>(
          `(${clickPddCategoryResult.toString()})(${JSON.stringify(leaf)})`,
        );
        if (result.count > 1)
          throw new NeedsUser(`后台有多个同名类目“${leaf}”，请在分类搜索结果中核对正确类目`);
        return result.count === 1;
      },
      12000,
      `后台没有唯一可用的末级类目“${leaf}”，请核对名称或店铺可用类目`,
    );
    await this.bridge.wait(
      async () =>
        (await this.bridge.eval<string>(`(${readPddCategoryLeaf.toString()})(true)`)) === leaf,
      12000,
      `后台尚未选中末级类目“${leaf}”，请核对分类页面`,
    );
  }
  async execute(t: Task, shop: Shop, context: ExecutionContext, reuseTab = false, restart = false) {
    this.context = context;
    this.task = t;
    this.guard();
    const loginCheckOnly = t.loginCheckOnly === true;
    if (loginCheckOnly) {
      this.patch(t, { loginCheckOnly: undefined });
      if (t.goodsId || t.saveAttemptedAt || restart)
        throw new ExecutionError(
          'login_required',
          '只核对登录的恢复状态已变化，请核对原任务后继续',
          'retry',
        );
    }
    await this.timed(t, reuseTab ? '复用已连接浏览器' : '连接浏览器并打开后台', async () => {
      // Subsequent products in this batch use the same tab; still check the shop below.
      if (reuseTab || t.goodsId) {
        try {
          if ((await this.bridge.eval<string>('location.origin')) === 'https://mms.pinduoduo.com')
            return;
        } catch {}
      }
      await this.bridge.connect();
    });
    await this.timed(t, '登录与核对店铺', async () => await this.login(shop, t, loginCheckOnly));
    if (t.executionMode === 'pdd_api') {
      await new PddApiDraft(this.bridge, this.directory, () => this.checkIdentity(shop)).execute(
        t,
        shop,
        context,
      );
      return;
    }
    if (t.saveAttemptedAt) {
      await this.readback(t, shop);
      return;
    }
    if (restart) {
      if (await this.findOriginalDraft(t, shop)) {
        this.patch(
          t,
          { saveAttemptedAt: new Date().toISOString() },
          '原编号已在草稿箱，转为核对原草稿',
        );
        await this.readback(t, shop);
        return;
      }
      this.patch(
        t,
        {
          previousGoodsIds: [...(t.previousGoodsIds || []), t.goodsId!],
          goodsId: undefined,
          formUrl: undefined,
          uploadManifest: undefined,
          uploadSubmission: undefined,
          skuImageManifest: undefined,
        },
        '已确认旧编号未保存，按运营确认重新开始填写',
      );
    }
    const p = t.productSnapshot;
    // Check local resources before allocating a goods ID or uploading anything.
    await this.timed(t, '检查本机图片资源', async () => {
      try {
        await validateLocalImageFiles(p, path.join(this.directory, 'assets'));
      } catch (error) {
        throw new ExecutionError('invalid_product', (error as Error).message, 'edit_product');
      }
    });
    this.guard();
    const categoryLeaf = pddCategoryLeaf(p.category);
    const categoryMatch = `${!!categoryLeaf} && (${readPddCategoryLeaf.toString()})() === ${JSON.stringify(categoryLeaf)}`;
    const existingForm = !!t.goodsId;
    if (existingForm) {
      const current = await this.bridge.eval<{
        id: string | null;
        category: boolean;
        input: boolean;
      }>(
        `(() => ({id:new URL(location.href).searchParams.get('goods_id'),category:${categoryMatch},input:!!document.querySelector('[data-tracking-click-viewid="title_input_area"]')}))()`,
      );
      if (current.id !== t.goodsId || !current.category || !current.input)
        throw new ExecutionError(
          'form_lost',
          `原商品 ${t.goodsId} 的填写页已离开或失效。可重新开始，程序会先查询旧编号是否已保存`,
          'restart_form',
        );
      this.patch(t, { phase: '恢复原商品填写页' }, `沿用原商品 ${t.goodsId}，重新核对并填写字段`);
    }
    // Unsaved add URLs lose category context on reload. Re-enter category selection;
    // once saving has been attempted, the branch above only reads the original ID.
    if (!existingForm)
      await this.timed(t, '选择类目并打开填写页', async () => {
        await this.bridge.navigate('https://mms.pinduoduo.com/goods/category');
        await this.selectCategory(p.category);
        await this.bridge.clickName('button', '确认发布该类商品');
        const form = await this.bridge.wait(
          async () =>
            await this.bridge.eval<{ url: string } | false>(
              `(() => {return location.href.includes('goods_id=')?{url:location.href}:false;})()`,
            ),
          20000,
          '商品填写页地址未打开',
        );
        const goodsId = new URL(form.url).searchParams.get('goods_id');
        if (!goodsId) throw new Error('后台未分配商品编号');
        this.patch(t, { formUrl: form.url, goodsId });
        await this.bridge.wait(
          async () =>
            await this.bridge.eval<boolean>(
              `!!document.querySelector('[data-tracking-click-viewid="title_input_area"]')`,
            ),
          20000,
          '原商品填写表单未加载',
        );
        await this.checkIdentity(shop);
        await this.bridge.wait(
          async () => await this.bridge.eval<boolean>(categoryMatch),
          12000,
          `后台商品分类与末级类目“${categoryLeaf}”不同，请核对`,
        );
      });
    await this.timed(t, '填写标题品牌及属性', async () => {
      this.guard();
      this.patch(t, { phase: '填写商品资料' }, '填写标题、品牌及类目属性');
      await this.bridge.fill('[data-tracking-click-viewid="title_input_area"]', p.title);
      if (p.brand) await this.attribute('品牌', p.brand, true);
      for (const [name, value] of [
        ['材质', p.material],
        ['适用人群', p.audience],
        ['是否可折叠', p.foldable],
      ])
        if (value) await this.attribute(name, value, true);
      for (const a of p.attributes || []) if (a.value) await this.attribute(a.name, a.value, true);
    });
    await this.timed(t, '核对后台图片上传要求', async () => {
      this.guard();
      this.patch(t, { phase: '核对后台图片上传要求' });
      await this.validateImageUploadSizes(t, p);
    });
    await this.timed(t, '填写规格价格库存及折扣', async () => {
      this.guard();
      this.patch(t, { phase: '填写规格价格库存' }, '生成规格组合并核对价格库存');
      await this.skus(p);
      await this.bridge.fill('[data-tracking-click-viewid="goods_advice_price"]', p.reference);
      if (p.discount) await this.discount(p.discount);
    });
    this.guard();
    await this.timed(t, '设置发货运费及承诺', async () => await this.services(p));
    this.patch(t, { phase: '上传商品图片' }, '按 Excel 中的顺序上传轮播图和详情图');
    await this.reuseSubmittedImages(t, shop, p);
    await this.images(t, p);
    await this.timed(t, '保存前核对商品资料', async () => {
      this.guard();
      await this.checkIdentity(shop);
      await this.verify(p);
    });
    await this.timed(t, '保存草稿并等待确认', async () => {
      this.guard();
      // Resolve first: a missing/ambiguous button has not attempted a save and must
      // leave the unsaved original page resumable. Bind the exact resolved target
      // to the original goods ID, then persist intent immediately before dispatch.
      const snapshot = await this.bridge.snapshot();
      let originalPage = false;
      try {
        const url = new URL(snapshot.url);
        originalPage =
          url.origin === 'https://mms.pinduoduo.com' &&
          !!t.goodsId &&
          url.searchParams.get('goods_id') === t.goodsId;
      } catch {}
      if (!originalPage)
        throw new ExecutionError(
          'form_changed',
          '保存前页面不是该任务的原商品，未点击保存，请核对原页面',
          'inspect_form',
        );
      const buttons = flatten(snapshot.tree).filter(
        (node) => node.role === 'button' && node.name === '保存草稿' && node.ref,
      );
      if (buttons.length !== 1)
        throw new ExecutionError(
          'platform_changed',
          '保存草稿按钮未唯一确认，尚未尝试保存，已保留原填写页',
          'inspect_form',
        );
      this.guard();
      this.patch(
        t,
        { phase: '保存后台草稿', saveAttemptedAt: new Date().toISOString() },
        '正在保存草稿',
      );
      // A dispatch error can have an unknown outcome. Keep the intent so retries
      // only read this goods ID; do not resolve another target or click again.
      await this.bridge.call('click', { selector: buttons[0].ref! });
      await this.bridge.wait(
        async () =>
          flatten((await this.bridge.snapshot()).tree).some((n) => n.name === '保存成功!'),
        20000,
        '后台未确认保存结果，请核对原商品草稿',
      );
      await this.bridge.clickName('button', '确定');
    });
    await this.readback(t, shop);
  }
  private async attribute(name: string, value: string, required: boolean) {
    const item = await this.bridge.eval<{ id: string; value: string } | undefined>(
      `(() => {const es=[...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter(e=>(e.querySelector('label')?.innerText||'').replace(/重要|\\*/g,'').trim()===${JSON.stringify(name)}&&e.id.startsWith('basic.propertys'));return es.length===1?{id:es[0].id,value:es[0].querySelector('input')?.value||''}:undefined;})()`,
    );
    if (!item) {
      if (required) throw new Error(`资料填写了“${name}”，但当前类目没有此属性，请修正商品资料`);
      return;
    }
    if (item.value === value) return;
    const selector = `[id=${JSON.stringify(item.id)}] input`;
    await this.bridge.call('click', { selector });
    let option = flatten((await this.bridge.snapshot()).tree).find(
      (n) => n.role === 'option' && n.name === value && n.ref,
    );
    if (!option) {
      await this.bridge.call('fill', { selector, value });
      await this.bridge.wait(
        async () => {
          option = flatten((await this.bridge.snapshot()).tree).find(
            (n) => n.role === 'option' && n.name === value && n.ref,
          );
          return option;
        },
        5000,
        `后台没有属性选项：${name} / ${value}`,
      );
    }
    await this.bridge.call('click', { selector: option!.ref });
    await this.bridge.wait(
      async () =>
        await this.bridge.eval<boolean>(
          `document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`,
        ),
      4000,
      `后台未接受属性：${name}`,
    );
  }
  private async skus(p: Product) {
    const names = (p.skus[0].options || []).map((o) => o.name);
    const values = names.map((_, i) => [...new Set(p.skus.map((s) => s.options![i].value))]);
    // PDD creates a Cartesian product. An incomplete matrix must not gain unintended SKUs.
    if (names.length && values.reduce((n, v) => n * v.length, 1) !== p.skus.length)
      throw new Error('规格组合未覆盖后台生成的全部组合，请补全 Excel；不会自动增加可购买规格');
    const read = async () => {
      const rows = await this.specRows();
      if (
        rows.length > names.length ||
        rows.some(
          (row, i) =>
            (row.name && row.name !== names[i]) ||
            new Set(row.values).size !== row.values.length ||
            row.values.some((v) => !values[i]?.includes(v)),
        )
      ) {
        const index = rows.findIndex(
          (row, i) =>
            (row.name && row.name !== names[i]) ||
            new Set(row.values).size !== row.values.length ||
            row.values.some((value) => !values[i]?.includes(value)),
        );
        const row = rows[index];
        const reason =
          rows.length > names.length
            ? `后台有 ${rows.length} 组规格，资料有 ${names.length} 组`
            : row.name && row.name !== names[index]
              ? `第 ${index + 1} 组类型：后台“${row.name}”，资料“${names[index]}”`
              : new Set(row.values).size !== row.values.length
                ? `第 ${index + 1} 组读到重复选项`
                : `第 ${index + 1} 组有资料未包含的选项“${row.values.find((value) => !values[index]?.includes(value))}”`;
        const expected = names.map((name, i) => ({ name, values: values[i] }));
        const observed = rows.slice(0, 4).map((row) => ({
          name: row.name,
          values: row.values.slice(0, 100),
          inputs: row.controls || [],
          buttons: row.buttons || [],
          choices: row.choices || [],
        }));
        const describe = (specs: { name: string; values: string[] }[]) =>
          specs.length
            ? specs
                .map(
                  (spec) =>
                    `${spec.name || '未选择类型'}：[${spec.values.slice(0, 6).join('、') || '未填写选项'}${spec.values.length > 6 ? '…' : ''}]`,
                )
                .join('；')
            : '无可选规格';
        throw new ExecutionError(
          'form_changed',
          `原填写页规格与资料不一致：${reason}。资料：${describe(expected)}。后台：${describe(observed)}。请核对原页；重新开始前会查询旧编号`,
          'restart_form',
          true,
          { source: 'spec_conflict', reason, expected, observed, observedRowCount: rows.length },
        );
      }
      return rows;
    };
    await read();
    // An interrupted original form may contain a valid prefix. Fill only missing
    // dimensions/values; never delete or replace a conflicting existing SKU.
    for (let i = 0; i < names.length; i++) {
      let rows = await read();
      if (!rows[i]) {
        await this.bridge.clickName('button', '添加规格类型(', true);
        rows = await this.bridge.wait(
          async () => {
            const current = await read();
            return current[i]?.typeSelector ? current : false;
          },
          4000,
          `后台未生成第 ${i + 1} 个规格类型输入框`,
        );
      }
      if (!rows[i].name) {
        await this.bridge.call('click', { selector: rows[i].typeSelector });
        const option = await this.bridge.wait(
          async () => {
            const options = flatten((await this.bridge.snapshot()).tree).filter(
              (n) => n.role === 'option' && n.ref && n.name?.replace(/\s*常用$/, '') === names[i],
            );
            return options.length === 1 ? options[0] : false;
          },
          4000,
          `后台没有唯一可选的规格类型：${names[i]}`,
        );
        await this.bridge.call('click', { selector: option.ref });
        await this.bridge.wait(
          async () => {
            const current = await read();
            return current[i]?.name === names[i];
          },
          4000,
          `后台未确认规格类型：${names[i]}`,
        );
      }
      for (let j = 0; j < values[i].length; j++) {
        // Selecting a type and blurring a value both replace controls. Re-read
        // the current row after each transition instead of retaining its old inputs.
        let observed: SpecRowState | undefined;
        let current: SpecRowState;
        try {
          current = await this.bridge.wait(
            async () => {
              const row = (await read())[i];
              observed = row;
              return row?.values.includes(values[i][j]) || row?.emptySelector ? row : false;
            },
            4000,
            `规格“${names[i]}”尚未出现第 ${j + 1} 个可填写选项`,
          );
        } catch (error) {
          if (!(error instanceof ExecutionError) || error.code !== 'page_timeout') throw error;
          const facts = {
            type: observed?.name || '',
            inputs: observed?.controls || [],
            buttons: observed?.buttons || [],
          };
          throw new ExecutionError(
            'platform_changed',
            `规格“${names[i]}”第 ${j + 1} 项没有可填写的输入框；已停止并保留原页`,
            'inspect_form',
            true,
            {
              source: 'spec_control',
              expected: { name: names[i], value: values[i][j] },
              observed: facts,
            },
          );
        }
        if (current.values.includes(values[i][j])) continue;
        const receipt = await this.bridge.fill(
          current.emptySelector!,
          values[i][j],
          'keyboard',
          '',
          async () => {
            const row = (await read())[i];
            return row?.name === names[i] && row.values.includes(values[i][j]);
          },
        );
        let observedCommit: SpecRowState | undefined;
        try {
          await this.bridge.wait(
            async () => {
              const row = (await read())[i];
              observedCommit = row;
              return row?.values.includes(values[i][j]);
            },
            4000,
            `规格选项未确认：${names[i]} / ${values[i][j]}`,
          );
        } catch (error) {
          if (!(error instanceof ExecutionError) || error.code !== 'page_timeout') throw error;
          const facts = {
            values: observedCommit?.values || [],
            inputs: observedCommit?.controls || [],
            buttons: observedCommit?.buttons || [],
            choices: observedCommit?.choices || [],
          };
          throw new ExecutionError(
            'platform_changed',
            `规格“${names[i]} / ${values[i][j]}”输入后未确认；已读到：${(observedCommit?.values || []).join('、') || '暂无'}。已停止，未填写价格或保存`,
            'inspect_form',
            true,
            {
              source: 'spec_confirmation',
              expected: { name: names[i], value: values[i][j] },
              observed: facts,
              inputTrace: receipt?.trace,
            },
          );
        }
        // Visible text precedes PDD's asynchronous spec lookup. Its response can
        // replace the whole spec row, dropping the next edit if we start early.
        // Wait for the price table to contain this committed prefix before typing
        // another option; DOM text alone is not a business acknowledgement.
        await this.bridge.wait(
          async () => {
            const current = await read();
            return (
              current[i]?.values.includes(values[i][j]) &&
              specPrefixMatches(await this.table(), current)
            );
          },
          8000,
          `规格“${names[i]} / ${values[i][j]}”的组合尚未生成，已保留原页`,
        );
      }
    }
    const matrixMatches = (table: SkuTable) => {
      try {
        this.matchSkuRows(table, p);
        return true;
      } catch {
        return false;
      }
    };
    const partialMatrixMatches = (table: SkuTable) => {
      const standardHeaders = new Set([
        '库存',
        '拼单价(元)',
        '单买价(元)',
        '规格编码',
        '商品编码',
        '预览图',
        '规格图',
        '操作',
        '状态',
      ]);
      if (
        table.headers.some((header) => !names.includes(header) && !standardHeaders.has(header)) ||
        !table.rows.length
      )
        return false;
      const dimensions = names
        .map((name, index) => ({ name, index, column: table.headers.indexOf(name) }))
        .filter((d) => d.column >= 0);
      if (!dimensions.length) return table.rows.length === 1;
      const expected = new Set(
        p.skus.map((sku) => JSON.stringify(dimensions.map((d) => sku.options![d.index].value))),
      );
      const actual = table.rows.map((row) =>
        JSON.stringify(dimensions.map((d) => row.cells[d.column]?.text)),
      );
      return new Set(actual).size === actual.length && actual.every((key) => expected.has(key));
    };
    let observedTable = await this.table();
    const enteredRows = await read();
    if (
      names.length &&
      !matrixMatches(observedTable) &&
      partialMatrixMatches(observedTable) &&
      enteredRows.length === names.length &&
      enteredRows.every(
        (row, i) =>
          row.name === names[i] &&
          row.values.length === values[i].length &&
          values[i].every((value) => row.values.includes(value)),
      )
    ) {
      // Recover only the evidenced state: all values match, and the current table
      // is an unambiguous subset/projection of the expected matrix. Recommit once,
      // through native text input + Tab, stopping as soon as the matrix is real.
      commit: for (let i = 0; i < names.length; i++)
        for (let j = 0; j < values[i].length; j++) {
          const row = (await read())[i],
            selector = row.valueSelectors[row.values.indexOf(values[i][j])];
          if (!selector)
            throw new ExecutionError(
              'platform_changed',
              `规格“${names[i]}”已显示值，但对应输入框不可核对，未尝试重新提交`,
              'inspect_form',
            );
          await this.bridge.fill(selector, values[i][j], 'keyboard', values[i][j]);
          await this.bridge.wait(
            async () => {
              const current = (await read())[i];
              return current.values.includes(values[i][j]);
            },
            4000,
            `重新提交后规格值未确认：${names[i]} / ${values[i][j]}`,
          );
          observedTable = await this.table();
          if (matrixMatches(observedTable)) break commit;
        }
    }
    try {
      await this.bridge.wait(
        async () => {
          observedTable = await this.table();
          return matrixMatches(observedTable);
        },
        10000,
        '后台规格组合尚未生成',
      );
    } catch (error) {
      if (!(error instanceof ExecutionError) || error.code !== 'page_timeout') throw error;
      const rows = await read();
      const facts = {
        expectedRows: p.skus.length,
        headers: observedTable.headers,
        rowCount: observedTable.rows.length,
        specs: rows.map((row) => ({
          type: row.name,
          values: row.values,
          inputs: row.controls || [],
          buttons: row.buttons || [],
          choices: row.choices || [],
        })),
      };
      throw new ExecutionError(
        'platform_changed',
        `规格已输入，但后台只生成 ${observedTable.rows.length} / ${p.skus.length} 个组合；已停止，未填写价格或保存`,
        'inspect_form',
        true,
        { source: 'spec_matrix', observed: facts },
      );
    }
    const table = await this.table();
    const matchedRows = this.matchSkuRows(table, p),
      imageColumn = table.headers.findIndex((h) => /预览图|规格图/.test(h)),
      imageTargets = new Map<string, SkuImageTarget>();
    if (imageColumn >= 0)
      for (let i = 0; i < p.skus.length; i++) {
        const sku = p.skus[i],
          cell = matchedRows[i].cells[imageColumn];
        if (!cell?.selector) throw new Error('规格图片单元格未定位');
        const existing = imageTargets.get(cell.selector);
        if (existing?.image && sku.image && existing.image !== sku.image)
          throw new Error('后台合并的规格图片单元格对应不同图片，未覆盖图片');
        const combination = JSON.stringify(
          (sku.options || []).map((option) => [option.name, option.value]),
        );
        if (existing) {
          existing.image ||= sku.image || '';
          existing.combinations.push(combination);
        } else
          imageTargets.set(cell.selector, { image: sku.image || '', combinations: [combination] });
      }
    if (imageColumn >= 0 && table.requiredHeaders?.includes(table.headers[imageColumn]))
      for (const [selector, target] of imageTargets)
        if (!target.image && !(await this.skuImageState(selector)).remoteUrl) {
          const combinations = target.combinations.map((key) => JSON.parse(key));
          throw new ExecutionError(
            'invalid_product',
            `当前类目要求规格预览图：${combinations[0].map(([name, value]: string[]) => `${name}:${value}`).join(' / ')} 未提供图片，请在商品资料中补充规格图后重试`,
            'edit_product',
            true,
            { source: 'required_sku_image', combinations },
          );
        }
    for (let i = 0; i < p.skus.length; i++) {
      const sku = p.skus[i],
        row = matchedRows[i];
      for (const [label, value] of [
        ['库存', sku.stock],
        ['拼单价(元)', sku.group],
        ['单买价(元)', sku.single],
        ['规格编码', sku.code || ''],
        ['商品编码', p.code],
      ]) {
        const col = table.headers.indexOf(label);
        if (col < 0) {
          if (label === '商品编码' && names.length) continue;
          throw new Error(`价格库存表缺少列：${label}`);
        }
        const cell = row.cells[col];
        if (!cell?.selector || cell.rowSpan !== 1 || cell.colSpan !== 1)
          throw new Error(`后台${label}单元格跨行或跨列，未改写其他规格`);
        const selector = `${cell.selector} input:not([type=file])`;
        await this.bridge.fill(selector, value);
      }
    }
    // A preview column is not a required-image rule. Keep omitted cells intact;
    // a supplied image belongs to every combination sharing that physical cell.
    for (const target of imageTargets.values()) if (target.image) await this.skuImage(p, target);
    if (names.length) {
      const control = await this.productCodeControl();
      await this.bridge.fill(control.selector, p.code);
    }
  }
  private async skuImageSelector(p: Product, target: SkuImageTarget) {
    // Every upload/replacement re-reads the table: React may reorder rows or
    // replace physical cells after the preceding image finishes uploading.
    const table = await this.table(),
      rows = this.matchSkuRows(table, p),
      column = table.headers.findIndex((h) => /预览图|规格图/.test(h));
    if (column < 0)
      throw new ExecutionError(
        'platform_changed',
        '规格图片列已变化，未操作其他图片',
        'inspect_form',
      );
    const selectors = new Set<string>();
    for (let i = 0; i < p.skus.length; i++) {
      const combination = JSON.stringify(
        (p.skus[i].options || []).map((option) => [option.name, option.value]),
      );
      if (target.combinations.includes(combination)) selectors.add(rows[i].cells[column]?.selector);
    }
    if (selectors.size !== 1 || !selectors.values().next().value)
      throw new ExecutionError(
        'platform_changed',
        '规格组合不再唯一对应一个图片格，未操作其他图片',
        'inspect_form',
      );
    const selector = [...selectors][0];
    const actual = p.skus.flatMap((sku, i) =>
      rows[i].cells[column]?.selector === selector
        ? [JSON.stringify((sku.options || []).map((option) => [option.name, option.value]))]
        : [],
    );
    if (JSON.stringify(actual.sort()) !== JSON.stringify([...target.combinations].sort()))
      throw new ExecutionError(
        'platform_changed',
        '规格图片合并范围已变化，未操作其他图片',
        'inspect_form',
      );
    return selector;
  }
  private async skuImage(p: Product, target: SkuImageTarget) {
    const goodsId = this.task.goodsId,
      asset = p.images[target.image];
    if (!goodsId || !asset)
      throw new ExecutionError(
        'upload_uncertain',
        '规格图片缺少原商品编号或本地资源，未上传',
        'inspect_form',
      );
    const key = JSON.stringify([...target.combinations].sort());
    let selector = await this.skuImageSelector(p, target),
      state = await this.skuImageState(selector);
    const manifest = this.task.skuImageManifest,
      known = manifest?.goodsId === goodsId ? manifest.slots[key] : undefined;
    if (state.remoteUrl && known?.assetId === asset.id && known.remoteUrl === state.remoteUrl)
      return;
    if (state.remoteUrl) {
      // Unknown previews are never claimed as this task's images. Replacement
      // is restricted to the exact current combination's uniquely matched cell.
      await this.removeSkuImage(selector, state.remoteUrl);
      await this.bridge.wait(
        async () => {
          selector = await this.skuImageSelector(p, target);
          state = await this.skuImageState(selector);
          return !state.remoteUrl && !!state.inputSelector;
        },
        5000,
        '该规格原预览图移除后未出现上传入口，已保留其他图片',
      );
    }
    if (!state.inputSelector)
      throw new ExecutionError(
        'platform_changed',
        '当前规格图片格没有唯一上传入口，未操作其他图片',
        'inspect_form',
      );
    const file = this.namedUpload(
      asset.id,
      target.image,
      `sku-${path.basename(target.image, path.extname(target.image))}`,
    );
    await this.bridge.upload(state.inputSelector, file, target.image);
    let remoteUrl: string;
    try {
      remoteUrl = await this.bridge.wait(
        async () => {
          const fresh = await this.skuImageState(await this.skuImageSelector(p, target));
          return fresh.remoteUrl || false;
        },
        15000,
        '该规格图片上传尚未确认，未将现有图片标记为完成',
      );
    } catch (error) {
      // Waiting blind for 15s cannot distinguish a slow upload from a rejected
      // file. Report what the cell and the page actually show at the deadline.
      if (!(error instanceof ExecutionError) || error.code !== 'page_timeout') throw error;
      const evidence = await this.skuImageEvidence(p, target);
      throw new ExecutionError(
        error.code,
        `${error.message}。已核对：${evidence}；已保留其他规格图、轮播图和详情图`,
        'retry',
        true,
        {
          source: 'sku_image_upload',
          image: target.image,
          fileName: path.basename(file),
          combinations: target.combinations,
          evidence,
        },
      );
    }
    this.patch(this.task, {
      skuImageManifest: {
        goodsId,
        slots: {
          ...(this.task.skuImageManifest?.goodsId === goodsId
            ? this.task.skuImageManifest.slots
            : {}),
          [key]: { assetId: asset.id, remoteUrl },
        },
      },
    });
  }
  private namedUpload(assetId: string, label: string, stem: string) {
    const source = path.join(this.directory, 'assets', assetId);
    const directory = path.join(this.directory, 'execution', this.task.id, 'uploads');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${stem}${imageExtension(source, label)}`);
    fs.copyFileSync(source, file);
    return file;
  }
  private async skuImageEvidence(p: Product, target: SkuImageTarget) {
    try {
      const selector = await this.skuImageSelector(p, target);
      const facts = await this.bridge.eval<{
        previews: number;
        uploadEntry: boolean;
        notices: string[];
      }>(
        `(() => {
        const cell=document.querySelector(${JSON.stringify(selector)});
        const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
        const urls=new Set();
        for(const image of cell.querySelectorAll('img'))if(visible(image)){const url=image.currentSrc||image.getAttribute('src')||'';if(/^https?:\\/\\//.test(url))urls.add(url);}
        for(const element of cell.querySelectorAll('[style]'))if(visible(element)){const url=element.style.backgroundImage.match(/^url\\(["']?(https?:[^"')]+)["']?\\)$/)?.[1];if(url)urls.add(url);}
        const notices=[...document.querySelectorAll('[role=alert],[role=dialog],[class*=notice],[class*=Notice],[class*=toast],[class*=Toast]')]
          .filter(visible).map(e=>(e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,120)).filter(Boolean);
        return {previews:urls.size,uploadEntry:!!cell.querySelector('input[type=file]'),notices:[...new Set(notices)].slice(0,3)};
      })()`,
        10000,
      );
      return `图片格预览图 ${facts.previews} 张、上传入口${facts.uploadEntry ? '仍在' : '已消失'}${facts.notices.length ? `、页面提示“${facts.notices.join(' / ')}”` : ''}`;
    } catch {
      return '图片格状态未能读取，请核对原页';
    }
  }
  private async skuImageState(selector: string, removeUrl?: string): Promise<SkuImageState> {
    const goodsId = this.task.goodsId;
    if (!goodsId)
      throw new ExecutionError(
        'upload_uncertain',
        '规格图片缺少原商品编号，未操作图片',
        'inspect_form',
      );
    const result = await this.bridge.eval<SkuImageState | { error: string }>(`(() => {
      const selector=${JSON.stringify(selector)},removeUrl=${JSON.stringify(removeUrl) || 'undefined'};
      if(location.origin!=='https://mms.pinduoduo.com'||new URL(location.href).searchParams.get('goods_id')!==${JSON.stringify(goodsId)})return {error:'当前页面已离开原商品编号'};
      const cells=[...document.querySelectorAll(selector)];
      if(cells.length!==1||!cells[0].closest('table[data-goods-table="sku"] tbody'))return {error:'规格图片单元格不唯一或已离开原价格库存表'};
      const cell=cells[0],visible=e=>e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
      const structure=()=>{
        const records=[];let count=0;
        const clean=(value,limit)=>{const text=String(value||'').replace(/\\s+/g,' ').trim();return /https?:|\\/\\//i.test(text)?'[链接省略]':text.slice(0,limit);};
        const walk=(element,depth)=>{
          if(count++>=64||depth>16)return;
          const item={depth,tag:(element.tagName||'unknown').toLowerCase()};
          for(const name of ['class','title','aria-label','role']){const value=clean(element.getAttribute?.(name),name==='class'?120:40);if(value)item[name]=value;}
          if(!['input','textarea','script','style'].includes(item.tag)){const text=clean([...element.childNodes||[]].filter(node=>node.nodeType===3).map(node=>node.textContent).join(''),32);if(text)item.text=text;}
          records.push(item);for(const child of element.children||[])walk(child,depth+1);
        };
        walk(cell,0);let output='';const encoder=new TextEncoder();
        for(const item of records){const next=output+(output?'\\n':'')+JSON.stringify(item);if(encoder.encode(next).length>5000)break;output=next;}
        return output;
      };
      const backgroundUrl=element=>element.style.backgroundImage.match(/^url\\(["']?(https?:[^"')]+)["']?\\)$/)?.[1]||'';
      const urls=new Set();
      for(const image of cell.querySelectorAll('img'))if(visible(image)){const url=image.currentSrc||image.getAttribute('src')||'';if(/^https?:\\/\\//.test(url))urls.add(url);}
      for(const element of cell.querySelectorAll('[style]'))if(visible(element)){const url=backgroundUrl(element);if(url)urls.add(url);}
      if(urls.size>1)return {error:'同一规格图片格出现多张不同预览图'};
      const remoteUrl=[...urls][0]||'',inputs=[...cell.querySelectorAll('input[type=file]')].filter(e=>!e.disabled);
      if(inputs.length>1)return {error:'同一规格图片格出现多个上传入口'};
      const buttons=[...cell.querySelectorAll('button,[role=button],[aria-label],[title]')].filter(e=>visible(e)&&!e.disabled
        &&/^(删除|移除)(图片)?$/.test((e.getAttribute('aria-label')||e.getAttribute('title')||e.textContent||'').trim()));
      if(removeUrl!==undefined){
        if(!remoteUrl||remoteUrl!==removeUrl)return {error:'规格预览图已变化，未移除图片'};
        // Confirmed in the real PDD preview DOM. Despite "batch" in its
        // tracking name, this icon is actionable only inside this exact cell's
        // one preview container whose current background URL is unchanged.
        const tracked=[...cell.querySelectorAll('i[data-tracking-click-viewid="el_specification_batch_modification_delete_images"]')].filter(visible);
        let removeButton;
        if(tracked.length){
          const wrappers=[...cell.querySelectorAll('.goods-sku-img')].filter(visible);
          const containers=wrappers.length===1?[...wrappers[0].querySelectorAll('span[style]')].filter(e=>visible(e)&&backgroundUrl(e)===remoteUrl):[];
          if(tracked.length!==1||wrappers.length!==1||containers.length!==1||tracked[0].parentElement!==containers[0]||tracked[0].closest('.goods-sku-img')!==wrappers[0])return {error:'规格删除图标没有唯一对应当前预览容器，未移除图片。仅该图片格的控件结构：'+structure()};
          removeButton=tracked[0];
        }else if(buttons.length===1)removeButton=buttons[0];
        if(!removeButton)return {error:'规格图片格没有唯一明确的删除或移除按钮。仅该图片格的控件结构：'+structure()};
        removeButton.click();
      }
      return {remoteUrl,inputSelector:inputs.length===1?selector+' input[type=file]':null};
    })()`);
    if ('error' in result)
      throw new ExecutionError(
        'upload_uncertain',
        `${result.error}；已保留其他规格图、轮播图和详情图`,
        'inspect_form',
      );
    return result;
  }
  private async removeSkuImage(selector: string, remoteUrl: string) {
    await this.skuImageState(selector, remoteUrl);
  }
  private async productCodeControl() {
    // Multi-SKU product codes also appear in the table's summary bar, without a
    // Beast form-item. Resolve the same uniquely labelled control for writes and
    // verification; never use the first text input in a broad page container.
    const result = await this.bridge.eval<
      { selector: string; value: string } | { error: string }
    >(`(() => {
      const visible=e=>e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
      const text=e=>(e.innerText||e.textContent||'').trim();
      const tables=[...document.querySelectorAll('table')].filter(e=>visible(e)&&e.innerText.includes('拼单价')&&e.innerText.includes('库存'));
      for(const e of document.querySelectorAll('[data-goods-product-code]'))e.removeAttribute('data-goods-product-code');
      if(tables.length!==1)return {error:'价格库存表不唯一'};
      const table=tables[0];
      for(let scope=table,depth=0;scope&&depth<8;scope=scope.parentElement,depth++){
        if(scope.matches('body,html,main,form,[role="main"],#root,#app')||scope.querySelector('[data-tracking-click-viewid="title_input_area"]'))break;
        if([...scope.querySelectorAll('table')].filter(visible).some(e=>e!==table))break;
        const labels=[...scope.querySelectorAll('*')].filter(e=>visible(e)&&!e.closest('tbody,thead')&&text(e)==='商品编码'
          &&![...e.children].some(child=>visible(child)&&text(child)==='商品编码'));
        const candidates=new Set();
        for(const label of labels){
          for(let container=label;container;container=container.parentElement){
            if(container.querySelector('table')||container.matches('tbody,thead'))break;
            const inputs=[...container.querySelectorAll('input')].filter(e=>visible(e)&&!e.closest('tbody,thead'));
            if(inputs.length){
              const input=inputs[0];
              if(inputs.length===1&&input.type==='text'&&!input.disabled&&!input.readOnly&&!/批量|规格编码/.test(text(container)))candidates.add(input);
              break;
            }
            if(container===scope)break;
          }
        }
        if(candidates.size>1)return {error:'找到多个商品编码输入框'};
        if(candidates.size===1){const input=[...candidates][0];input.setAttribute('data-goods-product-code','true');return {selector:'input[data-goods-product-code="true"]',value:input.value};}
      }
      return {error:'价格库存表关联区域未找到唯一可填写的商品编码输入框'};
    })()`);
    if ('error' in result)
      throw new ExecutionError(
        'platform_changed',
        `多规格商品编码控件未确认：${result.error}；未改写其他输入框`,
        'inspect_form',
      );
    return result;
  }
  private specRows() {
    return this.bridge.eval<SpecRowState[]>(`(() => {
    const visible=e=>e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
    for(const e of document.querySelectorAll('[data-goods-spec-type],[data-goods-spec-empty],[data-goods-spec-value]')){e.removeAttribute('data-goods-spec-type');e.removeAttribute('data-goods-spec-empty');e.removeAttribute('data-goods-spec-value');}
    return [...document.querySelectorAll('.goods-spec-row')].filter(visible).map((row,index)=>{
      const types=[...row.querySelectorAll('input[placeholder^="规格类型"]')].filter(visible);
      if(types.length>1)throw Error('同一规格行有多个可见的类型控件，无法唯一核对；未改写规格');
      const type=types[0];
      if(type)type.setAttribute('data-goods-spec-type',String(index));
      const inputs=[...row.querySelectorAll('input[placeholder="请输入规格名称"]')].filter(visible);
      const filled=inputs.filter(e=>e.value),valueSelectors=filled.map((e,valueIndex)=>{e.setAttribute('data-goods-spec-value',index+'-'+valueIndex);return '[data-goods-spec-value="'+index+'-'+valueIndex+'"]';});
      const empty=inputs.find(e=>!e.value&&!e.disabled&&!e.readOnly);
      if(empty)empty.setAttribute('data-goods-spec-empty',String(index));
      const controls=[...row.querySelectorAll('input')].filter(e=>visible(e)&&!['file','password','hidden'].includes(e.type)).slice(0,8).map(e=>({placeholder:(e.placeholder||'').slice(0,80),type:e.type,readOnly:!!e.readOnly,disabled:!!e.disabled,value:(e.value||'').slice(0,80),checked:['checkbox','radio'].includes(e.type)?!!e.checked:null}));
      const buttons=[...row.querySelectorAll('button,[role=button]')].filter(visible).map(e=>e.textContent.trim().slice(0,40)).filter(Boolean).slice(0,8);
      const choices=[...row.querySelectorAll('[role=checkbox],[role=radio],[aria-selected],[aria-pressed]')].filter(visible).slice(0,8).map(e=>({text:e.textContent.trim().slice(0,40),checked:e.getAttribute('aria-checked'),selected:e.getAttribute('aria-selected'),pressed:e.getAttribute('aria-pressed')}));
      return {name:type?.value||'',values:filled.map(e=>e.value),valueSelectors,typeSelector:type?'[data-goods-spec-type="'+index+'"]':'',emptySelector:empty?'[data-goods-spec-empty="'+index+'"]':null,controls,buttons,choices};
    });
  })()`);
  }
  private matchSkuRows(table: SkuTable, p: Product) {
    const names = (p.skus[0].options || []).map((option) => option.name);
    if (table.rows.length !== p.skus.length) throw new Error('后台规格数量变化');
    if (names.some((name) => table.headers.filter((header) => header === name).length !== 1))
      throw new Error('后台规格列无法唯一定位');
    const used = new Set<number>();
    return p.skus.map((sku) => {
      const rows = table.rows.filter((row) =>
        names.every(
          (name, i) => row.cells[table.headers.indexOf(name)]?.text === sku.options![i].value,
        ),
      );
      if (rows.length !== 1 || used.has(rows[0].index)) throw new Error('后台规格组合未唯一匹配');
      used.add(rows[0].index);
      return rows[0];
    });
  }
  private async table() {
    return parseSkuTable(await this.bridge.eval<unknown>(`(${readSkuTable.toString()})()`));
  }
  private async discount(value: string) {
    let state = await this.discountState(value);
    if (state.matchesExpected) return;
    if (state.state === 'collapsed' && state.editAvailable) {
      await this.bridge.call('click', {
        selector: '[id="sku.batch_discount"] span.price-text > span.edit',
      });
      state = await this.bridge.wait(
        async () => {
          const current = await this.discountState(value);
          return current.editable ? current : false;
        },
        5000,
        '折扣修改入口已点击，但输入框未就绪',
      );
    }
    if (!state.editable) throw new Error('未找到可编辑的满件折扣输入框');
    await this.bridge.fill('[id="sku.batch_discount"] input[placeholder="5.0~9.9"]', value);
    await this.bridge.wait(
      async () => (await this.discountState(value)).matchesExpected,
      5000,
      '满件折扣填写后与商品资料不一致',
    );
  }
  private discountState(expected: string) {
    return this.bridge.eval<DiscountPageFacts>(
      `${PDD_DISCOUNT_STATE}(${JSON.stringify(expected)})`,
    );
  }
  private async services(p: Product) {
    const expanded = await this.bridge.eval<boolean>(
      `!![...document.querySelectorAll('[data-tracking-click-viewid="el_expand_edit_button"]')].find(e=>e.innerText==='展开修改')`,
    );
    if (expanded)
      await this.bridge.call('click', {
        selector: '[data-tracking-click-viewid="el_expand_edit_button"]',
      });
    await this.bridge.clickName('radio', p.shipping, true);
    if (!p.freight) throw new Error('请在商品资料中确认目标店铺的运费模板');
    const current = await this.bridge.eval<string>(
      `document.querySelector('[id="service.cost_template_id"]')?.innerText.trim()||document.querySelector('[id="service.is_default_template_id"] label[data-checked="true"]')?.innerText.replace('推荐','').trim()||''`,
    );
    if (current !== p.freight) {
      await this.bridge.call('click', {
        selector: 'input[data-tracking-click-viewid="el_other_template_drop_down_boxes"]',
      });
      await this.bridge.call('click', {
        selector: '[id="service.cost_template_id"] [data-testid="beast-core-select-header"]',
      });
      await this.bridge.clickName('option', p.freight);
    }
    const services = { sevenDay: '按平台规则', invoice: '否', authenticity: '否', ...p.services };
    for (const [label, value] of [
      ['7天无理由退货', services.sevenDay],
      ['正品发票', services.invoice],
      ['假一赔十', services.authenticity],
    ]) {
      if (value === '按平台规则') continue;
      const state = await this.bridge.eval<
        { checked: boolean; disabled: boolean; selector: string } | undefined
      >(
        `(() => {const es=[...document.querySelectorAll('label')].filter(e=>e.innerText.trim()===${JSON.stringify(label)}&&e.querySelector('input[type=checkbox]'));if(es.length!==1)return undefined;const e=es[0].querySelector('input');e.setAttribute('data-goods-check',${JSON.stringify(label)});return {checked:e.checked,disabled:e.disabled,selector:'input[data-goods-check='+JSON.stringify(${JSON.stringify(label)})+']'};})()`,
      );
      if (!state) throw new Error(`后台没有承诺控件：${label}`);
      if (state.checked !== (value === '是')) {
        if (state.disabled) throw new Error(`后台要求的承诺与资料冲突：${label}`);
        await this.bridge.call('click', { selector: state.selector });
      }
    }
  }
  private async count(label: string) {
    const selector = label === '商品轮播图' ? '[id="basic.carousel_gallery"]' : '#detail_pic';
    return this.bridge.eval<number>(
      `(() => {const m=document.querySelector(${JSON.stringify(selector)})?.innerText.match(/已上传\\s*(\\d+)\\s*\\//);return m?Number(m[1]):-1;})()`,
    );
  }
  private async reuseSubmittedImages(t: Task, shop: Shop, p: Product) {
    if (!t.uploadSubmission || t.uploadManifest) return;
    const completed = (['main', 'detail'] as const).every(
      (kind) =>
        !p[kind].length ||
        t.timings?.some(
          (timing) =>
            timing.status === 'done' &&
            timing.name ===
              `批量提交${p[kind].length}张${kind === 'main' ? '商品轮播图' : '商品详情'}`,
        ),
    );
    if (!completed) return;
    await this.timed(t, '核对原图片上传结果', async () => {
      this.guard();
      const result = await this.recoverPage(t, shop, 'wait_uploads');
      if (!result.ok || !result.uploadManifest)
        throw new ExecutionError('upload_uncertain', result.message, 'inspect_form');
      this.patch(t, { uploadManifest: result.uploadManifest }, result.message);
    });
  }
  private async images(t: Task, p: Product) {
    const current = await this.remoteImages();
    if (current.main.length || current.detail.length) {
      const manifest = t.uploadManifest;
      if (
        manifest &&
        manifest.goodsId === t.goodsId &&
        JSON.stringify(current) ===
          JSON.stringify({ main: manifest.main, detail: manifest.detail }) &&
        current.main.length === p.main.length &&
        current.detail.length === p.detail.length
      ) {
        this.patch(t, {}, '原填写页已上传图片与任务记录匹配，沿用原图片');
        return;
      }
      throw new ExecutionError(
        'upload_uncertain',
        '原填写页已有图片，但上传记录不能完整匹配，请核对后重新开始',
        'restart_form',
      );
    }
    const baseline = await this.validateImageUploadSizes(t, p);
    for (const [kind, track, label] of [
      ['main', 'carousel_img_localfile_upload', '商品轮播图'],
      ['detail', 'detail_img_localfile_upload', '商品详情'],
    ] as const) {
      const existing = await this.count(label);
      if (existing !== 0)
        throw new ExecutionError(
          'upload_uncertain',
          `${label}上传状态不能确认，请核对后重新开始，防止重复上传`,
          'restart_form',
        );
      this.patch(t, {
        uploadSubmission: { ...t.uploadSubmission, goodsId: t.goodsId!, [kind]: [...p[kind]] },
      });
      if (!p[kind].length) continue;
      this.guard();
      const files = p[kind].map((name, i) => ({
        path: this.namedUpload(p.images[name].id, name, `${kind}-${i}`),
        name,
      }));
      this.patch(t, { phase: `批量上传${label} 0/${files.length}` });
      const entry = await this.imageUploadFacts(kind, true);
      await this.timed(
        t,
        `批量提交${files.length}张${label}`,
        async () =>
          await this.bridge.uploadMany(
            entry.inputSelector || `input[data-tracking-click-viewid="${track}"]`,
            files,
          ),
      );
    }
    // Start both independent upload controls before waiting, preserving each file order.
    await this.timed(t, '等待轮播图及详情图上传完成', async () => {
      let previous = '';
      await this.bridge.wait(
        async () => {
          this.guard();
          for (const kind of ['main', 'detail'] as const)
            if (p[kind].length) {
              const facts = await this.imageUploadFacts(kind);
              const rejection = facts.notices.find(
                (message) =>
                  !baseline.has(message) &&
                  /(?:上传|读取|校验).{0,16}(?:失败|错误)|(?:图片|文件).{0,20}(?:过大|太大|格式错误|尺寸不符|大小超出)|(?:超过|超出).{0,16}(?:限制|上限|重新|压缩)|不支持.{0,12}(?:格式|图片)|无法上传/.test(
                    message,
                  ),
              );
              if (rejection)
                throw new ExecutionError(
                  'invalid_product',
                  `后台拒绝图片上传：${rejection}`,
                  'edit_product',
                  true,
                  { source: 'image_upload_rejection', kind, notice: rejection },
                );
            }
          const ready = await this.bridge.eval<{ main: number; detail: number }>(
            `(() => ({main:[...document.querySelector('[id="basic.carousel_gallery"]').querySelectorAll('[style]')].filter(e=>/^url\\(["']?https:\\/\\//.test(e.style.backgroundImage)).length,detail:[...document.querySelector('#detail_pic .decoration-operate').querySelectorAll('img')].filter(e=>/^https:\\/\\//.test(e.getAttribute('src')||'')).length}))()`,
          );
          const progress = `轮播图 ${ready.main}/${p.main.length} · 详情图 ${ready.detail}/${p.detail.length}`;
          if (progress !== previous) {
            previous = progress;
            this.patch(t, { phase: `上传图片：${progress}` });
          }
          return ready.main === p.main.length && ready.detail === p.detail.length;
        },
        90000,
        '图片上传结果未确认，请核对后台图片',
      );
    });
    this.patch(t, { uploadManifest: { goodsId: t.goodsId!, ...(await this.remoteImages()) } });
  }
  private async imageUploadFacts(kind: 'main' | 'detail', requireInput = false) {
    let observed: Record<string, unknown> | undefined;
    try {
      return await this.bridge.wait(
        async () => {
          this.guard();
          const facts = await this.bridge.eval<unknown>(
            `(${readImageUploadFacts.toString()})(${JSON.stringify(kind)})`,
          );
          if (
            !isRecord(facts) ||
            typeof facts.text !== 'string' ||
            facts.text.length > 5000 ||
            !Array.isArray(facts.notices) ||
            facts.notices.length > 20 ||
            facts.notices.some((n: unknown) => typeof n !== 'string' || n.length > 300)
          )
            throw new ExecutionError(
              'platform_changed',
              '图片上传区返回内容无法识别，已保留当前页面',
              'inspect_form',
            );
          observed = {
            source: 'image_upload_area',
            kind,
            rootCount: facts.rootCount,
            inputCount: facts.inputCount,
            requireInput,
          };
          if (
            facts.available !== true ||
            (requireInput &&
              (facts.inputCount !== 1 ||
                typeof facts.inputSelector !== 'string' ||
                !facts.inputSelector ||
                facts.inputSelector.length > 400))
          )
            return false;
          return facts as {
            available: true;
            text: string;
            notices: string[];
            inputSelector?: string;
          };
        },
        8000,
        '图片上传区尚未就绪',
      );
    } catch (error) {
      if (!(error instanceof ExecutionError) || error.code !== 'page_timeout') throw error;
      throw new ExecutionError(
        'platform_changed',
        `${kind === 'main' ? '轮播图' : '详情图'}${requireInput ? '上传入口未能唯一定位' : '上传区域尚未读取'}，已保留当前页面，请稍后继续`,
        'inspect_form',
        true,
        observed,
      );
    }
  }
  private async validateImageUploadSizes(t: Task, p: Product) {
    const baseline = new Set<string>();
    for (const kind of ['main', 'detail'] as const) {
      if (!p[kind].length) continue;
      const facts = await this.imageUploadFacts(kind);
      facts.notices.forEach((notice) => baseline.add(notice));
      const limit = imageUploadSizeLimit(facts.text);
      if (!limit) {
        this.patch(
          t,
          {},
          `${kind === 'main' ? '轮播图' : '详情图'}：当前上传区未标明单张大小上限，继续读取平台上传返回提示`,
        );
        continue;
      }
      for (const name of p[kind])
        if (limit.strict ? p.images[name].bytes >= limit.bytes : p.images[name].bytes > limit.bytes)
          throw new ExecutionError(
            'invalid_product',
            `${name}：${imageSizeText(p.images[name].bytes)}，不符合后台要求“${limit.label}”，请压缩后重新添加`,
            'edit_product',
            true,
            { source: 'image_size', kind, name, bytes: p.images[name].bytes, limit },
          );
    }
    return baseline;
  }
  private async remoteImages() {
    return parseRemoteImages(await this.bridge.eval<unknown>(`(${readRemoteImages.toString()})()`));
  }
  private async capturedZeroStocks(p: Product) {
    if (!this.captureSavedStock) return new Set<number>();
    const network = await this.bridge.call<{
      requests: { requestId: string; url: string; method: string; status: number }[];
    }>('network', { cmd: 'list', filter: '/glide/v2/mms/query/commit/detail' });
    const commitId = new URL(this.task.formUrl!).searchParams.get('id');
    for (const request of [...(network.requests || [])].reverse()) {
      if (
        request.url !== 'https://mms.pinduoduo.com/glide/v2/mms/query/commit/detail' ||
        request.method !== 'POST' ||
        request.status !== 200
      )
        continue;
      const detail = await this.bridge.call<unknown>('network', {
        cmd: 'detail',
        requestId: request.requestId,
      });
      if (!isRecord(detail)) continue;
      const input: unknown =
        typeof detail.requestBody === 'string'
          ? JSON.parse(detail.requestBody)
          : detail.requestBody;
      if (
        !isRecord(input) ||
        String(input.goods_commit_id) !== commitId ||
        String(input.goods_id) !== this.task.goodsId
      )
        continue;
      const body = typeof detail.body === 'string' ? JSON.parse(detail.body) : detail.body;
      return new Set(confirmedDraftZeroStocks(body, this.task, p));
    }
    return new Set<number>();
  }
  private async verifySkus(p: Product, stage: 'form' | 'saved') {
    let table = await this.table(),
      rows = this.matchSkuRows(table, p);
    const labels = ['库存', '拼单价(元)', '单买价(元)'];
    const missing = () =>
      rows.flatMap((row, i) =>
        labels.flatMap((label) => {
          const cell = row.cells[table.headers.indexOf(label)];
          return (!cell || !cell.value.trim()) &&
            !(cell?.control && label === '库存' && this.savedZeroStocks.has(i))
            ? [{ sku: i, label, cell }]
            : [];
        }),
      );
    // A loaded title does not establish that the saved SKU inputs are loaded.
    // Wait read-only; a blank field never becomes an inferred zero.
    if (stage === 'saved' && missing().length) {
      try {
        await this.bridge.wait(
          async () => {
            this.guard();
            table = await this.table();
            rows = this.matchSkuRows(table, p);
            return missing().length === 0;
          },
          3000,
          '已保存草稿的规格数值尚未读到',
        );
      } catch (error) {
        if (!(error instanceof ExecutionError) || error.code !== 'page_timeout') throw error;
        if (
          missing().every(
            ({ sku, label, cell }) =>
              label === '库存' && p.skus[sku].stock === '0' && !!cell?.control,
          )
        )
          this.savedZeroStocks = await this.capturedZeroStocks(p);
        if (missing().length) {
          const fields = missing().map(({ sku, label, cell }) => ({
            combination: p.skus[sku].options || [],
            field: label,
            expected:
              label === '库存'
                ? p.skus[sku].stock
                : label === '拼单价(元)'
                  ? p.skus[sku].group
                  : p.skus[sku].single,
            observed: cell?.value ?? null,
            text: cell?.text || '',
            control: cell?.control || null,
          }));
          const first = fields[0];
          throw new ExecutionError(
            'page_timeout',
            `已保存草稿的${first.field}尚无法读回：${first.combination.map((o) => o.value).join(' / ') || '单规格'}，资料 ${first.expected}，${first.observed === null ? '控件缺失' : '页面为空白'}；未将空白当作 0，请核对原草稿`,
            'readback',
            true,
            { source: 'sku_readback', stage, goodsId: this.task.goodsId, fields },
          );
        }
      }
    }
    for (let i = 0; i < p.skus.length; i++)
      for (const [label, value] of [
        ['库存', p.skus[i].stock],
        ['拼单价(元)', p.skus[i].group],
        ['单买价(元)', p.skus[i].single],
      ]) {
        const cell = rows[i].cells[table.headers.indexOf(label)];
        if (
          stage === 'saved' &&
          label === '库存' &&
          value === '0' &&
          cell?.control &&
          !cell.value.trim() &&
          this.savedZeroStocks.has(i)
        )
          continue;
        if (
          !cell ||
          !cell.value.trim() ||
          !Number.isFinite(Number(cell.value)) ||
          Number(cell.value) !== Number(value)
        )
          throw new ExecutionError(
            'form_changed',
            `后台${label}与资料不同：${(p.skus[i].options || []).map((o) => o.value).join(' / ') || '单规格'}，资料 ${value}，页面 ${cell ? (cell.value.trim() ? cell.value : '空白') : '控件缺失'}${cell?.text ? `，单元格文字 ${cell.text}` : ''}`,
            stage === 'saved' ? 'readback' : 'inspect_form',
            true,
            {
              source: 'sku_readback',
              stage,
              goodsId: this.task.goodsId,
              fields: [
                {
                  combination: p.skus[i].options || [],
                  field: label,
                  expected: value,
                  observed: cell?.value ?? null,
                  text: cell?.text || '',
                  control: cell?.control || null,
                },
              ],
            },
          );
      }
    for (let i = 0; i < p.skus.length; i++) {
      const sku = p.skus[i],
        row = rows[i];
      const codeCol = table.headers.indexOf('规格编码');
      if (codeCol >= 0 && row.cells[codeCol].value !== (sku.code || ''))
        throw new Error('规格编码与资料不同');
      const productCol = table.headers.indexOf('商品编码');
      if (productCol >= 0 && row.cells[productCol].value !== p.code)
        throw new Error('商品编码与资料不同');
    }
    if (p.skus[0].options?.length) {
      const actual = await this.productCodeControl();
      if (actual.value !== p.code) throw new Error('商品编码与资料不同');
    }
  }
  private async verify(p: Product, stage: 'form' | 'saved' = 'form') {
    const title = await this.bridge.eval<string>(
      `document.querySelector('[data-tracking-click-viewid="title_input_area"]')?.value||''`,
    );
    this.check(
      'basic',
      title === p.title,
      `商品标题：期望 ${p.title}，后台 ${title || '未读到'}`,
      stage,
    );
    const categoryMatches = await this.bridge.eval<boolean>(
      `${!!pddCategoryLeaf(p.category)} && (${readPddCategoryLeaf.toString()})() === ${JSON.stringify(pddCategoryLeaf(p.category))}`,
    );
    this.check(
      'category',
      categoryMatches,
      categoryMatches
        ? `末级类目：${pddCategoryLeaf(p.category)}`
        : `后台末级类目与资料不同：${pddCategoryLeaf(p.category)}`,
      stage,
    );
    for (const [name, value] of [
      ['品牌', p.brand],
      ['材质', p.material],
      ['适用人群', p.audience],
      ['是否可折叠', p.foldable],
      ...(p.attributes || []).map((a) => [a.name, a.value]),
    ])
      if (value) {
        const actual = await this.bridge.eval<string | undefined>(
          `(() => {const es=[...document.querySelectorAll('[data-testid="beast-core-form-item"]')].filter(e=>(e.querySelector('label')?.innerText||'').replace(/重要|\\*/g,'').trim()===${JSON.stringify(name)}&&e.id.startsWith('basic.propertys'));return es.length===1?es[0].querySelector('input')?.value:undefined;})()`,
        );
        this.check(
          name === '品牌' ? 'brand' : 'attributes',
          actual === value,
          `${name}：期望 ${value}，后台 ${actual || '未读到'}`,
          stage,
        );
      }
    if (!p.brand) this.check('brand', true, '未填写品牌，未核验品牌选项', stage, 'not_applicable');
    if (
      ![p.material, p.audience, p.foldable, ...(p.attributes || []).map((a) => a.value)].some(
        Boolean,
      )
    )
      this.check('attributes', true, '未提供需核对的类目属性', stage, 'not_applicable');
    try {
      await this.verifySkus(p, stage);
    } catch (error) {
      this.check(
        'skus',
        false,
        (error as Error).message,
        stage,
        undefined,
        error instanceof ExecutionError ? error.details : undefined,
      );
    }
    this.check(
      'skus',
      true,
      `${p.skus.length} 个组合的价格、库存与编码已核对${stage === 'saved' && this.savedZeroStocks.size ? '；空白零库存已由原草稿响应确认' : ''}`,
      stage,
    );
    const mainCount = await this.count('商品轮播图'),
      detailCount = await this.count('商品详情');
    this.check(
      'images',
      mainCount === p.main.length && detailCount === p.detail.length,
      `轮播图 ${mainCount}/${p.main.length} 张、详情图 ${detailCount}/${p.detail.length} 张`,
      stage,
    );
    const values = parseSavedSettings(
      await this.bridge.eval<unknown>(`(${readSavedSettings.toString()})()`),
    );
    const discount = await this.discountState(p.discount);
    this.check(
      'discount',
      Number(values.reference) === Number(p.reference) && (!p.discount || discount.matchesExpected),
      `参考价 ${values.reference}；满件折扣 ${discount.currentValue || '未读到'}${p.discount ? '' : '（资料留空，沿用后台）'}`,
      stage,
    );
    this.check(
      'shipping',
      !!values.shipping?.startsWith(p.shipping),
      `发货承诺：${values.shipping || '未读到'}`,
      stage,
    );
    this.check(
      'freight',
      values.freight === p.freight,
      `运费模板：${values.freight || '未读到'}`,
      stage,
    );
    const services = { sevenDay: '按平台规则', invoice: '否', authenticity: '否', ...p.services };
    for (const [label, expected] of [
      ['7天无理由退货', services.sevenDay],
      ['正品发票', services.invoice],
      ['假一赔十', services.authenticity],
    ]) {
      const actual = await this.bridge.eval<boolean | undefined>(
        `(() => {const es=[...document.querySelectorAll('label')].filter(e=>e.innerText.trim()===${JSON.stringify(label)}&&e.querySelector('input[type=checkbox]'));return es.length===1?es[0].querySelector('input').checked:undefined;})()`,
      );
      if (actual === undefined || (expected !== '按平台规则' && actual !== (expected === '是')))
        this.check('services', false, `售后承诺 ${label} 与资料不同`, stage);
    }
    this.check('services', true, '售后承诺已逐项读取并核对，按平台规则项沿用后台值', stage);
  }
  private async findOriginalDraft(t: Task, shop: Shop): Promise<boolean> {
    if (!t.goodsId) throw new Error('原商品编号缺失，不能确认重新开始');
    await this.bridge.navigate(DRAFTS);
    await this.checkIdentity(shop);
    const selector = await this.bridge.wait(
      async () =>
        await this.bridge.eval<string | false>(
          `(() => {for(const e of document.querySelectorAll('input')){let p=e.parentElement;while(p&&p.querySelectorAll('input').length===1){if(p.innerText.trim()==='商品ID'){e.setAttribute('data-goods-query-id','true');return 'input[data-goods-query-id="true"]';}p=p.parentElement;}}return false;})()`,
        ),
      8000,
    );
    await this.bridge.fill(selector, t.goodsId);
    // Confirm a table response changed after this query before accepting an empty result.
    await this.bridge.eval(
      `(() => {const root=document.querySelector('.draft-container');if(!root)throw Error('草稿查询区域未找到');window.__goodsRestartQuery={changed:false,before:root.querySelector('table')?.innerText||''};window.__goodsRestartObserver?.disconnect();window.__goodsRestartObserver=new MutationObserver(()=>{const text=root.querySelector('table')?.innerText||'';if(text!==window.__goodsRestartQuery.before)window.__goodsRestartQuery.changed=true;});window.__goodsRestartObserver.observe(root,{childList:true,subtree:true,characterData:true});return true;})()`,
    );
    try {
      await this.bridge.clickName('button', '查询');
      return await this.bridge
        .wait(
          async () => {
            const result = await this.bridge.eval<{
              found: boolean;
              empty: boolean;
              changed: boolean;
            }>(
              `(() => {const root=document.querySelector('.draft-container');return {found:[...document.querySelectorAll('table tbody tr')].some(r=>r.innerText.includes(${JSON.stringify(t.goodsId)})),empty:/共有\\s*0\\s*条/.test(root?.innerText||''),changed:!!window.__goodsRestartQuery?.changed};})()`,
            );
            if (result.found) return { found: true };
            if (result.changed && result.empty) return { found: false };
            return false;
          },
          15000,
          '无法确认旧编号的查询结果，请在后台重置查询后再重试',
        )
        .then((r) => r.found);
    } catch (error) {
      throw new ExecutionError('form_lost', (error as Error).message, 'restart_form');
    } finally {
      await this.bridge.eval(
        `(() => {window.__goodsRestartObserver?.disconnect();delete window.__goodsRestartQuery;delete window.__goodsRestartObserver;return true;})()`,
      );
    }
  }
  private async readback(t: Task, shop: Shop) {
    await this.timed(t, '重新打开草稿核对保存字段', async () => {
      // Reopen the persisted editor first, then finish with a fresh draft list query.
      if (!t.formUrl || new URL(t.formUrl).origin !== 'https://mms.pinduoduo.com')
        throw new Error('草稿编辑地址无效');
      const edit = new URL(t.formUrl);
      edit.search = '';
      edit.searchParams.set('id', new URL(t.formUrl).searchParams.get('id') || '');
      edit.searchParams.set('goods_id', t.goodsId!);
      edit.searchParams.set('type', 'edit');
      // A new tab loads persisted server data without discarding or navigating an
      // editor whose beforeunload handler may still consider it dirty after save.
      this.savedZeroStocks.clear();
      this.captureSavedStock = false;
      const capture = (t.productSnapshot.skus || []).some((s) => s.stock === '0');
      if (capture) {
        await this.bridge.navigate('https://mms.pinduoduo.com/home/', { newTab: true });
        await this.bridge.call('network', { cmd: 'start' });
        this.captureSavedStock = true;
      }
      try {
        await this.bridge.navigate(edit.href, capture ? {} : { newTab: true });
        await this.bridge.wait(
          async () =>
            await this.bridge.eval<boolean>(
              `document.querySelector('[data-tracking-click-viewid="title_input_area"]')?.value?.length>0`,
            ),
          15000,
          '已保存草稿的资料尚未加载',
        );
        const expanded = await this.bridge.eval<boolean>(
          `!![...document.querySelectorAll('[data-tracking-click-viewid="el_expand_edit_button"]')].find(e=>e.innerText==='展开修改')`,
        );
        if (expanded)
          await this.bridge.call('click', {
            selector: '[data-tracking-click-viewid="el_expand_edit_button"]',
          });
        await this.checkIdentity(shop);
        await this.verify(t.productSnapshot, 'saved');
      } finally {
        if (this.captureSavedStock) {
          await this.bridge.call('network', { cmd: 'stop' }).catch(() => {});
          this.captureSavedStock = false;
        }
      }
    });
    await this.timed(t, '草稿箱查询并截图', async () => {
      this.patch(t, { phase: '核对草稿箱' }, '到草稿箱核对商品编号及状态');
      await this.bridge.navigate(DRAFTS, { newTab: true });
      await this.checkIdentity(shop);
      // List navigation can restore cached rows. Query the exact ID explicitly.
      const idInput = await this.bridge.wait(
        async () =>
          await this.bridge.eval<string | false>(
            `(() => {for(const e of document.querySelectorAll('input')){let p=e.parentElement;while(p&&p.querySelectorAll('input').length===1){if(p.innerText.trim()==='商品ID'){e.setAttribute('data-goods-query-id','true');return 'input[data-goods-query-id="true"]';}p=p.parentElement;}}return false;})()`,
          ),
        8000,
        '草稿箱查询控件尚未加载',
      );
      if (!idInput) throw new Error('草稿箱商品ID查询控件未找到');
      await this.bridge.fill(idInput, t.goodsId!);
      await this.bridge.clickName('button', '查询');
      const row = await this.bridge.wait(
        async () =>
          await this.bridge.eval<string | false>(
            `(() => {const rows=[...document.querySelectorAll('table tbody tr')].filter(r=>r.innerText.includes(${JSON.stringify(t.goodsId || 'MISSING')})&&r.innerText.includes(${JSON.stringify(t.title)}));return rows.length===1?rows[0].innerText:false;})()`,
          ),
        20000,
        '草稿箱未查到此商品，请核对后继续原任务，不要重复创建',
      );
      if (!row.includes('编辑中')) throw new Error('商品记录不是草稿编辑中状态，请人工核对');
      const file = path.join(this.directory, 'execution', t.id, '草稿保存结果.png');
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      await this.bridge.call('screenshot', { format: 'png', path: file });
      this.patch(t, { evidence: file });
    });
    this.patch(
      t,
      {
        status: 'succeeded',
        phase: '草稿已保存',
        result: {
          goodsId: t.goodsId!,
          status: '编辑中',
          shopName: shop.name,
          title: t.title,
          verifiedAt: new Date().toISOString(),
        },
        completedAt: new Date().toISOString(),
      },
      `草稿保存成功，商品 ID：${t.goodsId}；价格、库存及图片数量已读回核对`,
    );
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { validateLocalImageFiles } from '../importer';
import { BrowserBridge } from '../browser-bridge';
import { ExecutionError, type ExecutionContext } from '../execution';
import { TAOBAO_LOGIN_URL, TAOBAO_WORKBENCH, TaobaoLogin } from './taobao-login';
import { shopIdentityMessage } from './taobao-identity';
import { platformMeta } from '../../src/platforms';
import {
  TAOBAO_DRAFT_LIST,
  TAOBAO_ITEM_EDIT,
  TaobaoPublish,
  type TaobaoPublishDeps,
} from './taobao-publish';
import type { BackendCheck, Shop, ShopLoginEvent, Task, TaskStep } from '../../src/types';
import type { PageFacts, PageRecovery, RecoveryResult } from '../agent-service';

// 淘宝登录页与工作台、发品页是不同来源；都属于该平台后台。
const TAOBAO_TRUSTED_ORIGINS = [
  TAOBAO_LOGIN_URL,
  'https://loginmyseller.taobao.com',
  'https://sell.publish.tmall.com',
];
const stages: Record<string, TaskStep> = {
  连接浏览器并打开千牛后台: 'connect',
  复用已连接浏览器: 'connect',
  登录与核对店铺: 'login',
  打开千牛工作台: 'login',
  打开千牛登录页: 'login',
  等待人工登录: 'login',
  核对千牛后台店铺: 'login',
  读回草稿: 'draft_list',
};

export class TaobaoAdapter {
  private bridge = new BrowserBridge(TAOBAO_WORKBENCH, TAOBAO_TRUSTED_ORIGINS);
  private context!: ExecutionContext;
  private task!: Task;
  constructor(
    private directory: string,
    private decrypt: (shop: Shop) => Promise<string>,
  ) {}

  private guard() {
    this.context.guard();
  }
  private patch(_t: Task, values: Partial<Task>, message?: string) {
    this.context.patch(values, message);
  }
  private timed<T>(_t: Task, name: string, work: () => Promise<T>) {
    return this.context.step(name, work, stages[name]);
  }
  /** 只更新对应键的后端检查；不通过时中断流程。 */
  private check(key: string, passed: boolean, message: string) {
    this.setCheck(key, passed ? 'passed' : 'failed', message);
    if (!passed) throw new ExecutionError('form_changed', message, 'inspect_form', true);
  }
  /** 只上报结果，不中断（供发品流程内部使用）。 */
  private setCheck(key: string, status: 'passed' | 'failed' | 'not_applicable', message: string) {
    this.context.patch({
      backendChecks: (this.task.backendChecks || []).map((c) =>
        c.key === key
          ? ({
              ...c,
              status,
              message,
              stage: 'form',
              checkedAt: new Date().toISOString(),
            } satisfies BackendCheck)
          : c,
      ),
    });
  }
  /**
   * 登录与核对入口，供「店铺管理 → 登录与核对」调用。
   * relogin 会连接浏览器并打开千牛；check 只读核对当前登录结果。
   */
  async verifyLogin(
    shop: Shop,
    mode: 'relogin' | 'check',
    onEvent: (event: ShopLoginEvent) => void,
  ) {
    if (mode === 'relogin') {
      const startedAt = new Date().toISOString(),
        start = performance.now();
      onEvent({ name: '连接浏览器并打开千牛后台', startedAt, status: 'running' });
      try {
        await this.bridge.connect();
        onEvent({
          name: '连接浏览器并打开千牛后台',
          startedAt,
          status: 'done',
          durationMs: Math.round(performance.now() - start),
        });
      } catch (error) {
        onEvent({
          name: '连接浏览器并打开千牛后台',
          startedAt,
          status: 'failed',
          durationMs: Math.round(performance.now() - start),
        });
        throw error;
      }
    }
    await new TaobaoLogin(this.bridge, this.decrypt, onEvent).run(shop, mode);
  }

  /** 发品流程需要的桥接、资源目录与进度回调。 */
  private publishDeps(): TaobaoPublishDeps {
    return {
      bridge: this.bridge,
      directory: this.directory,
      patch: (values, message) => this.patch(this.task, values, message),
      step: (name, work, stage) => this.context.step(name, work, stage),
      guard: () => this.guard(),
      check: (key, status, message) => this.setCheck(key, status, message),
    };
  }

  /**
   * 已提交过的任务只做读回，绝不重复提交 —— 重复提交会在店里产生第二条商品。
   */
  private async readback(t: Task, goodsId: string) {
    const listUrl = `${TAOBAO_DRAFT_LIST}&queryItemId=${encodeURIComponent(goodsId)}`;
    await this.bridge.navigate(listUrl);
    const row = await this.bridge.wait(
      async () =>
        await this.bridge
          .eval<{ found: boolean; text: string; empty: boolean }>(
            `(() => {
            const text=document.body.innerText||'';
            const rows=[...document.querySelectorAll('table tbody tr')].filter(e=>e.getClientRects().length);
            const hit=rows.map(e=>(e.innerText||'').replace(/\\s+/g,' ').trim()).filter(v=>v.includes(${JSON.stringify(goodsId)}));
            return {found:hit.length>0,text:hit[0]||'',empty:/没有数据/.test(text)};
          })()`,
          )
          .then((state) => (state.found || state.empty ? state : false)),
      30000,
      `未能在草稿箱读到商品 ${goodsId}`,
    );
    if (!row.found)
      throw new ExecutionError(
        'save_uncertain',
        `草稿箱里找不到商品 ${goodsId}，请人工核对该商品是否已保存`,
        'readback',
      );
    this.patch(
      t,
      {
        goodsId,
        phase: '草稿已读回',
        message: row.text.slice(0, 200),
      },
      `草稿箱已确认：${row.text.slice(0, 120)}`,
    );
    this.setCheck('qualification', 'not_applicable', '本任务仅保存草稿，未执行最终发布审核');
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
    await this.timed(t, reuseTab ? '复用已连接浏览器' : '连接浏览器并打开千牛后台', async () => {
      if (reuseTab) {
        try {
          const host = await this.bridge.eval<string>('location.hostname');
          if (typeof host === 'string' && /(^|\.)taobao\.com$/.test(host)) return;
        } catch {}
      }
      await this.bridge.connect();
    });
    await this.timed(t, '登录与核对店铺', async () => {
      await new TaobaoLogin(
        this.bridge,
        this.decrypt,
        (event) => {
          if (event.status === 'running') this.patch(t, { phase: event.name }, event.name);
        },
        () => this.guard(),
      ).run(shop, loginCheckOnly ? 'check' : 'relogin');
      this.check('identity', true, shopIdentityMessage(shop));
    });
    if (loginCheckOnly) return;

    // 保存过就不再写第二次；只核对原草稿。
    if (t.saveAttemptedAt || t.goodsId) {
      if (!t.goodsId)
        throw new ExecutionError(
          'save_uncertain',
          '任务已标记为提交过但缺少商品 ID，请人工核对草稿箱后再决定是否重跑',
          'readback',
        );
      await this.timed(t, '读回草稿', async () => await this.readback(t, t.goodsId!));
      return;
    }
    if (restart && t.previousGoodsIds?.length)
      this.patch(t, { previousGoodsIds: [], message: '按运营确认重新填写' }, '重新开始填写');
    await context.step(
      '检查本机图片资源',
      async () => {
        try {
          await validateLocalImageFiles(t.productSnapshot, path.join(this.directory, 'assets'));
        } catch (error) {
          throw new ExecutionError('invalid_product', (error as Error).message, 'edit_product');
        }
      },
      'resources',
    );

    const publish = new TaobaoPublish(this.publishDeps());
    // 提交前先落盘保存意图：一旦进程在提交过程中退出，恢复时只会读回、不会重复提交。
    this.patch(
      t,
      { saveAttemptedAt: new Date().toISOString(), phase: '正在提交保存草稿' },
      '已进入提交阶段',
    );
    const saved = await publish.run(t, shop);
    await this.timed(t, '读回草稿', async () => await this.readback(t, saved.goodsId));
  }

  /**
   * 只读诊断：任务已绑定商品且当前页面正是该商品的填写页时，回读表单事实。
   * 不导航、不切换店铺、不改动任何字段。
   */
  async inspectDiagnosis(t: Task, shop: Shop): Promise<PageFacts> {
    if (
      !t.shopSnapshot ||
      t.shopSnapshot.name !== shop.name ||
      t.shopSnapshot.account !== shop.account
    )
      return { available: false, reason: '当前店铺配置与任务不一致，未读取页面' };
    if (!t.goodsId) {
      if (t.error?.code === 'login_required' || t.checkpoint?.step === 'login')
        return { available: false, reason: '登录异常，请在店铺管理处重新登录并核对身份' };
      return { available: false, reason: '任务尚未提交保存草稿，没有可读回的商品页' };
    }
    const facts = await this.bridge.eval<PageFacts>(
      `(() => {
        const id=new URL(location.href).searchParams.get('id');
        if(location.hostname!=='sell.publish.tmall.com'||id!==${JSON.stringify(t.goodsId)})
          return {available:false,reason:'当前页面不是该商品的填写页'};
        const shown=e=>{if(!e)return false;const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&getComputedStyle(e).visibility!=='hidden';};
        const text=e=>(e.innerText||e.textContent||'').replace(/\\s+/g,' ').trim();
        const fields=[];const errors=[];
        for(const root of document.querySelectorAll('[id^="sell-field-"]')){
          if(!shown(root))continue;
          const label=text(root.querySelector('.sell-component-info-wrapper-label')||{});
          if(!label)continue;
          const trigger=[...root.querySelectorAll('.next-select-trigger')].filter(shown).pop();
          const input=[...root.querySelectorAll('input,textarea')].find(e=>shown(e)&&!['checkbox','radio','file','hidden'].includes(e.type));
          fields.push({name:label,value:(trigger?text(trigger):(input?input.value:'')).slice(0,200)});
          const t2=text(root);
          if(/必填项未填|必填项不能为空|不合法/.test(t2))errors.push(label+'：'+t2.slice(0,160));
        }
        const dialogs=[...document.querySelectorAll('[role=dialog]')].filter(shown).slice(0,4)
          .map(d=>({title:text(d.querySelector('[role=heading],h1,h2,h3')||{}).slice(0,120),
            buttons:[...d.querySelectorAll('button')].filter(shown).map(b=>text(b).slice(0,60)).slice(0,8)}));
        return {available:true,fields:fields.slice(0,80),errors,dialogs,capturedAt:new Date().toISOString()};
      })()`,
    );
    return facts;
  }

  /**
   * 恢复动作：只做导航与等待，不改字段、不提交。
   */
  async recoverPage(_t: Task, _shop: Shop, action: PageRecovery): Promise<RecoveryResult> {
    if (!this.task?.goodsId) return { ok: false, message: '该任务还没有商品 ID，无法恢复页面' };
    const formUrl = `${TAOBAO_ITEM_EDIT}?itemId=${encodeURIComponent(this.task.goodsId)}`;
    if (action === 'wait_form_ready') {
      await this.bridge.navigate(formUrl);
      await this.bridge.wait(
        async () =>
          await this.bridge.eval<boolean>("!!document.getElementById('sell-field-title')"),
        40000,
        '商品填写页未就绪',
      );
      return { ok: true, message: `已打开商品 ${this.task.goodsId} 的填写页`, formState: 'ready' };
    }
    if (action === 'restore_original_form' || action === 'dismiss_notice') {
      await this.bridge.navigate(formUrl);
      return { ok: true, message: `已返回商品 ${this.task.goodsId} 的填写页`, formState: 'opened' };
    }
    return {
      ok: false,
      message: `淘宝流程暂不支持恢复动作「${action}」；未执行任何页面操作`,
    };
  }
}

/** 判断某个文件是否存在于本机资源目录（供导入期预检复用）。 */
export function taobaoAssetExists(directory: string, id: string) {
  return fs.existsSync(path.join(directory, 'assets', id));
}

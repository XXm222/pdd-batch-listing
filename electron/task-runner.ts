import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store';
import {
  ExecutionError,
  assertNoActiveTask,
  classifyError,
  initialChecks,
  type ExecutionContext,
  type PlatformAdapter,
} from './execution';
import { problems } from '../src/domain';
import type { Product, Shop, Task, StepTiming, TaskStep } from '../src/types';

export function prepareTasks(
  store: Store,
  input: { shopId: string; productIds: string[] },
): string[] {
  const shop = store.all<Shop>('shops').find((s) => s.id === input?.shopId);
  if (!shop?.credentialsSaved) throw new Error('请先保存店铺账号密码');
  if (
    !Array.isArray(input.productIds) ||
    !input.productIds.length ||
    input.productIds.length > 200 ||
    new Set(input.productIds).size !== input.productIds.length
  )
    throw new Error('请选择有效商品');
  const products = store.all<Product>('products');
  const selected = input.productIds.map((id) => products.find((p) => p.id === id));
  if (selected.some((p) => !p || problems(p).length))
    throw new Error('商品资料已变化，请先补充完整');
  assertNoActiveTask(
    store.all<Task>('tasks'),
    shop.id,
    selected.map((p) => p!.code),
  );
  const tasks: Task[] = selected.map((p) => ({
    id: crypto.randomUUID(),
    shopId: shop.id,
    shopName: shop.name,
    shopSnapshot: { name: shop.name, account: shop.account, updatedAt: shop.updatedAt },
    revision: 0,
    code: p!.code,
    title: p!.title,
    status: 'prepared',
    time: new Date().toISOString(),
    productSnapshot: structuredClone(p!),
    backendChecks: initialChecks(),
  }));
  store.saveTasks(tasks);
  return tasks.map((t) => t.id);
}

export class TaskRunner {
  private active = false;
  private stopping = false;
  get isActive() {
    return this.active;
  }
  get isStopping() {
    return this.stopping;
  }
  constructor(
    private store: Store,
    private directory: string,
    private adapter: PlatformAdapter,
    private onFatal: (error: unknown) => void = () => {},
    private onStopped: (id: string, remaining: string[]) => Promise<void> = async () => {},
  ) {}
  private task(id: string) {
    const t = this.store.all<Task>('tasks').find((t) => t.id === id);
    if (!t) throw new Error('任务不存在');
    if (t.clearedAt) throw new Error('该记录已清理，请先在“已清理”中恢复');
    return t;
  }
  private patch(t: Task, values: Partial<Task>, message?: string) {
    if (!message && values.phase && values.phase !== t.phase) message = values.phase;
    Object.assign(t, values);
    if (message) {
      t.message = message;
      t.logs = [...(t.logs || []), { time: new Date().toISOString(), message }];
    }
    this.store.updateTask(t);
  }
  recover() {
    for (const t of this.store.all<Task>('tasks'))
      if (t.status === 'running') {
        for (const timing of t.timings || [])
          if (timing.status === 'running') {
            timing.status = 'interrupted';
            timing.endedAt = new Date().toISOString();
          }
        this.patch(
          t,
          {
            status: t.saveAttemptedAt ? 'uncertain' : 'awaiting_user',
            error: {
              code: t.saveAttemptedAt ? 'save_uncertain' : 'paused',
              recovery: t.saveAttemptedAt ? 'readback' : 'inspect_form',
              message: '应用已重启，先核对原任务现场',
            },
          },
          t.saveAttemptedAt ? '应用已重启，请核对原商品草稿' : '应用已重启，继续时先检查原填写页',
        );
      }
  }
  start(ids: string[], restart = false) {
    if (this.active) throw new Error('默认浏览器正在执行，请等待当前任务结束');
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || new Set(ids).size !== ids.length)
      throw new Error('任务选择不正确');
    const tasks = ids.map((id) => this.task(id));
    if (tasks.some((t) => t.status === 'succeeded' || t.status === 'running'))
      throw new Error('所选任务已完成或正在执行');
    if (
      restart &&
      (tasks.length !== 1 ||
        tasks[0].saveAttemptedAt ||
        tasks[0].error?.recovery !== 'restart_form')
    )
      throw new Error('此任务不能重新创建商品，请核对原草稿');
    this.active = true;
    this.stopping = false;
    // Release the script queue before diagnostics read the page. A callback may start a
    // new bounded recovery run; do not clear that new run's active flag afterwards.
    void this.batch(tasks, restart)
      .then(
        async (id) => {
          this.active = false;
          if (id && !this.stopping)
            await this.onStopped(
              id,
              tasks.slice(tasks.findIndex((t) => t.id === id) + 1).map((t) => t.id),
            );
        },
        (error) => {
          this.active = false;
          this.stopping = true;
          this.onFatal(error);
        },
      )
      .catch((error) => this.onFatal(error));
  }
  stop() {
    this.stopping = true;
  }
  clearRecords(ids: string[], cleared: boolean) {
    if (this.active) throw new Error('请等待当前执行结束，或暂停后再清理记录');
    this.store.setTasksCleared(ids, cleared);
  }
  confirmShop(id: string) {
    const t = this.task(id);
    if (this.active || t.status === 'succeeded') throw new Error('当前不能更新任务店铺');
    const shop = this.store.all<Shop>('shops').find((s) => s.id === t.shopId);
    if (!shop) throw new Error('店铺已不存在');
    if (t.saveAttemptedAt)
      throw new Error('已尝试保存的商品须使用原店铺账号回查，请在店铺管理恢复原账号');
    this.patch(
      t,
      {
        shopName: shop.name,
        shopSnapshot: { name: shop.name, account: shop.account, updatedAt: shop.updatedAt },
        error: undefined,
      },
      '运营已确认使用当前保存的店铺身份',
    );
  }
  updateProduct(id: string) {
    const t = this.task(id);
    if (this.active || t.status === 'succeeded' || t.saveAttemptedAt)
      throw new Error('已保存或正在执行的任务不能更换商品快照');
    const product = this.store
      .all<Task['productSnapshot']>('products')
      .find((p) => p.id === t.productSnapshot.id);
    if (!product) throw new Error('原商品资料已不存在');
    const issues = problems(product);
    if (issues.length) throw new Error(issues.join('；'));
    assertNoActiveTask(this.store.all<Task>('tasks'), t.shopId, [product.code], t.id);
    this.patch(
      t,
      {
        productSnapshot: structuredClone(product),
        code: product.code,
        title: product.title,
        backendChecks: initialChecks(),
        error: t.goodsId
          ? {
              code: 'form_changed',
              message: '资料已更新，重新开始前先核对旧商品是否已保存',
              recovery: 'restart_form',
            }
          : undefined,
      },
      '运营已将已保存的最新版商品资料用于此任务',
    );
  }
  private async timed<T>(
    t: Task,
    name: string,
    work: () => Promise<T>,
    step?: TaskStep,
  ): Promise<T> {
    const start = performance.now();
    const timing: StepTiming = {
      name,
      step,
      attempt: t.attempt || 1,
      startedAt: new Date().toISOString(),
      status: 'running',
    };
    this.patch(t, {
      timings: [...(t.timings || []), timing],
      phase: name,
      ...(step
        ? { checkpoint: { step, state: 'running' as const, updatedAt: new Date().toISOString() } }
        : {}),
    });
    try {
      const value = await work();
      timing.status = 'done';
      return value;
    } catch (error) {
      timing.status = 'failed';
      throw error;
    } finally {
      timing.endedAt = new Date().toISOString();
      timing.durationMs = Math.round(performance.now() - start);
      this.patch(
        t,
        step && timing.status === 'done'
          ? { checkpoint: { step, state: 'done', updatedAt: new Date().toISOString() } }
          : {},
      );
    }
  }
  private preflight(t: Task): Shop {
    const shop = this.store.all<Shop>('shops').find((s) => s.id === t.shopId);
    if (!shop) throw new ExecutionError('shop_changed', '任务对应店铺已不存在', 'confirm_shop');
    if (
      t.shopSnapshot &&
      (t.shopSnapshot.name !== shop.name || t.shopSnapshot.account !== shop.account)
    )
      throw new ExecutionError(
        'shop_changed',
        '保存的店铺账号已改变，请先核对任务店铺',
        'confirm_shop',
      );
    if (!t.shopSnapshot) {
      if (shop.name !== t.shopName)
        throw new ExecutionError(
          'shop_changed',
          '原任务店铺名称与当前配置不同，请核对',
          'confirm_shop',
        );
      this.patch(
        t,
        { shopSnapshot: { name: shop.name, account: shop.account, updatedAt: shop.updatedAt } },
        '旧任务已补录店铺身份，执行时仍核对后台实际身份',
      );
    }
    if (t.saveAttemptedAt) return shop;
    const issues = problems(t.productSnapshot);
    if (!t.productSnapshot.freight) issues.push('请补充目标店铺运费模板');
    const dimensions = t.productSnapshot.skus[0]?.options || [];
    if (dimensions.length) {
      const combinations = dimensions.reduce(
        (count, _, i) =>
          count * new Set(t.productSnapshot.skus.map((s) => s.options?.[i]?.value)).size,
        1,
      );
      if (combinations !== t.productSnapshot.skus.length)
        issues.push('规格须填写后台生成的全部组合，请补全 Excel');
    }
    if (issues.length)
      throw new ExecutionError('invalid_product', issues.join('；'), 'edit_product', false);
    for (const name of [
      ...t.productSnapshot.main,
      ...t.productSnapshot.detail,
      ...t.productSnapshot.skus.map((s) => s.image).filter(Boolean),
    ] as string[]) {
      const a = t.productSnapshot.images[name];
      if (!a || !fs.existsSync(path.join(this.directory, 'assets', a.id)))
        throw new ExecutionError('invalid_product', `图片资源缺失：${name}`, 'edit_product', false);
    }
    return shop;
  }
  private async batch(tasks: Task[], restart: boolean) {
    let connected = false;
    let stoppedId: string | undefined;
    for (const t of tasks) {
      if (this.stopping) break;
      const start = performance.now();
      this.patch(
        t,
        {
          status: 'running',
          startedAt: new Date().toISOString(),
          completedAt: undefined,
          attempt: (t.attempt || 0) + 1,
          runElapsedMs: undefined,
          error: undefined,
          backendChecks: initialChecks(),
        },
        '开始执行原任务',
      );
      const context: ExecutionContext = {
        patch: (v, m) => this.patch(t, v, m),
        step: (name, work, step) => this.timed(t, name, work, step),
        guard: () => {
          if (this.stopping)
            throw new ExecutionError('paused', '执行已暂停，可继续原任务', 'inspect_form');
        },
      };
      try {
        const shop = this.preflight(t);
        await this.adapter.execute(t, shop, context, connected, restart);
        connected = true;
      } catch (error) {
        const failure = classifyError(error, t);
        const message = failure.message.slice(0, 500);
        this.patch(
          t,
          {
            status: t.saveAttemptedAt
              ? 'uncertain'
              : failure.code === 'invalid_product'
                ? 'failed'
                : 'awaiting_user',
            error: {
              code: failure.code,
              message,
              recovery: failure.recovery,
              ...(failure.details ? { details: failure.details } : {}),
            },
          },
          message,
        );
        if (failure.details) this.patch(t, {}, `规格诊断记录：${JSON.stringify(failure.details)}`);
        if (failure.stopBatch) {
          stoppedId = t.id;
          break;
        }
      } finally {
        this.patch(t, {
          completedAt: new Date().toISOString(),
          runElapsedMs: Math.round(performance.now() - start),
        });
      }
    }
    return stoppedId;
  }
}

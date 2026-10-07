import { PddAdapter } from './pdd-adapter';
import { TaobaoAdapter } from './taobao-adapter';
import { requireEnabledPlatform, platformMeta, type PlatformId } from '../../src/platforms';
import type { PlatformAdapter } from '../execution';
import type { PageFacts, PageRecovery, RecoveryResult } from '../agent-service';
import type { Shop, ShopLoginEvent, Task } from '../../src/types';

/**
 * 一个平台的运行时：执行器、登录核对、可选的页面诊断与恢复。
 * 平台之间互不共享选择器或页面脚本。
 */
export type PlatformRuntime = {
  id: PlatformId;
  portal: string;
  adapter: PlatformAdapter;
  verifyLogin(
    shop: Shop,
    mode: 'relogin' | 'check',
    onEvent: (event: ShopLoginEvent) => void,
  ): Promise<void>;
  inspectDiagnosis(task: Task, shop: Shop): Promise<PageFacts>;
  recoverPage(task: Task, shop: Shop, action: PageRecovery): Promise<RecoveryResult>;
};

export class PlatformRegistry {
  private readonly runtimes: Record<PlatformId, PlatformRuntime>;
  constructor(userDataDirectory: string, decrypt: (shop: Shop) => Promise<string>) {
    const pdd = new PddAdapter(userDataDirectory, decrypt);
    const taobao = new TaobaoAdapter(userDataDirectory, decrypt);
    this.runtimes = {
      pdd: {
        id: 'pdd',
        portal: platformMeta('pdd').portal,
        adapter: pdd,
        verifyLogin: (shop, mode, onEvent) => pdd.verifyLogin(shop, mode, onEvent),
        inspectDiagnosis: (task, shop) => pdd.inspectDiagnosis(task, shop),
        recoverPage: (task, shop, action) => pdd.recoverPage(task, shop, action),
      },
      taobao: {
        id: 'taobao',
        portal: platformMeta('taobao').portal,
        adapter: taobao,
        verifyLogin: (shop, mode, onEvent) => taobao.verifyLogin(shop, mode, onEvent),
        inspectDiagnosis: (task, shop) => taobao.inspectDiagnosis(task, shop),
        recoverPage: (task, shop, action) => taobao.recoverPage(task, shop, action),
      },
    };
  }
  of(platform: unknown): PlatformRuntime {
    return this.runtimes[requireEnabledPlatform(platform).id];
  }
  forShop(shop: Pick<Shop, 'platform'> | undefined): PlatformRuntime {
    return this.of(shop?.platform);
  }
  /** 任务执行器按店铺当前平台取适配器。 */
  adapterFor(shop: Pick<Shop, 'platform'>): PlatformAdapter {
    return this.forShop(shop).adapter;
  }
}

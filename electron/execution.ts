import type { BackendCheck, RecoveryAction, Shop, Task, TaskErrorCode, TaskStep } from '../src/types';

export class ExecutionError extends Error {
  constructor(public code:TaskErrorCode,message:string,public recovery:RecoveryAction='retry',public stopBatch=true,public details?:Record<string,unknown>){super(message);}
}
export interface ExecutionContext {
  patch(values:Partial<Task>,message?:string):void;
  step<T>(name:string,work:()=>Promise<T>,step?:TaskStep):Promise<T>;
  guard():void;
}
export interface PlatformAdapter {execute(task:Task,shop:Shop,context:ExecutionContext,reuseTab?:boolean,restart?:boolean):Promise<void>}
export function assertNoActiveTask(tasks:Task[],shopId:string,codes:string[],excludeId?:string){
  for(const task of tasks){
    if(task.clearedAt||task.id===excludeId||task.shopId!==shopId||!codes.includes(task.code))continue;
    if(task.agentDiagnosis?.status==='running')throw new Error(`商品 ${task.code}：Agent 正在处理，请等待处理结束`);
    if(task.status==='running')throw new Error(`商品 ${task.code}：正在执行，请等待当前任务结束`);
  }
}
export function initialChecks():BackendCheck[]{
  return [['identity','店铺与登录身份'],['basic','商品标题'],['category','商品类目'],['brand','品牌可选项'],['attributes','类目属性'],['skus','规格、价格、库存与编码'],['images','轮播图与详情图数量'],['shipping','发货承诺'],['freight','运费模板'],['services','售后承诺'],['discount','参考价与满件折扣']].map(([key,label])=>({key,label,status:'pending'} as BackendCheck)).concat([{key:'qualification',label:'品牌资质及最终发布校验',status:'not_checked',message:'本任务仅保存草稿，未执行最终发布审核'}]);
}
export function classifyError(error:unknown,t:Task):ExecutionError{
  if(error instanceof ExecutionError&&error.code==='shop_changed')return error;
  if(t.saveAttemptedAt)return new ExecutionError('save_uncertain',(error as Error).message||'请核对原草稿保存结果','readback',true,error instanceof ExecutionError?error.details:undefined);
  if(error instanceof ExecutionError)return error;
  return new ExecutionError('platform_changed',(error as Error).message||'后台页面变化，请核对后继续',t.goodsId?'inspect_form':'retry');
}
// Runtime diagnostics live in AgentService. Model output never executes in this adapter contract.

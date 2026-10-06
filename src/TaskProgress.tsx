import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Circle, LoaderCircle, Pause, Play, Store } from 'lucide-react';
import type { Product, Task, Workspace } from './types';
import { Modal } from './components';
import { AgentDiagnosis } from './AgentDiagnosis';
import { batchProgress, continuationIds, executionSteps, stepProgress, taskIsActive, taskStatusLabel } from './task-progress';

type Change = 'restart' | 'shop' | 'product';
export function TaskProgress({ data, ids, onClose, onWorkspace, onNotice, onEditProduct, onConfigureAgent, onBrowserSetup }: {
  data: Workspace; ids: string[]; onClose: () => void; onWorkspace: (workspace: Workspace) => void;
  onNotice: (message: string) => void; onEditProduct: (product: Product) => void;
  onConfigureAgent: () => void; onBrowserSetup: () => void;
}) {
  const batch = batchProgress(data.tasks, ids);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const task = batch.tasks.find(item => item.id === selectedId) || batch.current;
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<{ id: string; action: Change } | null>(null);
  const [diagnosisId, setDiagnosisId] = useState<string | null>(null);
  const globallyActive = data.tasks.some(taskIsActive);
  const activeId = batch.active?.id;
  useEffect(() => { if (activeId) setSelectedId(null); }, [activeId]);
  useEffect(() => {
    if (!batch.active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [!!batch.active]);
  const perform = async (work: () => Promise<Workspace>) => {
    if (busy) return; setBusy(true); setError('');
    try { onWorkspace(await work()); }
    catch (e) { const message = (e as Error).message; setError(message); if (message.includes('浏览器连接未就绪')) onBrowserSetup(); }
    finally { setBusy(false); }
  };
  const resume = (item: Task) => void perform(() => window.desktop.runTasks(continuationIds(batch.tasks, item)));
  const changeTask = confirm ? data.tasks.find(item => item.id === confirm.id) : undefined;
  const changeShop = data.shops.find(shop => shop.id === changeTask?.shopId);
  const changeProduct = data.products.find(product => product.id === changeTask?.productSnapshot.id);
  const edit = (item: Task) => { const product = data.products.find(p => p.id === item.productSnapshot.id); product ? onEditProduct(product) : setError('原商品资料不存在，请重新导入'); };
  const elapsed = task?.runElapsedMs ?? (task?.startedAt ? Math.max(0, now - Date.parse(task.startedAt)) : 0);
  const canAct = task && !globallyActive && task.status !== 'succeeded';
  return <><Modal title="商品执行进度" className="execution-modal" subtitle={`${batch.tasks[0]?.shopName || '目标店铺'} · 已保存 ${batch.completed} / ${batch.tasks.length} 件草稿`} onClose={onClose}
    footer={<><span className="footer-note">{batch.active ? '收起弹窗后会继续执行，可从主页再次打开。' : batch.finished ? '本次商品草稿均已保存。' : '处理入口在此窗口，历史原因保留在执行记录。'}</span>
      <div className="button-group"><button className="button" onClick={onClose}>{batch.active ? '收起进度' : '关闭'}</button>
        {batch.active ? <button className="button" disabled={busy} onClick={() => void perform(async () => { const result = await window.desktop.stopTasks(); onNotice('已请求暂停，当前操作完成后停止'); return result; })}><Pause size={15}/>暂停执行</button> : null}
        {canAct && !confirm && task.error?.recovery !== 'edit_product' && task.error?.recovery !== 'confirm_shop' && task.error?.recovery !== 'restart_form' ? <button className="button primary" disabled={busy} onClick={() => resume(task)}>{busy ? <LoaderCircle size={15} className="spin"/> : <Play size={15}/>} {task.saveAttemptedAt ? '核对保存结果' : task.status === 'prepared' ? '开始执行' : '继续执行'}</button> : null}
      </div></>}>
    <div className="execution-layout">
      <aside className="execution-products" aria-label="本次执行的商品"><p className="execution-queue-label">本次执行 · {batch.tasks.length} 件商品</p>
        <ol>{batch.tasks.map((item, index) => <li key={item.id}><button className={`execution-product ${task?.id === item.id ? 'selected' : ''}`} aria-pressed={task?.id === item.id} onClick={() => setSelectedId(item.id)}>
          <span className="execution-order">{item.status === 'succeeded' ? <CheckCircle2 size={17}/> : taskIsActive(item) ? <LoaderCircle size={17} className="spin"/> : index + 1}</span>
          <span><strong>{item.title}</strong><small>{taskStatusLabel(item)}</small></span></button></li>)}</ol>
      </aside>
      <section className="execution-detail" aria-label="商品当前进度">
        {task ? <>
          <div className="execution-current"><span className={`status ${task.status === 'succeeded' ? 'ready' : task.error ? 'warning' : 'neutral'}`}>{taskStatusLabel(task)}</span><span className="execution-duration">{task.startedAt ? `本次用时 ${(elapsed / 1000).toFixed(1)} 秒` : '尚未开始'}</span></div>
          <h3 className="execution-title">{task.title}</h3><p className="execution-code">{task.code}</p>
          <p className="execution-phase" role="status">{task.agentDiagnosis?.status === 'running' ? 'Agent 正在处理页面异常…' : task.phase || '准备执行'}</p>
          {task.error ? <div className="execution-problem" role="alert"><strong>此商品需要处理</strong><p>{task.error.message}</p>
            {!globallyActive ? <div className="execution-recovery">
              {task.error.code === 'browser_unavailable' ? <button className="button" disabled={busy} onClick={onBrowserSetup}>检查浏览器连接</button> : null}
              {task.error.recovery === 'edit_product' ? <><button className="button" disabled={busy} onClick={() => edit(task)}>编辑商品资料</button><button className="text-button" disabled={busy} onClick={() => setConfirm({ id: task.id, action: 'product' })}>使用已保存的新版资料</button></> :
                task.error.recovery === 'confirm_shop' ? <button className="button" disabled={busy} onClick={() => setConfirm({ id: task.id, action: 'shop' })}>核对店铺配置</button> :
                task.error.recovery === 'restart_form' ? <button className="button" disabled={busy} onClick={() => setConfirm({ id: task.id, action: 'restart' })}>重新开始填写</button> : null}
              <button className="text-button" disabled={busy} onClick={() => setDiagnosisId(task.id)}>Agent 诊断</button>
            </div> : null}
          </div> : null}
          {task.agentDiagnosis?.summary || task.agentDiagnosis?.error ? <p className="execution-agent">{task.agentDiagnosis.summary || task.agentDiagnosis.error}</p> : null}
          {task.result ? <div className="execution-result"><CheckCircle2 size={18}/><div><strong>后台草稿已保存并核对</strong><p>商品编号：{task.result.goodsId} · {task.result.status}</p></div></div> : null}
          <ol className="execution-steps" aria-label="商品执行步骤">{executionSteps.map(({ step, label }) => {
            const timing = stepProgress(task, step); const state = timing?.status || 'pending';
            const duration = timing?.durationMs ?? (timing?.status === 'running' ? Math.max(0, now - Date.parse(timing.startedAt)) : undefined);
            return <li key={step} className={`execution-step ${state}`}><span className="execution-step-icon">{state === 'done' ? <CheckCircle2 size={16}/> : state === 'running' ? <LoaderCircle size={16} className="spin"/> : state === 'failed' || state === 'interrupted' ? <AlertCircle size={16}/> : <Circle size={13}/>}</span><span>{label}</span><small>{state === 'pending' ? '待执行' : state === 'running' ? '进行中' : state === 'done' ? '已完成' : state === 'failed' ? '未完成' : '已暂停'}{duration !== undefined ? ` · ${(duration / 1000).toFixed(1)} 秒` : ''}</small></li>;
          })}</ol>
        </> : <p>本次执行记录已清理，可到执行记录恢复。</p>}
        {error ? <div className="error-message" role="alert">{error}</div> : null}
      </section>
    </div>
  </Modal>
    {changeTask && confirm ? <Modal title={confirm.action === 'restart' ? '重新开始填写' : confirm.action === 'shop' ? '核对店铺配置' : '更新商品资料'} onClose={() => { setConfirm(null); setError(''); }} busy={busy}
      footer={<><button className="button" disabled={busy} onClick={() => { setConfirm(null); setError(''); }}>取消</button><button className="button primary" disabled={busy || globallyActive || (confirm.action === 'shop' && (!changeShop || !!changeTask.saveAttemptedAt)) || (confirm.action === 'product' && !changeProduct)} onClick={() => void perform(async () => {
        if (confirm.action === 'restart') { const result = await window.desktop.restartTask(changeTask.id); setConfirm(null); return result; }
        const result = await (confirm.action === 'shop' ? window.desktop.confirmTaskShop(changeTask.id) : window.desktop.updateTaskProduct(changeTask.id)); setConfirm(null); return result;
      })}>{busy ? '正在处理…' : confirm.action === 'restart' ? '核对旧草稿并重新填写' : '确认更新'}</button></>}>
      <div className="modal-body recovery-body">{confirm.action === 'restart' ? <><p>原商品编号：{changeTask.goodsId}</p><p>先查询原草稿。确认未保存后，才重新创建填写页；旧编号和记录保留。</p></> : confirm.action === 'shop' ? <><p>原店铺：{changeTask.shopSnapshot?.name || changeTask.shopName}</p><p>当前店铺：{changeShop?.name || '店铺不存在'}</p><p>确认后使用当前保存的店铺配置，执行时仍核对实际登录身份。</p></> : <><p>更新为已保存资料：{changeProduct?.title || '原商品已不存在'}</p><p>原填写页已有编号时，重新填写前先核对旧草稿。</p></>}{error ? <div className="error-message" role="alert">{error}</div> : null}</div>
    </Modal> : null}
    {diagnosisId && data.tasks.find(item => item.id === diagnosisId) ? <AgentDiagnosis task={data.tasks.find(item => item.id === diagnosisId)!} onClose={() => setDiagnosisId(null)} onWorkspace={onWorkspace} onConfigure={onConfigureAgent} onEditProduct={() => edit(data.tasks.find(item => item.id === diagnosisId)!)}/> : null}
  </>;
}

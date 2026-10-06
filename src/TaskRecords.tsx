import { useState } from 'react';
import { ClipboardList, RotateCcw, Trash2 } from 'lucide-react';
import type { Workspace } from './types';
import { taskIsActive, taskIsHistory, taskStatusLabel } from './task-progress';

export function TaskRecords({ data, onWorkspace, onNotice, onOpenProgress }: {
  data: Workspace; onWorkspace: (workspace: Workspace) => void; onNotice: (message: string) => void; onOpenProgress: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [clearedView, setClearedView] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const running = data.tasks.some(taskIsActive);
  const records = data.tasks.filter(task => !task.clearedAt && taskIsHistory(task));
  const clearedRecords = data.tasks.filter(task => !!task.clearedAt && taskIsHistory(task));
  const visibleTasks = clearedView ? clearedRecords : records;
  const selectedIds = visibleTasks.filter(task => selected.has(task.id)).map(task => task.id);
  const changeRecords = async (ids: string[], restore = false) => {
    if (busy) return; setBusy(true);
    try {
      onWorkspace(await (restore ? window.desktop.restoreTaskRecords(ids) : window.desktop.clearTaskRecords(ids)));
      setSelected(new Set()); onNotice(restore ? `已恢复 ${ids.length} 条记录` : `已清理 ${ids.length} 条记录，可在“已清理”中恢复`);
    } catch (error) { onNotice((error as Error).message); }
    finally { setBusy(false); }
  };
  return <><div className="records-toolbar">
    <div className="filters" aria-label="执行记录分类">
      <button className={!clearedView ? 'active' : ''} aria-pressed={!clearedView} disabled={busy} onClick={() => { setClearedView(false); setSelected(new Set()); }}>执行记录<span>{records.length}</span></button>
      <button className={clearedView ? 'active' : ''} aria-pressed={clearedView} disabled={busy} onClick={() => { setClearedView(true); setSelected(new Set()); }}>已清理<span>{clearedRecords.length}</span></button>
    </div><div className="records-actions">
      <button className="button" disabled={busy || running || !selectedIds.length} onClick={() => void changeRecords(selectedIds, clearedView)}>{clearedView ? <RotateCcw size={15}/> : <Trash2 size={15}/>} {clearedView ? '恢复所选' : '清理所选'}{selectedIds.length ? `（${selectedIds.length}）` : ''}</button>
      <button className="text-button" disabled={busy || running || !visibleTasks.length} onClick={() => void changeRecords(visibleTasks.map(task => task.id), clearedView)}>{clearedView ? '恢复全部' : '清理全部'}</button>
    </div>
  </div><p className="records-hint">清理记录保留商品资料、店铺和后台草稿，可在“已清理”中恢复。{running ? '当前正在执行，结束或暂停后可清理。' : ''}</p>
    {visibleTasks.length ? <label className="records-select-all"><input type="checkbox" aria-label={clearedView ? '选择全部已清理记录' : '选择全部执行记录'} checked={selectedIds.length === visibleTasks.length} disabled={busy || running} onChange={event => setSelected(event.target.checked ? new Set(visibleTasks.map(task => task.id)) : new Set())}/>{selectedIds.length ? `已选 ${selectedIds.length} 条记录` : '全选记录'}</label> : null}
    <div className="task-list">{visibleTasks.length ? visibleTasks.map(task => <article className="task-row" key={task.id}>
      <input className="record-checkbox" type="checkbox" aria-label={`选择记录 ${task.title} ${task.id.slice(0, 8)}`} checked={selected.has(task.id)} disabled={busy || running} onChange={event => setSelected(old => { const next = new Set(old); event.target.checked ? next.add(task.id) : next.delete(task.id); return next; })}/>
      <span className="task-symbol"><ClipboardList size={20}/></span>
      <div className="task-detail"><h3>{task.title}</h3><p>{task.shopName} <span>·</span> {task.code}</p>{task.error && task.phase ? <p>停止步骤：{task.phase}</p> : null}
        {task.error ? <p className="task-error">失败原因：{task.error.message}</p> : null}
        {task.agentDiagnosis ? <details><summary>查看 Agent 处理原因</summary><p>{task.agentDiagnosis.summary || task.agentDiagnosis.error || '尚无处理结论'}</p>{task.agentDiagnosis.operations?.map((operation, i) => <p key={i}>{operation.name} · {operation.ok ? '完成' : '未完成'} · {operation.message}</p>)}</details> : null}
        {task.result ? <p className="task-result">商品 ID：{task.result.goodsId} · 后台状态：{task.result.status}</p> : null}
        {task.backendChecks?.length ? <details><summary>查看资料核验</summary><div className="table-scroll"><table className="timing-table checks-table"><thead><tr><th>项目</th><th>结果</th><th>依据</th></tr></thead><tbody>{task.backendChecks.map((check, i) => <tr key={check.key || i}><td>{check.label}</td><td>{({ pending: '待核验', passed: '已核对', failed: '不一致', not_checked: '未执行', not_applicable: '不适用' } as const)[check.status]}</td><td>{check.message || '此步骤尚未完成'}{check.checkedAt ? <small>{check.stage === 'saved' ? '草稿读回' : '填写页核对'} · {new Date(check.checkedAt).toLocaleTimeString('zh-CN')}</small> : null}</td></tr>)}</tbody></table></div></details> : null}
        {task.timings?.length ? <details><summary>查看分步耗时</summary><div className="table-scroll"><table className="timing-table"><thead><tr><th>次数</th><th>步骤</th><th>耗时</th><th>结果</th></tr></thead><tbody>{task.timings.map((timing, i) => <tr key={i}><td>{timing.attempt}</td><td>{timing.name}</td><td>{timing.durationMs !== undefined ? `${(timing.durationMs / 1000).toFixed(2)} 秒` : '—'}</td><td>{({ running: '执行中', done: '完成', failed: '失败', interrupted: '中断' } as const)[timing.status]}</td></tr>)}</tbody></table></div></details> : null}
        {task.logs?.length ? <details><summary>查看执行过程</summary><ol>{task.logs.map((log, i) => <li key={i}>{new Date(log.time).toLocaleTimeString('zh-CN')} {log.message}</li>)}</ol></details> : null}
      </div>
      <div className="task-meta"><span className={`status ${task.status === 'succeeded' ? 'ready' : task.error ? 'warning' : 'neutral'}`}>{taskStatusLabel(task)}</span><time>{new Date(task.time).toLocaleString('zh-CN')}</time>
        {task.runElapsedMs !== undefined ? <span className="cell-detail">本次用时 {(task.runElapsedMs / 1000).toFixed(2)} 秒</span> : null}
        {clearedView ? <><time>清理于 {new Date(task.clearedAt!).toLocaleString('zh-CN')}</time><button className="button" disabled={busy || running} onClick={() => void changeRecords([task.id], true)}><RotateCcw size={14}/>恢复记录</button></> : <><button className="button" onClick={() => onOpenProgress(task.id)}>在主页打开任务</button><button className="text-button" disabled={busy || running} onClick={() => void changeRecords([task.id])}><Trash2 size={14}/>清理记录</button></>}
        {task.evidence ? <button className="text-button" onClick={() => { void window.desktop.openEvidence(task.id).catch(error => onNotice(error.message)); }}>查看保存截图</button> : null}
      </div>
    </article>) : <div className="empty records-empty"><ClipboardList size={30}/><h3>{clearedView ? '没有已清理的记录' : '还没有历史结果'}</h3><p>{clearedView ? '清理后的记录会保留在这里，随时可以恢复。' : clearedRecords.length ? '可切换到“已清理”恢复记录，也可以到商品资料重新执行。' : '执行结束或暂停后，历史结果会显示在这里；当前进度在主页查看。'}</p></div>}</div>
  </>;
}

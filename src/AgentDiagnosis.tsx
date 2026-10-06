import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Modal } from './components';
import type { AgentConfig, AgentAction, Task, Workspace } from './types';
const labels:Record<AgentAction,string>={edit_product:'核对并编辑商品资料',resume:'继续原任务',readback:'核对原草稿保存结果',manual:'在后台人工核对'};
export function AgentDiagnosis({task,onClose,onWorkspace,onEditProduct,onConfigure}:{task:Task;onClose:()=>void;onWorkspace:(w:Workspace)=>void;onEditProduct:()=>void;onConfigure:()=>void}){
  const [config,setConfig]=useState<AgentConfig|null>(null),[includePage,setIncludePage]=useState(task.agentDiagnosis?.pageRequested??false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[selected,setSelected]=useState<number|null>(null);
  const loginStage=!task.goodsId&&task.checkpoint?.step==='login';
  const d=task.agentDiagnosis;const active=busy||d?.status==='running';
  const scopeChanged=!!d&&d.pageRequested!==includePage;
  useEffect(()=>{let alive=true;void window.desktop.agentConfig().then(c=>{if(alive)setConfig(c);}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[]);
  const diagnose=async()=>{if(active)return;setBusy(true);setError('');setSelected(null);try{onWorkspace(await window.desktop.diagnoseTask({id:task.id,includePage}));}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const confirm=async()=>{
    if(!d||selected===null||active)return;const p=d.proposals?.[selected];if(!p)return;
    if(p.action==='edit_product'){onClose();onEditProduct();return;}
    if(p.action==='manual'){onClose();return;}
    setBusy(true);setError('');try{onWorkspace(await window.desktop.confirmAgentAction({id:task.id,diagnosisId:d.id,proposalIndex:selected}));onClose();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  return <Modal title="Agent 异常诊断" subtitle={task.title} onClose={onClose} busy={!!active} wide
    footer={<><span className="footer-note">页面异常自动处理；商品资料由运营修改</span><div className="button-group"><button className="button" disabled={!!active} onClick={onClose}>关闭</button><button className={`button ${selected===null?'primary':''}`} disabled={!!active||!config?.baseUrl||!config.model} onClick={()=>void diagnose()}>{active?<LoaderCircle size={15} className="spin"/>:null}{active?'正在处理…':d?'重新诊断':'开始诊断'}</button>{selected!==null&&d?.status==='done'&&!d.automaticAction?<button className="button primary" disabled={!!active||scopeChanged} onClick={()=>void confirm()}>确认：{labels[d.proposals![selected].action]}</button>:null}</div></>}>
    <div className="modal-body agent-diagnosis">
      <section className="agent-scope"><h3>新诊断的发送范围</h3><p>{loginStage?'发送登录状态、页面结构和店铺核对结果，用于分析登录为何停住。不会发送账号密码或商品资料。':'发送此商品的字段、规格价格库存、承诺、异常与核验结果，用于分析当前问题。'}</p>{config?.baseUrl?<p className="agent-endpoint">新诊断使用接口：{config.baseUrl} · 模型：{config.model||'未填写'}</p>:<p>请先配置模型接口。<button className="text-button" onClick={()=>{onClose();onConfigure();}}>打开模型设置</button></p>}
      <label className="agent-checkbox"><input type="checkbox" checked={includePage} disabled={!!active} onChange={e=>{setIncludePage(e.target.checked);setSelected(null);}}/>{loginStage?'允许读取已连接浏览器的登录状态与店铺核对结果':'允许读取已连接浏览器中该商品原填写页的字段与已显示选项'}</label><small>{loginStage?'只检查拼多多页面的登录状态和匹配结果，不读取密码、完整账号或页面正文。':'只读取已核对店铺及商品编号的原页面。页面未打开时会说明限制。'}</small>{scopeChanged?<p className="agent-scope-changed" role="status">读取范围已改变，请重新诊断后选择建议。</p>:null}</section>
      <div className="agent-current-error"><strong>当前任务问题</strong><p>{task.error?.message||task.message}</p></div>
      {active?<p className="agent-progress" role="status"><LoaderCircle size={18} className="spin"/>{loginStage?'Agent 正在核对登录状态；确认店铺一致后交回本机脚本继续。账号密码由本机处理。':d?.trigger==='automatic'?'Agent 正在核对现场，按需处理通知、等待页面或恢复原填写页。总处理限时约 120 秒。':'模型正在分析，需要时会调用只读工具。总诊断限时约 90 秒。'}</p>:null}
      {d?.status==='done'?<section className="agent-result"><h3>已保存的诊断建议</h3><p className="agent-endpoint">这份建议使用：{d.model} · {d.endpoint} · {new Date(d.startedAt).toLocaleString('zh-CN')}</p><p className="agent-summary">{d.summary}</p><p className="quiet-note">模型建议可能有误，请结合后台实际内容核对。</p>
        {d.automaticAction?<p className="agent-confirmation" role="status">已自动交回脚本：{labels[d.automaticAction]}。当前执行状态以任务记录为准。</p>:null}
        <fieldset className="agent-proposals" disabled={!!active||scopeChanged||!!d.automaticAction}><legend className="sr-only">选择处理建议</legend>{d.proposals?.map((p,i)=><label key={i} className={`agent-proposal ${selected===i?'selected':''}`}><input type="radio" name="agent-proposal" checked={selected===i} onChange={()=>setSelected(i)}/><div><strong>{labels[p.action]}</strong><p>{p.reason}</p><ul>{p.evidence.map((e,j)=><li key={j}>{e}</li>)}</ul></div></label>)}</fieldset>
        {selected!==null?<div className="agent-confirmation" role="status">{d.proposals![selected].action==='edit_product'?'确认后打开商品资料，由你核对并保存修改。随后需更新原任务商品资料，再继续。':d.proposals![selected].action==='manual'?'请按建议到已连接浏览器处理。关闭诊断后，使用原任务的核对或继续入口。':`确认后将${labels[d.proposals![selected].action]}，继续遵守原店铺核对和草稿保存限制。`}</div>:null}
      </section>:null}
      {d?.operations?.length?<section className="agent-operations"><h3>Agent 页面处理记录</h3><ul>{d.operations.map((op,i)=><li key={i}>{op.ok?'已完成':'未完成'} · {op.message} · {(op.durationMs/1000).toFixed(2)} 秒</li>)}</ul></section>:null}
      {d?.status==='failed'||d?.status==='interrupted'?<div className="error-message" role="alert">{d.error}</div>:null}
      {d&&d.status!=='running'?<details className="agent-audit"><summary>查看诊断来源与耗时</summary><p>模型：{d.model} · 接口：{d.endpoint}</p><p>诊断耗时：{d.durationMs!==undefined?`${(d.durationMs/1000).toFixed(2)} 秒`:'未记录'}{d.tokens?` · ${d.tokens} tokens`:''} · 与填写耗时分别记录</p><ul>{d.sources.map((s,i)=><li key={i}>{s}</li>)}</ul></details>:null}
      {error?<div className="error-message" role="alert">{error}</div>:null}
    </div>
  </Modal>;
}

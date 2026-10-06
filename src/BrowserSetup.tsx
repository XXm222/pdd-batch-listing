import { useState } from 'react';
import { AlertCircle, CheckCircle2, Copy, Download, ExternalLink, FileText, LoaderCircle, RefreshCw } from 'lucide-react';
import { Modal } from './components';
import type { BrowserConnectionStatus } from './types';

type BrowserSetupProps = {
  status: BrowserConnectionStatus | null;
  checking: boolean;
  onCheck: () => Promise<void>;
  onClose: () => void;
};

export function BrowserSetup({ status, checking, onCheck, onClose }: BrowserSetupProps) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [folder, setFolder] = useState('');
  const ready = status?.state === 'ready';
  const showInstallSteps = !status || status.state === 'extension_disconnected';
  const locked = checking || !!busy;
  const connectionTitle = checking ? '正在检测浏览器连接…' : ready ? '浏览器已连接，可以开始填写商品' : status?.state === 'service_unavailable' ? '本机连接服务暂时不可用' : status?.state === 'version_mismatch' ? '连接服务与扩展版本不匹配' : status?.state === 'unsupported' ? '当前电脑暂不支持内置连接服务' : status ? '浏览器扩展尚未连接' : '先检测浏览器连接';
  const connectionHelp = checking ? '请保持浏览器打开。' : ready ? '以后保持浏览器和商品运营台打开即可，不需要重复安装。' : status?.state === 'extension_disconnected' ? '可能未安装、未开启扩展，或浏览器还没打开。已安装过的话，先打开浏览器再点“重新检测”。' : status?.state === 'service_unavailable' ? '暂时无法确认扩展是否已安装。请先重新检测，仍失败时重启商品运营台。' : status?.state === 'version_mismatch' ? '请打开下方的 Kimi 官方说明，联系管理员处理配套版本。商品运营台不会自动升级或重启已经运行的连接服务。' : status?.state === 'unsupported' ? '目前内置连接服务支持 Mac（Apple 芯片或 Intel 芯片）和 Windows x64。请联系管理员确认这台电脑的安装版本。' : '安装前可以先检测，已连接就无需重复安装。';

  const perform = async (kind: string, action: () => Promise<void>, message = '') => {
    if (locked) return;
    setBusy(kind); setError(''); setFeedback('');
    try { await action(); if (message) setFeedback(message); }
    catch (e) { setError(e instanceof Error ? e.message : '操作未完成，请重试。'); }
    finally { setBusy(''); }
  };

  const exportExtension = async () => {
    await perform('export', async () => {
      const result = await window.desktop.exportBrowserExtension();
      setFolder(result.folder);
      setFeedback('已打开上一级目录，并选中“Kimi浏览器扩展”文件夹。到浏览器加载扩展时，选择这个文件夹。');
    });
  };

  return <Modal title="连接日常使用的浏览器" subtitle="任务会在已连接 Kimi 扩展的浏览器中打开。要用系统默认浏览器，请先在该浏览器安装并连接扩展。" onClose={onClose} busy={!!busy}
    footer={<><span className="footer-note">安装时保持商品运营台打开</span><div className="button-group"><button className="button" onClick={onClose} disabled={!!busy}>{ready ? '完成' : showInstallSteps ? '稍后再装' : '关闭'}</button><button className="button primary" disabled={locked} onClick={() => void perform('check', onCheck)}>{checking || busy === 'check' ? <LoaderCircle size={15} className="spin" aria-hidden="true"/> : <RefreshCw size={15} aria-hidden="true"/>}{checking || busy === 'check' ? '正在检测…' : '重新检测'}</button></div></>}>
    <div className="modal-body browser-setup">
      <section className={`browser-connection-state ${ready && !checking ? 'connected' : ''}`} aria-live="polite" aria-atomic="true">
        {checking ? <LoaderCircle size={20} className="spin" aria-hidden="true"/> : ready ? <CheckCircle2 size={20} aria-hidden="true"/> : <AlertCircle size={20} aria-hidden="true"/>}
        <div><h3>{connectionTitle}</h3><p>{connectionHelp}</p>{!checking && status?.extensionVersion ? <small>扩展版本 {status.extensionVersion}</small> : null}{!checking && status?.message && status.state !== 'ready' && status.state !== 'extension_disconnected' ? <small>{status.message}</small> : null}</div>
      </section>

      <details className="browser-install-guide" open={showInstallSteps}>
        <summary>{ready ? '查看安装步骤或更换浏览器' : showInstallSteps ? '首次安装，按这 4 步操作' : '查看首次安装步骤'}</summary>
        <ol className="browser-install-steps">
          <li><span className="browser-step-number" aria-hidden="true">1</span><div><h3>打开你的 Chrome 或 Edge 浏览器</h3><p>在平时登录店铺的浏览器中安装。使用多个浏览器账号时，选平时操作店铺的那个。</p></div></li>
          <li><span className="browser-step-number" aria-hidden="true">2</span><div><h3>取出 App 自带的安装文件</h3><p>App 会准备好安装文件，并在上一级目录中选中“Kimi浏览器扩展”文件夹，不用自己解压。</p><button className="button" disabled={locked} onClick={() => void exportExtension()}>{busy === 'export' ? <LoaderCircle size={15} className="spin" aria-hidden="true"/> : <Download size={15} aria-hidden="true"/>}{busy === 'export' ? '正在准备…' : folder ? '再次定位扩展文件夹' : '打开上一级并选中文件夹'}</button> <button className="button" disabled={locked} onClick={() => void perform('folder-path', async () => { const result = await window.desktop.copyBrowserExtensionPath(); setFolder(result.folder); }, '扩展文件夹路径已复制。在浏览器选择文件夹的窗口中粘贴此路径即可。')}><Copy size={14} aria-hidden="true"/>复制文件夹路径</button>{folder ? <p className="browser-install-path">安装文件夹：<span>{folder}</span><small>请保留这个文件夹，移走或删除会让扩展无法使用。</small></p> : null}</div></li>
          <li><span className="browser-step-number" aria-hidden="true">3</span><div><h3>在浏览器中加载扩展</h3><p>复制对应地址，粘贴到浏览器地址栏打开。</p><div className="browser-extension-pages"><button className="button" disabled={locked} onClick={() => void perform('chrome', () => window.desktop.copyExtensionPage('chrome'), 'Chrome 扩展管理页地址已复制，请粘贴到 Chrome 地址栏打开。')}><Copy size={14} aria-hidden="true"/>复制 Chrome 扩展页</button><button className="button" disabled={locked} onClick={() => void perform('edge', () => window.desktop.copyExtensionPage('edge'), 'Edge 扩展管理页地址已复制，请粘贴到 Edge 地址栏打开。')}><Copy size={14} aria-hidden="true"/>复制 Edge 扩展页</button></div><p>打开“开发者模式” → 点击“加载已解压的扩展程序” → 选择上一步选中的“Kimi浏览器扩展”文件夹。</p><p className="browser-install-tip">也可以粘贴刚复制的文件夹路径：Mac 按 ⌘⇧G，Windows 在地址栏粘贴。要选择含 manifest.json 的文件夹，不要选择 ZIP 压缩包。已连接的扩展无需重装。</p></div></li>
          <li><span className="browser-step-number" aria-hidden="true">4</span><div><h3>回到这里，点击“重新检测”</h3><p>扩展默认自动连接。安装后点击“重新检测”，显示“浏览器已连接”即可使用；仍未连接时，再查看下方的设置说明。</p></div></li>
        </ol>
      </details>

      {!ready?<details className="browser-install-guide"><summary>仍未连接？检查扩展设置</summary><p className="quiet-note">先确认浏览器已打开、扩展已启用。扩展默认会自动连接本机服务；若仍未连接，在扩展设置的“本地 agent 远程控制”栏目下检查“连接地址”。</p><p className="quiet-note">默认地址无需手动填写。若之前断开过连接或改过设置，且 App 使用默认端口 10086，可在“连接地址”中点击“恢复默认”后重新检测。仅在 App 使用其他端口时，才需复制下面的地址。</p><div className="browser-address"><code>{status?.wsAddress || '检测后显示本机连接地址'}</code><button className="button" disabled={locked || !status?.wsAddress} onClick={() => void perform('address', () => window.desktop.copyBridgeAddress(), '本机连接地址已复制。')}><Copy size={14} aria-hidden="true"/>复制连接地址</button></div></details>:null}

      <div className="browser-guide-links"><button className="text-button" disabled={locked} onClick={() => void perform('guide', () => window.desktop.openBrowserGuide())}><FileText size={15} aria-hidden="true"/>打开完整安装教程</button><button className="text-button" disabled={locked} onClick={() => void perform('help', () => window.desktop.openBrowserHelp())}><ExternalLink size={15} aria-hidden="true"/>Kimi 官方说明</button></div>
      {error ? <div className="error-message" role="alert">{error}</div> : null}
      {feedback ? <p className="browser-setup-feedback" role="status">{feedback}</p> : null}
    </div>
  </Modal>;
}

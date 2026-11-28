import {
  Download,
  FolderOpen,
  Globe,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import type { BrowserConnectionStatus, UpdateState } from './types';

const BROWSER_TEXT: Record<BrowserConnectionStatus['state'], string> = {
  ready: '已连接，可以开始执行任务',
  extension_disconnected: '浏览器插件没有连上，点「连接教程」按步骤装一次',
  service_unavailable: '本机的桥接服务没起来，点「重新检测」',
  version_mismatch: '插件与本机服务版本不一致，点「连接教程」看升级步骤',
  unsupported: '当前的浏览器不受支持，请用 Chrome 或 Edge',
};

type Props = {
  browserStatus: BrowserConnectionStatus | null;
  checkingBrowser: boolean;
  version: string;
  updateState: UpdateState | null;
  encryptionAvailable: boolean;
  onCheckBrowser: () => void;
  onBrowserSetup: () => void;
  onAgentSettings: () => void;
  onUpdates: () => void;
  onDataFolder: () => void;
};

export function Settings({
  browserStatus,
  checkingBrowser,
  version,
  updateState,
  encryptionAvailable,
  onCheckBrowser,
  onBrowserSetup,
  onAgentSettings,
  onUpdates,
  onDataFolder,
}: Props) {
  const ready = browserStatus?.state === 'ready';
  const state = browserStatus?.state;
  const browserText = checkingBrowser
    ? '正在检测…'
    : !browserStatus
      ? '还没检测过浏览器连接'
      : BROWSER_TEXT[state!];
  const updateText =
    updateState?.status === 'available' && updateState.release
      ? `发现新版本 ${updateState.release.version}`
      : updateState?.status === 'downloading'
        ? `正在下载 ${Math.round(updateState.received / 1024 / 1024)} MB`
        : updateState?.status === 'ready'
          ? '新版本已下载，可以安装'
          : updateState?.status === 'error'
            ? '检查更新失败，重试一次或直接下载安装包'
            : '当前已是最新版';

  return (
    <section className="settings" aria-label="设置">
      <div className="section-head">
        <div>
          <h2>设置</h2>
          <p>浏览器连接、模型、资料目录与版本，都在这一页。</p>
        </div>
      </div>

      <div className="settings-list">
        <article className="settings-card">
          <div className="settings-row">
            <span
              className={`breath ${ready ? 'on' : state ? 'warn' : 'off'}`}
              aria-hidden="true"
            />
            <div className="settings-copy">
              <h3>浏览器连接</h3>
              <p className={ready ? '' : 'quiet-note'}>{browserText}</p>
              {browserStatus?.serviceVersion || browserStatus?.extensionVersion ? (
                <p className="quiet-note">
                  本机服务 {browserStatus?.serviceVersion || '未知'} · 插件{' '}
                  {browserStatus?.extensionVersion || '未知'}
                </p>
              ) : null}
            </div>
            <div className="settings-actions">
              <button
                className="button"
                onClick={onCheckBrowser}
                disabled={checkingBrowser}
                type="button"
              >
                <RefreshCw size={14} aria-hidden="true" />
                {checkingBrowser ? '检测中…' : '重新检测'}
              </button>
              <button className="button" onClick={onBrowserSetup} type="button">
                <Globe size={14} aria-hidden="true" />
                连接教程
              </button>
            </div>
          </div>
        </article>

        <article className="settings-card">
          <div className="settings-row">
            <span className="settings-icon" aria-hidden="true">
              <SlidersHorizontal size={16} />
            </span>
            <div className="settings-copy">
              <h3>Agent 模型</h3>
              <p className="quiet-note">看页面、点按钮、读回字段的那个模型，在这里换。</p>
            </div>
            <div className="settings-actions">
              <button className="button" onClick={onAgentSettings} type="button">
                打开模型设置
              </button>
            </div>
          </div>
        </article>

        <article className="settings-card">
          <div className="settings-row">
            <span className="settings-icon" aria-hidden="true">
              <FolderOpen size={16} />
            </span>
            <div className="settings-copy">
              <h3>本机资料</h3>
              <p className="quiet-note">
                商品资料、店铺与执行记录都存在这台电脑的资料目录里，不经过服务器。
                {encryptionAvailable
                  ? '密码已用系统钥匙串加密。'
                  : '当前系统不支持加密存储，密码不会保存。'}
              </p>
            </div>
            <div className="settings-actions">
              <button className="button" onClick={onDataFolder} type="button">
                打开资料目录
              </button>
            </div>
          </div>
        </article>

        <article className="settings-card">
          <div className="settings-row">
            <span className="settings-icon" aria-hidden="true">
              <Download size={16} />
            </span>
            <div className="settings-copy">
              <h3>软件更新</h3>
              <p className={updateState?.status === 'available' ? '' : 'quiet-note'}>
                {updateText}
              </p>
              <p className="quiet-note">当前版本 {version || '未知'}</p>
            </div>
            <div className="settings-actions">
              <button className="button" onClick={onUpdates} type="button">
                查看版本与更新
              </button>
            </div>
          </div>
        </article>

        <article className="settings-card">
          <div className="settings-row">
            <span className="settings-icon" aria-hidden="true">
              <ShieldCheck size={16} />
            </span>
            <div className="settings-copy">
              <h3>关于</h3>
              <p className="quiet-note">
                电商批量上架助手 {version || ''} · 本机运行，资料不出电脑 · 源码许可 PolyForm
                Noncommercial 1.0.0（非商业使用）
              </p>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}

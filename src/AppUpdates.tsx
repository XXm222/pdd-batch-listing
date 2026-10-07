import { useState } from 'react';
import { Download, LoaderCircle, RefreshCw } from 'lucide-react';
import { Modal } from './components';
import type { UpdateState } from './types';

export function AppUpdates({
  state,
  onClose,
  onState,
}: {
  state: UpdateState | null;
  onClose: () => void;
  onState: (state: UpdateState) => void;
}) {
  const [installing, setInstalling] = useState(false),
    [error, setError] = useState('');
  const checking = state?.status === 'checking',
    downloading = state?.status === 'downloading';
  const perform = async (kind: 'check' | 'download' | 'install' | 'manual') => {
    setError('');
    try {
      if (kind === 'install' || kind === 'manual') {
        setInstalling(true);
        await (kind === 'manual'
          ? window.desktop.openUpdateInstaller()
          : window.desktop.installUpdate());
      } else
        onState(
          await (kind === 'check' ? window.desktop.checkUpdate() : window.desktop.downloadUpdate()),
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInstalling(false);
    }
  };
  const ready = state?.status === 'ready';
  const notes = state?.release?.notes || state?.currentNotes || '';
  const message =
    installing && !downloading
      ? '正在准备安装并重启…'
      : state?.status === 'latest'
        ? '当前已是最新版'
        : ready
          ? '更新包已下载并校验完成'
          : checking
            ? '正在检查新版本…'
            : downloading
              ? '正在下载更新包…'
              : state?.release
                ? `发现新版本 ${state.release.version}`
                : '检查服务器是否有新版本';
  return (
    <Modal
      title="软件更新"
      subtitle={`当前版本 ${state?.currentVersion || '读取中'}`}
      onClose={onClose}
      busy={installing}
      footer={
        <>
          <span className="footer-note">更新会保留本机商品资料和店铺设置</span>
          <div className="button-group">
            {downloading ? (
              <button
                className="button"
                onClick={() => void window.desktop.cancelUpdate().catch((e) => setError(e.message))}
              >
                取消下载
              </button>
            ) : (
              <button
                className="button"
                disabled={checking || installing}
                onClick={() => void perform('check')}
              >
                <RefreshCw size={15} />
                检查更新
              </button>
            )}
            {state?.release && !checking ? (
              <button
                className="button primary"
                disabled={downloading || installing}
                onClick={() => void perform('install')}
              >
                {downloading || installing ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Download size={15} />
                )}
                {installing
                  ? downloading
                    ? '正在下载更新…'
                    : '正在准备安装…'
                  : ready
                    ? '安装并重启'
                    : downloading
                      ? '正在下载…'
                      : '更新并重启'}
              </button>
            ) : null}
          </div>
        </>
      }
    >
      <div className="modal-body update-body">
        <h3 role="status">{message}</h3>
        {state?.release ? (
          <>
            <p>
              版本 {state.release.version} · 安装包{' '}
              {(state.release.file.size / 1024 / 1024).toFixed(1)} MB
            </p>
          </>
        ) : null}
        <section className="update-content" aria-label="更新内容">
          <h4>{state?.release ? '新版本更新内容' : '当前版本更新内容'}</h4>
          {notes ? (
            <ul className="update-notes-list">
              {notes
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
            </ul>
          ) : (
            <p className="quiet-note">暂未提供更新说明。</p>
          )}
        </section>
        {downloading ? (
          <div aria-live="polite">
            <progress
              aria-label="更新包下载进度"
              max={state?.release?.file.size || 1}
              value={state?.received || 0}
            />
            <p>
              {Math.floor(((state?.received || 0) / (state?.release?.file.size || 1)) * 100)}% ·
              已下载 {((state?.received || 0) / 1024 / 1024).toFixed(1)} MB
            </p>
          </div>
        ) : null}
        {state?.release ? (
          <p className="quiet-note">
            点击“更新并重启”后，自动下载、校验并安装，完成后重新打开 App。请先保存正在编辑的资料。
          </p>
        ) : null}
        <p className="quiet-note">请等待商品任务、登录和资料处理结束后再安装更新。</p>
        {error || state?.message ? (
          <p className="error-message" role="alert">
            {error || state?.message}
          </p>
        ) : null}
        {error && ready ? (
          <button className="button" disabled={installing} onClick={() => void perform('manual')}>
            改用手动安装
          </button>
        ) : null}
      </div>
    </Modal>
  );
}

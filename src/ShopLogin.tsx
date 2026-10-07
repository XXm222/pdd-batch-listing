import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Circle, LoaderCircle, AlertCircle, LogIn } from 'lucide-react';
import { Modal } from './components';
import { platformMeta } from './platforms';
import type { Shop, ShopLoginResult } from './types';

export function ShopLogin({
  shop,
  onClose,
  onEdit,
  onBrowserSetup,
}: {
  shop: Shop;
  onClose: () => void;
  onEdit: () => void;
  onBrowserSetup: () => void;
}) {
  const [result, setResult] = useState<ShopLoginResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitted = useRef(false);
  useEffect(
    () =>
      window.desktop.onShopLoginChanged((update) => {
        if (update.shopId === shop.id) setResult(update);
      }),
    [shop.id],
  );
  const run = async (mode: 'relogin' | 'check') => {
    if (submitted.current) return;
    submitted.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await window.desktop.loginShop({ id: shop.id, mode });
      setResult(next);
      if (next.errorCode === 'browser_unavailable') onBrowserSetup();
    } catch (e) {
      setError((e as Error).message);
      if ((e as Error).message.includes('浏览器连接未就绪')) onBrowserSetup();
    } finally {
      submitted.current = false;
      setBusy(false);
    }
  };
  const succeeded = result?.status === 'succeeded';
  const meta = platformMeta(shop.platform);
  return (
    <Modal
      title="店铺登录与核对"
      subtitle={shop.name}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <span className="footer-note">
            {result?.durationMs !== undefined
              ? `本次耗时 ${(result.durationMs / 1000).toFixed(1)} 秒`
              : '使用本机保存的登录信息'}
          </span>
          <div className="button-group">
            <button className="button" disabled={busy} onClick={onClose}>
              {succeeded ? '完成' : '关闭'}
            </button>
            {!result || succeeded ? (
              <button
                className="button primary"
                disabled={busy}
                data-autofocus
                onClick={() => void run('relogin')}
              >
                <LogIn size={15} />
                {busy ? '正在登录…' : meta.draftPublishing ? '退出并重新登录' : '打开登录页登录'}
              </button>
            ) : (
              <>
                {result.status === 'credentials_rejected' ? (
                  <button className="button primary" disabled={busy} onClick={onEdit}>
                    修改登录信息
                  </button>
                ) : null}
                {result.status === 'failed' || result.status === 'verification_required' ? (
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => void run('check')}
                  >
                    核对登录结果
                  </button>
                ) : null}
                {result.status === 'failed' ? (
                  <button className="button" disabled={busy} onClick={() => void run('relogin')}>
                    重新登录
                  </button>
                ) : null}
              </>
            )}
          </div>
        </>
      }
    >
      <div className="modal-body shop-login-body">
        <p>{meta.loginHint}</p>
        {error ? (
          <div className="error-message" role="alert">
            {error}
          </div>
        ) : null}
        {result ? (
          <>
            <div
              className={`login-result ${succeeded ? 'success' : ''}`}
              role="status"
              aria-live="polite"
            >
              {busy ? (
                <LoaderCircle size={18} className="spin" />
              ) : succeeded ? (
                <CheckCircle2 size={18} />
              ) : (
                <AlertCircle size={18} />
              )}
              <span>{result.message}</span>
            </div>
            <ol className="login-steps">
              {result.events.map((event) => (
                <li key={`${event.name}-${event.startedAt}`}>
                  {event.status === 'running' ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : event.status === 'done' ? (
                    <CheckCircle2 size={16} />
                  ) : (
                    <Circle size={16} />
                  )}
                  <span>{event.name}</span>
                  <small>
                    {event.durationMs === undefined
                      ? '进行中'
                      : `${(event.durationMs / 1000).toFixed(1)} 秒${event.status === 'failed' ? ' · 未完成' : ''}`}
                  </small>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <div className="quiet-note">
            若后台要求验证码或短信验证，请在浏览器完成后返回这里核对登录结果。
          </div>
        )}
      </div>
    </Modal>
  );
}

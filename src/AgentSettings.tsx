import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, LoaderCircle } from 'lucide-react';
import { Modal } from './components';
import type { AgentConfig, AgentConfigInput } from './types';
const editable = (c: AgentConfig): AgentConfigInput => ({
  baseUrl: c.baseUrl,
  model: c.model,
  apiKey: '',
  autoDiagnose: c.autoDiagnose ?? true,
  autoReadPage: c.autoReadPage ?? true,
  autoRecover: c.autoRecover ?? true,
});
export function AgentSettings({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<AgentConfig>({ baseUrl: '', model: '', keySaved: false });
  const [input, setInput] = useState<AgentConfigInput>({ baseUrl: '', model: '', apiKey: '' });
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [visible, setVisible] = useState(false);
  const [fieldError, setFieldError] = useState<'baseUrl' | 'model' | 'apiKey' | null>(null);
  const addressRef = useRef<HTMLInputElement>(null),
    modelRef = useRef<HTMLInputElement>(null),
    keyRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (error && !busy && fieldError)
      ({ baseUrl: addressRef, model: modelRef, apiKey: keyRef })[fieldError].current?.focus();
  }, [error, busy, fieldError]);
  useEffect(() => {
    let alive = true;
    void window.desktop
      .agentConfig()
      .then((c) => {
        if (alive) {
          setConfig(c);
          setInput(editable(c));
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  const change = (value: Partial<AgentConfigInput>) => {
    setInput((v) => ({ ...v, ...value }));
    setMessage('');
    setError('');
    setFieldError(null);
  };
  const perform = async (kind: 'save' | 'test') => {
    if (loading || busy) return;
    setBusy(kind);
    setError('');
    setMessage('');
    try {
      if (kind === 'save') {
        const c = await window.desktop.saveAgentConfig(input);
        setConfig(c);
        setInput(editable(c));
        setMessage(
          c.keySaved
            ? '模型设置已保存，API Key 已加密存入本机。'
            : '设置已保存；云端异常处理还需要填写 API Key。',
        );
        setVisible(false);
      } else {
        const result = await window.desktop.testAgentConfig(input);
        setMessage(
          `模型已响应 · ${result.model} · ${(result.durationMs / 1000).toFixed(2)} 秒。当前填写的设置仍需保存后用于任务。`,
        );
      }
    } catch (e) {
      const m = (e as Error).message;
      setError(m);
      setFieldError(
        /地址|HTTPS/.test(m)
          ? 'baseUrl'
          : /API Key|认证/.test(m)
            ? 'apiKey'
            : /模型名称|模型名/.test(m)
              ? 'model'
              : null,
      );
    } finally {
      setBusy('');
    }
  };
  return (
    <Modal
      title="Agent 模型设置"
      subtitle="正常走脚本，页面异常时才接入 Agent。未配置模型也能执行。"
      onClose={onClose}
      busy={!!busy}
      footer={
        <>
          <span className="footer-note">密钥只用于你填写的模型接口</span>
          <div className="button-group">
            <button
              className="button"
              disabled={!!busy || loading}
              onClick={() => void perform('test')}
            >
              {busy === 'test' ? <LoaderCircle size={15} className="spin" /> : null}
              {busy === 'test' ? '正在验证…' : '验证连接'}
            </button>
            <button
              className="button primary"
              disabled={!!busy || loading}
              onClick={() => void perform('save')}
            >
              {busy === 'save' ? '正在保存…' : '保存设置'}
            </button>
          </div>
        </>
      }
    >
      <div className="modal-body agent-settings">
        {loading ? <p role="status">正在读取模型设置…</p> : null}
        <fieldset disabled={!!busy || loading}>
          <label>
            接口地址
            <input
              ref={addressRef}
              aria-invalid={fieldError === 'baseUrl'}
              aria-describedby={fieldError === 'baseUrl' ? 'agent-settings-error' : undefined}
              data-autofocus
              autoComplete="off"
              placeholder="https://你的模型接口/v1"
              value={input.baseUrl}
              onChange={(e) => change({ baseUrl: e.target.value })}
            />
            <small>填写服务商提供的 Base URL，软件会请求 /chat/completions。</small>
          </label>
          <label>
            模型名称
            <input
              ref={modelRef}
              aria-invalid={fieldError === 'model'}
              aria-describedby={fieldError === 'model' ? 'agent-settings-error' : undefined}
              autoComplete="off"
              placeholder="填写服务商的模型 ID"
              value={input.model}
              onChange={(e) => change({ model: e.target.value })}
            />
            <small>诊断模型需要支持工具调用和文本回答。</small>
          </label>
          <label>
            API Key
            <div className="agent-key">
              <input
                ref={keyRef}
                aria-invalid={fieldError === 'apiKey'}
                aria-describedby={fieldError === 'apiKey' ? 'agent-settings-error' : undefined}
                type={visible ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder={config.keySaved ? '留空保留已保存的密钥' : '填写云端 API Key'}
                value={input.apiKey}
                onChange={(e) => change({ apiKey: e.target.value, clearKey: false })}
              />
              <button
                className="icon-button"
                type="button"
                aria-label={visible ? '隐藏密钥' : '显示密钥'}
                aria-pressed={visible}
                onClick={() => setVisible((v) => !v)}
              >
                {visible ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
            <small>
              {config.keySaved
                ? '已保存的密钥不会回显；更换接口地址时需要重新填写。'
                : '保存时使用 Mac / Windows 系统加密服务。'}
            </small>
          </label>
          {config.keySaved ? (
            <label className="agent-checkbox">
              <input
                type="checkbox"
                checked={!!input.clearKey}
                onChange={(e) => change({ clearKey: e.target.checked, apiKey: '' })}
              />
              删除已保存的 API Key
            </label>
          ) : null}
          <div className="agent-auto-settings">
            <h3>页面异常处理</h3>
            <label className="agent-checkbox">
              <input
                type="checkbox"
                checked={!!input.autoDiagnose}
                onChange={(e) => change({ autoDiagnose: e.target.checked })}
              />
              脚本遇到页面异常时自动接入 Agent
            </label>
            <label className="agent-checkbox">
              <input
                type="checkbox"
                checked={!!input.autoReadPage}
                onChange={(e) => change({ autoReadPage: e.target.checked })}
              />
              允许自动读取原商品页的字段、错误与提示弹窗
            </label>
            <label className="agent-checkbox">
              <input
                type="checkbox"
                checked={!!input.autoRecover}
                onChange={(e) => change({ autoRecover: e.target.checked })}
              />
              自动处理页面异常，恢复后继续原任务与本批剩余商品
            </label>
            <small>
              默认开启。恢复限一次，沿用原商品编号。Excel
              资料有错需补充；验证码与权限验证需本人处理。模型未配置时，普通脚本仍可运行。
            </small>
          </div>
        </fieldset>
        <div className="agent-data-note">
          <strong>异常时会发送哪些资料</strong>
          <p>
            当前商品的标题、类目、属性、规格价格库存、发货承诺，以及任务异常和核验结果。开启页面读取时，还会附带已核对店铺与编号的原商品页字段、错误与弹窗标题。
          </p>
          <p>
            这些资料只在异常处理时发送至所填接口。店铺账号密码、Cookie、图片文件和整个后台页面不会发送。连接验证仅发送一条验证文本。
          </p>
        </div>
        {error ? (
          <div className="error-message" role="alert" id="agent-settings-error">
            {error}
            {fieldError === 'baseUrl' ? (
              <p>请使用服务商提供的完整地址，例如 https://你的服务商/v1。</p>
            ) : null}
          </div>
        ) : null}
        {message ? (
          <p className="agent-feedback" role="status">
            {message}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

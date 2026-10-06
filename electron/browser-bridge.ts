import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExecutionError } from './execution';
import { BridgeSetup } from './bridge-setup';

export type Node = {
  role?: string;
  name?: string;
  value?: string;
  ref?: string;
  checked?: boolean | string;
  children?: Node[];
};
export const flatten = (nodes: Node[]): Node[] =>
  nodes.flatMap((n) => [n, ...flatten(n.children || [])]);
export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const connectionError = () =>
  new ExecutionError(
    'browser_unavailable',
    '浏览器连接已断开。请打开左下角“浏览器连接 · 安装教程”，确认浏览器已打开、扩展已启用并已连接，再继续任务。',
  );
type TabResult = { success: boolean; url: string; tabId: number; borrowed?: boolean };
const missingTab = (error: unknown) =>
  error instanceof Error &&
  /^find_tab(?:\(active:true\))?: no (?:foreground )?tab matching\b/i.test(error.message);
const closedSessionTab = (error: unknown) =>
  error instanceof Error &&
  (/^session "goods-workspace(?:-[a-f0-9-]+)?": current tab \d+ was closed;/i.test(error.message) ||
    /^No tab with given id \d+\.?$/i.test(error.message));
export class BrowserBridge {
  private readonly origin: string;
  constructor(private readonly startUrl: string) {
    const url = new URL(startUrl);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('后台连接地址须使用不含凭据的 HTTPS 地址');
    this.origin = url.origin;
  }
  private url = 'http://127.0.0.1:10086';
  // The daemon outlives browser/App restarts. Keep one session for this adapter's
  // entire queue, without inheriting old tab IDs from an earlier App process.
  private readonly session = `goods-workspace-${randomUUID()}`;
  async call<T = unknown>(
    action: string,
    args: Record<string, unknown> = {},
    timeoutMs = 45000,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.url}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, args, session: this.session }),
        signal: controller.signal,
      });
      const result = await res.json().catch(() => {
        throw connectionError();
      });
      if (!result || typeof result.ok !== 'boolean' || (!res.ok && result.ok))
        throw connectionError();
      if (!result.ok) {
        const code = result.error?.code;
        const message =
          typeof result.error?.message === 'string' ? result.error.message : '浏览器命令执行失败';
        if (
          [
            'extension_not_connected',
            'extension_disconnected',
            'browser_disconnected',
            'connection_closed',
            'connection_refused',
          ].includes(code) ||
          /ECONNREFUSED|ECONNRESET|WebSocket (?:is )?(?:not open|closed|disconnected)|extension (?:is )?not connected/i.test(
            message,
          )
        )
          throw connectionError();
        throw new Error(message);
      }
      return result.data;
    } catch (error) {
      if (
        error instanceof TypeError ||
        controller.signal.aborted ||
        ['ECONNREFUSED', 'ECONNRESET'].includes((error as NodeJS.ErrnoException)?.code || '')
      )
        throw connectionError();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async connect() {
    const status = await new BridgeSetup().start();
    if (status.state !== 'ready') throw new ExecutionError('browser_unavailable', status.message);
    this.url = status.httpAddress;
    // The extension may be connected in a different browser from the OS default.
    // Select/create the tab through that same connection; openExternal + active:true
    // can open Edge while every subsequent command is sent to Chrome.
    for (const args of [{ url: this.origin }, { url: this.origin, active: true }]) {
      try {
        this.checkTab(await this.call<TabResult>('find_tab', args));
        return;
      } catch (error) {
        if (closedSessionTab(error)) break;
        if (!missingTab(error)) throw error;
      }
    }
    this.checkTab(
      await this.call<TabResult>('navigate', {
        url: this.startUrl,
        newTab: true,
        group_title: '商品运营台',
      }),
    );
  }
  private checkTab(tab: TabResult) {
    let trusted = false;
    try {
      trusted =
        tab?.success === true &&
        Number.isInteger(tab.tabId) &&
        new URL(tab.url).origin === this.origin;
    } catch {}
    if (!trusted)
      throw new ExecutionError(
        'browser_unavailable',
        '未能在已连接的浏览器中打开目标商家后台，请检查浏览器连接后继续。',
      );
  }
  snapshot() {
    return this.call<{ url: string; tree: Node[] }>('snapshot');
  }
  async navigate(url: string, options: { newTab?: boolean } = {}) {
    try {
      await this.call('navigate', {
        url,
        ...options,
        ...(options.newTab ? { group_title: '商品运营台' } : {}),
      });
    } catch (error) {
      if (!/beforeunload/i.test((error as Error).message)) throw error;
      await this.call('cdp', { method: 'Page.handleJavaScriptDialog', params: { accept: true } });
    }
  }
  async eval<T = unknown>(code: string, timeoutMs = 45000): Promise<T> {
    const result = await this.call<unknown>('evaluate', { code }, timeoutMs);
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new ExecutionError(
        'platform_changed',
        '浏览器脚本返回结构不正确，请核对原页面',
        'inspect_form',
      );
    return (result as { value?: unknown }).value as T;
  }
  async wait<T>(
    check: () => Promise<T | false | null | undefined>,
    timeout = 20000,
    message = '后台页面未及时响应',
  ): Promise<T> {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const value = await check();
      if (value) return value;
      await delay(150);
    }
    throw new ExecutionError('page_timeout', message);
  }
  async ref(role: string, name: string, starts = false) {
    const nodes = flatten((await this.snapshot()).tree).filter(
      (n) => n.role === role && n.ref && (starts ? n.name?.startsWith(name) : n.name === name),
    );
    if (nodes.length !== 1) throw new Error(`后台控件无法唯一定位：${name}`);
    return nodes[0].ref!;
  }
  async clickName(role: string, name: string, starts = false) {
    await this.call('click', { selector: await this.ref(role, name, starts) });
  }
  async fill(
    selector: string,
    value: string,
    mode: 'dom' | 'keyboard' = 'dom',
    expectedBefore?: string,
    confirmAccepted?: () => Promise<boolean>,
  ) {
    if (mode === 'keyboard') {
      return this.keyboardFill(selector, value, expectedBefore, confirmAccepted);
    }
    await this.call('fill', { selector, value });
    // Extension fill already focuses before changing the value. A second focus
    // after a rerender can reset a control's edit baseline, so only blur here.
    const checked = await this.eval<boolean>(
      `(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.blur();return e.value===${JSON.stringify(value)};})()`,
    );
    if (!checked) throw new Error('后台填写结果未确认');
  }
  private async keyboardFill(
    selector: string,
    value: string,
    expectedBefore?: string,
    confirmAccepted?: () => Promise<boolean>,
  ) {
    const id = randomUUID(),
      quotedSelector = JSON.stringify(selector),
      quotedId = JSON.stringify(id);
    const initial = await this.eval<{ url: string; value: string } | false>(
      `(() => {const e=document.querySelector(${quotedSelector});if(!e||!e.getClientRects().length||e.disabled||e.readOnly||e.type==='password'||!['INPUT','TEXTAREA'].includes(e.tagName))return false;return {url:location.href,value:e.value};})()`,
    );
    if (!initial) throw new Error('规格输入框未就绪，未发送键盘输入');
    if (expectedBefore !== undefined && initial.value !== expectedBefore)
      throw new Error('规格输入框内容已变化，未发送键盘输入');
    const quotedUrl = JSON.stringify(initial.url);
    const transactionSelector = JSON.stringify(`[data-goods-input-transaction="${id}"]`);
    const observerKey = JSON.stringify(`__goodsInput_${id}`);
    const trace: Record<string, unknown>[] = [];
    const inputFailure = (message: string) =>
      new ExecutionError('platform_changed', message, 'inspect_form', true, {
        source: 'spec_input',
        expected: value,
        initialValue: initial.value,
        trace,
      });
    const inspect = async (stage: string) => {
      const state = await this.eval<{
        same: boolean;
        urlMatches: boolean;
        active: boolean;
        value: string;
        start: number | null;
        end: number | null;
        events: { type: string; trusted: boolean; value: string; data: string }[];
      }>(
        `(() => {const e=document.querySelector(${transactionSelector}),observer=globalThis[${observerKey}];return {same:!!e&&location.href===${quotedUrl}&&e.getAttribute('data-goods-input-transaction')===${quotedId},urlMatches:location.href===${quotedUrl},active:!!e&&document.activeElement===e,value:e?.value||'',start:e?.selectionStart??null,end:e?.selectionEnd??null,events:observer?.events||[]};})()`,
      );
      // Selection markers can be relabelled as the empty input becomes a filled
      // option. Keep observing the original transaction, never its replacement.
      if (trace.length < 12) trace.push({ stage, ...state });
      return state;
    };
    const acceptedAfterTransition = async () => {
      if (!confirmAccepted) return false;
      try {
        await this.wait(
          async () => {
            const state = await inspect('acceptance');
            if (!state.urlMatches || (state.same && state.value && state.value !== value))
              throw inputFailure('规格输入期间页面或内容已变化，已停止并保留原页');
            return confirmAccepted();
          },
          1200,
          '规格选项尚未确认',
        );
        trace.push({ stage: 'accepted_option', accepted: true });
        return true;
      } catch (error) {
        if (error instanceof ExecutionError && error.code === 'page_timeout') return false;
        throw error;
      }
    };
    let selectionStarted = false;
    const selectAll = async (current: string) => {
      // Chromium/macOS can intercept Cmd+A before a native input receives it.
      // Set only the selection, preserving its value and React's input baseline;
      // text entry and Tab below still use native CDP input events.
      const selectedDirectly = await this.eval<boolean>(`(() => {
        const e=document.querySelector(${selectionStarted ? transactionSelector : quotedSelector});
        if(location.href!==${quotedUrl}||!e||e.value!==${JSON.stringify(current)}||!e.getClientRects().length||e.disabled||e.readOnly||typeof e.setSelectionRange!=='function')return false;
        let observer=globalThis[${observerKey}];
        if(observer&&observer.element!==e)return false;
        if(!observer){
          observer={element:e,events:[]};
          observer.listener=event=>{
            if(event.target!==e||location.href!==${quotedUrl}||observer.events.length>=16)return;
            const item={type:event.type,trusted:!!event.isTrusted,inputType:event.inputType||'',data:String(event.data||'').slice(0,80),value:e.value.slice(0,80),prevented:!!event.defaultPrevented};
            observer.events.push(item);
            Promise.resolve().then(()=>{item.prevented=!!event.defaultPrevented;item.valueAfter=e.value.slice(0,80);});
          };
          globalThis[${observerKey}]=observer;
          for(const type of ['beforeinput','input','change','blur'])e.addEventListener(type,observer.listener);
        }
        e.setAttribute('data-goods-input-transaction',${quotedId});e.focus();if(document.activeElement!==e)return false;e.setSelectionRange(0,e.value.length);return true;
      })()`);
      if (!selectedDirectly) throw new Error('规格输入框或焦点已变化，未发送键盘输入');
      selectionStarted = true;
      const selected = await inspect('selection');
      if (
        !selected.same ||
        !selected.active ||
        selected.value !== current ||
        selected.start !== 0 ||
        selected.end !== current.length
      )
        throw new Error('规格输入框未保持完整选区，未发送键盘输入');
    };
    const tab = async () => {
      for (const type of ['keyDown', 'keyUp'])
        await this.call('cdp', {
          method: 'Input.dispatchKeyEvent',
          params: { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
        });
      // A background tab can consume Tab without moving its input focus. Commit
      // through the original control's blur only when that exact transaction is
      // still focused. Never focus a replacement or send Enter to the form.
      const left = await this.eval<boolean>(
        `(() => {if(location.href!==${quotedUrl})return false;const e=document.querySelector(${transactionSelector});if(!e)return true;if(document.activeElement!==e)return true;if(e.value!==${JSON.stringify(value)})return false;e.blur();return document.activeElement!==e;})()`,
      );
      await inspect('after_tab');
      if (!left) throw inputFailure('规格文字已输入，但未能离开原输入框确认选项；已保留原页');
    };
    let failure: unknown;
    await this.call('cdp', {
      method: 'Emulation.setFocusEmulationEnabled',
      params: { enabled: true },
    });
    try {
      await selectAll(initial.value);
      await this.call('cdp', { method: 'Input.insertText', params: { text: value } });
      let entered = await inspect('after_insert');
      // Focus emulation may report a focused DOM input while the background
      // renderer receives no native input at all. Use the extension's documented
      // last resort only for an unchanged original field with no input receipt.
      if (
        entered.same &&
        entered.active &&
        entered.urlMatches &&
        entered.value === initial.value &&
        (initial.value === '' || initial.value === value) &&
        entered.events.length === 0
      ) {
        if (initial.value === '' && confirmAccepted && (await confirmAccepted())) return { trace };
        const before = await inspect('before_activation');
        if (
          !before.same ||
          !before.active ||
          !before.urlMatches ||
          before.value !== initial.value ||
          before.events.length
        )
          throw inputFailure('规格输入现场已变化，未重试；已停止并保留原页');
        const activation = await this.call<{ activation?: string }>('cdp', {
          method: 'Page.bringToFront',
          params: {},
        });
        trace.push({
          stage: 'activate_original_tab',
          activation: activation?.activation || 'requested',
        });
        const current = await inspect('after_activation');
        if (
          !current.same ||
          !current.urlMatches ||
          current.value !== initial.value ||
          current.events.length
        )
          throw inputFailure('激活原标签后规格输入现场已变化，未重试；已停止并保留原页');
        await selectAll(initial.value);
        await this.call('cdp', { method: 'Input.insertText', params: { text: value } });
        entered = await inspect('after_native_retry');
        if (
          entered.same &&
          entered.active &&
          entered.urlMatches &&
          entered.value === initial.value &&
          entered.events.length === 0
        )
          throw inputFailure(
            `浏览器未接收规格“${value.slice(0, 80)}”的输入；激活原标签并重试一次后仍未写入，已停止并保留原页`,
          );
      }
      if (!entered.same || entered.value !== value) {
        // This rollback exists only inside the current verified input transaction.
        // It cannot repair an old task or a user's conflicting value on resume.
        if (entered.same && initial.value === value && entered.value === value + value) {
          try {
            await selectAll(entered.value);
            await this.call('cdp', { method: 'Input.insertText', params: { text: initial.value } });
            const restored = await inspect('rollback');
            if (restored.same && restored.active && restored.value === initial.value) {
              await tab();
              throw new ExecutionError(
                'platform_changed',
                '规格输入出现本次重复写入，已恢复本次写入前内容；未继续填写，请核对原页',
                'inspect_form',
              );
            }
          } catch (error) {
            if (error instanceof ExecutionError) throw error;
          }
        }
        // An accepted option may clear or replace the entry box. Require a fresh
        // business-level acknowledgement before accepting that transition; do
        // not type again or blur whichever new empty box took its place.
        if (
          entered.urlMatches &&
          (!entered.same || !entered.value) &&
          (await acceptedAfterTransition())
        )
          return { trace };
        const observed = entered.same
          ? `页面显示“${entered.value.slice(0, 80)}”`
          : '输入后页面更换了控件';
        throw inputFailure(
          `规格输入未确认：预期“${value.slice(0, 80)}”，${observed}；已停止并保留原页，请核对当前规格`,
        );
      }
      if (!entered.active) {
        if (await acceptedAfterTransition()) return { trace };
        throw inputFailure('规格值已写入，但输入框焦点变化，尚未确认提交；已保留原页');
      }
      await tab();
      return { trace };
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await this.eval(
        `(() => {const observer=globalThis[${observerKey}],e=observer?.element;if(e){for(const type of ['beforeinput','input','change','blur'])e.removeEventListener(type,observer.listener);if(e.getAttribute('data-goods-input-transaction')===${quotedId})e.removeAttribute('data-goods-input-transaction');}delete globalThis[${observerKey}];})()`,
      ).catch(() => {});
      try {
        await this.call('cdp', {
          method: 'Emulation.setFocusEmulationEnabled',
          params: { enabled: false },
        });
      } catch (error) {
        if (!failure) throw error;
      }
    }
  }
  async upload(selector: string, assetPath: string, name: string) {
    await this.uploadMany(selector, [{ path: assetPath, name }]);
  }
  async uploadMany(selector: string, files: { path: string; name: string }[]) {
    try {
      await this.call('upload', { selector, files: files.map((f) => f.path) });
    } catch (error) {
      // The extension may lack file:// access; send local image bytes to the file input.
      if (!/file|文件|access|权限/i.test((error as Error).message)) throw error;
      const images = files.map((f) => {
        const bytes = fs.readFileSync(f.path);
        const png = bytes
          .subarray(0, 8)
          .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
        if (!png && !jpeg) throw new Error(`无法确认图片格式，未上传：${f.name}`);
        return {
          name: path.basename(f.path, path.extname(f.path)) + (png ? '.png' : '.jpg'),
          bytes: bytes.toString('base64'),
          mime: png ? 'image/png' : 'image/jpeg',
        };
      });
      await this.eval(
        `(() => {const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw Error('找不到图片上传控件');const d=new DataTransfer();for(const f of ${JSON.stringify(images)}){const b=atob(f.bytes);d.items.add(new File([Uint8Array.from(b,c=>c.charCodeAt(0))],f.name,{type:f.mime}));}input.files=d.files;input.dispatchEvent(new Event('change',{bubbles:true}));return d.files.length;})()`,
      );
    }
  }
}

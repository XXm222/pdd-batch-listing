const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BrowserBridge } = require('../dist-electron/electron/browser-bridge');
const { BridgeSetup } = require('../dist-electron/electron/bridge-setup');
const { ExecutionError } = require('../dist-electron/electron/execution');

async function withFetch(implementation, work) {
  const original = global.fetch;
  global.fetch = implementation;
  try { await work(new BrowserBridge()); } finally { global.fetch = original; }
}
const disconnected = error => error instanceof ExecutionError && error.code === 'browser_unavailable' && /安装教程/.test(error.message);

test('official extension_not_connected failure routes to browser setup instead of Agent diagnosis', async () => {
  await withFetch(async () => Response.json({ ok: false, error: { code: 'extension_not_connected', message: 'The extension is not connected' } }), async bridge => {
    await assert.rejects(bridge.call('snapshot'), disconnected);
  });
});

test('transport failures and malformed service responses offer connection instructions', async () => {
  for (const implementation of [
    async () => { throw new TypeError('fetch failed'); },
    async () => { throw Object.assign(new Error('Socket reset'), { code: 'ECONNRESET' }); },
    async () => new Response('<html>Bad Gateway</html>', { status: 502 }),
    async () => Response.json({ status: 'another service' }),
    async () => Response.json({ ok: false, error: { message: 'WebSocket is not open' } })
  ]) await withFetch(implementation, async bridge => assert.rejects(bridge.call('snapshot'), disconnected));
});

test('page-level failures remain page failures rather than browser installation errors', async () => {
  await withFetch(async () => Response.json({ ok: false, error: { code: 'element_not_found', message: 'Selector not found' } }), async bridge => {
    await assert.rejects(bridge.call('click'), error => !(error instanceof ExecutionError) && error.message === 'Selector not found');
  });
});

test('successful bridge commands keep their data contract', async () => {
  await withFetch(async () => Response.json({ ok: true, data: { title: 'Goods' } }), async bridge => {
    assert.deepEqual(await bridge.call('snapshot'), { title: 'Goods' });
  });
});

test('disconnect while borrowing a tab is preserved instead of swallowed by the wait loop', async () => {
  const original = BridgeSetup.prototype.start;
  BridgeSetup.prototype.start = async () => ({ state: 'ready', httpAddress: 'http://127.0.0.1:10086' });
  try {
    await withFetch(async () => Response.json({ ok: false, error: { code: 'extension_not_connected' } }), async bridge => {
      await assert.rejects(bridge.connect(), disconnected);
    });
  } finally { BridgeSetup.prototype.start = original; }
});

async function connected(work) {
  const original = BridgeSetup.prototype.start;
  BridgeSetup.prototype.start = async () => ({ state: 'ready', httpAddress: 'http://127.0.0.1:10086' });
  try { await work(); } finally { BridgeSetup.prototype.start = original; }
}
const homeTab = { success: true, url: 'https://mms.pinduoduo.com/home/', tabId: 7 };
const noSessionTab = { ok: false, error: { message: 'find_tab: no tab matching https://mms.pinduoduo.com in this session — use navigate to open it' } };
const noForegroundTab = { ok: false, error: { message: "find_tab(active:true): no foreground tab matching https://mms.pinduoduo.com — the user isn't viewing that page right now" } };

test('reconnection reuses the App session tab even when a different browser tab is foreground', async () => connected(async () => {
  const commands = [];
  await withFetch(async (_url, options) => {
    commands.push(JSON.parse(options.body));
    return Response.json({ ok: true, data: homeTab });
  }, bridge => bridge.connect());
  assert.deepEqual(commands.map(c => [c.action, c.args]), [['find_tab', { url: 'https://mms.pinduoduo.com' }]]);
}));

test('first connection can borrow the visible PDD page without creating another tab', async () => connected(async () => {
  const commands = [];
  await withFetch(async (_url, options) => {
    commands.push(JSON.parse(options.body));
    return Response.json(commands.length === 1 ? noSessionTab : { ok: true, data: { ...homeTab, borrowed: true } });
  }, bridge => bridge.connect());
  assert.deepEqual(commands.map(c => c.action), ['find_tab', 'find_tab']);
  assert.equal(commands[1].args.active, true);
}));

test('missing PDD in the connected browser opens a new tab through the same extension session', async () => connected(async () => {
  const commands = [];
  await withFetch(async (_url, options) => {
    commands.push(JSON.parse(options.body));
    return Response.json([noSessionTab, noForegroundTab, { ok: true, data: homeTab }][commands.length - 1]);
  }, bridge => bridge.connect());
  assert.deepEqual(commands.map(c => c.action), ['find_tab', 'find_tab', 'navigate']);
  assert.deepEqual(commands[2].args, { url: homeTab.url, newTab: true, group_title: '商品运营台' });
  assert.equal(new Set(commands.map(c => c.session)).size,1);
  assert.match(commands[0].session,/^goods-workspace-[a-f0-9-]{36}$/);
}));

test('separate App adapters do not inherit old sessions while each adapter keeps its entire queue in one session', async () => {
  const original=global.fetch,commands=[];
  global.fetch=async (_url,options)=>{commands.push(JSON.parse(options.body));return Response.json({ok:true,data:{}});};
  try{
    const first=new BrowserBridge(),second=new BrowserBridge();
    await first.call('snapshot');await first.call('snapshot');await second.call('snapshot');
    assert.equal(commands[0].session,commands[1].session);
    assert.notEqual(commands[0].session,commands[2].session);
  }finally{global.fetch=original;}
});

test('tab permission failures do not trigger navigation or get hidden by retrying', async () => connected(async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return Response.json({ ok: false, error: { message: 'Debugger permission denied' } });
  }, bridge => assert.rejects(bridge.connect(), /Debugger permission denied/));
  assert.equal(calls, 1);
}));

test('a closed current session tab recovers by opening a fresh PDD tab without touching other tabs', async () => connected(async () => {
  for(const message of ['session "goods-workspace": current tab 1600484327 was closed; session still has tabs [1600484220] — call list_tabs to re-target, or navigate to open a new tab','No tab with given id 1600484229.']){
  const commands=[];
  await withFetch(async (_url,options)=>{
    commands.push(JSON.parse(options.body));
    return Response.json(commands.length===1?{ok:false,error:{message}}:{ok:true,data:homeTab});
  }, bridge=>bridge.connect());
  assert.deepEqual(commands.map(c=>c.action),['find_tab','navigate']);
  assert.deepEqual(commands[1].args,{url:homeTab.url,newTab:true,group_title:'商品运营台'});
  }
}));

test('a loose host match cannot select a non-PDD origin for login', async () => connected(async () => {
  await withFetch(async () => Response.json({ ok: true, data: { ...homeTab, url: 'https://other.mms.pinduoduo.com/' } }),
    bridge => assert.rejects(bridge.connect(), error => error.code === 'browser_unavailable'));
}));

test('normal fill relies on extension pre-focus and never focuses a second time after setting the value', async () => {
  const bridge = new BrowserBridge(), actions = [];
  const input = { value: '', focus() { actions.push('focus'); }, blur() { actions.push('blur'); } };
  bridge.call = async (action, args) => { assert.equal(action, 'fill'); input.focus(); input.value = args.value; actions.push('set'); };
  bridge.eval = async code => vm.runInNewContext(code, { document: { querySelector: () => input } });
  await bridge.fill('#spec', '紫');
  assert.deepEqual(actions, ['focus', 'set', 'blur']);
});

function keyboardFixture(options = {}) {
  const bridge = new BrowserBridge(), actions = [], attrs = new Map(), listeners = new Map();
  const input = { value: options.value ?? '灰色', tagName: 'INPUT', disabled: false, readOnly: !!options.readOnly,
    type: options.type || 'text',
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    selectionStart: 0, selectionEnd: 0, getClientRects: () => [{}],
    setSelectionRange(start,end) { this.selectionStart=options.loseSelection?this.value.length:start;this.selectionEnd=end;if(options.replaceNode)attrs.clear(); },
    focus() { document.activeElement = this; }, blur() { actions.push(['blur', {}]); if (!options.blurStaysFocused) document.activeElement = null; }, setAttribute: (key, value) => attrs.set(key, value),
    getAttribute: key => attrs.get(key) ?? null, removeAttribute: key => attrs.delete(key) };
  const document = { activeElement: null, querySelector(selector) {
    if(selector.startsWith('[data-goods-input-transaction='))return attrs.has('data-goods-input-transaction')?input:null;
    return input;
  } };
  const location = { href: 'https://mms.pinduoduo.com/goods/goods_add/index?goods_id=1' };
  const context = vm.createContext({ document, location, navigator: { platform: options.platform||'Win32' } });
  const event = (type, text) => {
    for (const listener of listeners.get(type) || []) listener({ type, target: input, isTrusted: true,
      inputType: 'insertText', data: text, defaultPrevented: false });
  };
  let insertions = 0, activated = false;
  bridge.eval = async code => {
    const value = vm.runInContext(code, context);
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
  };
  bridge.call = async (action, { method, params }) => {
    assert.equal(action, 'cdp'); actions.push([method, params]);
    if (method === 'Page.bringToFront') {
      activated = true;
      if (options.changeOnActivation) input.value = '运营新填写';
      if (options.navigateOnActivation) location.href = 'https://mms.pinduoduo.com/home/';
      return { activation: 'tab' };
    }
    if (method === 'Input.dispatchKeyEvent' && params.key === 'a' && params.type === 'keyDown') {
      input.selectionStart = options.loseSelection ? input.value.length : 0;
      input.selectionEnd = input.value.length;
      if (options.replaceNode) attrs.clear();
    }
    if (method === 'Input.insertText') {
      insertions++;
      assert.equal(document.activeElement, input);
      if (options.ignoreNativeAlways || (options.ignoreNativeBeforeActivation && !activated)) return;
      event('beforeinput', params.text);
      if (options.externalChange) input.value = '运营新填写';
      else if (options.duplicateOnce && insertions === 1) input.value += params.text;
      else input.value = input.value.slice(0, input.selectionStart) + params.text + input.value.slice(input.selectionEnd);
      input.selectionStart = input.selectionEnd = input.value.length;
      event('input', params.text);
      if(options.clearAfterInsert)input.value='';
      if(options.replaceAfterInsert)attrs.clear();
    }
    if (method === 'Input.dispatchKeyEvent' && params.key === 'Tab' && params.type === 'keyDown' && options.tabMovesFocus) document.activeElement = null;
  };
  return { bridge, input, actions, attrs, listeners, context };
}

test('Mac and Windows directly verify the full selection without system shortcuts before native text entry and Tab', async () => {
  for(const platform of ['MacIntel','Win32']){
  const f = keyboardFixture({platform});
  await f.bridge.fill('#spec', '灰色', 'keyboard', '灰色');
  assert.equal(f.input.value, '灰色');
  assert.equal(f.actions.some(([method,params])=>method==='Input.dispatchKeyEvent'&&['a','Meta','Control'].includes(params.key)),false);
  assert.equal(f.actions.filter(([method])=>method==='Input.insertText').length,1);
  assert.deepEqual(f.actions.filter(([method, params]) => method === 'Input.dispatchKeyEvent' && params.key === 'Tab').map(([, params]) => params.type), ['keyDown', 'keyUp']);
  assert.equal(f.actions.at(-1)[1].enabled, false);
  assert.equal(f.attrs.size, 0);
  assert.equal([...f.listeners.values()].every(set => set.size === 0), true);
  }
});

test('lost selection or replaced input aborts before inserting any text', async () => {
  for (const options of [{ loseSelection: true }, { replaceNode: true }]) {
    const f = keyboardFixture(options);
    await assert.rejects(f.bridge.fill('#spec', '灰色', 'keyboard', '灰色'), /未保持完整选区/);
    assert.equal(f.actions.some(([method]) => method === 'Input.insertText'), false);
    assert.equal(f.input.value, '灰色');
    assert.equal(f.actions.at(-1)[1].enabled, false);
  }
});

test('a current-transaction duplicate is restored once to its verified prior value then stops the task', async () => {
  const f = keyboardFixture({ duplicateOnce: true });
  await assert.rejects(f.bridge.fill('#spec', '灰色', 'keyboard', '灰色'), /已恢复本次写入前内容/);
  assert.equal(f.input.value, '灰色');
  assert.equal(f.actions.filter(([method]) => method === 'Input.insertText').length, 2);
});

test('unknown changes and old duplicate values are never treated as a current-transaction rollback', async () => {
  const changed = keyboardFixture({ externalChange: true });
  await assert.rejects(changed.bridge.fill('#spec', '灰色', 'keyboard', '灰色'), /预期“灰色”，页面显示“运营新填写”/);
  assert.equal(changed.input.value, '运营新填写');
  assert.equal(changed.actions.filter(([method]) => method === 'Input.insertText').length, 1);
  const old = keyboardFixture({ value: '灰色灰色' });
  await assert.rejects(old.bridge.fill('#spec', '灰色', 'keyboard', '灰色'), /内容已变化/);
  assert.deepEqual(old.actions, []);
});

test('keyboard input rejects uneditable fields before any key events and fills verified empty controls once', async () => {
  const locked = keyboardFixture({ readOnly: true });
  await assert.rejects(locked.bridge.fill('#spec', '灰色', 'keyboard', '灰色'), /未就绪/);
  assert.deepEqual(locked.actions, []);
  const empty = keyboardFixture({ value: '' });
  await empty.bridge.fill('#spec', '灰色', 'keyboard', '');
  assert.equal(empty.input.value, '灰色');
  assert.equal(empty.actions.filter(([method]) => method === 'Input.insertText').length, 1);
});

test('native text input commits a background control when Tab leaves focus unchanged, without retyping or Enter', async () => {
  const f = keyboardFixture({ value: '' });
  await f.bridge.fill('#spec', '灰色', 'keyboard', '');
  assert.equal(f.actions.filter(([action]) => action === 'blur').length, 1);
  assert.equal(f.actions.filter(([action]) => action === 'Input.insertText').length, 1);
  assert.equal(f.actions.some(([, params]) => params.key === 'Enter'), false);
});

test('a successful native Tab does not blur an already committed or replacement control', async () => {
  const f = keyboardFixture({ value: '', tabMovesFocus: true });
  await f.bridge.fill('#spec', '20L', 'keyboard', '');
  assert.equal(f.actions.some(([action]) => action === 'blur'), false);
});

test('a control that refuses to leave focus stops before confirming an option', async () => {
  const f = keyboardFixture({ value: '', blurStaysFocused: true });
  await assert.rejects(f.bridge.fill('#spec', '灰色', 'keyboard', ''), error => error.code === 'platform_changed' && /未能离开原输入框/.test(error.message));
  assert.equal(f.actions.filter(([action]) => action === 'Input.insertText').length, 1);
  assert.equal(f.actions.at(-1)[1].enabled, false);
});

test('a cleared or replaced entry box succeeds only when the actual option is freshly acknowledged, without retyping or Tab', async () => {
  for(const options of [{clearAfterInsert:true},{replaceAfterInsert:true}]){
    const f=keyboardFixture({value:'',...options});let checks=0;
    await f.bridge.fill('#spec','灰色','keyboard','',async()=>{checks++;return true;});
    assert.equal(checks,1);
    assert.equal(f.actions.filter(([method])=>method==='Input.insertText').length,1);
    assert.equal(f.actions.some(([method])=>method==='Input.dispatchKeyEvent'||method==='blur'),false);
    assert.equal(f.attrs.size,0);
  }
});

test('an empty entry box without option acknowledgement stops and retains input evidence', async () => {
  const f=keyboardFixture({value:'',clearAfterInsert:true});
  f.bridge.wait=async check=>{for(let i=0;i<3;i++)if(await check())return true;throw new ExecutionError('page_timeout','未确认');};
  await assert.rejects(f.bridge.fill('#spec','灰色','keyboard','',async()=>false),error=>error.code==='platform_changed'
    && error.details.expected==='灰色'&&error.details.trace.some(e=>e.stage==='after_insert'&&e.value===''));
  assert.equal(f.actions.filter(([method])=>method==='Input.insertText').length,1);
  assert.equal(f.actions.some(([method])=>method==='Input.dispatchKeyEvent'),false);
});

test('business acknowledgement cannot hide an unexpected current input value', async () => {
  const f=keyboardFixture({value:'',externalChange:true});let checks=0;
  await assert.rejects(f.bridge.fill('#spec','灰色','keyboard','',async()=>{checks++;return true;}),/运营新填写/);
  assert.equal(checks,0);
  assert.equal(f.input.value,'运营新填写');
});

test('relabelled empty-input selectors keep observing the original input transaction', async () => {
  const f=keyboardFixture({value:''});const originalCall=f.bridge.call;
  let inserted=false,staleReads=0;
  const originalEval=f.bridge.eval;
  f.bridge.call=async(action,args)=>{await originalCall(action,args);if(args.method==='Input.insertText')inserted=true;};
  f.bridge.eval=async code=>{
    if(inserted&&code.includes('document.querySelector("#spec")')){staleReads++;return false;}
    return originalEval(code);
  };
  await f.bridge.fill('#spec','20L','keyboard','');
  assert.equal(f.input.value,'20L');assert.equal(staleReads,0);
  assert.equal(f.actions.filter(([method])=>method==='Input.insertText').length,1);
});

test('an unchanged field with no input events activates the original tab and retries native input once', async () => {
  const f = keyboardFixture({ value: '', ignoreNativeBeforeActivation: true });
  const result = await f.bridge.fill('#spec', '20L', 'keyboard', '');
  assert.equal(f.input.value, '20L');
  assert.equal(f.actions.filter(([method]) => method === 'Input.insertText').length, 2);
  assert.equal(f.actions.filter(([method]) => method === 'Page.bringToFront').length, 1);
  assert.equal(f.actions.some(([,params]) => params.key === 'Enter'), false);
  assert.deepEqual(result.trace.find(item => item.stage === 'after_insert').events, []);
  assert.deepEqual(result.trace.find(item => item.stage === 'after_native_retry').events.map(item => item.type), ['beforeinput', 'input']);
  assert.equal(f.attrs.size, 0);
  assert.equal([...f.listeners.values()].every(set => set.size === 0), true);
  assert.equal(Object.keys(f.context).some(key => key.startsWith('__goodsInput_')), false);
});

test('missing input receipts after the bounded native retry stops without Tab or further writes', async () => {
  const f = keyboardFixture({ value: '', ignoreNativeAlways: true });
  await assert.rejects(f.bridge.fill('#spec', '20L', 'keyboard', ''), error => error.code === 'platform_changed'
    && /激活原标签并重试一次后仍未写入/.test(error.message)
    && error.details.trace.some(item => item.stage === 'after_native_retry' && item.events.length === 0));
  assert.equal(f.input.value, '');
  assert.equal(f.actions.filter(([method]) => method === 'Input.insertText').length, 2);
  assert.equal(f.actions.filter(([method]) => method === 'Page.bringToFront').length, 1);
  assert.equal(f.actions.some(([method]) => method === 'Input.dispatchKeyEvent'), false);
  assert.equal(f.attrs.size, 0);
  assert.equal([...f.listeners.values()].every(set => set.size === 0), true);
});

test('received input events followed by a page clear never cause activation or retyping', async () => {
  const f = keyboardFixture({ value: '', clearAfterInsert: true });
  f.bridge.wait = async check => { if (await check()) return true; throw new ExecutionError('page_timeout', '未确认'); };
  await assert.rejects(f.bridge.fill('#spec', '20L', 'keyboard', '', async () => false), error => {
    const inserted = error.details.trace.find(item => item.stage === 'after_insert');
    return inserted.value === '' && inserted.events.some(item => item.type === 'input' && item.value === '20L' && item.valueAfter === '');
  });
  assert.equal(f.actions.filter(([method]) => method === 'Input.insertText').length, 1);
  assert.equal(f.actions.some(([method]) => method === 'Page.bringToFront'), false);
});

test('activation cannot retry into changed content or a changed page, and password fields are never observed', async () => {
  for (const options of [{ changeOnActivation: true }, { navigateOnActivation: true }]) {
    const f = keyboardFixture({ value: '', ignoreNativeBeforeActivation: true, ...options });
    await assert.rejects(f.bridge.fill('#spec', '20L', 'keyboard', ''), /激活原标签后规格输入现场已变化/);
    assert.equal(f.actions.filter(([method]) => method === 'Input.insertText').length, 1);
    assert.equal(f.actions.some(([method]) => method === 'Input.dispatchKeyEvent'), false);
    if (options.changeOnActivation) assert.equal(f.input.value, '运营新填写');
  }
  const f = keyboardFixture({ type: 'password' });
  await assert.rejects(f.bridge.fill('#spec', '20L', 'keyboard'), /未就绪/);
  assert.deepEqual(f.actions, []);
  assert.equal(f.listeners.size, 0);
});

test('byte upload fallback keeps actual PNG/JPEG bytes, filename extensions and MIME types consistent', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goods-byte-upload-'));
  const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0]);
  const jpeg = Buffer.from([0xff,0xd8,0xff,0xe0,0,0]);
  const first = path.join(directory, 'main-0'), second = path.join(directory, 'sku-gray.png');
  fs.writeFileSync(first,png); fs.writeFileSync(second,jpeg);
  const bridge = new BrowserBridge(), changes = [], input = { dispatchEvent(event) { changes.push(event.type); } };
  bridge.call = async action => { assert.equal(action,'upload'); throw new Error('file access denied'); };
  class DataTransfer {
    files = [];
    items = { add: file => this.files.push(file) };
  }
  class File {
    constructor(parts,name,options) { this.bytes = Buffer.from(parts[0]); this.name = name; this.type = options.type; }
  }
  bridge.eval = async code => vm.runInNewContext(code, { document: { querySelector: () => input }, DataTransfer, File,
    Event: class { constructor(type) { this.type=type; } }, atob: value => Buffer.from(value,'base64').toString('binary') });
  try {
    await bridge.uploadMany('#image-input',[{path:first,name:'主图.jpg'},{path:second,name:'规格图.png'}]);
    assert.deepEqual(input.files.map(file => [file.name,file.type]), [['main-0.png','image/png'],['sku-gray.jpg','image/jpeg']]);
    assert.ok(input.files[0].bytes.equals(png)); assert.ok(input.files[1].bytes.equals(jpeg));
    assert.deepEqual(changes,['change']);
    fs.writeFileSync(first,'not an image');
    await assert.rejects(bridge.uploadMany('#image-input',[{path:first,name:'主图.png'}]),/无法确认图片格式/);
    assert.deepEqual(changes,['change'],'a misleading label cannot submit invalid bytes');
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});

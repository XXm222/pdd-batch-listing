const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { PddAdapter } = require('../dist-electron/electron/platforms/pdd-adapter');

// Run the production browser expression against a small DOM tree. It deliberately
// includes the unrelated batch, SKU-row and page-level inputs that must be ignored.
class Element {
  constructor(tag, text = '', attributes = {}, children = []) {
    this.tagName = tag;
    this.ownText = text;
    this.attributes = { ...attributes };
    this.children = [];
    this.type = attributes.type || 'text';
    this.value = attributes.value || '';
    this.disabled = !!attributes.disabled;
    this.readOnly = !!attributes.readOnly;
    for (const child of children) this.append(child);
  }
  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }
  get innerText() {
    return this.textContent;
  }
  getClientRects() {
    return this.closest('[hidden]') ? [] : [{}];
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  matches(selector) {
    return selector.split(',').some((part) => {
      if (part === '*') return true;
      if (part.startsWith('#')) return this.attributes.id === part.slice(1);
      const match = /^(\w+)?(?:\[([^=\]]+)(?:="([^"]*)")?\])?$/.exec(part);
      assert.ok(match, `unsupported fixture selector ${part}`);
      return (
        (!match[1] || this.tagName === match[1]) &&
        (!match[2] ||
          (match[2] in this.attributes &&
            (match[3] === undefined || this.attributes[match[2]] === match[3])))
      );
    });
  }
  closest(selector) {
    return this.matches(selector) ? this : this.parentElement?.closest(selector) || null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}
const el = (tag, text = '', attributes = {}, children = []) =>
  new Element(tag, text, attributes, children);
function field(attributes = {}, wrapper = 'div') {
  const input = el('input', '', attributes);
  return {
    input,
    root: el(wrapper, '', {}, [
      el('span', '', {}, [el('span', '商品编码')]),
      el('div', '', {}, [input]),
    ]),
  };
}
function fixture(...summaries) {
  const rowCode = field({ value: 'row-code' });
  const table = el('table', '拼单价 库存', {}, [
    el('tbody', '', {}, [el('tr', '', {}, [el('td', '', {}, [rowCode.root])])]),
  ]);
  const batch = el('div', '', {}, [
    el('label', '批量规格编码'),
    el('input', '', { value: 'batch-code' }),
  ]);
  const region = el('section', '', {}, [
    batch,
    el('div', '', {}, [table]),
    ...summaries.map((summary) => summary.root),
  ]);
  const global = field({ value: 'outside-sku' });
  const body = el('body', '', {}, [region, global.root]);
  const adapter = new PddAdapter('/isolated', async () => assert.fail('no credentials'));
  const evaluate = (code) =>
    JSON.parse(
      JSON.stringify(
        vm.runInNewContext(code, {
          document: body,
          getComputedStyle: () => ({ visibility: 'visible' }),
        }),
      ),
    );
  adapter.bridge = { eval: async (code) => evaluate(code) };
  return { adapter, region, table, rowCode, batch, body, global, evaluate };
}

test('summary-bar product code resolves without a Beast label and reads the same input it marks', async () => {
  const summary = field({ value: 'PRODUCT-001' }),
    f = fixture(summary);
  const result = await f.adapter.productCodeControl();
  assert.deepEqual(result, {
    selector: 'input[data-goods-product-code="true"]',
    value: 'PRODUCT-001',
  });
  assert.equal(f.body.querySelector(result.selector), summary.input);
  assert.equal(f.rowCode.input.attributes['data-goods-product-code'], undefined);
  assert.equal(f.global.input.attributes['data-goods-product-code'], undefined);
});

test('traditional labelled form item remains supported within the SKU region', async () => {
  const summary = field({ value: 'FORM-CODE' });
  summary.root.attributes['data-testid'] = 'beast-core-form-item';
  summary.root.children[0].tagName = 'label';
  assert.equal((await fixture(summary).adapter.productCodeControl()).value, 'FORM-CODE');
});

test('two visible summary controls are ambiguous and neither is marked', async () => {
  const first = field(),
    second = field(),
    f = fixture(first, second);
  await assert.rejects(
    f.adapter.productCodeControl(),
    (error) => error.code === 'platform_changed' && /多个商品编码/.test(error.message),
  );
  assert.equal(f.body.querySelector('[data-goods-product-code]'), null);
});

test('SKU-row and unrelated page inputs cannot substitute for a missing summary control', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.productCodeControl(), /未找到唯一可填写/);
  assert.equal(f.body.querySelector('[data-goods-product-code]'), null);
});

test('password/file/readonly/disabled/hidden inputs and multi-input containers are rejected', async () => {
  for (const attributes of [
    { type: 'password' },
    { type: 'file' },
    { readOnly: true },
    { disabled: true },
    { hidden: '' },
  ]) {
    const summary = field(attributes);
    await assert.rejects(fixture(summary).adapter.productCodeControl(), /未找到唯一可填写/);
  }
  const summary = field();
  summary.root.append(el('input'));
  await assert.rejects(fixture(summary).adapter.productCodeControl(), /未找到唯一可填写/);
});

test('batch-code containers and entire product-form containers are not used as a fallback', async () => {
  const summary = field();
  summary.root.append(el('span', '批量规格编码'));
  await assert.rejects(fixture(summary).adapter.productCodeControl(), /未找到唯一可填写/);
  const other = field(),
    f = fixture(other);
  f.region.append(el('input', '', { 'data-tracking-click-viewid': 'title_input_area' }));
  await assert.rejects(f.adapter.productCodeControl(), /未找到唯一可填写/);
});

test('re-rendered summary input is re-located and its current value is used by verification', async () => {
  const summary = field({ value: 'PRODUCT-001' }),
    f = fixture(summary);
  await f.adapter.productCodeControl();
  const replacement = el('input', '', { value: 'CHANGED' });
  summary.input.parentElement.children = [];
  summary.root.children[1].append(replacement);
  assert.equal((await f.adapter.productCodeControl()).value, 'CHANGED');
  const p = {
    title: 'title',
    category: 'category',
    code: 'PRODUCT-001',
    skus: [
      {
        options: [{ name: '颜色', value: '紫色' }],
        stock: '1',
        group: '2',
        single: '3',
        code: 'sku',
      },
    ],
  };
  f.adapter.table = async () => ({
    headers: ['颜色', '库存', '拼单价(元)', '单买价(元)', '规格编码'],
    rows: [
      {
        cells: [{ text: '紫色' }, { value: '1' }, { value: '2' }, { value: '3' }, { value: 'sku' }],
      },
    ],
  });
  f.adapter.check = (kind, ok, message) => {
    if (!ok) throw new Error(message);
  };
  f.adapter.bridge.eval = async (code) =>
    code.includes('const tables=')
      ? f.evaluate(code)
      : code.includes('title_input_area')
        ? 'title'
        : true;
  await assert.rejects(f.adapter.verify(p), /商品编码与资料不同/);
});

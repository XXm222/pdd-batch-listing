const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { PddAdapter } = require('../dist-electron/electron/platforms/pdd-adapter');
const { ExecutionError } = require('../dist-electron/electron/execution');

function product() {
  return {
    code: 'SKU-RESUME',
    skus: ['紫', '灰'].flatMap((color, i) =>
      ['10L', '20L', '30L'].map((size, j) => ({
        options: [
          { name: '颜色', value: color },
          { name: '容量', value: size },
        ],
        code: `00${i}${j}`,
        stock: String(i + j),
        group: `2${i}.${j}0`,
        single: `3${i}.${j}0`,
      })),
    ),
    images: {},
  };
}

function fixture(initial = [], behavior = {}) {
  const rows = structuredClone(initial).map((row) => ({
    ...row,
    committedValues: [...row.values],
    empty: true,
  }));
  const adapter = new PddAdapter('/isolated', async () =>
    assert.fail('SKU work must not decrypt credentials'),
  );
  const calls = [],
    pending = [],
    written = new Map();
  let readCount = 0,
    currentType = -1,
    matrixCommitted = !(behavior.defaultTable || behavior.partialTable);
  const later = (reads, work) => pending.push({ at: readCount + reads, work });
  adapter.specRows = async () => {
    readCount++;
    for (const operation of pending.filter((p) => p.at <= readCount)) operation.work();
    for (let i = pending.length - 1; i >= 0; i--)
      if (pending[i].at <= readCount) pending.splice(i, 1);
    return rows.map((row, i) => ({
      name: row.name,
      values: [...row.values],
      valueSelectors: row.values.map((_, j) => `value-${i}-${j}-${readCount}`),
      typeSelector: `type-${i}-${readCount}`,
      emptySelector: row.empty ? `empty-${i}-${readCount}` : null,
      controls: [],
      buttons: [],
      choices: [],
    }));
  };
  const table = () => {
    if (!matrixCommitted && behavior.partialTable) {
      const headers = [
        behavior.partialName || '颜色',
        '库存',
        '拼单价(元)',
        '单买价(元)',
        '规格编码',
      ];
      return {
        headers,
        rows: (behavior.partialValues || ['紫', '灰']).map((value, index) => ({
          index,
          cells: headers.map((_, column) => ({
            text: column === 0 ? value : '',
            value: '',
            rowSpan: 1,
            colSpan: 1,
            selector: `table[data-goods-table="sku"] tbody tr:nth-child(${index + 1}) td:nth-child(${column + 1})`,
          })),
        })),
      };
    }
    if (!matrixCommitted)
      return {
        headers: ['库存', '拼单价(元)', '单买价(元)', '规格编码'],
        rows: [{ index: 0, cells: [] }],
      };
    const dimensions = rows.filter((row) => row.name && row.committedValues?.length);
    const headers = [
      ...dimensions.map((row) => row.name),
      '库存',
      '拼单价(元)',
      '单买价(元)',
      '规格编码',
    ];
    const combinations = dimensions
      .reduce(
        (all, row) => all.flatMap((values) => row.committedValues.map((v) => [...values, v])),
        [[]],
      )
      .reverse();
    return {
      headers,
      rows: combinations.map((values, index) => ({
        index,
        cells: headers.map((_, column) => ({
          text: values[column] || '',
          value: '',
          rowSpan: 1,
          colSpan: 1,
          selector: `table[data-goods-table="sku"] tbody tr:nth-child(${index + 1}) td:nth-child(${column + 1})`,
        })),
      })),
    };
  };
  adapter.table = async () => table();
  adapter.productCodeControl = async () => ({
    selector: 'input[data-goods-product-code="true"]',
    value: '',
  });
  adapter.bridge = {
    async clickName(role, name) {
      assert.equal(role, 'button');
      assert.equal(name, '添加规格类型(');
      calls.push('add-type');
      later(2, () => rows.push({ name: '', values: [], committedValues: [], empty: false }));
    },
    async call(action, args) {
      assert.equal(action, 'click');
      calls.push(['click', args.selector]);
      const type = /^type-(\d+)-(\d+)$/.exec(args.selector);
      if (type) {
        assert.equal(Number(type[2]), readCount, 'use freshly read type control');
        currentType = Number(type[1]);
        return;
      }
      const option = /^option-(颜色|容量)$/.exec(args.selector);
      assert.ok(option, 'only observed spec options may be clicked');
      const row = rows[currentType];
      later(2, () => {
        row.name = option[1];
      });
      later(4, () => {
        row.empty = true;
      });
    },
    async snapshot() {
      return {
        tree: ['颜色', '容量'].map((name) => ({ role: 'option', name, ref: `option-${name}` })),
      };
    },
    async wait(check, _timeout, message) {
      for (let i = 0; i < 20; i++) {
        const value = await check();
        if (value) return value;
      }
      throw new ExecutionError('page_timeout', message);
    },
    async fill(selector, value, mode, expectedBefore, confirmAccepted) {
      calls.push(['fill', selector, value, mode, expectedBefore]);
      const existing = /^value-(\d+)-(\d+)-(\d+)$/.exec(selector);
      if (existing) {
        assert.equal(mode, 'keyboard');
        assert.equal(expectedBefore, value);
        assert.equal(Number(existing[3]), readCount);
        assert.equal(
          rows[Number(existing[1])].values[Number(existing[2])],
          value,
          'recommit only the exact existing value',
        );
        if (behavior.nativeCommits !== false) matrixCommitted = true;
        return;
      }
      const empty = /^empty-(\d+)-(\d+)$/.exec(selector);
      if (empty) {
        assert.equal(mode, 'keyboard');
        assert.equal(expectedBefore, '');
        assert.equal(
          typeof confirmAccepted,
          'function',
          'native input must have a business-level acknowledgement',
        );
        assert.equal(Number(empty[2]), readCount, 'use freshly read value control');
        const row = rows[Number(empty[1])];
        assert.equal(row.empty, true);
        assert.deepEqual(
          row.committedValues,
          row.values,
          'do not type another value while the previous async lookup is pending',
        );
        row.empty = false;
        later(2, () => {
          if (!behavior.neverCommit) {
            row.values.push(value);
            if (behavior.reorder) row.values.reverse();
          }
        });
        later(4, () => {
          if (!behavior.neverCommit) row.committedValues = [...row.values];
          row.empty = true;
        });
        return {
          trace: [
            { stage: 'after_insert', value },
            { stage: 'after_tab', value: behavior.neverCommit ? '' : value },
          ],
        };
      }
      const cell = /tbody tr:nth-child\((\d+)\) td:nth-child\((\d+)\)/.exec(selector);
      if (cell) {
        const current = table(),
          row = current.rows[Number(cell[1]) - 1],
          header = current.headers[Number(cell[2]) - 1];
        written.set(`${row.cells[0].text}|${row.cells[1].text}|${header}`, value);
        return;
      }
      assert.equal(selector, 'input[data-goods-product-code="true"]');
    },
    async eval() {
      assert.fail('SKU matrix fixture must use the separately verified product code locator');
    },
    async navigate() {
      assert.fail('SKU resume must not navigate or allocate a goods ID');
    },
  };
  return { adapter, rows, calls, written };
}

test('two dimensions wait for type rendering, value commit and the next empty control, then map six SKU prices by values', async () => {
  const f = fixture(),
    p = product();
  await f.adapter.skus(p);
  assert.deepEqual(
    f.rows.map(({ name, values }) => ({ name, values })),
    [
      { name: '颜色', values: ['紫', '灰'] },
      { name: '容量', values: ['10L', '20L', '30L'] },
    ],
  );
  assert.equal(f.calls.filter((call) => call === 'add-type').length, 2);
  assert.equal(f.calls.filter((call) => Array.isArray(call) && /^empty-/.test(call[1])).length, 5);
  for (const sku of p.skus) {
    const key = sku.options.map((option) => option.value).join('|');
    for (const [header, field] of [
      ['库存', 'stock'],
      ['拼单价(元)', 'group'],
      ['单买价(元)', 'single'],
      ['规格编码', 'code'],
    ])
      assert.equal(f.written.get(`${key}|${header}`), sku[field]);
  }
});

test('an interrupted original form keeps its valid prefix and fills only missing values and types', async () => {
  const f = fixture([
    { name: '颜色', values: ['紫'] },
    { name: '', values: [] },
  ]);
  await f.adapter.skus(product());
  assert.equal(f.calls.includes('add-type'), false);
  const values = f.calls
    .filter((call) => Array.isArray(call) && /^empty-/.test(call[1]))
    .map((call) => call[2]);
  assert.deepEqual(values, ['灰', '10L', '20L', '30L']);
});

test('a fully filled original SKU matrix is read and reused without adding or rewriting spec values', async () => {
  const f = fixture([
    { name: '颜色', values: ['紫', '灰'] },
    { name: '容量', values: ['10L', '20L', '30L'] },
  ]);
  await f.adapter.skus(product());
  assert.equal(
    f.calls.some(
      (call) => call === 'add-type' || (Array.isArray(call) && /^empty-|^type-/.test(call[1])),
    ),
    false,
  );
});

test('conflicting existing spec values stop before mutating the original form', async () => {
  const f = fixture([{ name: '颜色', values: ['红'] }]);
  await assert.rejects(
    f.adapter.skus(product()),
    (error) => error.code === 'form_changed' && error.recovery === 'restart_form',
  );
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.rows[0].values, ['红']);
});

test('an incomplete Cartesian product is rejected before touching any browser control', async () => {
  const f = fixture(),
    p = product();
  p.skus.pop();
  await assert.rejects(f.adapter.skus(p), /未覆盖后台生成的全部组合/);
  assert.deepEqual(f.calls, []);
});

test('missing writable spec input reports only the observed spec controls without guessing a new selector', async () => {
  const f = fixture();
  f.adapter.specRows = async () => [
    {
      name: '颜色',
      values: [],
      typeSelector: 'type-0',
      emptySelector: null,
      controls: [{ placeholder: '新的规格输入提示', readOnly: true, disabled: false, value: '' }],
      buttons: ['添加选项'],
    },
  ];
  await assert.rejects(
    f.adapter.skus(product()),
    (error) =>
      error.code === 'platform_changed' &&
      error.recovery === 'inspect_form' &&
      /没有可填写的输入框/.test(error.message) &&
      error.details.observed.inputs[0].placeholder === '新的规格输入提示' &&
      error.details.observed.inputs[0].readOnly === true &&
      error.details.observed.buttons.includes('添加选项'),
  );
  assert.deepEqual(f.calls, []);
});

test('current DOM spec reader chooses only visible editable known value inputs and collects bounded control facts', async () => {
  function input(placeholder, value = '', flags = {}) {
    const attrs = new Map();
    return {
      placeholder,
      value,
      type: 'text',
      readOnly: false,
      disabled: false,
      getClientRects() {
        return this.hidden ? [] : [{}];
      },
      setAttribute: (key, text) => attrs.set(key, text),
      removeAttribute: (key) => attrs.delete(key),
      attrs,
      ...flags,
    };
  }
  const type = input('规格类型1', '颜色');
  const filled = input('请输入规格名称', '紫');
  const readonly = input('请输入规格名称', '', { readOnly: true });
  const disabled = input('请输入规格名称', '', { disabled: true });
  const editable = input('请输入规格名称');
  const hidden = input('请输入规格名称', '不得读取的隐藏值', { hidden: true });
  const inputs = [type, filled, readonly, disabled, editable, hidden];
  const row = {
    getClientRects: () => [{}],
    querySelector: () => type,
    querySelectorAll(selector) {
      if (selector === 'input[placeholder="请输入规格名称"]') return inputs.slice(1);
      if (selector === 'input') return inputs;
      if (selector === 'button,[role=button]')
        return [{ textContent: '添加选项', getClientRects: () => [{}] }];
      if (selector === '[role=checkbox],[role=radio],[aria-selected],[aria-pressed]') return [];
      throw new Error(`unexpected row selector ${selector}`);
    },
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === '.goods-spec-row') return [row];
      if (selector === '[data-goods-spec-type],[data-goods-spec-empty],[data-goods-spec-value]')
        return inputs.filter((i) => i.attrs.size);
      throw new Error(`unexpected document selector ${selector}`);
    },
  };
  const adapter = new PddAdapter('/isolated', async () => assert.fail('not needed'));
  adapter.bridge = {
    eval: async (code) =>
      JSON.parse(
        JSON.stringify(
          vm.runInNewContext(code, {
            document,
            getComputedStyle: () => ({ visibility: 'visible' }),
          }),
        ),
      ),
  };
  const [state] = await adapter.specRows();
  assert.equal(state.name, '颜色');
  assert.deepEqual(state.values, ['紫']);
  assert.equal(editable.attrs.get('data-goods-spec-empty'), '0');
  assert.equal(readonly.attrs.has('data-goods-spec-empty'), false);
  assert.equal(disabled.attrs.has('data-goods-spec-empty'), false);
  assert.equal(hidden.attrs.has('data-goods-spec-empty'), false);
  assert.ok(!JSON.stringify(state).includes('不得读取的隐藏值'));
  assert.deepEqual(state.buttons, ['添加选项']);
});

test('complete matching values with a default one-row table are recommitted with keyboard input and stop once all six combinations exist', async () => {
  const f = fixture(
    [
      { name: '颜色', values: ['紫', '灰'] },
      { name: '容量', values: ['10L', '20L', '30L'] },
    ],
    { defaultTable: true },
  );
  await f.adapter.skus(product());
  const commits = f.calls.filter((call) => Array.isArray(call) && call[3] === 'keyboard');
  assert.equal(commits.length, 1);
  assert.equal(commits[0][2], '紫');
  assert.equal(
    f.calls.some((call) => call === 'add-type'),
    false,
  );
  assert.deepEqual(
    f.rows.map((row) => row.values),
    [
      ['紫', '灰'],
      ['10L', '20L', '30L'],
    ],
  );
});

test('keyboard recommit runs at most once per existing value and never writes prices without a verified matrix', async () => {
  const f = fixture(
    [
      { name: '颜色', values: ['紫', '灰'] },
      { name: '容量', values: ['10L', '20L', '30L'] },
    ],
    { defaultTable: true, nativeCommits: false },
  );
  await assert.rejects(
    f.adapter.skus(product()),
    (error) =>
      error.code === 'platform_changed' &&
      /1 \/ 6 个组合/.test(error.message) &&
      error.details.observed.expectedRows === 6 &&
      error.details.observed.rowCount === 1 &&
      error.details.observed.specs.every((row) => Array.isArray(row.choices)),
  );
  assert.equal(f.calls.filter((call) => Array.isArray(call) && call[3] === 'keyboard').length, 5);
  assert.equal(f.written.size, 0);
});

test('a verified partial color matrix can recommit matching inputs until the second dimension is generated', async () => {
  const f = fixture(
    [
      { name: '颜色', values: ['紫', '灰'] },
      { name: '容量', values: ['10L', '20L', '30L'] },
    ],
    { partialTable: true },
  );
  await f.adapter.skus(product());
  const commits = f.calls.filter((call) => Array.isArray(call) && /^value-/.test(call[1]));
  assert.equal(commits.length, 1);
  assert.equal(commits[0][4], commits[0][2]);
  assert.equal(f.written.size, 24);
});

test('foreign, duplicate or unexpected-dimension partial rows cannot trigger input recommit', async () => {
  for (const behavior of [
    { partialValues: ['红'] },
    { partialValues: ['紫', '紫'] },
    { partialName: '型号' },
  ]) {
    const f = fixture(
      [
        { name: '颜色', values: ['紫', '灰'] },
        { name: '容量', values: ['10L', '20L', '30L'] },
      ],
      { partialTable: true, ...behavior },
    );
    await assert.rejects(f.adapter.skus(product()), (error) => error.code === 'platform_changed');
    assert.equal(
      f.calls.some((call) => Array.isArray(call) && call[3] === 'keyboard'),
      false,
    );
    assert.equal(f.written.size, 0);
  }
});

test('reordered existing options are matched by their values and never duplicated on resume', async () => {
  const f = fixture([
    { name: '颜色', values: ['灰', '紫'] },
    { name: '容量', values: ['30L', '10L', '20L'] },
  ]);
  await f.adapter.skus(product());
  assert.equal(
    f.calls.some((call) => Array.isArray(call) && call[3] === 'keyboard'),
    false,
  );
  assert.equal(f.written.size, 24);
});

test('option reordering during rendering preserves all six SKU price mappings', async () => {
  const f = fixture([], { reorder: true }),
    p = product();
  await f.adapter.skus(p);
  assert.equal(f.calls.filter((call) => Array.isArray(call) && call[3] === 'keyboard').length, 5);
  for (const sku of p.skus) {
    const key = sku.options.map((option) => option.value).join('|');
    assert.equal(f.written.get(`${key}|拼单价(元)`), sku.group);
    assert.equal(f.written.get(`${key}|库存`), sku.stock);
  }
});

test('unconfirmed option commit retains observed facts and never enters price filling', async () => {
  const f = fixture([], { neverCommit: true });
  await assert.rejects(
    f.adapter.skus(product()),
    (error) =>
      error.code === 'platform_changed' &&
      error.recovery === 'inspect_form' &&
      /输入后未确认/.test(error.message) &&
      error.details.source === 'spec_confirmation' &&
      error.details.expected.value === '紫' &&
      Array.isArray(error.details.observed.inputs) &&
      error.details.inputTrace.some((event) => event.stage === 'after_tab' && event.value === ''),
  );
  assert.equal(f.written.size, 0);
  assert.equal(f.calls.filter((call) => Array.isArray(call) && call[3] === 'keyboard').length, 1);
});

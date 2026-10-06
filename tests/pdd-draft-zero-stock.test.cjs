const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  confirmedDraftZeroStocks,
  PddAdapter,
} = require('../dist-electron/electron/platforms/pdd-adapter');
const { ExecutionError } = require('../dist-electron/electron/execution');
const task = {
  goodsId: '101',
  formUrl: 'https://mms.pinduoduo.com/goods/goods_add/index?id=202&goods_id=101&type=edit',
  saveAttemptedAt: 'saved',
};
const product = {
  title: '六规格核验',
  code: 'CODE',
  skus: ['紫色', '灰色'].flatMap((color) =>
    ['10L', '20L', '30L'].map((size, i) => ({
      options: [
        { name: '颜色', value: color },
        { name: '容量', value: size },
      ],
      stock: String(i),
      group: '29.90',
      single: '31.90',
      code: color + size,
    })),
  ),
};
function response() {
  return {
    success: true,
    result: {
      id: 202,
      goods_id: 101,
      goods_name: product.title,
      out_goods_sn: product.code,
      sku: product.skus.map((s) => ({
        spec: s.options.map((o) => ({ parent_name: o.name, spec_name: o.value })),
        quantity: 0,
        quantity_delta: Number(s.stock),
        multi_price: 2990,
        price: 3190,
        out_sku_sn: s.code,
      })),
    },
  };
}
test('zero stock is established by exact original commit, complete combinations, prices and codes', () => {
  const b = response();
  b.result.sku.reverse();
  assert.deepEqual(confirmedDraftZeroStocks(b, task, product), [0, 3]);
});
test('wrong goods, commit, title, code, duplicated combination or price never establishes a blank zero', () => {
  for (const mutate of [
    (b) => (b.success = false),
    (b) => (b.result.goods_id = 999),
    (b) => (b.result.id = 999),
    (b) => (b.result.goods_name = 'other'),
    (b) => (b.result.out_goods_sn = 'other'),
    (b) => b.result.sku.pop(),
    (b) => (b.result.sku[1] = b.result.sku[0]),
    (b) => (b.result.sku[1].price = 0),
    (b) => (b.result.sku[1].out_sku_sn = 'other'),
  ]) {
    const b = response();
    mutate(b);
    assert.deepEqual(confirmedDraftZeroStocks(b, task, product), []);
  }
  assert.deepEqual(
    confirmedDraftZeroStocks(response(), { ...task, saveAttemptedAt: undefined }, product),
    [],
  );
});
test('missing, null, string zero, or nonzero server quantities do not establish zero', () => {
  for (const value of [undefined, null, '0', 1])
    for (const field of ['quantity', 'quantity_delta']) {
      const b = response();
      b.result.sku[0][field] = value;
      assert.deepEqual(confirmedDraftZeroStocks(b, task, product), [3]);
    }
});
test('only blank saved stock with a real control and a captured server zero can pass', async () => {
  const p = { code: 'CODE', skus: [product.skus[0]] };
  const a = new PddAdapter('/unused', async () => assert.fail());
  a.task = task;
  a.context = { guard() {} };
  const headers = ['颜色', '容量', '库存', '拼单价(元)', '单买价(元)', '规格编码'];
  a.table = async () => ({
    headers,
    rows: [
      {
        cells: headers.map((_, i) => ({
          text: i < 2 ? ['紫色', '10L'][i] : '',
          value: ['', '', '', '29.90', '31.90', p.skus[0].code][i],
          control: i === 2 ? { type: 'text' } : undefined,
        })),
      },
    ],
  });
  a.productCodeControl = async () => ({ value: 'CODE' });
  a.bridge = {
    wait: async (_c, _t, m) => {
      throw new ExecutionError('page_timeout', m);
    },
  };
  a.capturedZeroStocks = async () => new Set([0]);
  await a.verifySkus(p, 'saved');
  await assert.rejects(a.verifySkus(p, 'form'), /空白/);
});

test('malformed captured bodies never establish zero stock or throw a shape error', () => {
  for (const body of [null, {}, { success: true, result: null }, { success: true, result: [] }])
    assert.deepEqual(confirmedDraftZeroStocks(body, task, product), []);
  for (const mutate of [
    (b) => (b.result.sku[0] = null),
    (b) => (b.result.sku[0].spec[0] = null),
    (b) => (b.result.sku[0].spec = 'invalid'),
  ]) {
    const body = response();
    mutate(body);
    assert.deepEqual(confirmedDraftZeroStocks(body, task, product), []);
  }
});

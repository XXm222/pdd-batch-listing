const test = require('node:test');
const assert = require('node:assert/strict');
const { PddAdapter } = require('../dist-electron/electron/platforms/pdd-adapter');
const { ExecutionError, classifyError } = require('../dist-electron/electron/execution');

test('saved draft readback opens a fresh server editor without navigating or discarding the original tab', async () => {
  const task = {
    goodsId: '1012777690971',
    saveAttemptedAt: '2026-10-05T07:05:21.388Z',
    formUrl:
      'https://mms.pinduoduo.com/goods/goods_add/index?id=202828498645&goods_id=1012777690971&type=add',
    productSnapshot: {},
  };
  const adapter = new PddAdapter('/unused', async () =>
    assert.fail('readback must not decrypt credentials'),
  );
  const navigations = [];
  adapter.timed = async (_task, _name, work) => work();
  adapter.checkIdentity = async () => {};
  adapter.verify = async (_product, stage) => {
    assert.equal(stage, 'saved');
    throw new Error('actual inventory mismatch');
  };
  adapter.bridge = {
    navigate: async (url, options) => navigations.push({ url, options }),
    wait: async (check) => check(),
    eval: async (code) => code.includes('title_input_area'),
    call: async () => assert.fail('a failed readback must never save or accept a discard dialog'),
  };
  await assert.rejects(adapter.readback(task, {}), /actual inventory mismatch/);
  assert.equal(navigations.length, 1);
  const opened = new URL(navigations[0].url);
  assert.equal(opened.searchParams.get('goods_id'), task.goodsId);
  assert.equal(opened.searchParams.get('type'), 'edit');
  assert.deepEqual(navigations[0].options, { newTab: true });
  assert.equal(task.saveAttemptedAt, '2026-10-05T07:05:21.388Z');
});

function numericReadback(values, expectedStock = '0', field = '库存') {
  const adapter = new PddAdapter('/unused', async () =>
    assert.fail('numeric readback must not decrypt credentials'),
  );
  const product = {
    code: 'original-code',
    skus: [
      {
        stock: expectedStock,
        group: '29.90',
        single: '31.90',
        code: '001',
        options: [
          { name: '颜色', value: '紫色' },
          { name: '容量', value: '10L' },
        ],
      },
    ],
  };
  adapter.task = { goodsId: 'original-goods', saveAttemptedAt: 'saved-intent' };
  adapter.context = { guard() {} };
  const headers = ['颜色', '容量', '库存', '拼单价(元)', '单买价(元)', '规格编码'];
  let reads = 0,
    waits = 0;
  adapter.table = async () => {
    const current = values[Math.min(reads++, values.length - 1)];
    return {
      headers,
      rows: [
        {
          index: 0,
          cells: headers.map((label, i) => ({
            text: i < 2 ? ['紫色', '10L'][i] : '',
            value:
              label === field
                ? current
                : i === 2
                  ? expectedStock
                  : i === 3
                    ? '29.90'
                    : i === 4
                      ? '31.90'
                      : i === 5
                        ? '001'
                        : '',
            selector: 'physical-' + i,
            rowSpan: 1,
            colSpan: 1,
            ...(i === 2
              ? {
                  control: {
                    type: 'text',
                    placeholder: '0',
                    valueAttribute: null,
                    disabled: false,
                    readOnly: false,
                  },
                }
              : {}),
          })),
        },
      ],
    };
  };
  adapter.productCodeControl = async () => ({ value: 'original-code' });
  adapter.bridge = {
    wait: async (check, timeout, message) => {
      waits++;
      assert.equal(timeout, 3000);
      for (let i = 0; i < 3; i++) if (await check()) return true;
      throw new ExecutionError('page_timeout', message);
    },
  };
  return { adapter, product, reads: () => reads, waits: () => waits };
}

test('saved SKU inputs are allowed to finish loading before comparing a real zero stock', async () => {
  const f = numericReadback(['', '0']);
  await f.adapter.verifySkus(f.product, 'saved');
  assert.equal(f.reads(), 2);
  assert.equal(f.waits(), 1);
  const ready = numericReadback(['0']);
  await ready.adapter.verifySkus(ready.product, 'saved');
  assert.equal(ready.reads(), 1);
  assert.equal(ready.waits(), 0);
});

test('persistent blank stock or price is not inferred as zero, and saved errors retain original-goods evidence', async () => {
  for (const [expected, field] of [
    ['0', '库存'],
    ['12', '库存'],
    ['0', '拼单价(元)'],
  ]) {
    const f = numericReadback([''], expected, field);
    await assert.rejects(f.adapter.verifySkus(f.product, 'saved'), (error) => {
      assert.equal(error.code, 'page_timeout');
      assert.equal(error.recovery, 'readback');
      assert.match(error.message, /尚无法读回/);
      assert.equal(error.details.goodsId, 'original-goods');
      assert.equal(error.details.fields[0].observed, '');
      assert.equal(error.details.fields[0].field, field);
      if (field === '库存')
        assert.equal(
          error.details.fields[0].control.placeholder,
          '0',
          'a placeholder is evidence, never a confirmed quantity',
        );
      const classified = classifyError(error, f.adapter.task);
      assert.equal(classified.code, 'save_uncertain');
      assert.equal(classified.recovery, 'readback');
      assert.deepEqual(classified.details, error.details);
      return true;
    });
    assert.equal(f.adapter.task.goodsId, 'original-goods');
    assert.equal(f.adapter.task.saveAttemptedAt, 'saved-intent');
  }
});

test('a real saved quantity mismatch still fails and form verification does not wait or accept blanks', async () => {
  const different = numericReadback(['2']);
  await assert.rejects(
    different.adapter.verifySkus(different.product, 'saved'),
    (error) =>
      error.code === 'form_changed' &&
      error.details.fields[0].expected === '0' &&
      error.details.fields[0].observed === '2',
  );
  assert.equal(different.waits(), 0);
  const blank = numericReadback(['']);
  await assert.rejects(blank.adapter.verifySkus(blank.product, 'form'), /页面 空白/);
  assert.equal(blank.waits(), 0);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  readRemoteImages,
  readSavedSettings,
  parseSkuTable,
  parseRemoteImages,
  parseSavedSettings,
} = require('../dist-electron/electron/platforms/pdd-page-scripts');

const table = () => ({
  headers: ['颜色', '库存'],
  rows: [
    {
      index: 0,
      cells: [
        { text: '紫色', value: '', selector: 'td:first-child', rowSpan: 1, colSpan: 1 },
        {
          text: '',
          value: '0',
          selector: 'td:last-child',
          rowSpan: 1,
          colSpan: 1,
          control: {
            type: 'text',
            placeholder: '',
            valueAttribute: null,
            disabled: false,
            readOnly: false,
          },
        },
      ],
    },
  ],
});
test('untrusted SKU replies cannot disguise missing cells, zero spans or malformed controls as valid tables', () => {
  assert.deepEqual(parseSkuTable(table()), table());
  for (const mutate of [
    (t) => t.rows[0].cells.pop(),
    (t) => (t.rows[0].index = 1),
    (t) => (t.rows[0].cells[1].value = 0),
    (t) => (t.rows[0].cells[1].rowSpan = 0),
    (t) => (t.rows[0].cells[1].control.disabled = 'false'),
    (t) => (t.rows[0].cells[1] = null),
  ]) {
    const t = table();
    mutate(t);
    assert.throws(
      () => parseSkuTable(t),
      (e) => e.code === 'platform_changed' && e.recovery === 'inspect_form',
    );
  }
  assert.throws(() => parseSkuTable(null), /返回结构/);
});
test('serialized image reader runs without module helpers and excludes local previews', () => {
  const document = {
    querySelector(selector) {
      return selector.includes('carousel_gallery')
        ? {
            querySelectorAll: () => [
              { style: { backgroundImage: 'url("https://img.example/main.png")' } },
              { style: { backgroundImage: 'url("blob:preview")' } },
            ],
          }
        : {
            querySelectorAll: () => [
              { getAttribute: () => 'https://img.example/detail.png' },
              { getAttribute: () => 'blob:preview' },
            ],
          };
    },
  };
  const result = JSON.parse(
    JSON.stringify(vm.runInNewContext(`(${readRemoteImages.toString()})()`, { document })),
  );
  assert.deepEqual(parseRemoteImages(result), {
    main: ['https://img.example/main.png'],
    detail: ['https://img.example/detail.png'],
  });
});
test('image response boundary rejects counts, nulls and unsafe URLs but permits pending empty lists', () => {
  assert.deepEqual(parseRemoteImages({ main: [], detail: [] }), { main: [], detail: [] });
  for (const value of [
    { main: 1, detail: [] },
    { main: [null], detail: [] },
    { main: ['blob:preview'], detail: [] },
    { main: [], detail: ['http://img.example/a'] },
  ])
    assert.throws(
      () => parseRemoteImages(value),
      (e) => e.code === 'platform_changed',
    );
});
test('saved settings execute in page scope and missing reference remains missing instead of becoming zero', () => {
  const document = {
    querySelector(selector) {
      if (selector.includes('goods_advice_price')) return { value: '' };
      if (selector.includes('shipment_limit_second')) return { innerText: '48小时发货及揽收' };
      if (selector.includes('cost_template_id')) return { innerText: '新疆西藏不配送默认模板' };
      return null;
    },
  };
  const result = JSON.parse(
    JSON.stringify(vm.runInNewContext(`(${readSavedSettings.toString()})()`, { document })),
  );
  assert.deepEqual(parseSavedSettings(result), {
    reference: '',
    shipping: '48小时发货及揽收',
    freight: '新疆西藏不配送默认模板',
  });
  assert.equal(parseSavedSettings({}).reference, undefined);
  for (const value of [null, { reference: 0 }, { freight: false }, { shipping: null }])
    assert.throws(() => parseSavedSettings(value), /返回结构/);
});

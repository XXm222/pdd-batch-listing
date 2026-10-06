const test = require('node:test'),
  assert = require('node:assert/strict');
const { freightOptions } = require('../dist-electron/src/domain');
test('freight select preserves imported custom names and blank without silently choosing a default', () => {
  const saved = [
    { freight: '店铺自建包邮模板' },
    { freight: '' },
    { freight: '新疆西藏不配送默认模板' },
    { freight: '店铺自建包邮模板' },
  ];
  assert.deepEqual(freightOptions('导入专用模板', saved), [
    '新疆西藏不配送默认模板',
    '新疆西藏收费默认模板',
    '店铺自建包邮模板',
    '导入专用模板',
  ]);
  assert.deepEqual(freightOptions('', []), ['新疆西藏不配送默认模板', '新疆西藏收费默认模板']);
  assert.equal(saved[1].freight, '');
});

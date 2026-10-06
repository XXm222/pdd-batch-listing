const test = require('node:test'),
  assert = require('node:assert/strict');
const { newProduct, problems } = require('../dist-electron/src/domain');
const { productList } = require('../dist-electron/src/product-list');
function product(id) {
  return {
    ...newProduct('CODE-' + id, 'Product ' + id),
    id,
    category: '卫浴>泡脚桶',
    reference: '69.9',
    shipping: '48小时发货及揽收',
    skus: [{ spec: '默认规格', group: '39.9', single: '49.9', stock: '10' }],
    main: ['main.png'],
    images: {
      'main.png': {
        id: 'a'.repeat(64),
        name: 'main.png',
        url: '',
        width: 800,
        height: 800,
        bytes: 1,
      },
    },
  };
}
test('pagination, filters and selection retain hidden ready products and exclude incomplete ones', () => {
  const products = Array.from({ length: 42 }, (_, i) => product(String(i)));
  const incomplete = { ...product('missing'), title: '' };
  products.push(incomplete);
  assert.deepEqual(problems(products[0]), []);
  const selected = new Set(['0', '41', 'missing', 'removed']);
  const second = productList(products, '', 'all', 1, selected);
  assert.equal(second.rows.length, 3);
  assert.equal(second.readyRows.length, 2);
  assert.equal(second.readyCount, 42);
  assert.deepEqual(
    second.chosen.map((p) => p.id),
    ['0', '41'],
  );
  assert.equal(productList(products, ' code-41 ', 'ready', 99, selected).currentPage, 0);
  assert.equal(productList(products, ' code-41 ', 'ready', 99, selected).rows[0].id, '41');
  assert.deepEqual(
    productList(products, '', 'incomplete', 0, selected).rows.map((p) => p.id),
    ['missing'],
  );
  const empty = productList(products, 'not found', 'all', 0, selected);
  assert.equal(empty.pageCount, 1);
  assert.equal(empty.rows.length, 0);
  assert.deepEqual([...selected], ['0', '41', 'missing', 'removed']);
});

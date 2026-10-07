const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const JSZip = require('jszip');
const {
  parseSalePage,
  productFromPage,
  imageUrl,
  ShopCollector,
  readSkuPictureCells,
} = require('../dist-electron/electron/shop-collector');
const { parseWorkbook } = require('../dist-electron/electron/importer');
const { exportProductWorkbook } = require('../dist-electron/electron/workbook-export');
const { sanitizeProducts } = require('../dist-electron/electron/product-service');
const { problems } = require('../dist-electron/src/domain');

function source() {
  const goods = { goodsId: '101', title: '泡脚桶', thumbnail: '', price: '' };
  const facts = {
    url: 'https://mms.pinduoduo.com/goods/goods_add/index?goods_id=101&id=201',
    title: '泡脚桶',
    code: '0000123',
    specs: ['颜色', '容量'],
    attributes: [],
    skuImages: [],
    services: {},
  };
  const cell = (text = '', value = '') => ({
    text,
    value,
    selector: '',
    rowSpan: 1,
    colSpan: 1,
    control: {
      type: 'text',
      placeholder: '',
      valueAttribute: null,
      disabled: false,
      readOnly: false,
    },
  });
  const table = {
    headers: ['颜色', '容量', '拼单价（元）', '单买价（元）', '库存', '规格编码'],
    rows: [
      {
        index: 0,
        cells: [
          cell('紫色'),
          cell('10L'),
          cell('', '29.90'),
          cell('', '31.90'),
          cell('', ''),
          cell('', '00001'),
        ],
      },
      {
        index: 1,
        cells: [
          cell('灰色'),
          cell('20L'),
          cell('', '42.50'),
          cell('', '45.50'),
          cell('', '0'),
          cell('', '00002'),
        ],
      },
    ],
  };
  const sku = (color, volume, group, single, quantity) => ({
    spec: [
      { parent_name: '颜色', spec_name: color },
      { parent_name: '容量', spec_name: volume },
    ],
    multi_price: group,
    price: single,
    quantity,
  });
  // Offline schema check, not evidence of reading the current online editor.
  const commit = {
    success: true,
    result: {
      id: 201,
      goods_id: 101,
      goods_name: '泡脚桶',
      sku: [sku('灰色', '20L', 4250, 4550, 12), sku('紫色', '10L', 2990, 3190, 0)],
    },
  };
  const remote = { main: ['https://img.pddpic.com/main.png'], detail: [] };
  return { goods, facts, table, commit, remote };
}
test('collection matches SKU combinations independently of response order and preserves actual zero/positive quantities', () => {
  const s = source();
  const { product: p } = productFromPage(s.goods, s.facts, s.table, {}, s.remote, s.commit);
  assert.deepEqual(
    p.skus.map((v) => [v.options.map((o) => o.value), v.group, v.single, v.stock, v.code]),
    [
      [['紫色', '10L'], '29.90', '31.90', '0', '00001'],
      [['灰色', '20L'], '42.50', '45.50', '12', '00002'],
    ],
  );
  assert.equal(p.services.invoice, '');
  assert.throws(
    () =>
      productFromPage(
        s.goods,
        s.facts,
        { ...s.table, rows: s.table.rows.slice(0, 1) },
        {},
        s.remote,
        s.commit,
      ),
    /数量不同/,
  );
  s.facts.code = '';
  s.commit.result.out_goods_sn = '0000123';
  assert.equal(
    productFromPage(s.goods, s.facts, s.table, {}, s.remote, s.commit).product.code,
    '0000123',
  );
  assert.throws(() => productFromPage(s.goods, s.facts, s.table, {}, s.remote), /实际库存/);
  s.commit.result.goods_id = 999;
  assert.throws(
    () => productFromPage(s.goods, s.facts, s.table, {}, s.remote, s.commit),
    /实际库存/,
  );
  s.commit.result.goods_id = 101;
  s.commit.result.sku[0].price = 1;
  assert.throws(() => productFromPage(s.goods, s.facts, s.table, {}, s.remote, s.commit), /不一致/);
  s.facts.url = s.facts.url.replace('goods_id=101', 'goods_id=102');
  assert.throws(() => productFromPage(s.goods, s.facts, s.table, {}, s.remote, s.commit), /身份/);
});
test('当前库存与库存增减分开读取，实际零库存保留并与响应核对', () => {
  const s = source();
  s.table.headers[4] = '当前库存';
  s.table.headers.push('库存增减', '改后库存');
  s.table.rows.forEach((row, i) => {
    row.cells[4].text = i ? '12' : '0';
    row.cells.push({ text: '', value: '999' }, { text: '', value: '999' });
  });
  const p = productFromPage(s.goods, s.facts, s.table, {}, s.remote, s.commit).product;
  assert.equal(p.skus[0].stock, '0');
  assert.equal(p.skus[1].stock, '12');
  s.table.rows[0].cells[4].text = '999';
  assert.throws(
    () => productFromPage(s.goods, s.facts, s.table, {}, s.remote, s.commit),
    /当前库存.*不一致/,
  );
});
test('list requires confirmed sale state, unique IDs, recognized pagination and safe image/editor origins', () => {
  const raw = {
    ready: true,
    active: true,
    paginationKnown: true,
    hasNext: false,
    goods: [
      {
        goodsId: '00101',
        title: '泡脚桶',
        editUrl: 'https://mms.pinduoduo.com/goods/goods_add/index?goods_id=00101',
        thumbnail: 'https://img.pddpic.com/1.png',
      },
    ],
  };
  assert.equal(parseSalePage(raw).goods[0].goodsId, '00101');
  assert.throws(() => parseSalePage({ ...raw, active: false }), /在售/);
  assert.throws(() => parseSalePage({ ...raw, paginationKnown: false }), /分页/);
  assert.throws(() => parseSalePage({ ...raw, goods: [...raw.goods, ...raw.goods] }), /唯一/);
  assert.throws(
    () =>
      parseSalePage({
        ...raw,
        goods: [{ ...raw.goods[0], editUrl: 'https://evil.example/goods/?goods_id=00101' }],
      }),
    /地址/,
  );
  assert.throws(() => imageUrl('https://img.pddpic.com.evil.example/a.png'));
  assert.throws(() => imageUrl('https://127.0.0.1/a.png'));
  assert.throws(() => imageUrl('http://img.pddpic.com/a.png'));
});
test('listing waits for the sale entry after navigation and deduplicates the same snapshot ref', async () => {
  // Offline navigation lifecycle regression; this is not a real PDD page fixture.
  const collector = new ShopCollector(
    '',
    '',
    async () => '',
    () => {},
    () => true,
  );
  const calls = [];
  let snapshots = 0;
  collector.login = async () => {};
  collector.bridge = {
    navigate: async () => calls.push('navigate'),
    snapshot: async () => ({
      tree:
        ++snapshots === 1
          ? []
          : [
              { ref: '@sale', role: 'tab', name: '在售\n（ 1 ）' },
              { ref: '@sale', role: 'tab', name: '在售（1）' },
            ],
    }),
    wait: async (check, timeout, message) => {
      assert.equal(timeout, 15000);
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await check();
        if (result) return result;
      }
      throw Error(message);
    },
    call: async (action, args) => calls.push([action, args.selector]),
    eval: async (code) => {
      if (code.includes('saleListEntry')) return { count: 0 };
      calls.push('read');
      return {
        ready: true,
        active: true,
        paginationKnown: true,
        hasNext: false,
        goods: [{ goodsId: '101', title: '泡脚桶' }],
      };
    },
  };
  const result = await collector.list({ id: 'shop', name: '样例店铺', updatedAt: 'now' });
  assert.equal(snapshots, 2);
  assert.deepEqual(calls, ['navigate', ['click', '@sale'], 'read']);
  assert.equal(result.status, 'ready');
  assert.equal(result.completeList, true);
  assert.equal(result.goods[0].goodsId, '101');
  assert.equal(collector.busy, false);
});
test('distinct sale entries remain ambiguous and never click or read a possibly wrong list', async () => {
  const collector = new ShopCollector(
    '',
    '',
    async () => '',
    () => {},
    () => true,
  );
  collector.login = async () => {};
  collector.bridge = {
    navigate: async () => {},
    snapshot: async () => ({
      tree: [
        { ref: '@sale1', role: 'tab', name: '在售（1）' },
        { ref: '@sale2', role: 'tab', name: '在售（2）' },
      ],
    }),
    wait: async (check, timeout, message) => {
      assert.equal(await check(), false);
      assert.equal(await check(), false);
      throw Error(message);
    },
    call: async () => assert.fail('ambiguous entry must not be clicked'),
    eval: async (code) => {
      if (code.includes('saleListEntry')) return { count: 0 };
      assert.fail('unconfirmed list must not be read');
    },
  };
  const result = await collector.list({ id: 'shop', name: '样例店铺', updatedAt: 'now' });
  assert.equal(result.status, 'error');
  assert.match(result.message, /加载后仍未找到唯一/);
  assert.equal(result.completeList, false);
  assert.deepEqual(result.goods, []);
  assert.equal(collector.busy, false);
});
test('merged picture cells retain the same image for each covered SKU row', () => {
  const previous = global.document;
  try {
    global.document = {
      querySelectorAll: (selector) => [
        { querySelector: () => ({ currentSrc: `https://img.pddpic.com/${selector}.png` }) },
      ],
    };
    assert.deepEqual(readSkuPictureCells(['purple', 'purple', 'gray']), [
      'https://img.pddpic.com/purple.png',
      'https://img.pddpic.com/purple.png',
      'https://img.pddpic.com/gray.png',
    ]);
  } finally {
    if (previous === undefined) delete global.document;
    else global.document = previous;
  }
});
test('batch produces separate pictured workbooks, preserves source/zero stock/unknown promises and reports partial failures', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goods-collection-'));
  try {
    const [p] = await parseWorkbook(path.resolve('resources/templates/商品资料示例.xlsx'), dir);
    p.skus[0].stock = '0';
    p.code = '0000123';
    p.source = '拼多多采集：样例店铺；商品ID 101';
    p.services = { invoice: '', sevenDay: '', authenticity: '' };
    const bytes = await exportProductWorkbook(
      p,
      path.resolve('resources/templates/商品资料模板.xlsx'),
      dir,
    );
    const [saved] = sanitizeProducts(
      { all: (table) => (table === 'assets' ? Object.values(p.images) : []) },
      [p],
    );
    assert.equal(saved.services.invoice, '');
    assert(problems(saved).some((message) => /正品发票/.test(message)));
    const output = path.join(dir, 'batch.zip'),
      seen = [];
    const collector = new ShopCollector(
      path.join(dir, 'cache'),
      '',
      async () => '',
      (state) => seen.push(state.status),
      () => true,
    );
    collector.shop = { id: 'source', name: '样例店铺', updatedAt: 'now' };
    collector.state = {
      ...collector.state,
      shopId: 'source',
      shopName: '样例店铺',
      goods: ['101', '102', '103'].map((goodsId) => ({
        goodsId,
        title: '同编码商品',
        thumbnail: '',
        price: '',
      })),
      status: 'ready',
    };
    collector.login = async () => {};
    collector.readGoods = async (g) => {
      if (g.goodsId === '103') throw Error('实际库存未读取');
      return { bytes, warnings: ['品牌待核对'] };
    };
    const result = await collector.export(['101', '102', '103'], output);
    assert.equal(result.status, 'done');
    assert.equal(result.completed, 3);
    assert.equal(collector.busy, false);
    assert.equal(result.goods.find((g) => g.goodsId === '103').status, 'failed');
    const archive = await JSZip.loadAsync(await fs.readFile(output));
    const files = Object.keys(archive.files).filter((n) => n.endsWith('.xlsx'));
    assert.equal(files.length, 2);
    assert.match(await archive.file('导出结果.txt').async('string'), /实际库存未读取/);
    for (const name of files) {
      const file = path.join(dir, name);
      await fs.writeFile(file, await archive.file(name).async('nodebuffer'));
      const [back] = await parseWorkbook(file, dir);
      assert.equal(back.code, '0000123');
      assert.equal(back.skus[0].stock, '0');
      assert.equal(back.source, p.source);
      assert.equal(back.services.invoice, '');
      assert.deepEqual(
        back.main.map((n) => back.images[n].id),
        p.main.map((n) => p.images[n].id),
      );
      assert.deepEqual(
        back.skus.map((v) => [v.options, v.group, v.single, v.stock]),
        p.skus.map((v) => [v.options, v.group, v.single, v.stock]),
      );
    }
    assert(seen.includes('exporting'));
    assert.deepEqual(await fs.readdir(path.join(dir, 'cache')), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('stopping the second item saves the first completed workbook and marks remaining items stopped', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goods-stop-'));
  try {
    const collector = new ShopCollector(
      path.join(dir, 'cache'),
      '',
      async () => '',
      () => {},
      () => true,
    );
    collector.shop = { id: 'source', name: '样例店铺', updatedAt: 'now' };
    collector.state = {
      ...collector.state,
      shopId: 'source',
      goods: ['101', '102', '103'].map((goodsId) => ({
        goodsId,
        title: '商品',
        price: '',
        thumbnail: '',
      })),
    };
    collector.login = async () => {};
    collector.readGoods = async (g) => {
      if (g.goodsId === '102') {
        collector.cancel();
        throw Error('停止');
      }
      return { bytes: Buffer.from('completed-workbook'), warnings: [] };
    };
    const output = path.join(dir, 'partial.zip');
    const state = await collector.export(['101', '102', '103'], output);
    assert.equal(state.status, 'cancelled');
    assert.equal(state.outputPath, output);
    assert.equal(state.completed, 1);
    assert.equal(collector.busy, false);
    assert.deepEqual(
      state.goods.map((g) => g.status),
      ['done', 'stopped', 'stopped'],
    );
    const zip = await JSZip.loadAsync(await fs.readFile(output));
    assert.equal(Object.keys(zip.files).filter((n) => n.endsWith('.xlsx')).length, 1);
    assert.match(await zip.file('导出结果.txt').async('string'), /保存已完成的 1 件/);
    assert.deepEqual(await fs.readdir(path.join(dir, 'cache')), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  saleListEntry,
  readSalePage,
  parseSalePage,
  ShopCollector,
} = require('../dist-electron/electron/shop-collector');

function page({ label = '在售中(99+)', hidden = false, disabled = false } = {}) {
  const element = (innerText, extra = {}) => ({
    innerText,
    className: '',
    getClientRects: () => [{}],
    getAttribute() {
      return null;
    },
    setAttribute(name, value) {
      this[name] = value;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    ...extra,
  });
  const tab = element(label, { getClientRects: () => (hidden ? [] : [{}]) });
  const info = element('准确的商品标题\nID: 001234\n商品编码: 0001', {
    querySelector(selector) {
      if (selector.includes('ele_blue_title')) return element('准确的商品标题');
      if (selector === 'img') return { currentSrc: 'https://img.pddpic.com/1.png' };
      return null;
    },
  });
  const row = element('准确的商品标题\nID: 001234\n销售中', {
    cells: [info, element('29.99'), element('0')],
  });
  const head = element('商品信息\t价格(元)\t总库存', {
    rows: [{ cells: [element('商品信息'), element('价格(元)'), element('总库存')] }],
  });
  const headerTable = element('', { tHead: head, tBodies: [] });
  const bodyTable = element('', { tBodies: [{ rows: [row] }] });
  const container = element('', { querySelectorAll: () => [headerTable, bodyTable] });
  headerTable.closest = () => container;
  const next = element('', {
    className: disabled ? 'PGT_next PGT_disabled' : 'PGT_next',
    getAttribute(name) {
      return name === 'data-testid' ? 'beast-core-pagination-next' : null;
    },
  });
  const document = {
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector.includes('tab-itemLabel')) return [tab];
      if (selector === 'table') return [headerTable, bodyTable];
      if (selector.includes('aria-selected')) return [tab];
      if (selector === '[data-testid="beast-core-pagination"]') return [element('共有 1 条')];
      if (selector.includes('pagination-next')) return [next];
      return [];
    },
  };
  return { tab, next, run: (fn) => vm.runInNewContext(`(${fn.toString()})()`, { document, URL }) };
}

test('真实在售中(99+)标签通过 DOM 定位，隐藏标签不作为入口', () => {
  const p = page();
  assert.equal(p.run(saleListEntry).count, 1);
  assert.equal(p.tab['data-goods-sale-tab'], 'true');
  assert.equal(page({ hidden: true }).run(saleListEntry).count, 0);
});

test('分离的表头和商品行、ID:编号及标题控件能读取，图标分页可识别', () => {
  const p = page();
  const raw = p.run(readSalePage);
  const parsed = parseSalePage(raw);
  assert.equal(raw.active, true);
  assert.equal(raw.total, 1);
  assert.equal(parsed.goods[0].goodsId, '001234');
  assert.equal(parsed.goods[0].title, '准确的商品标题');
  assert.equal(parsed.goods[0].price, '29.99');
  assert.equal(parsed.hasNext, true);
  assert.equal(p.next['data-goods-sale-next'], 'true');
});

test('末页禁用的图标不会被当作下一页', () => {
  assert.equal(page({ disabled: true }).run(readSalePage).hasNext, false);
});

test('编辑新标签页必须匹配来源和商品编号，普通 ID: 行能找到编辑入口', async () => {
  for (const url of [
    'https://mms.pinduoduo.com/goods/goods_add/index?goods_id=001234',
    'https://mms.pinduoduo.com/goods/goods_add/index?goods_id=999999',
    'https://evil.example/goods/goods_add/index?goods_id=001234',
  ]) {
    const c = new ShopCollector(
      '',
      '',
      async () => '',
      () => {},
      () => true,
    );
    const calls = [];
    c.bridge = {
      navigate: async (target) => calls.push(['navigate', target]),
      eval: async (code) => {
        if (code.includes('saleListEntry')) return { count: 1, selector: '@sale' };
        if (code.includes('readSalePage'))
          return {
            ready: true,
            active: true,
            paginationKnown: true,
            goods: [{ goodsId: '001234', title: '标题' }],
            hasNext: false,
          };
        return 'https://mms.pinduoduo.com/goods/goods_list';
      },
      snapshot: async () => ({
        tree: [
          {
            role: 'row',
            name: '标题 ID: 001234',
            children: [{ role: 'link', name: '编辑', ref: '@edit' }],
          },
        ],
      }),
      call: async (action, args) => {
        calls.push([action, args.selector]);
        if (action === 'find_tab') return { url };
      },
      wait: async (check, _timeout, message) => {
        const value = await check();
        if (!value) throw Error(message);
        return value;
      },
    };
    const run = () => c.openGoods({ goodsId: '001234', title: '标题' });
    if (url.includes('evil') || url.includes('999999')) await assert.rejects(run(), /核对商品编号/);
    else await run();
    assert(calls.some(([action, selector]) => action === 'click' && selector === '@edit'));
    assert.equal(calls.filter(([action]) => action === 'navigate').length, 1);
  }
});

test('表格和分页未就绪时等待；末页总数不一致不能报告完整读取', async () => {
  const c = new ShopCollector(
    '',
    '',
    async () => '',
    () => {},
    () => true,
  );
  c.login = async () => {};
  let reads = 0;
  c.bridge = {
    navigate: async () => {},
    call: async () => {},
    eval: async (code) => {
      if (code.includes('saleListEntry')) return { count: 1, selector: '@sale' };
      reads++;
      return {
        ready: true,
        active: true,
        paginationKnown: reads > 1,
        hasNext: false,
        total: 2,
        goods: [{ goodsId: '1234', title: '标题' }],
      };
    },
    wait: async (check, _timeout, message) => {
      for (let i = 0; i < 3; i++) {
        const value = await check();
        if (value) return value;
      }
      throw Error(message);
    },
  };
  const result = await c.list({ id: 'shop', name: '样例店铺' });
  assert.equal(reads, 2);
  assert.equal(result.status, 'error');
  assert.equal(result.completeList, false);
  assert.match(result.message, /与后台总数 2 不一致/);
});

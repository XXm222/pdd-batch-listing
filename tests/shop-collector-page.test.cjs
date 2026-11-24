const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { ExecutionError } = require('../dist-electron/electron/execution');
const {
  saleListEntry,
  readSalePage,
  parseSalePage,
  ShopCollector,
} = require('../dist-electron/electron/shop-collector');

function page({
  label = '在售中(99+)',
  hidden = false,
  disabled = false,
  noNext = false,
  noPager = false,
  nestedNext = false,
  iconDisabled = false,
  totalLabel = '共有 1 条',
  busy = false,
} = {}) {
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
    closest() {
      return null;
    },
    contains() {
      return false;
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
  const container = element('', {
    querySelectorAll: () => [headerTable, bodyTable],
    closest: () => (busy ? container : null),
  });
  headerTable.closest = () => container;
  const next = element('', {
    className: disabled ? 'PGT_next PGT_disabled' : 'PGT_next',
    getAttribute(name) {
      if (nestedNext) return name === 'aria-label' ? '下一页' : null;
      return name === 'data-testid' ? 'beast-core-pagination-next' : null;
    },
    closest(selector) {
      return disabled && selector.includes('aria-disabled') ? this : null;
    },
    contains: (child) => nestedNext && child === icon,
  });
  const icon = element('', {
    getAttribute: (name) => (name === 'data-testid' ? 'beast-core-pagination-next' : null),
    closest(selector) {
      if (selector.startsWith('button')) return next;
      return disabled || iconDisabled ? this : null;
    },
  });
  const controls = noNext ? [] : nestedNext ? [next, icon] : [next];
  const pager = element(totalLabel, { querySelectorAll: () => controls });
  const document = {
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector.includes('tab-itemLabel')) return [tab];
      if (selector === 'table') return [headerTable, bodyTable];
      if (selector.includes('aria-selected')) return [tab];
      if (selector.startsWith('[data-testid="beast-core-pagination"]'))
        return noPager ? [] : [pager];
      if (selector.includes('pagination-next')) return controls;
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

test('下一页按钮和嵌套图标只定位一次，并遵守外层按钮禁用状态', () => {
  const p = page({ nestedNext: true });
  assert.equal(p.run(readSalePage).hasNext, true);
  assert.equal(p.next['data-goods-sale-next'], 'true');
  const last = page({ nestedNext: true, disabled: true });
  assert.equal(last.run(readSalePage).paginationKnown, true);
  assert.equal(last.next['data-goods-sale-next'], undefined);
  assert.equal(page({ nestedNext: true, iconDisabled: true }).run(readSalePage).hasNext, false);
});

test('单页可以用准确的在售总数确认，只有 99+ 或行数不符时仍等待', () => {
  const samples = [
    [{ noNext: true, totalLabel: '共 1 件' }, true, 1],
    [{ noNext: true, noPager: true, label: '在售商品（1）' }, true, 1],
    [{ noNext: true, noPager: true, label: '在售商品（1,234）' }, false, 1234],
    [{ noNext: true, noPager: true }, false, undefined],
  ];
  for (const [options, ready, total] of samples) {
    const raw = page(options).run(readSalePage);
    assert.equal(raw.paginationKnown, ready);
    assert.equal(raw.total, total);
    assert.equal(raw.hasNext, false);
  }
  assert.equal(page({ busy: true }).run(readSalePage).ready, false);
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

test('翻页须等到商品变化，跨页重复时保留已读结果并拒绝标记完成', async () => {
  const c = new ShopCollector(
    '',
    '',
    async () => '',
    () => {},
    () => true,
  );
  c.login = async () => {};
  let reads = 0;
  let clicks = 0;
  c.bridge = {
    navigate: async () => {},
    call: async () => {
      clicks++;
    },
    eval: async (code) => {
      if (code.includes('saleListEntry')) return { count: 1, selector: '@sale' };
      if (!code.includes('readSalePage')) return 1;
      const goods = ++reads <= 2 ? ['101', '102'] : ['102', '103'];
      return {
        ready: true,
        active: true,
        paginationKnown: true,
        hasNext: reads <= 2,
        total: 4,
        goods: goods.map((goodsId) => ({ goodsId, title: '标题' })),
      };
    },
    wait: async (check) => {
      for (let i = 0; i < 3; i++) {
        const result = await check();
        if (result) return result;
      }
      throw new ExecutionError('page_timeout', '超时');
    },
  };
  const result = await c.list({ id: 'shop', name: '样例店铺' });
  assert.equal(clicks, 2);
  assert.equal(reads, 3);
  assert.deepEqual(
    result.goods.map((g) => g.goodsId),
    ['101', '102'],
  );
  assert.equal(result.completeList, false);
  assert.match(result.message, /不同页读到了相同的商品编号/);
});

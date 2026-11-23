const test = require('node:test');
const assert = require('node:assert/strict');
const {
  apiCents,
  apiInvoice,
  apiInstallPair,
  apiSrvTemplates,
  apiRim,
  apiInstallType,
  apiCategory,
  apiProperties,
  assertApiMatrix,
  apiSkuMatches,
  PddApiDraft,
} = require('../dist-electron/electron/platforms/pdd-api-draft.js');

const product = () => ({
  code: '0001',
  title: '测试商品',
  category: '末级类目',
  brand: '',
  material: '',
  audience: '',
  foldable: '',
  reference: '6.00',
  discount: '',
  shipping: '48小时发货及揽收',
  freight: '运费模板',
  attributes: [],
  images: {},
  main: [],
  detail: [],
  skus: [
    {
      options: [{ name: '颜色', value: '红' }],
      group: '4.01',
      single: '5.02',
      stock: '0',
      code: '0001',
    },
    {
      options: [{ name: '颜色', value: '蓝' }],
      group: '4.03',
      single: '5.04',
      stock: '2000',
      code: '0002',
    },
  ],
});
const savedSkus = () => [
  {
    spec: [{ parent_name: '颜色', spec_name: '蓝' }],
    multi_price: 403,
    price: 504,
    quantity: 0,
    quantity_delta: 2000,
    out_sku_sn: '0002',
  },
  {
    spec: [{ parent_name: '颜色', spec_name: '红' }],
    multi_price: 401,
    price: 502,
    quantity: 0,
    quantity_delta: 0,
    out_sku_sn: '0001',
  },
];

test('API金额按分转换，不接受额外小数或隐式格式', () => {
  assert.equal(apiCents('0.29'), 29);
  assert.equal(apiCents('00119.99'), 11999);
  for (const value of ['-1', '1.001', '1e2', '', ' 1']) assert.throws(() => apiCents(value));
});
test('API类目按可用末级名称匹配，重复编号去重，同名不同路径拒绝', () => {
  const c = {
    optional: true,
    cat_id_1: 1,
    cat_name_1: '一级',
    cat_id_2: 2,
    cat_name_2: '末级类目',
  };
  assert.equal(apiCategory({ cat_info_v2_lists: [c, { ...c }] }, '旧路径 > 末级类目').id, 2);
  assert.throws(() => apiCategory({ cat_info_v2_lists: [c, { ...c, cat_id_1: 3 }] }, '末级类目'));
  assert.throws(() => apiCategory({ cat_info_v2_lists: [{ ...c, optional: false }] }, '末级类目'));
});
test('API拒绝不完整或重复的规格矩阵，不会增补可买组合', () => {
  const p = product();
  assert.doesNotThrow(() => assertApiMatrix(p));
  p.skus[0].options.push({ name: '容量', value: '大' });
  p.skus[1].options.push({ name: '容量', value: '小' });
  assert.throws(() => assertApiMatrix(p));
  const duplicate = product();
  duplicate.skus[1].options[0].value = '红';
  assert.throws(() => assertApiMatrix(duplicate));
});
test('API属性由当前模板映射，缺必填项或含歧义选项时停止', () => {
  const p = product();
  p.brand = '品牌A';
  const template = {
    modules: [
      {
        id: 10,
        propertys: [
          {
            id: 20,
            pid: 5,
            ref_pid: 30,
            name_alias: '品牌',
            required: true,
            control_type: 1,
            values: { content: [{ vid: 40, value: '品牌A' }] },
          },
        ],
      },
    ],
  };
  assert.equal(apiProperties(p, template)[0].vid, 40);
  p.brand = '';
  assert.throws(() => apiProperties(p, template));
  p.brand = '品牌A';
  template.modules[0].propertys[0].values.content.push({ vid: 41, value: '品牌A' });
  assert.throws(() => apiProperties(p, template));
});
test('API规格按名称值匹配，保留编码前导零和真实零库存', () => {
  const p = product(),
    actual = savedSkus();
  assert.equal(apiSkuMatches(p, actual, {}), true);
  actual[1].quantity_delta = undefined;
  assert.equal(apiSkuMatches(p, actual, {}), false);
  actual[1].quantity_delta = 0;
  actual[0].quantity = 5;
  assert.equal(apiSkuMatches(p, actual, {}), false);
  actual[0].quantity = 0;
  actual[1].out_sku_sn = '1';
  assert.equal(apiSkuMatches(p, actual, {}), false);
});
test('已经尝试API保存的任务只读原编号，读回失败不提交或分配新编号', async () => {
  const t = {
    productSnapshot: product(),
    goodsId: '123',
    saveAttemptedAt: '2026-10-08',
    apiDraft: {
      commitId: '456',
      categoryId: 2,
      freightId: 3,
      services: { refund: 1, invoice: 0, authenticity: 0 },
      uploads: {},
    },
  };
  const bridge = {
    async eval(code) {
      assert.ok(code.includes('/glide/v2/mms/query/commit/detail'));
      assert.ok(code.includes('123') && code.includes('456'));
      return { ok: false };
    },
  };
  const adapter = new PddApiDraft(bridge, '/unused', async () => {});
  await assert.rejects(() =>
    adapter.execute(
      t,
      { name: '店铺', account: '店铺:子账号' },
      {
        guard() {},
        patch() {},
        async step(_n, work) {
          return work();
        },
      },
    ),
  );
});

test('草稿列表索引延迟时只重复查询，不重建或保存，唯一记录确认后才成功', async () => {
  const p = product(),
    routes = [];
  const t = {
    productSnapshot: p,
    goodsId: '123',
    saveAttemptedAt: '2026-10-08',
    backendChecks: [],
    apiDraft: {
      commitId: '456',
      categoryId: 2,
      freightId: 3,
      services: { refund: 1, invoice: 0, authenticity: 0 },
      uploads: {},
    },
  };
  let lists = 0;
  const bridge = {
    async eval(code) {
      const route = code.match(/"route":"([^"]+)"/)[1];
      routes.push(route);
      if (route.endsWith('/commit/detail'))
        return {
          ok: true,
          value: {
            goods_id: 123,
            id: 456,
            check_status: 0,
            goods_name: p.title,
            out_goods_sn: p.code,
            cat_id: 2,
            sku: savedSkus(),
            galleries: [],
            shipment_limit_second: 172800,
            cost_template_id: 3,
            market_price: 600,
            is_refundable: 1,
            invoice_status: 0,
            is_folt: 0,
          },
        };
      if (route.endsWith('/template/mall')) return { ok: true, value: { modules: [] } };
      if (route.endsWith('/query/V2')) return { ok: true, value: { floor_list: [] } };
      assert.equal(route, '/glide/v2/mms/query/commit/list');
      return {
        ok: true,
        value:
          ++lists === 1
            ? { total: 0, list: [] }
            : {
                total: 1,
                list: [
                  {
                    goods_id: 123,
                    id: 456,
                    check_status: 0,
                    goods_name: p.title,
                    out_goods_sn: p.code,
                  },
                ],
              },
      };
    },
    async wait(check) {
      while (!(await check())) {
        assert.notEqual(t.status, 'succeeded');
      }
    },
  };
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'api-draft-readback-'));
  try {
    t.id = 'readonly';
    await new PddApiDraft(bridge, directory, async () => {}).execute(
      t,
      { name: '店铺', account: '店铺:子账号' },
      {
        guard() {},
        patch(values) {
          Object.assign(t, values);
        },
        async step(_n, work) {
          return work();
        },
      },
    );
    assert.equal(lists, 2);
    assert.equal(t.status, 'succeeded');
    assert.equal(
      routes.some((r) => /action\/edit|commit\/(save|create_new)$/.test(r)),
      false,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const vm = require('node:vm');
const { pageApiScript } = require('../dist-electron/electron/platforms/pdd-api-draft.js');

// 页面守卫跑在真实页面里：header 上的子账号带真实姓名后缀，
// 只比整行文字就会把「已登录」判成「换了账号」，这曾经让类目接口报 shop_changed。
function livePage(options = {}) {
  const lines = options.names || [
    '规则中心',
    '邓禄普黑豆专卖店',
    '邓禄普:珠珠(王玮珠)',
    '退出当前账号',
  ];
  const calls = [];
  const header = { innerText: lines.join('\n'), textContent: lines.join(' ') };
  const userinfo =
    options.userinfo === null
      ? null
      : {
          id: options.userId ?? 190551753,
          mall_id: 549046886,
          username: '邓禄普:珠珠',
          nickname: '王玮珠',
          mall: { mall_id: 549046886, mall_name: '邓禄普黑豆专卖店' },
        };
  const sandbox = {
    location: { origin: 'https://mms.pinduoduo.com' },
    document: { querySelector: (selector) => (selector === 'header' ? header : null) },
    localStorage: {
      getItem: (key) => (key === 'new_userinfo' && userinfo ? JSON.stringify(userinfo) : null),
    },
    window: {
      __mms: {
        fetch: {
          get: async (route, body) => {
            calls.push([route, body]);
            return {
              cat_info_v2_lists: [{ optional: true, cat_name_1: '末级类目', cat_id_1: 101 }],
            };
          },
          post: async () => ({}),
        },
      },
    },
  };
  sandbox.window.__user = userinfo ? { id: userinfo.id, mallId: userinfo.mall_id } : undefined;
  return { sandbox, calls };
}

const runApi = async (shop, options) => {
  const { sandbox, calls } = livePage(options);
  const result = await vm.runInNewContext(
    pageApiScript(
      {
        route: '/vodka/v2/mms/search/categories/v2',
        method: 'get',
        body: { keyword: '乘用车轮胎' },
      },
      shop,
    ),
    sandbox,
  );
  return { result, calls };
};

test('类目接口在带真实姓名后缀的已登录页面里照常请求', async () => {
  const shop = { name: '邓禄普黑豆专卖店', account: '邓禄普:珠珠' };
  const { result, calls } = await runApi(shop);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/vodka/v2/mms/search/categories/v2');
  // 页面沙箱里的对象来自另一个 realm，只能按序列化值比较。
  assert.equal(JSON.stringify(calls[0][1]), JSON.stringify({ keyword: '乘用车轮胎' }));
});

test('类目接口不会为别的子账号放行，绑定编号不符时同样拦下', async () => {
  const other = await runApi({ name: '邓禄普黑豆专卖店', account: '邓禄普:阿珍' });
  assert.equal(other.result.ok, false);
  assert.equal(other.result.identity, true);
  assert.equal(other.calls.length, 0);

  const bound = {
    name: '邓禄普黑豆专卖店',
    account: '邓禄普:珠珠',
    mallId: 549046886,
    userId: 190551753,
  };
  assert.equal((await runApi(bound)).result.ok, true);
  const stranger = await runApi(bound, { userId: 190551754 });
  assert.equal(stranger.result.ok, false);
  assert.equal(stranger.result.identity, true);
  assert.equal(stranger.calls.length, 0);
});

test('类目不提供正品发票时资料填“是”按不勾选执行，不阻断任务', () => {
  const tire = {
    authentic_invoice: false,
    is_electronic_invoice: false,
    is_paper_invoice: false,
    allow_invoice_sub_type: false,
    must_set_invoice: false,
  };
  assert.equal(
    JSON.stringify(apiInvoice(true, tire)),
    JSON.stringify({ invoice: 0, offers: false }),
  );
  assert.equal(
    JSON.stringify(apiInvoice(false, tire)),
    JSON.stringify({ invoice: 0, offers: false }),
  );
});

test('类目提供发票服务时资料填“是”仍拒绝静默设置发票类型', () => {
  assert.equal(
    JSON.stringify(apiInvoice(true, { authentic_invoice: true })),
    JSON.stringify({ invoice: 1, offers: true }),
  );
  assert.equal(
    JSON.stringify(apiInvoice(true, { is_electronic_invoice: true })),
    JSON.stringify({ invoice: 1, offers: true }),
  );
  assert.equal(
    JSON.stringify(apiInvoice(false, { authentic_invoice: true })),
    JSON.stringify({ invoice: 0, offers: true }),
  );
});

test('发票规则的数组写法与缺省键不会被当成已提供', () => {
  assert.equal(apiInvoice(true, { allow_invoice_sub_type: [1, 2] }).offers, true);
  assert.equal(apiInvoice(true, { allow_invoice_sub_type: [] }).offers, false);
  assert.equal(apiInvoice(true, { authentic_invoice: 'true' }).offers, false);
  assert.equal(apiInvoice(true, {}).offers, false);
});

test('到店安装：模板 ID 写进 srv_template_id_map，键按安装类型走', () => {
  assert.equal(apiInstallType('store'), '2');
  assert.equal(apiInstallType('home'), '3');
  assert.equal(
    JSON.stringify(apiInstallPair('store', 'SIST_418714932725772662')),
    JSON.stringify({ 2: 'SIST_418714932725772662' }),
  );
  assert.equal(
    JSON.stringify(apiInstallPair('home', ' SIST_abc-1 ')),
    JSON.stringify({ 3: 'SIST_abc-1' }),
  );
});

test('到店安装：还没换成模板 ID 时明确拒绝', () => {
  assert.throws(() => apiInstallPair('store', '到店模版1'), /到店安装模板还没换成后台模板 ID/);
  assert.throws(() => apiInstallPair('store', 'SIST_'), /到店安装模板/);
  assert.throws(() => apiInstallPair('store', ''), /到店安装模板/);
});

test('到店安装：填中文模板名时从下拉项里把模板 ID 挖出来', async () => {
  const vm = require('node:vm');
  const { PDD_TEMPLATE_LOOKUP } = require('../dist-electron/electron/platforms/pdd-api-draft.js');
  const option = (label, value) => ({
    textContent: label,
    click() {},
    ['__reactInternalInstance$abc']: { memoizedProps: { option: { label, value } }, return: null },
  });
  const run = async (name, labels) => {
    const items = labels.map(([label, value]) => option(label, value));
    const headers = [
      { click() {}, parentElement: { parentElement: { innerText: '配送到店模板' } } },
    ];
    const sandbox = {
      document: {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: (selector) => {
          if (selector.includes('option')) return items;
          if (selector.includes('label')) return [];
          if (selector.includes('header')) return headers;
          return [];
        },
      },
      setTimeout: (fn) => {
        fn();
        return 0;
      },
      Promise,
    };
    const lookup = vm.runInNewContext(`(${PDD_TEMPLATE_LOOKUP.toString()})`, sandbox);
    return lookup(name);
  };

  const matched = await run('到店模版1', [['到店模版1', 'SIST_418714932725772662']]);
  assert.equal(matched.ok, true);
  assert.equal(matched.id, 'SIST_418714932725772662');

  // 「模板」和「模版」两种写法都认，空格与全角括号忽略
  const loose = await run(' 到店模板 1 ', [['到店模版1', 'SIST_418714932725772662']]);
  assert.equal(loose.ok, true);
  assert.equal(loose.id, 'SIST_418714932725772662');

  const missing = await run('到店模版9', [['到店模版1', 'SIST_418714932725772662']]);
  assert.equal(missing.ok, false);
  assert.equal(missing.options[0].label, '到店模版1');
  assert.match(missing.reason, /没有这个模板/);
});

test('到店安装：老资料没算轮辋直径时按规格选项与标题自动推', () => {
  const product = {
    title: '邓禄普 汽车轮胎 215/55R18 95V FM800',
    install: { delivery: 'store', template: 'SIST_418714932725772662' },
    skus: [{ options: [{ name: '型号', value: '205/45R17 88W XL SPORT MAXX LUX SC' }] }],
  };
  assert.equal(apiRim(product, product.skus[0]), '17英寸', '规格里没写直径时也要能推出来');
  assert.equal(
    apiRim({ ...product, install: undefined }, product.skus[0]),
    '',
    '没开到店安装就不写这一项',
  );
  assert.equal(
    apiRim(product, { options: [{ name: '型号', value: '245/40R19 防爆胎' }] }),
    '防爆胎19英寸',
  );
  assert.equal(apiRim(product, { rim: '20英寸', options: [] }), '20英寸', '导入时算好的直接用');
});
test('到店安装：面板没展开、复选框没勾时自动展开勾选再取模板', async () => {
  const vm = require('node:vm');
  const { PDD_TEMPLATE_LOOKUP } = require('../dist-electron/electron/platforms/pdd-api-draft.js');
  const clicked = [];
  const header = { click() {}, parentElement: { parentElement: { innerText: '配送到店模板' } } };
  const box = { querySelector: (selector) => (selector.includes('header') ? header : null) };
  const items = [
    {
      textContent: '到店模版1',
      click() {},
      ['__reactInternalInstance$auto']: {
        memoizedProps: { option: { label: '到店模版1', value: 'SIST_auto_1' } },
        return: null,
      },
    },
  ];
  let checked = false;
  let ready = false;
  const input = {
    type: 'checkbox',
    get checked() {
      return checked;
    },
    click() {
      checked = true;
      ready = true;
    },
    closest: () => labelWrap,
  };
  const labelWrap = {
    textContent: '到店安装',
    querySelector: () => input,
    click() {
      input.click();
    },
  };
  const expand = { textContent: '展开修改', click: () => clicked.push('expand') };
  const sandbox = {
    document: {
      getElementById: () => (ready ? box : null),
      querySelector: () => null,
      querySelectorAll: (selector) => {
        if (selector.includes('option')) return items;
        if (selector.includes('label')) return [labelWrap];
        if (selector.includes('header')) return [header];
        if (selector === 'button,a,span,div') return [expand];
        return [];
      },
    },
    setTimeout: (fn) => {
      fn();
      return 0;
    },
    Promise,
  };
  const lookup = vm.runInNewContext(`(${PDD_TEMPLATE_LOOKUP.toString()})`, sandbox);
  const result = await lookup('到店模版1');
  assert.equal(clicked.length, 1, '页面收起时先点「展开修改」');
  assert.equal(checked, true, '「到店安装」没勾时自动勾上');
  assert.equal(result.ok, true);
  assert.equal(result.id, 'SIST_auto_1');
});

test('到店安装：类目没有「到店安装」入口时给出可核对的原因', async () => {
  const vm = require('node:vm');
  const { PDD_TEMPLATE_LOOKUP } = require('../dist-electron/electron/platforms/pdd-api-draft.js');
  const sandbox = {
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    setTimeout: (fn) => {
      fn();
      return 0;
    },
    Promise,
  };
  const lookup = vm.runInNewContext(`(${PDD_TEMPLATE_LOOKUP.toString()})`, sandbox);
  const result = await lookup('到店模版1');
  assert.equal(result.ok, false);
  assert.match(result.reason, /找不到「到店安装」勾选项/);
});
test('到店安装：按真实页面结构（更多服务分组 + bottom-switch）展开后读到模板清单', async () => {
  const vm = require('node:vm');
  const { PDD_TEMPLATE_OPTIONS } = require('../dist-electron/electron/platforms/pdd-api-draft.js');
  const clicked = [];
  const header = { click() {}, parentElement: { parentElement: { innerText: '配送到店模板' } } };
  const box = { querySelector: (selector) => (selector.includes('header') ? header : null) };
  const items = [
    {
      textContent: '到店模版1',
      click() {},
      ['__reactInternalInstance$real']: {
        memoizedProps: { option: { label: '到店模版1', value: 'SIST_real_1' } },
        return: null,
      },
    },
  ];
  let expanded = false;
  const toggle = {
    click: () => {
      clicked.push('bottom-switch');
      expanded = true;
    },
  };
  const groupLabel = {
    textContent: '更多服务',
    parentElement: { querySelector: (selector) => (selector === '.bottom-switch' ? toggle : null) },
  };
  let checked = false;
  const input = {
    type: 'checkbox',
    get checked() {
      return checked;
    },
    click: () => {
      checked = true;
    },
    closest: () => labelWrap,
  };
  const labelWrap = {
    textContent: '到店安装（勾选即表示同意《到店安装服务条款》）',
    querySelector: () => input,
    click: () => input.click(),
  };
  const sandbox = {
    document: {
      getElementById: () => (checked ? box : null),
      querySelector: () => null,
      querySelectorAll: (selector) => {
        if (selector === '.mui-form-group-label') return [groupLabel];
        if (selector.includes('option')) return items;
        if (selector.includes('label')) return [labelWrap];
        if (selector.includes('header')) return [header];
        void expanded;
        return [];
      },
    },
    setTimeout: (fn) => {
      fn();
      return 0;
    },
    Promise,
  };
  const read = vm.runInNewContext(`(${PDD_TEMPLATE_OPTIONS.toString()})`, sandbox);
  const unchecked = await read();
  assert.equal(clicked.length, 1, '先点分组里的 bottom-switch 展开「更多服务」');
  assert.equal(checked, false, '只读：不会替运营勾「到店安装」');
  assert.equal(unchecked.ok, false);
  assert.match(unchecked.reason, /只读/);
  checked = true;
  const result = await read();
  assert.equal(checked, true);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.options)), [
    { label: '到店模版1', value: 'SIST_real_1' },
  ]);
});

test('草稿读回：安装类型、模板与每个 SKU 的轮辋直径缺一项都判不一致', () => {
  const { apiInstallMatches } = require('../dist-electron/electron/platforms/pdd-api-draft.js');
  const product = {
    code: 'READBACK',
    title: '邓禄普轮胎 205/45R17',
    install: { delivery: 'store', template: 'SIST_real_1' },
    skus: [
      { spec: '205/45R17', group: '30', single: '40', stock: '1', rim: '17英寸' },
      { spec: '225/50R18', group: '30', single: '40', stock: '1', rim: '18英寸' },
    ],
  };
  // 真实草稿详情里没有表单那个 srv_template_id_map，模板落在 goods_srv_templates 的 id 上。
  const good = {
    goods_srv_templates: [
      { type: 8, id: 'SIST_real_1' },
      { type: 10, id: '' },
    ],
    sku: [
      { sku_srv_templates: '{"rimDiameter":"17英寸"}' },
      { sku_srv_templates: '{"rimDiameter":"18英寸"}' },
    ],
  };
  assert.equal(apiInstallMatches(product, good, 'SIST_real_1'), true);
  // 只比 id 集合的话，模板挂到了对家槽位（配送到店 ↔ 配送到家）也会被放过。
  assert.equal(
    apiInstallMatches(
      product,
      {
        ...good,
        goods_srv_templates: [
          { type: 8, id: '' },
          { type: 10, id: 'SIST_real_1' },
        ],
      },
      'SIST_real_1',
    ),
    false,
    '模板挂到了另一种安装类型的槽位',
  );
  assert.equal(
    apiInstallMatches(
      { ...product, install: { delivery: 'home', template: 'SIST_real_1' } },
      {
        ...good,
        goods_srv_templates: [
          { type: 8, id: 'SIST_real_1' },
          { type: 10, id: '' },
        ],
      },
      'SIST_real_1',
    ),
    false,
    '资料选配送到家，后台却挂在配送到店',
  );
  assert.equal(apiInstallMatches(product, {}, 'SIST_real_1'), false, '缺模板');
  assert.equal(
    apiInstallMatches(
      product,
      {
        ...good,
        goods_srv_templates: [
          { type: 8, id: 'SIST_other' },
          { type: 10, id: '' },
        ],
      },
      'SIST_real_1',
    ),
    false,
    '模板不是商品指定的那个',
  );
  assert.equal(
    apiInstallMatches(
      product,
      {
        ...good,
        goods_srv_templates: [
          { type: 8, id: '' },
          { type: 10, id: '' },
        ],
      },
      'SIST_real_1',
    ),
    false,
    '模板没绑定上（两个 id 都是空的）',
  );
  assert.equal(
    apiInstallMatches(product, { ...good, sku: good.sku.slice(0, 1) }, 'SIST_real_1'),
    false,
    'SKU 数量对不上',
  );
  assert.equal(
    apiInstallMatches(
      product,
      { ...good, sku: [good.sku[0], { sku_srv_templates: '{}' }] },
      'SIST_real_1',
    ),
    false,
    '第二个 SKU 没写轮辋直径',
  );
  assert.equal(
    apiInstallMatches(product, { ...good, sku: [good.sku[1], good.sku[0]] }, 'SIST_real_1'),
    true,
    '后台把 SKU 顺序打乱也能对上',
  );
  assert.equal(
    apiInstallMatches({ ...product, install: undefined }, {}, undefined),
    true,
    '没开到店安装就不比',
  );
});

test('提交到店安装时必须同时写 goods_srv_templates，只发 srv_template_id_map 后台不会落库', () => {
  assert.deepEqual(apiSrvTemplates('store', 'SIST_418714932725772662'), [
    { type: 8, id: 'SIST_418714932725772662' },
    { type: 10, id: '' },
  ]);
  assert.deepEqual(apiSrvTemplates('home', 'SIST_9'), [
    { type: 8, id: '' },
    { type: 10, id: 'SIST_9' },
  ]);
  assert.throws(() => apiSrvTemplates('store', '到店模版1'), /SIST_/);
  assert.throws(() => apiSrvTemplates('store', ''), /SIST_/);
});

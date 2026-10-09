const test = require('node:test');
const assert = require('node:assert/strict');
const {
  apiCents,
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

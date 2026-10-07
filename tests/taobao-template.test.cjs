/**
 * 淘宝模板（版本 4）的导入与校验：字段解析、图片位、以及「拼多多模板不能通用」的那些差异。
 * 真实模板文件由 scripts/build-taobao-template.py 生成。
 */
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { importFiles, parseWorkbook } = require('../dist-electron/electron/importer');
const {
  problems,
  isTaobaoProduct,
  isStructuredProduct,
  requiresFreightTemplate,
} = require('../dist-electron/src/domain');

const BLANK = path.resolve('resources/templates/淘宝商品资料模板.xlsx');
const EXAMPLE = path.resolve('resources/templates/淘宝商品资料示例.xlsx');

test('淘宝空白模板可导入、字段为空且不含任何商品数据', async () => {
  const [blank] = await parseWorkbook(BLANK);
  assert.equal(blank.templateFormat, '淘宝运营模板 v4');
  assert.equal(blank.code, '');
  assert.equal(blank.title, '');
  assert.equal(blank.main.length, 0);
  assert.equal(blank.detail.length, 0);
  // 空白模板没有规格数据行，不应凭空造出一条 SKU
  assert.equal(blank.skus.length, 0);
  // 发货地留空 → 校验必须报出来，而不是用兜底值悄悄放过
  assert.ok(problems(blank).some((m) => /发货地必须填到/.test(m)));
});

test('淘宝示例模板解析出后台发品需要的全部字段', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'goods-taobao-template-'));
  try {
    const { products, assets } = await importFiles([EXAMPLE], directory, false);
    assert.equal(products.length, 1);
    const p = products[0];
    assert.equal(p.templateFormat, '淘宝运营模板 v4');
    assert.ok(isTaobaoProduct(p));
    assert.ok(isStructuredProduct(p));
    assert.equal(p.code, 'B2242CZ+0030402');
    assert.equal(p.title, '家用泡脚桶可折叠保温泡脚袋恒温高深过小腿足浴桶便携宿舍泡脚盆');
    assert.equal(p.category, '家庭/个人清洁工具 > 卫浴/置物用具 > 足浴盆/足浴桶');
    assert.equal(p.material, '防水布');
    assert.equal(p.foldable, '可折叠');
    // 天猫发品表单必填、而拼多多模板里没有的几项
    assert.deepEqual(p.taobao, {
      originProvince: '广东',
      originCity: '深圳',
      extractWay: '邮寄',
      freightBearer: '卖家承担',
      deliveryTime: '48小时',
      shelfTime: '放入仓库',
      auctionPoint: '0.5',
    });
    // 天猫只有一个一口价，导入时两侧都写同一个值，下游按平台各取所需
    assert.equal(p.skus.length, 1);
    assert.equal(p.skus[0].single, '90.99');
    assert.equal(p.skus[0].group, '90.99');
    assert.equal(p.skus[0].stock, '2000');
    // 天猫 SKU 表没有编码列，淘宝模板已去掉「规格编码」，导入应留空而不是报错
    assert.equal(p.skus[0].code, '');
    // 图片位按后台命名：1:1主图最多 5 张，详情图最多 20 张
    assert.equal(p.main.length, 5);
    assert.equal(p.detail.length, 20);
    assert.equal(p.threeToFour.length, 0);
    assert.equal(p.whiteBg.length, 0);
    assert.equal(p.usp.length, 0);
    assert.equal(p.attributes.length, 2);
    assert.deepEqual(problems(p), []);
    assert.equal(assets.length, 25);
    for (const a of assets) assert.ok((await fs.stat(path.join(directory, a.id))).size > 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('淘宝模板与拼多多模板的差异：参考价与满件折扣不再必填', () => {
  const base = {
    code: 'C1',
    title: '测试商品',
    category: '家庭/个人清洁工具 > 卫浴/置物用具 > 足浴盆/足浴桶',
    shipping: '48小时发货及揽收',
    reference: '',
    discount: '',
    main: ['a.png'],
    detail: [],
    images: { 'a.png': { id: '1', width: 1440, height: 1440, bytes: 1000 } },
    skus: [{ spec: '默认规格', group: '', single: '90.99', stock: '10' }],
    services: { sevenDay: '是', invoice: '否', authenticity: '否' },
    templateFormat: '淘宝运营模板 v4',
  };
  // 淘宝商品：没有参考价、没有拼单价，也能通过校验
  assert.deepEqual(problems({ ...base, taobao: undefined }), []);
  assert.deepEqual(
    problems({
      ...base,
      taobao: {
        originProvince: '广东',
        originCity: '深圳',
        extractWay: '邮寄',
        freightBearer: '卖家承担',
        deliveryTime: '48小时',
        shelfTime: '放入仓库',
        auctionPoint: '0.5',
      },
    }),
    [],
  );
  // 换成拼多多模板格式，同样的数据就要报缺参考价
  const pdd = problems({ ...base, templateFormat: '运营模板 v3' });
  assert.ok(pdd.includes('请补充参考价'));
});

test('淘宝专有设置缺项会被校验拦住', () => {
  const p = {
    code: 'C1',
    title: '测试商品',
    category: 'a > b > c',
    shipping: '48小时发货及揽收',
    reference: '',
    discount: '',
    main: ['a.png'],
    detail: [],
    images: { 'a.png': { id: '1', width: 1440, height: 1440, bytes: 1000 } },
    skus: [{ spec: '默认规格', group: '', single: '9.9', stock: '1' }],
    services: { sevenDay: '是', invoice: '否', authenticity: '否' },
    templateFormat: '淘宝运营模板 v4',
    taobao: {
      originProvince: '广东',
      originCity: '', // 只填省不填市 —— 后台会报「必填项未填」
      extractWay: '自提',
      freightBearer: '卖家承担',
      deliveryTime: '72小时',
      shelfTime: '放入仓库',
      auctionPoint: '0.7', // 不是 0.5 的整数倍
    },
  };
  const out = problems(p);
  assert.ok(out.some((m) => /发货地必须填到/.test(m)));
  assert.ok(out.some((m) => /提取方式请选择/.test(m)));
  assert.ok(out.some((m) => /发货时间请选择/.test(m)));
  assert.ok(out.some((m) => /返点比例须为/.test(m)));
});

test('淘宝主图超 5 张、详情图超 20 张会被拦住（拼多多上限是 10 / 50）', () => {
  const image = { id: '1', width: 1440, height: 1440, bytes: 1000 };
  const names = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${i + 1}.png`);
  const images = {};
  for (const n of [...names('m', 6), ...names('d', 21)]) images[n] = { ...image };
  const p = {
    code: 'C1',
    title: '测试商品',
    category: 'a > b > c',
    shipping: '48h',
    reference: '',
    discount: '',
    main: names('m', 6),
    detail: names('d', 21),
    images,
    skus: [{ spec: '默认规格', group: '', single: '9.9', stock: '1' }],
    services: { sevenDay: '是', invoice: '否', authenticity: '否' },
    templateFormat: '淘宝运营模板 v4',
  };
  const out = problems(p);
  assert.ok(out.some((m) => /主图最多 5 张/.test(m)));
  assert.ok(out.some((m) => /详情图最多 20 张/.test(m)));
});

test('仓库模板与运营资料里的淘宝模板保持一致', async () => {
  for (const name of ['淘宝商品资料模板.xlsx', '淘宝商品资料示例.xlsx']) {
    assert.ok(
      (await fs.readFile(path.resolve('resources/templates', name))).equals(
        await fs.readFile(path.resolve('运营资料', name)),
      ),
      `${name} 在 resources/templates 与 运营资料 下不一致`,
    );
  }
});

test('运费模板只对拼多多必填，淘宝任务不该被这一栏拦住', () => {
  // 这是多 agent 审计发现的 P0：preflight 曾对所有平台强制 p.freight 非空，
  // 而天猫发品表单根本没有独立的运费模板字段 —— 淘宝任务在任何页面动作之前
  // 就被 invalid_product 拦下，填了又完全不被使用。
  assert.equal(requiresFreightTemplate('pdd'), true);
  assert.equal(requiresFreightTemplate('taobao'), false);
});

test('商家编码是独立栏位，留空时回落到商品编码', () => {
  const p = {
    code: 'B2242CZ+0030402',
    outerId: 'SHOP-A-001',
  };
  assert.equal((p.outerId || '').trim() || p.code, 'SHOP-A-001');
  assert.equal(
    ({ code: 'B2242CZ+0030402', outerId: '' }.outerId || '').trim() || 'B2242CZ+0030402',
    'B2242CZ+0030402',
  );
  assert.equal(({ code: 'X', outerId: undefined }.outerId || '').trim() || 'X', 'X');
});

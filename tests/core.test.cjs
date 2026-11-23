const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const JSZip = require('jszip');
const { parseWorkbook, importFiles, collectFiles } = require('../dist-electron/electron/importer');
const { Store } = require('../dist-electron/electron/store');
const { problems, resolveShopName } = require('../dist-electron/src/domain');
test('店铺名称手填优先，留空才由账号推导；格式边界与旧账号编辑兼容', () => {
  // 后台店铺名称是权威值，主账号名（冒号前半段）经常与店铺名不同。
  assert.equal(resolveShopName('手填名称', ' 日用生活馆:运营账号 ', true), '手填名称');
  assert.equal(resolveShopName('', ' 日用生活馆:运营账号 ', true), '日用生活馆');
  assert.equal(resolveShopName('', ' 日用生活馆 ： 运营账号 ', true), '日用生活馆');
  assert.equal(resolveShopName('', '日用生活馆:运营账号：二级', true), '日用生活馆');
  // 主账号登录（手机号 / 数字 ID / 邮箱 / 无冒号）推导不出店铺名，必须手填。
  for (const account of ['demo_operator_local', '13812345678', '190551753', 'a@b.com']) {
    assert.throws(() => resolveShopName('', account, true), /请填写与后台一致的店铺名称/);
  }
  // 冒号缺一边同样推导不出名称，手填依旧可用。
  for (const account of [':运营账号', '店铺名:', '店铺名：  ', ' ：运营账号']) {
    assert.equal(resolveShopName('手填名称', account, true), '手填名称');
  }
  assert.throws(() => resolveShopName('', `${'店'.repeat(51)}:运营`, true), /50/);
  assert.equal(
    resolveShopName('测试店铺 · 本机验证', 'demo_operator_local', false),
    '测试店铺 · 本机验证',
  );
  assert.throws(() => resolveShopName('', 'demo_operator_local', false), /50/);
});
const example = path.join(__dirname, '原始两页示例.xlsx');
const imageRoot = path.join(__dirname, '../resources/assets');
async function patchedExample(destination, changes, source = example) {
  const zip = await JSZip.loadAsync(await fs.readFile(source));
  for (const [sheet, cells] of Object.entries(changes)) {
    const name = `xl/worksheets/sheet${sheet}.xml`;
    let xml = await zip.file(name).async('string');
    for (const [ref, value] of Object.entries(cells)) {
      const pattern = new RegExp(`<x:c\\b[^>]*\\br="${ref}"[^>]*(?:/>|>[\\s\\S]*?</x:c>)`);
      const replacement =
        value === null
          ? `<x:c r="${ref}"/>`
          : value === 'FORMULA'
            ? `<x:c r="${ref}"><x:f>1+1</x:f><x:v>2</x:v></x:c>`
            : value === 'FORMULA_NO_VALUE'
              ? `<x:c r="${ref}"><x:f>1+1</x:f></x:c>`
              : `<x:c r="${ref}" t="str"><x:v>${value}</x:v></x:c>`;
      if (pattern.test(xml)) xml = xml.replace(pattern, replacement);
      else {
        const row = ref.match(/\d+/)[0];
        const rowPattern = new RegExp(`(<x:row\\b[^>]*\\br="${row}"[^>]*>)([\\s\\S]*?)(</x:row>)`);
        assert.ok(rowPattern.test(xml), ref);
        xml = xml.replace(rowPattern, (_, open, body, close) => open + body + replacement + close);
      }
    }
    zip.file(name, xml);
  }
  await fs.writeFile(destination, await zip.generateAsync({ type: 'nodebuffer' }));
}

test('原始两页模板可读取，链接不进入商品模型', async () => {
  const [p] = await parseWorkbook(example);
  assert.equal(p.code, 'DEMO-FB-FORM-001');
  assert.equal(p.skuCode, 'DEMO-FB-STD');
  assert.equal(p.skus[0].stock, '10');
  assert.equal(p.skus[0].group, '40');
  assert.equal(p.discount, '9.5');
  assert.deepEqual(p.main, ['foot-bath-main.png']);
  assert.deepEqual(p.detail, ['foot-bath-scene.png']);
  assert.equal(p.url, undefined);
});
const v2Example = path.join(__dirname, '../resources/templates/泡脚桶示例.xlsx');
test('三页模板完整读取两个 SKU、服务与规格图，缺少图片时明确提示', async () => {
  const [p] = await parseWorkbook(v2Example);
  assert.equal(p.templateFormat, '运营模板 v2');
  assert.equal(p.expectedShop, '');
  assert.equal(p.skus.length, 2);
  assert.deepEqual(p.skus[1].options, [{ name: '容量', value: '20L' }]);
  assert.equal(p.skus[1].code, 'FB20L');
  assert.equal(p.skus[1].stock, '8');
  assert.equal(p.services.sevenDay, '是');
  assert.deepEqual(p.attributes, []);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'goods-v2-'));
  try {
    const r = await importFiles(
      [
        v2Example,
        path.join(imageRoot, 'foot-bath-main.png'),
        path.join(imageRoot, 'foot-bath-scene.png'),
      ],
      tmp,
      true,
    );
    assert.deepEqual(problems(r.products[0]), []);
    assert.ok(problems(p).some((x) => x.includes('规格图未匹配')));
    const db = await Store.open(path.join(tmp, 'database'));
    try {
      db.saveProducts(r.products);
      db.close();
      const reopened = await Store.open(path.join(tmp, 'database'));
      assert.equal(reopened.all('products')[0].skus[1].image, 'foot-bath-main.png');
      reopened.close();
    } catch (e) {
      throw e;
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
test('多规格组合与售后条件检查；材质选项由实际后台类目核验', async () => {
  const [p] = await parseWorkbook(v2Example);
  p.images = Object.fromEntries(
    [...p.main, ...p.detail].map((name) => [
      name,
      { id: 'x', name, url: '', bytes: 1024, width: 600, height: 600 },
    ]),
  );
  p.skus[0].stock = '0';
  assert.deepEqual(problems(p), []);
  // 本机保留运营填写值；PddAdapter.attribute 根据当前类目实际选项决定是否接受。
  const materialInput = structuredClone(p);
  materialInput.material = 'PP+TPE';
  assert.deepEqual(problems(materialInput), []);
  for (const [change, expected] of [
    [(q) => (q.skus[1].code = q.skus[0].code), '编码重复'],
    [(q) => (q.skus[1].options[0].name = '颜色'), '每行的区分方式和顺序要一致'],
    [(q) => (q.skus[1].options[0].value = ''), '请同时填写区分方式和具体选项'],
    [(q) => (q.services.sevenDay = '否'), '无理由退货'],
    [(q) => (q.attributes = [{ name: '补充属性', value: '', required: true }]), '未填写完整'],
  ]) {
    const q = structuredClone(p);
    change(q);
    assert.ok(
      problems(q).some((x) => x.includes(expected)),
      expected,
    );
  }
});
test('新版表头与规格图路径检查；必填属性可追加，旧表仍可解析', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'goods-v2-invalid-'));
  try {
    const file = path.join(tmp, 'v2.xlsx');
    await patchedExample(file, { 1: { A24: '使用场景', B24: '家用', C24: '是' } }, v2Example);
    const [p] = await parseWorkbook(file);
    assert.deepEqual(p.attributes, [{ name: '使用场景', value: '家用', required: true }]);
    for (const change of [
      { 2: { A4: '错误表头' } },
      { 2: { I5: '../图片.png' } },
      { 2: { F5: 'FORMULA_NO_VALUE' } },
    ]) {
      await patchedExample(file, change, v2Example);
      await assert.rejects(parseWorkbook(file));
    }
    // 带缓存值的公式（运营普遍用「拼单价/0.99」算单买价）现在直接读缓存值。
    await patchedExample(file, { 2: { F5: 'FORMULA' } }, v2Example);
    assert.equal((await parseWorkbook(file))[0].skus[0].group, '2');
    assert.equal((await parseWorkbook(example))[0].skuCode, 'DEMO-FB-STD');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
test('两个商品文件夹的同名图片按各自目录匹配，原图移走后存档仍可用', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'goods-import-'));
  try {
    for (const [dir, code, asset] of [
      ['A', 'TEST-A', 'foot-bath-main.png'],
      ['B', 'TEST-B', 'foot-bath-scene.png'],
    ]) {
      await fs.mkdir(path.join(tmp, dir, 'images'), { recursive: true });
      await patchedExample(path.join(tmp, dir, '商品资料.xlsx'), {
        1: { B19: code },
        2: { C5: '主图.png', C15: null },
      });
      await fs.copyFile(path.join(imageRoot, asset), path.join(tmp, dir, 'images/主图.png'));
    }
    const files = await collectFiles(tmp);
    const destination = path.join(tmp, 'saved');
    const result = await importFiles(files, destination, true);
    assert.equal(result.products.length, 2);
    const a = result.products.find((p) => p.code === 'TEST-A');
    const b = result.products.find((p) => p.code === 'TEST-B');
    assert.notEqual(a.images['主图.png'].id, b.images['主图.png'].id);
    assert.deepEqual(problems(a), []);
    assert.deepEqual(problems(b), []);
    await fs.rename(path.join(tmp, 'A/images'), path.join(tmp, 'A/moved'));
    assert.ok((await fs.stat(path.join(destination, a.images['主图.png'].id))).size > 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
test('无缓存值的公式、非正整数顺序及上级目录文件名被拒绝', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'goods-invalid-'));
  try {
    const cases = [
      { 1: { B15: 'FORMULA_NO_VALUE' } },
      { 2: { B5: '0' } },
      { 2: { C5: '../主图.png' } },
      { 2: { C5: '__proto__' } },
    ];
    for (let i = 0; i < cases.length; i++) {
      const file = path.join(tmp, `${i}.xlsx`);
      await patchedExample(file, cases[i]);
      await assert.rejects(parseWorkbook(file));
    }
    // 运营常隔行插图（例如只填轮播图 1、5、6），顺序有空洞不该阻断导入。
    const gapped = path.join(tmp, 'gapped.xlsx');
    await patchedExample(gapped, { 2: { B5: '5' } });
    assert.equal((await parseWorkbook(gapped))[0].main.length, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
test('零库存有效，小数金额和图片比例约束生效', async () => {
  const [p] = await parseWorkbook(example);
  const image = { id: 'x', name: p.main[0], url: '', bytes: 1024, width: 600, height: 600 };
  p.images = { [p.main[0]]: image, [p.detail[0]]: { ...image, name: p.detail[0] } };
  p.skus[0].stock = '0';
  assert.deepEqual(problems(p), []);
  p.skus[0].group = '1.234';
  assert.ok(problems(p).some((x) => x.includes('两位小数')));
  p.skus[0].group = '39.9';
  p.images[p.main[0]].height = 700;
  assert.ok(problems(p).some((x) => x.includes('1:1')));
});
test('SQLite 重开保留资料，重复编码事务失败不污染已保存商品', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'goods-db-'));
  let db;
  try {
    db = await Store.open(tmp);
    const [p] = await parseWorkbook(example);
    db.saveProducts([p]);
    await assert.rejects(async () => db.saveProducts([{ ...p, id: crypto.randomUUID() }]));
    assert.equal(db.all('products').length, 1);
    db.close();
    db = await Store.open(tmp);
    assert.equal(db.all('products')[0].code, p.code);
    const shop = {
      id: crypto.randomUUID(),
      name: '测试店铺',
      account: 'test',
      credentialsSaved: true,
      updatedAt: new Date().toISOString(),
    };
    db.saveShop(shop, 'ciphertext-only');
    assert.equal(db.all('shops')[0].secret, undefined);
    assert.equal(db.secret(shop.id), 'ciphertext-only');
    db.saveTasks([
      {
        id: crypto.randomUUID(),
        shopId: shop.id,
        shopName: shop.name,
        code: p.code,
        title: p.title,
        status: 'prepared',
        time: new Date().toISOString(),
        productSnapshot: p,
      },
    ]);
    db.saveProducts([{ ...p, title: '改过的标题' }]);
    assert.equal(db.all('tasks')[0].productSnapshot.title, p.title);
  } finally {
    db?.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
test('一份表坏了不影响其余表导入，失败原因逐份返回', async () => {  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'goods-tolerant-'));
  try {
    await patchedExample(path.join(tmp, 'good.xlsx'), { 1: { B19: 'TEST-OK' } });
    await patchedExample(path.join(tmp, 'bad.xlsx'), { 1: { B15: 'FORMULA_NO_VALUE' } });
    const result = await importFiles(
      [path.join(tmp, 'good.xlsx'), path.join(tmp, 'bad.xlsx')],
      path.join(tmp, 'saved'),
      false,
    );
    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].code, 'TEST-OK');
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].file, 'bad.xlsx');
    assert.match(result.failures[0].reason, /公式/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
test('上架前体检点出库存为零、参考价偏低与缺轮辋直径', () => {
  const { preflight, preflightNotice } = require('../dist-electron/src/product-checks');
  const base = {
    code: 'CHECK-1',
    title: '轮胎',
    reference: '700',
    install: { delivery: 'store', template: '到店模版1' },
    skus: [
      { options: [{ name: '型号', value: 'A' }], group: '600', single: '800', stock: '0', rim: '' },
      { options: [{ name: '型号', value: 'B' }], group: '600', single: '800', stock: '5', rim: '18英寸' },
    ],
  };
  const issues = preflight(base);
  assert.ok(issues.some((line) => /库存为 0/.test(line)));
  assert.ok(issues.some((line) => /参考价 700 不高于最贵单买价 800/.test(line)));
  assert.ok(issues.some((line) => /1 个规格缺轮辋直径/.test(line)));
  assert.match(preflightNotice([base]), /^导入完成，有 3 条上架前待处理：CHECK-1：/);
  // 没开到店安装时不该报轮辋直径与模板缺失。
  const plain = { ...base, install: undefined, reference: '900', skus: base.skus.map((s) => ({ ...s, stock: '5' })) };
  assert.deepEqual(preflight(plain), []);
  assert.equal(preflightNotice([plain]), '');
});
test('图片归属自检拦下引用不到与孤儿图', () => {
  const { auditImages } = require('../dist-electron/src/product-checks');
  const clean = {
    main: ['main-1.png'],
    detail: ['detail-1.png'],
    skus: [{ image: 'sku-1.png' }, {}],
    images: { 'main-1.png': {}, 'detail-1.png': {}, 'sku-1.png': {} },
  };
  assert.deepEqual(auditImages(clean), []);
  const dangling = {
    main: ['main-1.png'],
    detail: [],
    skus: [{ image: 'sku-9.png' }],
    images: { 'main-1.png': {} },
  };
  assert.match(auditImages(dangling).join('|'), /第 1 行规格图「sku-9\.png」不在图片清单里/);
  const orphan = { main: ['main-1.png'], detail: [], skus: [], images: { 'main-2.png': {} } };
  const lines = auditImages(orphan).join('|');
  assert.match(lines, /轮播图 1「main-1\.png」不在图片清单里/);
  assert.match(lines, /图片清单里的「main-2\.png」没有任何位置引用/);
});

test('保存资料时到店安装与轮辋直径不会被丢掉', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'goods-save-install-'));
  try {
    const [product] = await parseWorkbook(v2Example);
    product.install = { delivery: 'store', template: '到店模版1' };
    product.skus = product.skus.map((sku) => ({ ...sku, rim: '17英寸' }));
    const db = await Store.open(path.join(tmp, 'database'));
    try {
      db.saveProducts([product]);
      const [saved] = db.all('products');
      assert.deepEqual(saved.install, { delivery: 'store', template: '到店模版1' });
      assert.equal(saved.skus[0].rim, '17英寸');
      const { sanitizeProducts } = require('../dist-electron/electron/product-service');
      assert.throws(
        () => sanitizeProducts(db, [{ ...saved, skus: [{ ...saved.skus[0], rim: '99英寸' }] }]),
        /轮辋直径不在后台选项里/,
      );
    } finally {
      db.close();
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
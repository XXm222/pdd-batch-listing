const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PddAdapter } = require('../dist-electron/electron/platforms/pdd-adapter');
const { ExecutionError } = require('../dist-electron/electron/execution');

// Local assets are stored under their content hash with no extension; the
// fixtures keep real bytes on disk so the uploaded copy is built for real.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24)]);
// Production asset IDs are content hashes: 64 hex characters and no extension.
const PURPLE_ID = '8'.repeat(64),
  GRAY_ID = '4'.repeat(64);
function assetDirectory(assets = { [PURPLE_ID]: PNG, [GRAY_ID]: PNG }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goods-sku-'));
  fs.mkdirSync(path.join(directory, 'assets'), { recursive: true });
  for (const [name, bytes] of Object.entries(assets))
    fs.writeFileSync(path.join(directory, 'assets', name), bytes);
  return directory;
}

function product() {
  return {
    code: 'MERGED-6',
    images: { purple: { id: PURPLE_ID }, gray: { id: GRAY_ID } },
    skus: ['紫色', '灰色'].flatMap((color, i) =>
      ['10L', '20L', '30L'].map((capacity, j) => ({
        options: [
          { name: '颜色', value: color },
          { name: '容量', value: capacity },
        ],
        group: `${20 + i}.${j}`,
        single: `${30 + i}.${j}`,
        stock: String(i + j),
        code: `${i}${j}`,
        image: i ? 'gray' : 'purple',
      })),
    ),
  };
}

// DOM-shaped fixture: table() executes its actual browser expression over physical
// cells. Rows under a rowspan deliberately omit the inherited cells altogether.
function page(options = {}) {
  const cell = (text, options = {}) => ({
    innerText: text,
    rowSpan: 1,
    colSpan: 1,
    querySelector(selector) {
      return selector === 'input:not([type=file])' && this.input ? this.input : null;
    },
    ...options,
  });
  const input = () => cell('', { input: { value: '' } });
  const head = [
    {
      cells: [
        cell('颜色', { rowSpan: 2 }),
        cell('容量', { rowSpan: 2 }),
        cell('*库存', { rowSpan: 2 }),
        cell('价格', { colSpan: 2 }),
        cell('预览图', { rowSpan: 2 }),
        cell('规格编码', { rowSpan: 2 }),
      ],
    },
    { cells: [cell('拼单价(元)'), cell('单买价(元)')] },
  ];
  const rows = [];
  for (const color of ['紫色', '灰色'])
    for (const [index, capacity] of ['10L', '20L', '30L'].entries()) {
      rows.push({
        cells: [
          ...(index === 0 ? [cell(color, { rowSpan: 3 })] : []),
          cell(capacity),
          input(),
          input(),
          input(),
          ...(index === 0 ? [cell('', { rowSpan: 3, upload: true })] : []),
          input(),
        ],
      });
    }
  const table = {
    innerText: '颜色 容量 库存 拼单价(元) 单买价(元) 预览图 规格编码',
    tHead: { rows: head },
    tBodies: [{ rows }],
    setAttribute() {},
  };
  const document = {
    querySelectorAll(selector) {
      assert.equal(selector, 'table');
      return [table];
    },
  };
  const writes = [],
    uploads = [];
  function physicalCell(selector) {
    const match =
      /tbody:nth-of-type\((\d+)\) > tr:nth-child\((\d+)\) > :is\(td,th\):nth-child\((\d+)\)/.exec(
        selector,
      );
    assert.ok(match, `expected physical cell selector: ${selector}`);
    return table.tBodies[Number(match[1]) - 1].rows[Number(match[2]) - 1].cells[
      Number(match[3]) - 1
    ];
  }
  const adapter = new PddAdapter(options.directory || assetDirectory(options.assets), async () =>
    assert.fail('table checks must not access credentials'),
  );
  adapter.specRows = async () => [
    { name: '颜色', values: ['紫色', '灰色'] },
    { name: '容量', values: ['10L', '20L', '30L'] },
  ];
  const productCode = {
    selector: 'input[data-goods-product-code="true"]',
    value: '',
  };
  adapter.productCodeControl = async () => productCode;
  adapter.task = { id: 'task-1', goodsId: 'goods-1' };
  adapter.context = {
    patch(values) {
      Object.assign(adapter.task, values);
    },
  };
  adapter.skuImageState = async (selector) => {
    const cell = physicalCell(selector);
    return {
      remoteUrl: cell.remoteUrl || '',
      inputSelector: cell.remoteUrl ? null : `${selector} input[type=file]`,
    };
  };
  adapter.bridge = {
    async eval(code) {
      if (code.includes("document.querySelectorAll('table')"))
        return JSON.parse(JSON.stringify(vm.runInNewContext(code, { document })));
      assert.fail('unexpected browser expression in table fixture');
    },
    async wait(check) {
      const result = await check();
      assert.ok(result);
      return result;
    },
    async fill(selector, value) {
      if (selector === productCode.selector) {
        productCode.value = value;
        return;
      }
      const cell = physicalCell(selector);
      assert.ok(cell.input, 'write must target an actual input, not a merged spec/image cell');
      cell.input.value = value;
      writes.push({ selector, value });
    },
    async upload(selector, assetPath, name) {
      const cell = physicalCell(selector);
      assert.equal(cell.upload, true);
      cell.remoteUrl = `https://img.example/${name}.jpg`;
      uploads.push({ selector, name, path: assetPath });
    },
  };
  return { adapter, table, rows, cell, writes, uploads };
}

test('actual table reader expands merged headers and two-dimensional six-SKU rowspans with physical selectors', async () => {
  const f = page(),
    table = await f.adapter.table();
  assert.deepEqual(table.headers, [
    '颜色',
    '容量',
    '库存',
    '拼单价(元)',
    '单买价(元)',
    '预览图',
    '规格编码',
  ]);
  assert.deepEqual(table.requiredHeaders, ['库存']);
  assert.deepEqual(
    table.rows.map((row) => row.cells.slice(0, 2).map((cell) => cell.text)),
    product().skus.map((sku) => sku.options.map((option) => option.value)),
  );
  assert.match(table.rows[1].cells[2].selector, /tr:nth-child\(2\).*nth-child\(2\)$/);
  assert.equal(table.rows[1].cells[0].selector, table.rows[0].cells[0].selector);
  assert.equal(table.rows[1].cells[5].selector, table.rows[0].cells[5].selector);
  assert.equal(f.adapter.matchSkuRows(table, product()).length, 6);
});

test('six merged-row SKUs receive their own price/stock/code and shared preview uploads target the physical image cells', async () => {
  const f = page(),
    p = product();
  await f.adapter.skus(p);
  const actual = await f.adapter.table();
  for (const [i, sku] of p.skus.entries()) {
    const cells = actual.rows[i].cells;
    assert.equal(cells[2].value, sku.stock);
    assert.equal(cells[3].value, sku.group);
    assert.equal(cells[4].value, sku.single);
    assert.equal(cells[6].value, sku.code);
  }
  assert.equal(f.writes.length, 24);
  assert.deepEqual(
    f.uploads.map((upload) => upload.name),
    ['purple', 'gray'],
  );
  assert.match(f.uploads[0].selector, /tr:nth-child\(1\).*nth-child\(6\)/);
  assert.match(f.uploads[1].selector, /tr:nth-child\(4\).*nth-child\(6\)/);
  assert.equal(Object.keys(f.adapter.task.skuImageManifest.slots).length, 2);
  await f.adapter.skus(p);
  assert.equal(
    f.uploads.length,
    2,
    'verified uploaded previews must be reused without accessing disappeared file inputs',
  );
});

test('omitted SKU previews leave existing images intact and still fill and verify all prices and stocks', async () => {
  const f = page(),
    p = product();
  for (const sku of p.skus) sku.image = '';
  f.rows[0].cells[5].remoteUrl = 'https://img.example/existing.jpg';
  await f.adapter.skus(p);
  await f.adapter.verifySkus(p, 'form');
  assert.equal(f.writes.length, 24);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.rows[0].cells[5].remoteUrl, 'https://img.example/existing.jpg');
  assert.equal(f.adapter.task.skuImageManifest, undefined);
});

test('one supplied preview covers its whole merged cell while omitted image cells stay empty', async () => {
  const f = page(),
    p = product();
  for (const sku of p.skus) sku.image = '';
  p.skus[1].image = 'purple';
  await f.adapter.skus(p);
  await f.adapter.verifySkus(p, 'form');
  assert.equal(f.writes.length, 24);
  assert.deepEqual(
    f.uploads.map((upload) => upload.name),
    ['purple'],
  );
  assert.equal(f.rows[3].cells[5].remoteUrl, undefined);
  const slots = Object.keys(f.adapter.task.skuImageManifest.slots);
  assert.equal(slots.length, 1);
  assert.equal(JSON.parse(slots[0]).length, 3);
});

test('a backend-required preview without a supplied or existing image asks to edit the product before writing prices', async () => {
  const f = page(),
    p = product();
  f.table.tHead.rows[0].cells[4].innerText = '*预览图';
  for (const sku of p.skus) sku.image = '';
  await assert.rejects(f.adapter.skus(p), (error) => {
    assert.equal(error.code, 'invalid_product');
    assert.equal(error.recovery, 'edit_product');
    assert.equal(error.details.source, 'required_sku_image');
    assert.match(error.message, /当前类目要求规格预览图.*颜色:紫色/);
    return true;
  });
  assert.equal(f.writes.length, 0);
  assert.equal(f.uploads.length, 0);
  for (const row of [f.rows[0], f.rows[3]])
    row.cells[5].remoteUrl = 'https://img.example/existing.jpg';
  await f.adapter.skus(p);
  await f.adapter.verifySkus(p, 'form');
  assert.equal(f.uploads.length, 0);
});

test('SKU previews are uploaded as named copies, never as the extensionless asset store path', async () => {
  const directory = assetDirectory(),
    f = page({ directory }),
    p = product();
  await f.adapter.skus(p);
  assert.equal(f.uploads.length, 2);
  for (const upload of f.uploads) {
    assert.match(
      upload.path,
      /\.png$/,
      'the browser derives the accepted type from the uploaded file name',
    );
    assert.ok(path.isAbsolute(upload.path));
    assert.equal(path.dirname(upload.path), path.join(directory, 'execution', 'task-1', 'uploads'));
    assert.ok(fs.existsSync(upload.path), 'the uploaded copy must exist on disk');
    const stored = path.join(directory, 'assets', p.images[upload.name].id);
    assert.notEqual(
      upload.path,
      stored,
      'the extensionless asset store path must never be uploaded',
    );
    assert.equal(fs.readFileSync(upload.path).length, fs.readFileSync(stored).length);
  }
});

test('an uploaded copy follows the real image bytes and refuses an unknown format', async () => {
  // The label says .png but the bytes are JPEG: the copy must still be accepted.
  const jpeg = page({ assets: { [PURPLE_ID]: JPEG, [GRAY_ID]: JPEG } });
  await jpeg.adapter.skus(product());
  assert.deepEqual(
    jpeg.uploads.map((upload) => path.extname(upload.path)),
    ['.jpg', '.jpg'],
  );

  const directory = assetDirectory({ 'unknown-asset': Buffer.from('not an image') });
  fs.writeFileSync(path.join(directory, 'assets', 'fallback.png'), Buffer.from('not an image'));
  const adapter = new PddAdapter(directory, async () => assert.fail('no credentials'));
  adapter.task = { id: 'task-1', goodsId: 'goods-1' };
  assert.throws(
    () => adapter.namedUpload('fallback.png', 'fallback.png', 'sku-x'),
    /无法确认图片格式/,
  );
  assert.throws(
    () => adapter.namedUpload('unknown-asset', 'unknown-asset', 'sku-y'),
    /无法确认图片格式/,
  );
  assert.throws(
    () => adapter.namedUpload('missing.png', 'missing.png', 'sku-z'),
    /无法读取本机图片/,
  );
});

test('an unconfirmed SKU upload reports the image cell and the page notice instead of a bare timeout', async () => {
  const f = page(),
    wait = f.adapter.bridge.wait;
  f.adapter.bridge.wait = async (check, timeout, message) => {
    if (!/规格图片上传尚未确认/.test(message || '')) return wait(check, timeout, message);
    f.adapter.skuImageEvidence = async () =>
      '图片格预览图 0 张、上传入口仍在、页面提示“上传图片格式为jpg、jpeg、png”';
    throw new ExecutionError('page_timeout', message);
  };
  await assert.rejects(f.adapter.skus(product()), (error) => {
    assert.match(error.message, /该规格图片上传尚未确认/);
    assert.match(error.message, /上传图片格式为jpg、jpeg、png/);
    assert.equal(error.code, 'page_timeout');
    assert.equal(error.details.source, 'sku_image_upload');
    assert.equal(error.details.image, 'purple');
    assert.match(error.details.fileName, /^sku-purple\.png$/);
    return true;
  });
  assert.equal(
    f.adapter.task.skuImageManifest,
    undefined,
    'an unconfirmed upload is never recorded as reusable',
  );
});

test('duplicate actual or expected combinations cannot be mistaken for a complete matrix', async () => {
  const f = page(),
    p = product(),
    table = await f.adapter.table();
  table.rows[1].cells[1].text = '10L';
  assert.throws(() => f.adapter.matchSkuRows(table, p), /唯一匹配/);
  const clean = await f.adapter.table();
  p.skus[1] = structuredClone(p.skus[0]);
  assert.throws(() => f.adapter.matchSkuRows(clean, p), /唯一匹配/);
});

test('different SKU images cannot overwrite one shared rowspan preview cell', async () => {
  const f = page(),
    p = product();
  p.skus[1].image = 'gray';
  await assert.rejects(f.adapter.skus(p), /合并.*不同图片/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.uploads.length, 0);
});

test('body colspan expansion keeps later physical columns and refuses a shared stock/price input', async () => {
  const f = page();
  // Stock and group price are one physical cell, so all later cells shift left.
  f.rows[0].cells[2].colSpan = 2;
  f.rows[0].cells.splice(3, 1);
  const table = await f.adapter.table();
  assert.equal(table.rows[0].cells[2].selector, table.rows[0].cells[3].selector);
  assert.match(table.rows[0].cells[4].selector, /tr:nth-child\(1\).*nth-child\(4\)$/);
  await assert.rejects(f.adapter.skus(product()), /库存.*跨行或跨列/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.uploads.length, 0);
});

test('unrecorded existing SKU previews are replaced only in their uniquely matched slots and then persisted', async () => {
  const f = page(),
    removed = [];
  f.rows[0].cells[5].remoteUrl = 'https://img.example/legacy-purple.jpg';
  f.rows[3].cells[5].remoteUrl = 'https://img.example/legacy-gray.jpg';
  f.adapter.removeSkuImage = async (selector, expectedUrl) => {
    const state = await f.adapter.skuImageState(selector);
    assert.equal(state.remoteUrl, expectedUrl);
    const index = selector.includes('tr:nth-child(1)')
      ? 0
      : selector.includes('tr:nth-child(4)')
        ? 3
        : -1;
    assert.notEqual(index, -1, 'replacement must stay inside the matched physical image cells');
    f.rows[index].cells[5].remoteUrl = '';
    removed.push(selector);
  };
  await f.adapter.skus(product());
  assert.equal(removed.length, 2);
  assert.equal(f.uploads.length, 2);
  assert.deepEqual(
    Object.values(f.adapter.task.skuImageManifest.slots).map((slot) => slot.assetId),
    [PURPLE_ID, GRAY_ID],
  );
});

test('wrong goods ID, changed local asset or changed remote image cannot satisfy a prior image manifest', async () => {
  for (const mutation of ['goods', 'asset', 'remote']) {
    const f = page(),
      p = product();
    await f.adapter.skus(p);
    if (mutation === 'goods') f.adapter.task.skuImageManifest.goodsId = 'other-goods';
    if (mutation === 'asset') p.images.purple.id = 'c'.repeat(64);
    if (mutation === 'remote') f.rows[0].cells[5].remoteUrl = 'https://img.example/changed.jpg';
    let attempts = 0;
    f.adapter.removeSkuImage = async () => {
      attempts++;
      throw new Error('verified replacement required');
    };
    await assert.rejects(f.adapter.skus(p), /verified replacement required/);
    assert.equal(attempts, 1);
    assert.equal(f.uploads.length, 2);
  }
});

test('a merged image cell cannot be replaced on behalf of only one of its combinations', async () => {
  const f = page(),
    p = product();
  await assert.rejects(
    f.adapter.skuImageSelector(p, {
      image: 'purple',
      combinations: [
        JSON.stringify(p.skus[0].options.map((option) => [option.name, option.value])),
      ],
    }),
    /合并范围已变化/,
  );
  assert.equal(f.uploads.length, 0);
});

test('an upload failure does not record the image as reusable', async () => {
  const f = page();
  f.adapter.bridge.upload = async () => {
    throw new Error('upload interrupted');
  };
  await assert.rejects(f.adapter.skus(product()), /upload interrupted/);
  assert.equal(f.adapter.task.skuImageManifest, undefined);
});

function imageCellFixture({
  urls = ['https://img.example/preview.jpg'],
  uploads = 0,
  buttons = ['删除图片'],
  validCell = true,
} = {}) {
  let deleted = 0;
  const controls = buttons.map((label) => ({
    disabled: false,
    textContent: label,
    getClientRects: () => [{}],
    getAttribute: () => '',
    click() {
      deleted++;
    },
  }));
  const cell = {
    closest: () => validCell,
    querySelectorAll(selector) {
      if (selector === 'img')
        return urls.map((url) => ({ currentSrc: url, getClientRects: () => [{}] }));
      if (selector === '[style]') return [];
      if (selector === 'input[type=file]')
        return Array.from({ length: uploads }, () => ({ disabled: false }));
      if (selector === 'button,[role=button],[aria-label],[title]') return controls;
      if (
        selector ===
        'i[data-tracking-click-viewid="el_specification_batch_modification_delete_images"]'
      )
        return [];
      assert.fail(`unexpected image selector ${selector}`);
    },
  };
  const document = {
    querySelectorAll(selector) {
      assert.equal(selector, 'specific-sku-cell');
      return [cell];
    },
  };
  const adapter = new PddAdapter('/isolated', async () => assert.fail('no credentials'));
  adapter.task = { goodsId: 'goods-1' };
  adapter.bridge = {
    eval: async (code) =>
      JSON.parse(
        JSON.stringify(
          vm.runInNewContext(code, {
            document,
            URL,
            TextEncoder,
            location: {
              origin: 'https://mms.pinduoduo.com',
              href: 'https://mms.pinduoduo.com/goods/goods_add/index?goods_id=goods-1',
            },
            getComputedStyle: () => ({ visibility: 'visible' }),
          }),
        ),
      ),
  };
  return { adapter, cell, deleted: () => deleted };
}

test('image reader distinguishes a completed preview from an empty unique file input', async () => {
  const ready = await imageCellFixture().adapter.skuImageState('specific-sku-cell');
  assert.equal(ready.remoteUrl, 'https://img.example/preview.jpg');
  assert.equal(ready.inputSelector, null);
  const empty = await imageCellFixture({ urls: [], uploads: 1 }).adapter.skuImageState(
    'specific-sku-cell',
  );
  assert.equal(empty.remoteUrl, '');
  assert.equal(empty.inputSelector, 'specific-sku-cell input[type=file]');
});

test('preview deletion atomically rechecks image URL and one explicit delete control in the same SKU cell', async () => {
  const f = imageCellFixture();
  await assert.rejects(
    f.adapter.removeSkuImage('specific-sku-cell', 'https://img.example/other.jpg'),
    /预览图已变化/,
  );
  assert.equal(f.deleted(), 0);
  await f.adapter.removeSkuImage('specific-sku-cell', 'https://img.example/preview.jpg');
  assert.equal(f.deleted(), 1);
  for (const options of [
    { urls: ['https://img.example/1.jpg', 'https://img.example/2.jpg'] },
    { buttons: ['删除', '移除'] },
    { buttons: ['其他操作'] },
    { validCell: false },
  ]) {
    const ambiguous = imageCellFixture(options);
    await assert.rejects(
      ambiguous.adapter.removeSkuImage('specific-sku-cell', 'https://img.example/preview.jpg'),
    );
    assert.equal(ambiguous.deleted(), 0);
  }
});

test('unknown delete control reports only a bounded structural summary of that one image cell', async () => {
  const f = imageCellFixture({ buttons: [] });
  const node = (tagName, attributes, text, children = []) => ({
    tagName,
    children,
    value: 'BUSINESS_INPUT_SECRET',
    getAttribute: (name) => attributes[name] || null,
    childNodes: [{ nodeType: 3, textContent: text }],
  });
  f.cell.tagName = 'TD';
  f.cell.getAttribute = (name) => (name === 'class' ? 'sku-preview-cell' : null);
  f.cell.children = [
    node(
      'DIV',
      {
        class: 'preview-wrapper',
        style: 'background-image:url(https://private.example/image.jpg)',
      },
      '',
      [
        node('SVG', { class: 'close-icon', title: '删除预览', role: 'button' }, ''),
        node(
          'IMG',
          { src: 'https://private.example/image.jpg', title: 'https://private.example/path' },
          '',
        ),
        node('INPUT', { class: 'upload-input' }, 'BUSINESS_INPUT_SECRET'),
      ],
    ),
    ...Array.from({ length: 25 }, () =>
      node('DIV', { class: 'long-class-'.repeat(15) }, '填充文字'.repeat(20)),
    ),
  ];
  await assert.rejects(
    f.adapter.removeSkuImage('specific-sku-cell', 'https://img.example/preview.jpg'),
    (error) => {
      assert.match(error.message, /sku-preview-cell/);
      assert.match(error.message, /close-icon/);
      assert.match(error.message, /"depth":2/);
      assert.doesNotMatch(
        error.message,
        /BUSINESS_INPUT_SECRET|private\.example|background-image|"src"|"style"/,
      );
      const summary = error.message
        .split('仅该图片格的控件结构：')[1]
        .split('；已保留其他规格图')[0];
      assert.ok(Buffer.byteLength(summary) <= 5000);
      return true;
    },
  );
  assert.equal(f.deleted(), 0);
});

test('deeply wrapped X icon is reported read-only without treating its shape or class as permission to delete', async () => {
  const f = imageCellFixture({ buttons: [] });
  const node = (tagName, className, children = []) => ({
    tagName,
    children,
    getAttribute: (name) =>
      name === 'class'
        ? className
        : name === 'src'
          ? 'https://private.example/image.jpg'
          : name === 'style'
            ? 'secret-style'
            : null,
    childNodes: [],
    click() {
      assert.fail('structural diagnostics must never click an unlabelled icon');
    },
  });
  let branch = node('PATH', 'x-path-do-not-click');
  branch = node('SVG', 'x-svg-do-not-click', [branch]);
  branch = node('I', 'x-icon-class-'.repeat(14), [branch]);
  branch = node('SPAN', 'x-wrapper', [branch]);
  for (let i = 0; i < 9; i++) branch = node('DIV', `nested-${i}`, [branch]);
  f.cell.tagName = 'TD';
  f.cell.children = [branch];
  await assert.rejects(
    f.adapter.removeSkuImage('specific-sku-cell', 'https://img.example/preview.jpg'),
    (error) => {
      const summary = error.message
        .split('仅该图片格的控件结构：')[1]
        .split('；已保留其他规格图')[0];
      const rows = summary.split('\n').map((row) => JSON.parse(row));
      assert.ok(rows.some((row) => row.tag === 'path' && row.depth === 13));
      assert.ok(rows.some((row) => row.tag === 'svg' && row.depth === 12));
      assert.equal(rows.find((row) => row.tag === 'i').class.length, 120);
      assert.ok(Buffer.byteLength(summary) <= 5000);
      assert.doesNotMatch(summary, /private\.example|secret-style|"src"|"style"/);
      return true;
    },
  );
  assert.equal(f.deleted(), 0);
});

function trackedImageCellFixture(options = {}) {
  const f = imageCellFixture({ urls: [], buttons: options.namedFallback ? ['删除'] : [] });
  let clicked = 0,
    neighborClicked = 0,
    batchClicked = 0;
  const visible = { getClientRects: () => [{}] };
  const container = {
    ...visible,
    style: { backgroundImage: `url("${options.url || 'https://img.example/preview.jpg'}")` },
  };
  const wrapper = {
    ...visible,
    querySelectorAll(selector) {
      assert.equal(selector, 'span[style]');
      return options.duplicateContainers ? [container, container] : [container];
    },
  };
  const icon = {
    ...visible,
    parentElement: options.wrongParent ? {} : container,
    closest(selector) {
      assert.equal(selector, '.goods-sku-img');
      return options.wrongWrapper ? {} : wrapper;
    },
    click() {
      clicked++;
    },
  };
  // Identical tracking attributes can exist on adjacent rows and the batch
  // toolbar. The production expression may query only the supplied cell.
  const neighbor = {
    ...icon,
    click() {
      neighborClicked++;
    },
  };
  const batch = {
    ...icon,
    click() {
      batchClicked++;
    },
  };
  const original = f.cell.querySelectorAll;
  f.cell.querySelectorAll = (selector) => {
    if (selector === '[style]') return [container];
    if (selector === '.goods-sku-img')
      return options.duplicateWrappers ? [wrapper, wrapper] : [wrapper];
    if (
      selector ===
      'i[data-tracking-click-viewid="el_specification_batch_modification_delete_images"]'
    )
      return options.outsideOnly ? [] : options.duplicateIcons ? [icon, icon] : [icon];
    return original(selector);
  };
  return {
    ...f,
    neighbor,
    batch,
    clicked: () => clicked,
    neighborClicked: () => neighborClicked,
    batchClicked: () => batchClicked,
  };
}

test('observed PDD tracking icon replaces only its exact SKU preview and leaves adjacent rows and batch controls untouched', async () => {
  const f = trackedImageCellFixture();
  await f.adapter.removeSkuImage('specific-sku-cell', 'https://img.example/preview.jpg');
  assert.equal(f.clicked(), 1);
  assert.equal(f.neighborClicked(), 0);
  assert.equal(f.batchClicked(), 0);
  assert.equal(f.deleted(), 0, 'named fallback is not involved in the tracked-icon path');
  const outside = trackedImageCellFixture({ outsideOnly: true });
  await assert.rejects(
    outside.adapter.removeSkuImage('specific-sku-cell', 'https://img.example/preview.jpg'),
    /没有唯一明确/,
  );
  assert.equal(outside.neighborClicked(), 0);
  assert.equal(outside.batchClicked(), 0);
});

test('tracked deletion rejects ambiguous or foreign containers even when a named fallback is also present', async () => {
  for (const options of [
    { duplicateIcons: true },
    { duplicateWrappers: true },
    { duplicateContainers: true },
    { wrongParent: true },
    { wrongWrapper: true },
  ]) {
    const f = trackedImageCellFixture({ ...options, namedFallback: true });
    await assert.rejects(
      f.adapter.removeSkuImage('specific-sku-cell', 'https://img.example/preview.jpg'),
      /没有唯一对应当前预览容器/,
    );
    assert.equal(f.clicked(), 0);
    assert.equal(f.deleted(), 0);
    assert.equal(f.neighborClicked(), 0);
    assert.equal(f.batchClicked(), 0);
  }
});

test('tracked icon cannot delete a preview whose URL changed after it was inspected', async () => {
  const f = trackedImageCellFixture({ url: 'https://img.example/replaced.jpg' });
  await assert.rejects(
    f.adapter.removeSkuImage('specific-sku-cell', 'https://img.example/preview.jpg'),
    /预览图已变化/,
  );
  assert.equal(f.clicked(), 0);
  assert.equal(f.neighborClicked(), 0);
  assert.equal(f.batchClicked(), 0);
});

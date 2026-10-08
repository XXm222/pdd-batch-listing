const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const {
  newProduct,
  applyImages,
  imageProblems,
  imageUploadSizeLimit,
  problems,
  missingSkuImages,
  withSkuOptions,
} = require('../dist-electron/src/domain');
const {
  saveImage,
  inspectImageFile,
  validateLocalImageFiles,
} = require('../dist-electron/electron/importer');
const { PddAdapter } = require('../dist-electron/electron/platforms/pdd-adapter');
const { readImageUploadFacts } = require('../dist-electron/electron/platforms/pdd-page-scripts');
const { ExecutionError } = require('../dist-electron/electron/execution');
const vm = require('node:vm');
const base = {
  id: 'a'.repeat(64),
  name: 'large.png',
  url: '',
  width: 600,
  height: 600,
  bytes: 3 * 1024 * 1024,
  format: 'png',
};
test('editing shared SKU dimensions preserves option order, prices, real zero stock and image bindings', () => {
  const sku = {
    spec: '颜色:紫色 / 容量:10L',
    options: [
      { name: '颜色', value: '紫色' },
      { name: '容量', value: '10L' },
    ],
    group: '19.99',
    single: '20.99',
    stock: '0',
    code: 'SKU-1',
    image: 'purple.jpg',
  };
  const renamed = withSkuOptions(sku, [
    { name: '款式', value: '紫色' },
    { name: '', value: '10L' },
  ]);
  assert.deepEqual(renamed.options, [
    { name: '款式', value: '紫色' },
    { name: '', value: '10L' },
  ]);
  assert.equal(renamed.spec, '款式:紫色 / :10L');
  for (const key of ['group', 'single', 'stock', 'code', 'image'])
    assert.equal(renamed[key], sku[key]);
  assert.equal(sku.options[0].name, '颜色');
  const single = withSkuOptions(sku, [
    { name: '颜色', value: '紫色' },
    { name: '', value: '' },
  ]);
  assert.equal(single.options.length, 1);
  assert.equal(
    withSkuOptions(sku, [
      { name: '', value: '' },
      { name: '', value: '' },
    ]).spec,
    '默认规格',
  );
});
test('SKU image prompts clear when a real image is bound and do not turn every category into a mandatory-image rule', () => {
  const p = newProduct();
  p.templateFormat = '运营模板 v3';
  p.skus[0].options = [{ name: '颜色', value: '紫色' }];
  const initialProblems = problems(p);
  assert.deepEqual(missingSkuImages(p), [0]);
  assert.deepEqual(problems(p), initialProblems);
  const supplied = applyImages(p, [base], { kind: 'sku', index: 0 });
  assert.deepEqual(missingSkuImages(supplied), []);
  delete supplied.images[supplied.skus[0].image];
  assert.deepEqual(missingSkuImages(supplied), [0]);
  p.skus[0].options = [];
  assert.deepEqual(missingSkuImages(p), []);
  p.templateFormat = '淘宝运营模板 v4';
  p.skus[0].options = [{ name: '颜色', value: '紫色' }];
  assert.deepEqual(missingSkuImages(p), []);
});
test('full upload area remains readable after its file input disappears; input selection is scoped and unambiguous', () => {
  const run = (local, generic, global, rootCount = 1) => {
    const root = {
      innerText: '已上传10/10，图片大小小于3MB',
      querySelectorAll: (selector) => (selector.includes('data-tracking') ? local : generic),
    };
    const document = {
      querySelectorAll: (selector) =>
        selector === '[id="basic.carousel_gallery"]'
          ? Array.from({ length: rootCount }, () => root)
          : selector.startsWith('input')
            ? global
            : [],
    };
    return JSON.parse(
      JSON.stringify(
        vm.runInNewContext(`(${readImageUploadFacts.toString()})("main")`, { document }),
      ),
    );
  };
  const full = run([], [], []);
  assert.equal(full.available, true);
  assert.equal(full.inputCount, 0);
  assert.equal(full.inputSelector, '');
  assert.match(full.text, /10\/10/);
  const own = run([{}], [{}], [{}, {}]);
  assert.equal(own.inputCount, 1);
  assert.match(own.inputSelector, /^\[id="basic.carousel_gallery"\]/);
  const plain = run([], [{}], []);
  assert.match(plain.inputSelector, /input\[type="file"\]/);
  const ambiguous = run([{}, {}], [{}, {}], [{}, {}]);
  assert.equal(ambiguous.inputSelector, '');
  assert.equal(ambiguous.inputCount, 2);
  assert.equal(run([], [], [], 2).available, false);
});
test('area remount is retried, while ambiguous submission inputs stop with diagnostics', async () => {
  const a = new PddAdapter('/unused', async () => ''),
    good = {
      available: true,
      rootCount: 1,
      inputCount: 0,
      inputSelector: '',
      text: '已上传10/10',
      notices: [],
    };
  a.context = { guard: () => {}, patch: () => {} };
  let calls = 0;
  a.bridge = {
    eval: async () => (++calls === 1 ? { ...good, available: false, rootCount: 0 } : good),
    wait: async (check) => {
      for (let i = 0; i < 3; i++) {
        const result = await check();
        if (result) return result;
      }
      throw new ExecutionError('page_timeout', 'timeout');
    },
  };
  assert.equal((await a.imageUploadFacts('main')).available, true);
  assert.equal(calls, 2);
  a.bridge.eval = async () => ({ ...good, inputCount: 2 });
  await assert.rejects(
    a.imageUploadFacts('main', true),
    (e) =>
      e.code === 'platform_changed' &&
      e.details.inputCount === 2 &&
      e.details.requireInput === true,
  );
});
test('image upload confirmation finishes when full controls remove pickers and never re-submits the files', async () => {
  const a = new PddAdapter('/unused', async () => ''),
    t = { id: 't', goodsId: '123' },
    p = {
      ...newProduct(),
      main: ['m'],
      detail: ['d'],
      images: { m: { ...base, bytes: 1000 }, d: { ...base, bytes: 1000 } },
    };
  a.task = t;
  a.context = {
    guard: () => {},
    patch: (values) => Object.assign(t, values),
    step: async (_name, work) => work(),
  };
  a.namedUpload = () => '/mock';
  a.count = async () => 0;
  const uploaded = { main: false, detail: false },
    submits = [];
  a.remoteImages = async () => ({
    main: uploaded.main ? ['https://img.example/m'] : [],
    detail: uploaded.detail ? ['https://img.example/d'] : [],
  });
  a.bridge = {
    eval: async (code) => {
      if (code.includes('readImageUploadFacts')) {
        const kind = code.endsWith('("detail")') ? 'detail' : 'main';
        return {
          available: true,
          rootCount: 1,
          inputCount: uploaded[kind] ? 0 : 1,
          inputSelector: uploaded[kind] ? '' : kind,
          text: '',
          notices: [],
        };
      }
      return { main: uploaded.main ? 1 : 0, detail: uploaded.detail ? 1 : 0 };
    },
    wait: async (check) => {
      for (let i = 0; i < 3; i++) {
        const r = await check();
        if (r) return r;
      }
      throw new ExecutionError('page_timeout', 'timeout');
    },
    uploadMany: async (selector) => {
      submits.push(selector);
      uploaded[selector] = true;
    },
  };
  await a.images(t, p);
  assert.deepEqual(submits, ['main', 'detail']);
  assert.equal(t.uploadManifest.main.length, 1);
  assert.equal(t.uploadManifest.detail.length, 1);
  await a.images(t, p);
  assert.equal(submits.length, 2);
});
test('resuming accepted submissions waits for the original pictures without reuploading or trusting an incomplete submission', async () => {
  const a = new PddAdapter('/unused', async () => ''),
    p = { ...newProduct(), main: ['m'], detail: ['d'] };
  const t = {
    id: 't',
    goodsId: '123',
    productSnapshot: p,
    uploadSubmission: { goodsId: '123', main: ['m'], detail: ['d'] },
    timings: [
      { name: '批量提交1张商品轮播图', status: 'done' },
      { name: '批量提交1张商品详情', status: 'done' },
    ],
  };
  a.task = t;
  a.context = {
    guard: () => {},
    patch: (values) => Object.assign(t, values),
    step: async (_name, work) => work(),
  };
  a.bridge = { eval: async () => true, wait: async (check) => check() };
  a.inspectDiagnosis = async () => ({ available: true });
  a.remoteImages = async () => ({
    main: ['https://img.example/m'],
    detail: ['https://img.example/d'],
  });
  await a.reuseSubmittedImages(t, { name: '店铺', account: '账号' }, p);
  assert.equal(t.uploadManifest.main.length, 1);
  assert.equal(t.uploadManifest.goodsId, '123');
  delete t.uploadManifest;
  t.uploadSubmission.detail = ['other'];
  await assert.rejects(
    a.reuseSubmittedImages(t, { name: '店铺', account: '账号' }, p),
    (e) => e.code === 'upload_uncertain',
  );
  t.timings.pop();
  a.recoverPage = async () => {
    throw Error('must not claim incomplete submissions');
  };
  await a.reuseSubmittedImages(t, { name: '店铺', account: '账号' }, p);
});
test('both local entry paths enforce byte validity, 20MB reading cap and known main rules without inventing detail limit', () => {
  const p = newProduct();
  assert.throws(() => applyImages(p, [base], { kind: 'main' }), /large.png.*3MB/);
  const badBatch = Array.from({ length: 4 }, (_, i) => ({
    ...base,
    name: `${i + 1}-${'长文件名'.repeat(15)}.png`,
    width: 2560,
    height: 1080,
  }));
  assert.throws(
    () => applyImages(p, badBatch, { kind: 'main' }),
    (error) =>
      error.imageIssues.length === 8 &&
      badBatch.every((a) => error.imageIssues.some((issue) => issue.includes(a.name))),
  );
  const detail = applyImages(p, [base], { kind: 'detail' });
  assert.equal(detail.detail.length, 1);
  assert.equal(imageProblems(base, 'detail').length, 0);
  for (const bytes of [0, -1, NaN, Infinity, 20 * 1024 * 1024 + 1]) {
    const a = { ...base, bytes };
    assert.throws(() => applyImages(p, [a], { kind: 'detail' }), /大小|20MB/);
    const imported = { ...p, detail: ['large.png'], images: { 'large.png': a } };
    assert.ok(problems(imported).some((s) => /large.png.*(?:大小|20MB)/.test(s)));
  }
  assert.ok(imageProblems({ ...base, format: 'gif' }, 'detail').some((s) => s.includes('PNG')));
  assert.ok(imageProblems({ ...base, width: 1.5 }, 'detail').some((s) => s.includes('尺寸无效')));
  assert.equal(imageUploadSizeLimit('推荐图片小于3MB，最多50张'), undefined);
  assert.equal(imageUploadSizeLimit('已上传0/50，推荐宽790px'), undefined);
  const cap = imageUploadSizeLimit('PNG/JPEG，单张图片大小不超过 5MB');
  assert.equal(cap.bytes, 5 * 1024 * 1024);
  assert.equal(cap.strict, false);
  assert.equal(imageUploadSizeLimit('图片大小须小于 500KB').strict, true);
});
test('execution rereads actual images and detects altered byte metadata, content and symlinks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goods-image-validation-'));
  try {
    const image = await saveImage(path.resolve('resources/assets/foot-bath-main.png'), dir);
    assert.equal(image.format, 'png');
    const p = { ...newProduct(), detail: [image.name], images: { [image.name]: image } };
    await validateLocalImageFiles(p, dir);
    await assert.rejects(
      validateLocalImageFiles(
        { ...p, images: { [image.name]: { ...image, bytes: image.bytes - 1 } } },
        dir,
      ),
      /资料不同/,
    );
    await fs.writeFile(path.join(dir, image.id), Buffer.from('not an image'));
    await assert.rejects(validateLocalImageFiles(p, dir), /PNG|JPEG/);
    await fs.unlink(path.join(dir, image.id));
    await fs.symlink(path.resolve('resources/assets/foot-bath-main.png'), path.join(dir, image.id));
    await assert.rejects(inspectImageFile(path.join(dir, image.id)), /符号链接/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('PDD stops before submitting any image when the current detail field declares a smaller cap', async () => {
  const a = new PddAdapter('/unused', async () => ''),
    p = {
      ...newProduct(),
      main: ['m'],
      detail: ['large.png'],
      images: { m: { ...base, name: 'm', bytes: 1000 }, 'large.png': base },
    };
  a.task = { id: 't', goodsId: '123' };
  a.context = { patch: () => {}, guard: () => {}, step: async (_name, fn) => fn() };
  a.remoteImages = async () => ({ main: [], detail: [] });
  a.imageUploadFacts = async (kind) => ({
    available: true,
    text: kind === 'detail' ? '单张图片大小须小于 3MB' : '',
    notices: [],
  });
  let uploads = 0;
  a.bridge = {
    uploadMany: async () => {
      uploads++;
    },
  };
  await assert.rejects(
    a.images(a.task, p),
    (e) =>
      e.code === 'invalid_product' &&
      e.recovery === 'edit_product' &&
      e.details.name === 'large.png',
  );
  assert.equal(uploads, 0);
  a.imageUploadFacts = async () => ({ available: true, text: '未标明大小上限', notices: [] });
  a.count = async () => 0;
  a.namedUpload = () => '/mock';
  let after = false;
  a.bridge = {
    uploadMany: async () => {
      after = true;
      uploads++;
    },
    eval: async (code) =>
      code.includes('readImageUploadFacts')
        ? {
            available: true,
            text: '',
            notices: after ? ['图片大小超过限制，请压缩后重新上传'] : [],
          }
        : { main: 0, detail: 0 },
    wait: async (check) => check(),
  };
  // Preserve the seam above so the rejection path uses the same page facts contract.
  a.imageUploadFacts = async () => ({
    available: true,
    text: '',
    notices: after ? ['图片大小超过限制，请压缩后重新上传'] : [],
  });
  await assert.rejects(
    a.images(a.task, p),
    (e) => e.code === 'invalid_product' && e.details.source === 'image_upload_rejection',
  );
});

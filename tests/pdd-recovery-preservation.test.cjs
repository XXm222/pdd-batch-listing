const test = require('node:test');
const assert = require('node:assert/strict');
const { PddAdapter } = require('../dist-electron/electron/platforms/pdd-adapter');
const shop = {
  id: 's',
  name: 'fixture shop',
  account: 'fixture shop:operator',
  updatedAt: '2026-01-01',
};
const task = {
  id: 'existing-task',
  goodsId: '123',
  formUrl: 'https://mms.pinduoduo.com/goods/goods_add/index?goods_id=123',
  checkpoint: { step: 'skus' },
  attempt: 1,
  productSnapshot: {
    title: '商品标题',
    brand: '品牌',
    material: '材质',
    audience: '',
    foldable: '',
    attributes: [],
  },
};
const full = () => ({
  available: true,
  fields: [
    { name: '商品标题', value: '商品标题' },
    { name: '品牌', value: '品牌' },
    { name: '材质', value: '材质' },
  ],
  errors: [],
  dialogs: [],
});
const empty = () => ({
  available: true,
  fields: [{ name: '商品标题', value: '' }],
  errors: [],
  dialogs: [],
});
async function fixture(sequence, work) {
  const a = new PddAdapter('/unused', async () => {
    throw Error('not allowed');
  });
  let reads = 0,
    navigations = 0,
    tick = 0;
  const original = Date.now;
  Date.now = () => tick;
  a.inspectDiagnosis = async () => {
    const page = sequence[Math.min(reads, sequence.length - 1)];
    reads++;
    return structuredClone(page);
  };
  a.bridge = {
    eval: async () => true,
    navigate: async () => {
      navigations++;
    },
    wait: async (check) => {
      for (let i = 0; i < 16; i++) {
        tick += 300;
        if (await check()) return true;
      }
      throw Error('fixture bounded wait expired');
    },
  };
  try {
    await work({
      a,
      get reads() {
        return reads;
      },
      get navigations() {
        return navigations;
      },
    });
  } finally {
    Date.now = original;
  }
}

test('legacy restore request never reopens an unsaved add URL even when the same goods ID is retained', async () => {
  const a = new PddAdapter('/unused', async () => {
    throw Error('not allowed');
  });
  a.bridge = {
    eval: async () => {
      throw Error('must not read or navigate');
    },
    navigate: async () => {
      throw Error('must not navigate');
    },
  };
  const before = JSON.stringify(task),
    result = await a.recoverPage(task, shop, 'restore_original_form');
  assert.equal(result.ok, false);
  assert.match(result.message, /清空已填资料/);
  assert.equal(JSON.stringify(task), before);
});

test('wait confirms stable preserved fields rather than merely the presence of a title input', async () => {
  await fixture([full()], async (f) => {
    const result = await f.a.recoverPage(task, shop, 'wait_form_ready');
    assert.equal(result.ok, true);
    assert(f.reads >= 5);
    assert.equal(f.navigations, 0);
    assert.match(result.message, /不代表原脚本定位或规格错误已解决/);
    assert.equal(result.formState, JSON.stringify([full().fields, [], [], undefined]));
  });
});

test('a temporarily incomplete form resets the stability window before any success', async () => {
  await fixture([full(), full(), empty(), full()], async (f) => {
    const result = await f.a.recoverPage(task, shop, 'wait_form_ready');
    assert.equal(result.ok, true);
    assert(f.reads >= 7);
    assert.equal(f.navigations, 0);
  });
});

test('missing or cleared fields after a completed basic step never count as recovered', async () => {
  for (const after of [
    empty(),
    { available: false, reason: 'still loading' },
    {
      ...full(),
      fields: full().fields.map((f) => (f.name === '材质' ? { ...f, value: 'changed' } : f)),
    },
  ]) {
    await fixture([full(), after], async (f) => {
      const result = await f.a.recoverPage(task, shop, 'wait_form_ready');
      assert.equal(result.ok, false);
      assert.equal(f.navigations, 0);
      assert.match(result.message, /尚未稳定.*未刷新/);
    });
  }
});

test('final verification catches a late field reset after the stable observation window', async () => {
  await fixture([full(), full(), full(), full(), empty()], async (f) => {
    const result = await f.a.recoverPage(task, shop, 'wait_form_ready');
    assert.equal(result.ok, false);
    assert.equal(f.navigations, 0);
  });
});

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  pddCategoryLeaf,
  readPddCategoryLeaf,
  clickPddCategoryResult,
} = require('../dist-electron/electron/platforms/pdd-page-scripts');
const { PddAdapter } = require('../dist-electron/electron/platforms/pdd-adapter');

const LEAF = '足浴盆/足浴桶';
const PATH = `家庭/个人清洁工具 > 卫浴/置物用具 > ${LEAF}`;
function page(paths = [PATH]) {
  let selected = '';
  const node = (text, hidden = false) => ({
    innerText: text,
    getClientRects: () => (hidden ? [] : [{}]),
    click() {
      selected = text;
    },
  });
  const results = paths.map((path) => node(path));
  const form = [node(PATH)];
  const input = { value: '', focus() {}, click() {}, dispatchEvent() {} };
  const document = {
    body: { innerText: PATH },
    querySelector: () => input,
    querySelectorAll(selector) {
      if (selector === '[data-testid="beast-core-search-panel"] li') return results;
      if (selector === '.category-area .sort-name') return form;
      if (selector === '.bottom-container-v2 .cate-text') return selected ? [node(selected)] : [];
      if (selector.startsWith('input[')) return [node('')];
      return [];
    },
  };
  return {
    results,
    form,
    input,
    selected: () => selected,
    run: (code) =>
      vm.runInNewContext(code, {
        document,
        getComputedStyle: () => ({ visibility: 'visible' }),
        MouseEvent: class {},
      }),
  };
}

test('末级类目保留斜杠，完整路径、单名称及不同层级均取最后一级', () => {
  for (const category of [LEAF, PATH, `家居生活 ＞ ${PATH}`, `其他上级 >> ${LEAF} `])
    assert.equal(pddCategoryLeaf(category), LEAF);
  assert.equal(pddCategoryLeaf(' > > '), '');
});

test('搜索结果仅点击唯一可见的精确末级名称，不使用旧的 selectedCate ID', () => {
  const p = page([PATH, '家电 > 电动足浴盆/足浴桶', '家居 > 沐浴桶/沐浴盆']);
  p.results.push({ innerText: PATH, getClientRects: () => [], click: () => assert.fail('hidden') });
  const result = p.run(`(${clickPddCategoryResult.toString()})(${JSON.stringify(LEAF)})`);
  assert.equal(result.count, 1);
  assert.equal(result.path, PATH);
  assert.equal(p.selected(), PATH);
});

test('多个同名类目或没有精确匹配时不点击猜测结果', () => {
  for (const paths of [[PATH, `其他分类 > ${LEAF}`], ['家具 > 足浴盆']]) {
    const p = page(paths);
    const result = p.run(`(${clickPddCategoryResult.toString()})(${JSON.stringify(LEAF)})`);
    assert.notEqual(result.count, 1);
    assert.equal(p.selected(), '');
  }
});

test('填写页核对只读取实际分类栏，不被正文或隐藏的同名类目误导', () => {
  const p = page();
  assert.equal(p.run(`(${readPddCategoryLeaf.toString()})()`), LEAF);
  p.form[0].innerText = '其他上级 > 沐浴桶/沐浴盆';
  assert.equal(p.run(`(${readPddCategoryLeaf.toString()})()`), '沐浴桶/沐浴盆');
  p.form[0].getClientRects = () => [];
  assert.equal(p.run(`(${readPddCategoryLeaf.toString()})()`), '');
});

test('适配器用末级名称搜索并确认已选分类，同名歧义给出可处理提示', async () => {
  for (const category of [LEAF, PATH]) {
    const adapter = new PddAdapter('/unused', async () => assert.fail('credentials'));
    adapter.context = { guard() {} };
    const p = page();
    adapter.bridge = {
      eval: async (code) => p.run(code),
      fill: async (selector, value, mode) => {
        assert.equal(value, LEAF);
        assert.equal(mode, 'keyboard');
        p.input.value = value;
      },
      wait: async (check) => {
        const value = await check();
        assert.ok(value);
        return value;
      },
    };
    await adapter.selectCategory(category);
    assert.equal(p.selected(), PATH);
    const ambiguous = page([PATH, `另一上级 > ${LEAF}`]);
    adapter.bridge.eval = async (code) => ambiguous.run(code);
    adapter.bridge.fill = async (_selector, value) => {
      ambiguous.input.value = value;
    };
    await assert.rejects(
      adapter.selectCategory(category),
      (error) => error.code === 'form_changed' && /多个同名类目/.test(error.message),
    );
    assert.equal(ambiguous.selected(), '');
  }
});

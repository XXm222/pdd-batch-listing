/**
 * 淘宝发品流程的纯逻辑覆盖：标题长度、图片落位计划、价格/数量取值、
 * 类目候选匹配、图片落位核对。
 *
 * 真实页面行为（选择器、确认弹窗、级联）由 verification/taobao-20261006/ 的
 * 实跑记录与截图背书，这里只测不依赖浏览器的部分，也不模拟页面。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TAOBAO_MAIN_IMAGE_LIMIT,
  TAOBAO_DETAIL_IMAGE_LIMIT,
  TB_SHOWN,
  taobaoCharLength,
  taobaoTitleProblem,
  taobaoImagePlan,
  taobaoPrice,
  taobaoQuantity,
  taobaoAttributePlan,
  matchTaobaoCategoryPath,
  taobaoImageProblems,
  taobaoImageSummary,
  taobaoSkuPlan,
} = require('../dist-electron/electron/platforms/taobao-publish.js');

test('标题长度按汉字 2 字符计算', () => {
  assert.equal(taobaoCharLength('abc'), 3);
  assert.equal(taobaoCharLength('泡脚桶'), 6);
  assert.equal(taobaoCharLength('泡脚桶abc'), 9);
  // 真实在售商品标题正好 30 个汉字 = 60 字符，必须判为合规
  const real = '家用泡脚桶可折叠保温泡脚袋恒温高深过小腿足浴桶便携宿舍泡脚盆';
  assert.equal(taobaoCharLength(real), 60);
  assert.equal(taobaoTitleProblem(real), null);
});

test('标题超长与空标题都要被拦下', () => {
  assert.match(taobaoTitleProblem(''), /为空/);
  assert.match(taobaoTitleProblem('   '), /为空/);
  const tooLong = '家'.repeat(31); // 62 字符
  assert.match(taobaoTitleProblem(tooLong), /超长：62\/60/);
});

test('主图裁到 5 张、详情图裁到 20 张，溢出量如实返回', () => {
  const plan = taobaoImagePlan({
    main: Array.from({ length: 10 }, (_, i) => `main-${i + 1}`),
    detail: Array.from({ length: 25 }, (_, i) => `detail-${i + 1}`),
  });
  assert.equal(plan.main.length, TAOBAO_MAIN_IMAGE_LIMIT);
  assert.equal(plan.main[0], 'main-1');
  assert.equal(plan.main[4], 'main-5');
  assert.equal(plan.detail.length, TAOBAO_DETAIL_IMAGE_LIMIT);
  assert.deepEqual(plan.overflow, { main: 5, detail: 5 });
});

test('图片数量不足时不补空、不报溢出', () => {
  const plan = taobaoImagePlan({ main: ['a'], detail: [] });
  assert.deepEqual(plan.main, ['a']);
  assert.deepEqual(plan.detail, []);
  assert.deepEqual(plan.overflow, { main: 0, detail: 0 });
});

test('一口价取第一个有库存 SKU 的单买价', () => {
  assert.equal(
    taobaoPrice({
      skus: [
        { spec: '10L', group: '', single: '49.9', stock: '0' },
        { spec: '20L', group: '', single: '59.9', stock: '8' },
      ],
    }),
    '59.9',
  );
  assert.equal(
    taobaoPrice({ skus: [{ spec: '', group: '', single: '90.99', stock: '2000' }] }),
    '90.99',
  );
  // 全部无库存时仍要给出一个价格，否则前台无法定价
  assert.equal(
    taobaoPrice({ skus: [{ spec: '', group: '', single: '12.5', stock: '0' }] }),
    '12.5',
  );
});

test('价格非法或缺价格时返回 null，由流程报错而不是猜一个值', () => {
  assert.equal(taobaoPrice({ skus: [] }), null);
  assert.equal(taobaoPrice({ skus: [{ spec: '', group: '', single: '', stock: '10' }] }), null);
  assert.equal(taobaoPrice({ skus: [{ spec: '', group: '', single: 'abc', stock: '10' }] }), null);
  // 超过两位小数不符合天猫一口价
  assert.equal(
    taobaoPrice({ skus: [{ spec: '', group: '', single: '9.999', stock: '10' }] }),
    null,
  );
});

test('商品数量按 SKU 库存求和', () => {
  assert.equal(
    taobaoQuantity({
      skus: [
        { spec: '10L', group: '', single: '49.9', stock: '10' },
        { spec: '20L', group: '', single: '59.9', stock: '8' },
      ],
    }),
    18,
  );
  assert.equal(
    taobaoQuantity({ skus: [{ spec: '', group: '', single: '90.99', stock: '2000' }] }),
    2000,
  );
  assert.equal(taobaoQuantity({ skus: [] }), 0);
});

test('类目属性计划只取有值的项，且不重复', () => {
  const plan = taobaoAttributePlan({
    material: '防水布',
    audience: '',
    foldable: '可折叠',
    attributes: [
      { name: '风格', value: '简约', required: false },
      { name: '材质', value: '重复项应被忽略', required: false },
      { name: '空值', value: '  ', required: false },
    ],
  });
  assert.deepEqual(plan, [
    { name: '材质', value: '防水布' },
    { name: '折叠功能', value: '可折叠' },
    { name: '风格', value: '简约' },
  ]);
});

test('类目候选按最后一级匹配，商品资料用 > 而页面用 >>', () => {
  const candidates = [
    '家庭/个人清洁工具>>卫浴/置物用具>>沐浴桶/沐浴盆',
    '家庭/个人清洁工具>>卫浴/置物用具>>足浴盆/足浴桶',
    '个人护理/保健/按摩器材>>家用保健器材>>足浴器',
  ];
  const target = '家庭/个人清洁工具 > 卫浴/置物用具 > 足浴盆/足浴桶';
  assert.equal(matchTaobaoCategoryPath(candidates, target), 1);
  // AI 默认选中的不一定是目标类目，匹配必须只认文本
  assert.equal(
    matchTaobaoCategoryPath(candidates, '家庭/个人清洁工具>>卫浴/置物用具>>沐浴桶/沐浴盆'),
    0,
  );
});

test('类目候选里没有目标时必须返回 -1，让流程停下来人工确认', () => {
  const candidates = ['家庭/个人清洁工具>>卫浴/置物用具>>沐浴桶/沐浴盆'];
  assert.equal(matchTaobaoCategoryPath(candidates, '食品>>零食>>坚果'), -1);
  assert.equal(matchTaobaoCategoryPath(candidates, ''), -1);
  assert.equal(
    matchTaobaoCategoryPath([], '家庭/个人清洁工具 > 卫浴/置物用具 > 足浴盆/足浴桶'),
    -1,
  );
});

test('图片落位只卡我们能控制的两个槽位：主图缺失/超限、详情为空', () => {
  const good = {
    mainImagesGroup: { count: 5 },
    descRepublicOfSell: { count: 24 },
    threeToFourImages: { count: 0 },
    diaopai: { count: 0 },
    yinHeWhiteBgImage: { count: 0 },
    uspImageV3: { count: 0 },
    guideImageGroup: { count: 1, firstSrc: 'https://x/O1CN.png_320x320.webp' },
  };
  assert.deepEqual(taobaoImageProblems(good), []);

  const problems = taobaoImageProblems({
    mainImagesGroup: { count: 6 },
    descRepublicOfSell: { count: 0 },
    yinHeWhiteBgImage: { count: 0 },
    uspImageV3: { count: 0 },
    threeToFourImages: { count: 0 },
    diaopai: { count: 0 },
    guideImageGroup: { count: 1 },
  });
  assert.equal(problems.length, 2);
  assert.match(problems.join('；'), /超过 5 张上限/);
  assert.match(problems.join('；'), /宝贝详情没有图片/);
});

test('平台自动填充占位图片位不再判为串位、不再中断提交', () => {
  // 导购素材会被平台自动生成透明底图（.png），白底图/卖点图也可能被平台或人工补上。
  // 这些都不是「详情图串位」，不能拿来卡提交 —— 之前这里会误判并让整个任务失败。
  const slots = {
    mainImagesGroup: { count: 5 },
    descRepublicOfSell: { count: 12 },
    threeToFourImages: { count: 5 },
    diaopai: { count: 1 },
    yinHeWhiteBgImage: { count: 1 },
    uspImageV3: { count: 1 },
    guideImageGroup: { count: 1, firstSrc: 'https://img/O1CN01.png' },
  };
  assert.deepEqual(taobaoImageProblems(slots), []);
  // 数量仍然要如实汇报给运营看
  const summary = taobaoImageSummary(slots);
  assert.match(summary, /1:1主图 5 张/);
  assert.match(summary, /白底图 1 张/);
  assert.match(summary, /导购素材·透明素材图 1 张/);
});

test('页面脚本都带可见性判定，避免命中未布局的重复控件', () => {
  assert.match(TB_SHOWN, /getBoundingClientRect/);
  assert.match(TB_SHOWN, /visibility/);
});

test('规格计划：单规格商品不需要建规格', () => {
  assert.deepEqual(
    taobaoSkuPlan({ skus: [{ spec: '默认规格', group: '', single: '90.99', stock: '2000' }] }),
    {
      kind: 'single',
    },
  );
  assert.deepEqual(taobaoSkuPlan({ skus: [] }), { kind: 'single' });
});

test('规格计划：单维度多值生成建规格清单与逐行价格', () => {
  const plan = taobaoSkuPlan({
    skus: [
      {
        spec: '容量:10L',
        group: '49.9',
        single: '49.9',
        stock: '10',
        options: [{ name: '容量', value: '10L' }],
      },
      {
        spec: '容量:20L',
        group: '59.9',
        single: '59.9',
        stock: '8',
        options: [{ name: '容量', value: '20L' }],
      },
    ],
  });
  assert.equal(plan.kind, 'dimensions');
  assert.deepEqual(plan.dimensions, [{ name: '容量', values: ['10L', '20L'] }]);
  assert.deepEqual(plan.rows, [
    { values: ['10L'], price: '49.9', quantity: '10' },
    { values: ['20L'], price: '59.9', quantity: '8' },
  ]);
});

test('规格计划：两个维度生成交叉组合，不再压成一条', () => {
  const plan = taobaoSkuPlan({
    skus: [
      {
        spec: '紫/大',
        group: '',
        single: '99',
        stock: '1',
        options: [
          { name: '颜色', value: '紫' },
          { name: '适用体重', value: '大' },
        ],
      },
      {
        spec: '紫/小',
        group: '',
        single: '89',
        stock: '2',
        options: [
          { name: '颜色', value: '紫' },
          { name: '适用体重', value: '小' },
        ],
      },
      {
        spec: '红/大',
        group: '',
        single: '98',
        stock: '3',
        options: [
          { name: '颜色', value: '红' },
          { name: '适用体重', value: '大' },
        ],
      },
      {
        spec: '红/小',
        group: '',
        single: '88',
        stock: '4',
        options: [
          { name: '颜色', value: '红' },
          { name: '适用体重', value: '小' },
        ],
      },
    ],
  });
  assert.equal(plan.kind, 'dimensions');
  assert.deepEqual(plan.dimensions, [
    { name: '颜色', values: ['紫', '红'] },
    { name: '适用体重', values: ['大', '小'] },
  ]);
  assert.equal(plan.rows.length, 4);
  assert.deepEqual(plan.rows[0], { values: ['紫', '大'], price: '99', quantity: '1' });
  assert.deepEqual(plan.rows[3], { values: ['红', '小'], price: '88', quantity: '4' });
});

test('规格计划：交叉组合不齐必须报错，否则后台生成的表与资料对不上', () => {
  const plan = taobaoSkuPlan({
    skus: [
      {
        spec: '紫/大',
        group: '',
        single: '99',
        stock: '1',
        options: [
          { name: '颜色', value: '紫' },
          { name: '适用体重', value: '大' },
        ],
      },
      {
        spec: '红/小',
        group: '',
        single: '88',
        stock: '4',
        options: [
          { name: '颜色', value: '红' },
          { name: '适用体重', value: '小' },
        ],
      },
    ],
  });
  assert.equal(plan.kind, 'unsupported');
  assert.match(plan.reason, /规格组合不完整/);
  assert.match(plan.reason, /共需 4 条，实际 2 条/);
});

test('规格计划：超过两个维度报错（天猫上限）', () => {
  const plan = taobaoSkuPlan({
    skus: [
      {
        spec: 'x',
        group: '',
        single: '9',
        stock: '1',
        options: [
          { name: '颜色', value: '紫' },
          { name: '尺寸', value: '大' },
          { name: '材质', value: '棉' },
        ],
      },
    ],
  });
  assert.equal(plan.kind, 'unsupported');
  assert.match(plan.reason, /最多支持两个销售属性/);
});

test('规格计划：多条 SKU 但没写区分方式，也要报错而不是静默压平', () => {
  const plan = taobaoSkuPlan({
    skus: [
      { spec: 'A', group: '', single: '10', stock: '1' },
      { spec: 'B', group: '', single: '20', stock: '2' },
    ],
  });
  assert.equal(plan.kind, 'unsupported');
  assert.match(plan.reason, /没有填写「区分方式」/);
});

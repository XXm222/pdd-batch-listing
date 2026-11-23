const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RIM_OPTIONS,
  rimDiameter,
  rimDiameterLabel,
  rimDiameterLabelOf,
  rimOptionLabel,
  tireKind,
} = require('../dist-electron/src/pdd-rim.js');
const { newProduct, problems } = require('../dist-electron/src/domain.js');

// 真实数据来自运营给的那张 53 SKU 轮胎表（规格清单 → 具体选项1）
const REAL_SPECS = [
  '205/45R17 88W XL SPORT MAXX LUX SC',
  '215/45R17 91W XL SPORT MAXX LUX SC',
  '215/50R17 95V XL SPORT MAXX LUX SC',
  '215/50R18 92V SPORT MAXX LUX SC',
  '275/40R20 106W SPORT MAXX LUX SC',
];

test('轮辋直径：从真实规格选项里读出英寸数并翻成后台选项', () => {
  const labels = REAL_SPECS.map((spec) => rimDiameterLabel(spec));
  assert.deepEqual(labels, ['17英寸', '17英寸', '17英寸', '18英寸', '20英寸']);
  assert.equal(rimDiameter('275/40R20 106W'), 20);
});

test('轮辋直径：13 及以下与 21 及以上落到两端档位', () => {
  assert.equal(rimDiameterLabel('155/70R13 75T'), '13英寸及以下');
  assert.equal(rimDiameterLabel('175/65R14 82H'), '14英寸');
  assert.equal(rimDiameterLabel('295/30R21 102Y'), '21英寸及以上');
  assert.equal(rimDiameterLabel('315/35R22 111W'), '21英寸及以上');
  assert.equal(rimDiameterLabelOf(12), '13英寸及以下');
  assert.equal(rimDiameterLabelOf(19), '19英寸');
});

test('轮辋直径：ZR 写法与带单位写法都认', () => {
  assert.equal(rimDiameter('225/40ZR18 92Y'), 18);
  assert.equal(rimDiameterLabel('225/40ZR18 92Y'), '18英寸');
  assert.equal(rimDiameter('轮胎 20英寸'), 20);
  assert.equal(rimDiameterLabel('轮胎 20英寸'), '20英寸');
});

test('轮辋直径：防爆胎与雪地胎带前缀，普通胎不带', () => {
  assert.equal(tireKind('245/40R18 97Y 防爆胎'), 'runflat');
  assert.equal(rimDiameterLabel('245/40R18 97Y 防爆胎'), '防爆胎18英寸');
  assert.equal(rimDiameterLabel('225/45R17 RFT'), '防爆胎17英寸');
  assert.equal(rimDiameterLabel('205/55R16 雪地胎'), '雪地胎16英寸');
  assert.equal(rimDiameterLabel('205/55R16 WINTER'), '雪地胎16英寸');
  assert.equal(tireKind('205/55R16 91V'), 'normal');
  assert.equal(rimDiameterLabel('205/55R16 91V'), '16英寸');
});

test('轮辋直径：读不到尺寸时返回 undefined，绝不猜', () => {
  assert.equal(rimDiameter('邓禄普(DUNLOP)汽车轮胎【新品上市】SPORT MAXX LUX'), undefined);
  assert.equal(rimDiameter('215/55 93V'), undefined);
  assert.equal(rimDiameterLabel(undefined, ''), undefined);
  assert.equal(rimDiameterLabel('SPORT MAXX LUX'), undefined);
});

test('轮辋直径：规格选项优先，取不到才退回商品标题', () => {
  const spec = '215/50R18 92V SPORT MAXX LUX SC';
  const title = '邓禄普通用 205/55R16';
  assert.equal(rimDiameterLabel(spec, title), '18英寸');
  assert.equal(rimDiameterLabel(undefined, title), '16英寸');
  assert.equal(rimDiameterLabel('无尺寸选项', title), '16英寸');
});

test('轮辋直径：下拉一共 27 个合法选项，档位与后台一致', () => {
  assert.equal(RIM_OPTIONS.length, 27);
  assert.equal(new Set(RIM_OPTIONS).size, 27);
  for (const label of ['13英寸及以下', '14英寸', '17英寸', '20英寸', '21英寸及以上']) {
    assert.ok(RIM_OPTIONS.includes(label), label);
  }
  for (const label of ['防爆胎17英寸', '雪地胎20英寸', '雪地胎21英寸及以上']) {
    assert.ok(RIM_OPTIONS.includes(label), label);
  }
  assert.ok(!RIM_OPTIONS.includes('12英寸'));
  assert.ok(!RIM_OPTIONS.includes('22英寸'));
});

test('轮辋直径：表格里手填的原文规范成后台选项', () => {
  assert.equal(rimOptionLabel('17'), '17英寸');
  assert.equal(rimOptionLabel(' 17 英寸 '), '17英寸');
  assert.equal(rimOptionLabel('17寸'), '17英寸');
  assert.equal(rimOptionLabel('R18'), '18英寸');
  assert.equal(rimOptionLabel('防爆胎18英寸'), '防爆胎18英寸');
  assert.equal(rimOptionLabel('雪地胎 16 寸'), '雪地胎16英寸');
  // 超出档位的数字落到两端档，和后台下拉一样，不报错
  assert.equal(rimOptionLabel('12英寸'), '13英寸及以下');
  assert.equal(rimOptionLabel('22英寸'), '21英寸及以上');
  // 不是选项就返回 undefined，交给导入器报错，绝不猜
  assert.equal(rimOptionLabel('大号'), undefined);
  assert.equal(rimOptionLabel(''), undefined);
  assert.equal(rimOptionLabel(undefined), undefined);
});

test('到店安装：开了就必须每行都有合法轮辋直径，否则核对报错', () => {
  const build = () => {
    const p = newProduct('3516793', '邓禄普(DUNLOP)汽车轮胎 205/45R17');
    p.category = '汽车/用品/配件/改装 > 汽车零配件 > 乘用车轮胎';
    p.reference = '900';
    p.skus = [
      { spec: '型号:205/45R17', group: '800', single: '810', stock: '5', code: '3633125', rim: '17英寸' },
      { spec: '型号:215/50R18', group: '900', single: '910', stock: '5', code: '3633085', rim: '18英寸' },
    ];
    p.install = { delivery: 'store', template: 'SIST_418714932725772662' };
    return p;
  };
  assert.deepEqual(
    problems(build()).filter((line) => line.includes('轮辋直径') || line.includes('到店安装')),
    [],
  );

  const missing = build();
  missing.skus[1].rim = undefined;
  assert.match(problems(missing).join('\n'), /第2行规格的轮辋直径须从后台下拉选择/);

  const bogus = build();
  bogus.skus[0].rim = '大号17';
  assert.match(problems(bogus).join('\n'), /第1行规格的轮辋直径须从后台下拉选择/);

  const noTemplate = build();
  noTemplate.install = { delivery: 'store', template: ' ' };
  assert.match(problems(noTemplate).join('\n'), /已开启到店安装，请填写到店安装模板/);
});

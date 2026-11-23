const test = require('node:test');
const assert = require('node:assert/strict');
const { pickShop } = require('../dist-electron/electron/shop-pick.js');

const shop = (id, name) => ({
  id,
  name,
  account: '主账号:子账号',
  platform: 'pdd',
  credentialsSaved: true,
  updatedAt: 'now',
});

test('目标店铺支持店铺 ID，名称归一化后比对，同名不猜', () => {
  const a = shop('shop-a', '邓禄普黑豆专卖店');
  const b = shop('shop-b', '另一个店');
  assert.equal(pickShop([a, b], 'shop-a'), a, '填 ID 直接命中');
  assert.equal(pickShop([a, b], '邓禄普黑豆专卖店'), a);
  assert.equal(pickShop([a, b], ' 邓禄普黑豆专卖店 '), a, '前后空格不影响');
  assert.equal(pickShop([a, b], '邓禄普黑豆专卖店\u3000'), a, '全角空格不影响');
  assert.equal(pickShop([a, b], '邓禄普黑豆专卖店'.replace('黑豆', '黑豆')), a);
});

test('同名店铺多于一家时报歧义，不静默挑第一个', () => {
  const first = shop('shop-1', '同名店');
  const second = shop('shop-2', '同名 店');
  assert.throws(() => pickShop([first, second], '同名店'), /2 家店铺都叫/);
  assert.equal(pickShop([first, second], 'shop-2'), second, '填 ID 仍然能明确指定');
});

test('只有一个店铺时留空就直接用它，多店铺留空要报错', () => {
  const only = shop('shop-a', '唯一店');
  assert.equal(pickShop([only], ''), only);
  assert.throws(() => pickShop([only, shop('shop-b', '另一个')], ''), /没写「目标店铺」/);
  assert.throws(() => pickShop([], '任意'), /还没有添加店铺/);
  assert.throws(() => pickShop([shop('shop-a', '甲店')], '乙店'), /找不到店铺「乙店」/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_PLATFORM,
  PLATFORMS,
  PLATFORM_IDS,
  PLATFORM_ORDER,
  isPlatformId,
  normalizePlatform,
  platformMeta,
  requireEnabledPlatform,
} = require('../dist-electron/src/platforms.js');
const { resolveShopName, shopNameFromAccount } = require('../dist-electron/src/domain.js');

test('平台清单固定为拼多多和淘宝，默认平台为拼多多', () => {
  assert.deepEqual([...PLATFORM_IDS], ['pdd', 'taobao']);
  assert.deepEqual([...PLATFORM_ORDER], ['pdd', 'taobao']);
  assert.equal(DEFAULT_PLATFORM, 'pdd');
  assert.deepEqual(Object.keys(PLATFORMS), ['pdd', 'taobao']);
});

test('旧资料缺失或非法平台字段一律按拼多多处理，不做破坏性迁移', () => {
  assert.equal(normalizePlatform(undefined), 'pdd');
  assert.equal(normalizePlatform(null), 'pdd');
  assert.equal(normalizePlatform(''), 'pdd');
  assert.equal(normalizePlatform('jd'), 'pdd');
  assert.equal(normalizePlatform('pdd'), 'pdd');
  assert.equal(normalizePlatform('taobao'), 'taobao');
  assert.equal(isPlatformId('taobao'), true);
  assert.equal(isPlatformId('TAOBAO'), false);
  assert.equal(isPlatformId(undefined), false);
});

test('平台元数据包含界面文案、HTTPS 入口和能力边界', () => {
  for (const id of PLATFORM_IDS) {
    const meta = platformMeta(id);
    assert.equal(meta.id, id);
    assert.ok(meta.label.length > 0, `${id} 需要平台名称`);
    assert.ok(meta.portal.startsWith('https://'), `${id} 的入口必须是 HTTPS`);
    assert.ok(meta.accountExample.length > 0, `${id} 需要账号示例`);
    assert.ok(meta.accountHint.length > 0, `${id} 需要账号格式说明`);
    assert.ok(meta.namePlaceholder.length > 0, `${id} 需要店铺名称提示`);
    assert.ok(meta.loginHint.length > 0, `${id} 需要登录说明`);
    assert.equal(typeof meta.draftPublishing, 'boolean');
    if (!meta.draftPublishing) assert.ok(meta.draftPendingMessage.length > 0);
  }
  assert.equal(platformMeta('pdd').draftPublishing, true);
  assert.equal(platformMeta('pdd').derivesNameFromAccount, true);
  assert.equal(platformMeta('pdd').allowsSubAccount, true);
  // 淘宝草稿流程已适配（见 项目文档/25淘宝发品流程Workflow.md）。
  assert.equal(platformMeta('taobao').draftPublishing, true);
  assert.equal(platformMeta('taobao').derivesNameFromAccount, false);
  assert.equal(platformMeta('taobao').allowsSubAccount, false);
  assert.equal(platformMeta('pdd').enabled, true);
  assert.equal(platformMeta('taobao').enabled, false);
  assert.equal(requireEnabledPlatform(undefined).id, 'pdd');
  assert.throws(() => requireEnabledPlatform('taobao'), /淘宝暂未开放/);
});

test('拼多多沿用「店铺名:子账号」推导，淘宝必须手填店铺名称', () => {
  assert.equal(shopNameFromAccount(' 日用生活馆:运营账号 '), '日用生活馆');
  assert.equal(resolveShopName('', '日用生活馆:运营账号', true, 'pdd'), '日用生活馆');
  assert.throws(() => resolveShopName('手填名称', 'demo_operator', true, 'pdd'), /店铺名:子账号/);

  assert.equal(resolveShopName('  Mandla旗舰店  ', '会员名', true, 'taobao'), 'Mandla旗舰店');
  assert.equal(resolveShopName('Mandla旗舰店', '会员名', false, 'taobao'), 'Mandla旗舰店');
  // 淘宝账号不是「店铺名:子账号」，缺名称时不能凭账号推导。
  assert.throws(
    () => resolveShopName('', '日用生活馆:运营账号', true, 'taobao'),
    /请填写淘宝店铺名称/,
  );
  assert.throws(() => resolveShopName('', '会员名', true, 'taobao'), /请填写淘宝店铺名称/);
  // 未传平台时保持旧行为，避免影响既有调用方。
  assert.equal(resolveShopName('', '日用生活馆:运营账号', true), '日用生活馆');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  templateShopProblem,
} = require('../dist-electron/electron/platforms/pdd-template-guard.js');

const shop = (extra = {}) => ({
  id: 'shop-a',
  name: '某轮胎专卖店',
  account: '主账号:子账号',
  platform: 'pdd',
  credentialsSaved: true,
  updatedAt: 'now',
  ...extra,
});

test('绑定过编号的店铺：编号缺一个或对不上都停下，一致才放行', () => {
  const bound = shop({ mallId: 549046886, userId: 190551753 });
  assert.equal(templateShopProblem(bound, { mallId: 549046886, userId: 190551753 }), null);
  assert.match(
    String(templateShopProblem(bound, {})),
    /读不到当前页面的后台店铺 ID/,
    '完全没身份字段要停',
  );
  assert.match(
    String(templateShopProblem(bound, { mallId: 549046886 })),
    /读不到当前页面的后台店铺 ID/,
    '只有店铺 ID、没有账号 ID 也要停',
  );
  assert.match(String(templateShopProblem(bound, { mallId: 111111, userId: 222222 })), /另一家店/);
});

test('没绑定编号的店铺：必须有当前页店名，缺店名不放行', () => {
  const loose = shop();
  // 复核提的就是这条：有当前账号 ID 但没有店名时，旧代码直接放行读到了别家模板。
  assert.match(
    String(templateShopProblem(loose, { mallId: 549046886, userId: 190551753 })),
    /读不到当前页面的店铺名/,
  );
  assert.match(String(templateShopProblem(loose, {})), /读不到当前页面的店铺名/);
  assert.equal(templateShopProblem(loose, { mallId: 549046886, mallName: '某轮胎专卖店' }), null);
  assert.match(
    String(templateShopProblem(loose, { mallName: '别家店' })),
    /浏览器里打开的店铺是「别家店」/,
  );
});

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const init = require('sql.js');
(async () => {
  const directory = process.argv[2];
  assert.ok(directory, '需要提供测试资料目录');
  const SQL = await init({
    wasmBinary: Uint8Array.from(fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')))
      .buffer,
  });
  const bytes = fs.readFileSync(path.join(directory, 'workspace.sqlite'));
  const db = new SQL.Database(bytes);
  const read = (table) =>
    db.exec(`SELECT json FROM ${table}`)[0]?.values.map((row) => JSON.parse(row[0])) || [];
  const products = read('products'),
    shops = read('shops'),
    tasks = read('tasks'),
    assets = read('assets');
  assert.equal(products.length, 2);
  assert.equal(shops.length, 1);
  assert.equal(tasks.length, 1);
  assert.equal(shops[0].name, '测试店铺 · 本机验证');
  assert.equal(shops[0].account, 'demo_operator_local');
  assert.ok(shops[0].credentialsSaved);
  assert.equal(shops[0].password, undefined);
  assert.equal(shops[0].secret, undefined);
  const secrets = db.exec('SELECT secret FROM shops')[0].values;
  assert.ok(secrets.every((row) => row[0].length > 40 && row[0] !== 'DemoOnly-Local-0930'));
  assert.ok(!bytes.includes(Buffer.from('DemoOnly-Local-0930')));
  assert.equal(tasks[0].status, 'prepared');
  assert.equal(tasks[0].productSnapshot.code, 'DEMO-FB-FORM-001');
  assert.ok(assets.every((a) => fs.existsSync(path.join(directory, 'assets', a.id))));
  db.close();
  console.log(
    JSON.stringify(
      {
        products: products.length,
        shops: shops.length,
        tasks: tasks.length,
        assets: assets.length,
        credentialsEncrypted: true,
        plaintextAbsent: true,
        taskSnapshot: true,
      },
      null,
      2,
    ),
  );
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

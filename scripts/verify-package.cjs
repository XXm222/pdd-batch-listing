const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const { createRequire } = require('node:module');
const builderRequire = createRequire(require.resolve('electron-builder'));
const asar = createRequire(builderRequire.resolve('app-builder-lib'))('@electron/asar');
const bundle =
  process.argv[2] ||
  path.join(
    require('../package.json').build.directories.output,
    'mac-arm64/商品运营台.app/Contents/Resources',
  );
const archive = path.join(bundle, 'app.asar');
const files = [];
function walk(directory) {
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    fs.statSync(file).isDirectory() ? walk(file) : files.push(file);
  }
}
walk('dist');
walk('dist-electron');
walk('resources');
files.push('LICENSE', 'NOTICE');
for (const file of files)
  assert.ok(
    asar.extractFile(archive, file.replaceAll(path.sep, '/')).equals(fs.readFileSync(file)),
    file,
  );
const built = JSON.parse(asar.extractFile(archive, 'package.json').toString());
const source = JSON.parse(fs.readFileSync('package.json', 'utf8'));
for (const key of [
  'name',
  'productName',
  'version',
  'main',
  'dependencies',
  'packageManager',
  'license',
])
  assert.deepEqual(built[key], source[key]);
assert.ok(
  fs
    .readFileSync('运营资料/商品资料模板.xlsx')
    .equals(fs.readFileSync('resources/templates/商品资料模板.xlsx')),
);
assert.ok(
  fs
    .readFileSync('运营资料/商品资料示例.xlsx')
    .equals(fs.readFileSync('resources/templates/商品资料示例.xlsx')),
);
assert.ok(
  fs.existsSync(path.join(bundle, 'app.asar.unpacked/node_modules/sql.js/dist/sql-wasm.wasm')),
);
assert.ok(
  fs.existsSync(path.join(bundle, 'app.asar.unpacked/dist-electron/electron/import-worker.js')),
);
const result = {
  version: source.version,
  filesChecked: files.length,
  sourceMatches: true,
  templateMatches: true,
  wasmPresent: true,
  workerPresent: true,
  asarSHA256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
};
fs.mkdirSync(`verification/${source.version}`, { recursive: true });
fs.writeFileSync(
  `verification/${source.version}/构建一致性.json`,
  JSON.stringify(result, null, 2) + '\n',
);
console.log(JSON.stringify(result, null, 2));

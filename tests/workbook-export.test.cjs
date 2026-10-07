const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');
const { parseWorkbook } = require('../dist-electron/electron/importer');
const { exportProductWorkbook } = require('../dist-electron/electron/workbook-export');
test('operator export keeps identifiers, zero stock, image bytes/order and supports template reimport', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goods-export-'));
  try {
    for (const kind of ['商品资料', '淘宝商品资料']) {
      const [p] = await parseWorkbook(path.resolve(`resources/templates/${kind}示例.xlsx`), dir);
      p.code = '0000123';
      p.title = '=SUM(A1:A2) & <商品>';
      p.skus[0].stock = '0';
      p.skus[0].code = '0000456';
      if (p.skus.length > 1) p.skus[1].code = '0000457';
      const file = path.join(dir, `${kind}.xlsx`),
        bytes = await exportProductWorkbook(
          p,
          path.resolve(`resources/templates/${kind}模板.xlsx`),
          dir,
        );
      await fs.writeFile(file, bytes);
      const [back] = await parseWorkbook(file, dir);
      assert.equal(back.code, p.code);
      assert.equal(back.title, p.title);
      assert.equal(back.skus[0].stock, '0');
      assert.deepEqual(
        back.skus.map((s) => [s.options, s.group, s.single, s.stock]),
        p.skus.map((s) => [s.options, s.group, s.single, s.stock]),
      );
      if (kind === '商品资料') assert.equal(back.skus[0].code, '0000456');
      else assert.deepEqual(back.taobao, p.taobao);
      for (const key of ['main', 'detail', 'threeToFour', 'whiteBg', 'usp'])
        assert.deepEqual(
          (back[key] || []).map((n) => back.images[n].id),
          (p[key] || []).map((n) => p.images[n].id),
        );
      assert.deepEqual(
        back.skus.map((s) => (s.image ? back.images[s.image].id : null)),
        p.skus.map((s) => (s.image ? p.images[s.image].id : null)),
      );
      const zip = await JSZip.loadAsync(bytes),
        parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });
      const s = parser.parse(await zip.file('xl/worksheets/sheet2.xml').async('string'));
      const row = s.worksheet.sheetData.row.find((r) => Number(r['@r']) === 5),
        price = row.c.find((c) => c['@r'] === (kind === '商品资料' ? 'F5' : 'E5'));
      assert.equal(price['@t'], 'n');
      assert.equal(
        (await zip.file('xl/worksheets/sheet1.xml').async('string')).includes('<f>'),
        false,
      );
      const main = p.main[0],
        id = p.images[main].id;
      await fs.writeFile(path.join(dir, id), Buffer.from('corrupt image'));
      await assert.rejects(
        exportProductWorkbook(p, path.resolve(`resources/templates/${kind}模板.xlsx`), dir),
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

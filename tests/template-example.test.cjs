const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {importFiles,parseWorkbook}=require('../dist-electron/electron/importer');
const {problems}=require('../dist-electron/src/domain');
test('blank download stays empty and separate example includes two complete SKUs and embedded images',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'goods-template-example-'));
  try{
    const [blank]=await parseWorkbook(path.resolve('resources/templates/商品资料模板.xlsx'));
    assert.equal(blank.code,'');assert.equal(blank.title,'');assert.equal(blank.skus.length,0);assert.equal(blank.main.length,0);assert.equal(blank.detail.length,0);
    const {products,assets}=await importFiles([path.resolve('resources/templates/商品资料示例.xlsx')],directory,false);
    assert.equal(products.length,1);const p=products[0];
    assert.equal(p.code,'EXAMPLE-FB001');assert.equal(p.templateFormat,'运营模板 v3');
    assert.deepEqual(p.skus.map(s=>[s.options[0].value,s.group,s.single,s.stock]),[['10L','39.9','49.9','10'],['20L','49.9','59.9','8']]);
    assert.equal(p.main.length,1);assert.equal(p.detail.length,1);assert.ok(p.skus.every(s=>s.image&&p.images[s.image]));
    assert.equal(assets.length,4);assert.deepEqual(problems(p),[]);
    for(const a of assets)assert.ok((await fs.stat(path.join(directory,a.id))).size>0);
    assert.ok((await fs.readFile('resources/templates/商品资料模板.xlsx')).equals(await fs.readFile('运营资料/商品资料模板.xlsx')));
    assert.ok((await fs.readFile('resources/templates/商品资料示例.xlsx')).equals(await fs.readFile('运营资料/商品资料示例.xlsx')));
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

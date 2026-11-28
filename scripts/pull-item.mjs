/**
 * 回扒本店商品资料 → JSON + 原图。
 *
 * 用法：把 ITEM_ID 改成目标商品，然后
 *   ego-browser nodejs < scripts/pull-item.mjs
 *
 * 输出：
 *   /tmp/tb-pull-<id>/item.json        商品字段（标题/货号/类目/品牌/SKU/图片URL…）
 *   /tmp/tb-pull-<id>/img/*.jpg        下载的原图（alicdn 实际返回 webp，已转成真 JPEG）
 *   /tmp/tb-pull-<id>/manifest.json    图片清单（kind/order/file/w/h/bytes）
 *
 * 下一步用 scripts/build-excel-from-item.py 把 JSON + 图片组装成淘宝模板 Excel。
 */
const ITEM_ID = '1083107251544';

const fs = await import('node:fs/promises');
const path = await import('node:path');

const WORK = `/tmp/tb-pull-${ITEM_ID}`; // 与 build-excel-from-item.py 保持一致
const IMG_DIR = path.join(WORK, 'img');
await fs.mkdir(IMG_DIR, { recursive: true });

const task = await taskSpace(`淘宝商品资料回扒 ${ITEM_ID}`);
const page = task.page('p1');
await page.goto(`https://sell.publish.tmall.com/tmall/itemEdit.htm?itemId=${ITEM_ID}`, {
  timeout: 90000,
});
await page.waitForSelector('#sell-field-title', { state: 'visible', timeout: 60000 });
await page.waitForTimeout(7000);

const raw = await page.evaluate(`(() => {
  const shown=(e)=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0;};
  const read=(id)=>{const r=document.getElementById('sell-field-'+id);if(!r)return null;
    const i=[...r.querySelectorAll('input,textarea')].find(x=>shown(x)&&!['checkbox','radio','file','hidden'].includes(x.type));
    return i?i.value:null;};
  const imgs=(id)=>{const r=document.getElementById('sell-field-'+id);if(!r)return [];
    return [...r.querySelectorAll('img')].map(i=>i.src).filter(s=>s&&!s.endsWith('.svg'));};
  const trs=[...document.querySelectorAll('#sell-field-sku table tbody tr')];
  return JSON.stringify({
    title: read('title'), code: read('p-13021751'), outerId: read('outerId'),
    price: read('price'), quantity: read('quantity'),
    category: (()=>{const r=document.getElementById('sell-field-category');return r?(r.innerText||'').replace(/\\s+/g,' ').trim():null;})(),
    brand: (()=>{const t=[...document.querySelectorAll('#struct-p-20000 .next-select-trigger')].filter(shown)[0];return t?(t.innerText||'').trim():null;})(),
    main: imgs('mainImagesGroup'), threeToFour: imgs('threeToFourImages'),
    detail: imgs('descRepublicOfSell'), whiteBg: imgs('yinHeWhiteBgImage'),
    sku: trs.map(tr=>({
      props: [...tr.querySelectorAll('td.is-sale-prop')].map(td=>(td.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean),
      price: tr.querySelector('td.sell-sku-cell-money input')?.value ?? null,
      qty: tr.querySelector('td.sell-sku-cell-number input')?.value ?? null,
      code: tr.querySelector('td.sell-sku-cell-input input')?.value ?? null,
    })),
  });
})()`);
const data = JSON.parse(raw);

// 去缩略后缀取原图
const orig = (u) => u.replace(/_\d+x\d+q\d+_\.webp$/, '');
const manifest = [];
let seq = 0;
for (const [kind, urls, limit] of [
  ['main', data.main, 5],
  ['detail', data.detail, 20],
]) {
  for (const [i, url] of urls.slice(0, limit).entries()) {
    const file = `${kind}-${String(i + 1).padStart(2, '0')}.jpg`;
    const res = await fetch(orig(url));
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2000) continue; // 跳过占位/空图
    await fs.writeFile(path.join(IMG_DIR, file), buf);
    manifest.push({ kind, order: i + 1, file, url: orig(url), bytes: buf.length });
    seq += 1;
  }
}

await fs.writeFile(path.join(WORK, 'item.json'), JSON.stringify(data, null, 1));
await fs.writeFile(path.join(WORK, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log({
  work: WORK,
  title: data.title,
  code: data.code,
  skus: data.sku.length,
  main: data.main.length,
  detail: data.detail.length,
  downloaded: seq,
});

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { imageSize } from 'image-size';
import { isTaobaoProduct } from '../src/domain';
import type { Asset, Product } from '../src/types';

const array = (value: any): any[] =>
  value == null || value === '' ? [] : Array.isArray(value) ? value : [value];
const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false,
  trimValues: false,
  htmlEntities: true,
});
const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  suppressEmptyNode: true,
});
const text = (cell: any) => String(cell?.is?.t?.['#text'] ?? cell?.is?.t ?? cell?.v ?? '');
const column = (index: number) => String.fromCharCode(65 + index);

/** Export the shipped operator template; image previews retain the original file bytes. */
export async function exportProductWorkbook(p: Product, template: string, assetsDirectory: string) {
  const taobao = isTaobaoProduct(p);
  const zip = await JSZip.loadAsync(await fs.readFile(template));
  const shared = zip.file('xl/sharedStrings.xml')
    ? array(
        new XMLParser({ removeNSPrefix: true, parseTagValue: false }).parse(
          await zip.file('xl/sharedStrings.xml')!.async('string'),
        ).sst?.si,
      ).map((c) => String(c.t ?? ''))
    : [];
  const sheets = await Promise.all(
    [1, 2, 3].map(async (i) => {
      let raw = await zip.file(`xl/worksheets/sheet${i}.xml`)!.async('string');
      const prefix = raw.match(/<([\w-]+):worksheet[ >]/)?.[1];
      if (prefix)
        raw = raw
          .replace(new RegExp(`(<\\/?)${prefix}:`, 'g'), '$1')
          .replace(`xmlns:${prefix}=`, `xmlns=`);
      return parser.parse(raw);
    }),
  );
  const rows = sheets.map((s) => array(s.worksheet.sheetData.row));
  const content = (cell: any) => (cell?.['@t'] === 's' ? shared[Number(cell.v)] : text(cell));
  const set = (sheet: number, rowNumber: number, col: number, value: string, numeric = false) => {
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value))
      throw Error('商品字段包含无法写入 Excel 的控制字符，请修正');
    let row = rows[sheet].find((r) => Number(r['@r']) === rowNumber);
    if (!row) {
      const sample = rows[sheet].find(
        (r) => Number(r['@r']) === (sheet === 0 ? (taobao ? 26 : 24) : 5),
      );
      row = sample ? structuredClone(sample) : { '@r': rowNumber, c: [] };
      row['@r'] = rowNumber;
      for (const c of array(row.c)) {
        c['@r'] = c['@r'].replace(/\d+$/, String(rowNumber));
        delete c.v;
        delete c.is;
        delete c.f;
      }
      rows[sheet].push(row);
    }
    row.c = array(row.c);
    const address = `${column(col)}${rowNumber}`;
    let cell = row.c.find((c: any) => c['@r'] === address);
    if (!cell) {
      const sample = rows[sheet].find(
        (r) => Number(r['@r']) === (sheet === 0 ? (taobao ? 26 : 24) : 5),
      );
      const style = array(sample?.c).find((c) => c['@r'].replace(/\d/g, '') === column(col))?.[
        '@s'
      ];
      cell = { '@r': address, ...(style !== undefined ? { '@s': style } : {}) };
      row.c.push(cell);
    }
    delete cell.v;
    delete cell.is;
    delete cell.f;
    if (numeric && value !== '') {
      if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)))
        throw Error('价格或库存不是有效数值，请在资料中修正后导出');
      cell['@t'] = 'n';
      cell.v = value;
    } else {
      cell['@t'] = 'inlineStr';
      cell.is = { t: { '@xml:space': 'preserve', '#text': value } };
    }
    row.c.sort((a: any, b: any) =>
      a['@r'].replace(/\d/g, '').localeCompare(b['@r'].replace(/\d/g, '')),
    );
  };
  const info: Record<string, string> = {
    商品编码: p.code,
    商家编码: p.outerId || '',
    商品标题: p.title,
    目标类目: p.category,
    商品品牌: p.brand,
    材质: p.material,
    适用人群: p.audience,
    是否可折叠: p.foldable,
    '参考价（元）': p.reference,
    '满2件折扣（折）': p.discount,
    发货承诺: p.shipping,
    运费模板: p.freight,
    '7天无理由退货': p.source.startsWith('拼多多采集：')
      ? (p.services?.sevenDay ?? '')
      : p.services?.sevenDay || '按平台规则',
    正品发票: p.source.startsWith('拼多多采集：')
      ? (p.services?.invoice ?? '')
      : p.services?.invoice || '否',
    假一赔十: p.source.startsWith('拼多多采集：')
      ? (p.services?.authenticity ?? '')
      : p.services?.authenticity || '否',
    发货地省份: p.taobao?.originProvince || '',
    发货地城市: p.taobao?.originCity || '',
    提取方式: p.taobao?.extractWay || '',
    运费承担: p.taobao?.freightBearer || '',
    发货时间: p.taobao?.deliveryTime || '',
    上架时间: p.taobao?.shelfTime || '',
    '返点比例（%）': p.taobao?.auctionPoint || '',
    是否测试素材: p.demo ? '是' : '否',
  };
  for (const row of rows[0]) {
    const label = content(array(row.c).find((c) => c['@r'] === `A${row['@r']}`));
    if (Object.hasOwn(info, label))
      set(
        0,
        Number(row['@r']),
        1,
        info[label],
        ['参考价（元）', '满2件折扣（折）', '返点比例（%）'].includes(label),
      );
  }
  const attributeStart = taobao ? 26 : 24;
  if (!taobao && p.source.startsWith('拼多多采集：')) {
    set(0, 21, 0, '采集来源');
    set(0, 21, 1, p.source);
    set(0, 21, 2, '自动记录');
    set(0, 21, 3, '库存为采集时数据。未读取字段留空，重新导入后须补充。');
    rows[0].find((r) => Number(r['@r']) === 21)['@ht'] = 76;
  }
  for (const [i, a] of (p.attributes || []).entries()) {
    set(0, attributeStart + i, 0, a.name);
    set(0, attributeStart + i, 1, a.value);
    set(0, attributeStart + i, 2, a.required ? '是' : '否');
  }
  const media = new Map<string, { target: string; asset: Asset }>();
  const pictures: { row: number; col: number; asset: Asset; target: string }[][] = [[], [], []];
  let total = 0;
  const picture = async (sheet: number, row: number, col: number, name: string) => {
    const asset = p.images[name];
    if (!asset || !/^[a-f0-9]{64}$/.test(asset.id))
      throw Error(`图片尚未添加，无法生成完整 Excel：${name}`);
    let saved = media.get(asset.id);
    if (!saved) {
      const file = path.join(assetsDirectory, asset.id),
        stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024)
        throw Error(`图片文件无效：${name}`);
      const raw = await fs.readFile(file),
        size = imageSize(raw);
      if (
        createHash('sha256').update(raw).digest('hex') !== asset.id ||
        !['png', 'jpg'].includes(size.type || '')
      )
        throw Error(`图片文件已变化：${name}`);
      total += raw.length;
      if (total > 75 * 1024 * 1024) throw Error('图片总大小超过 75MB，请减少图片后导出');
      const target = `xl/media/export-${media.size + 1}.${size.type === 'png' ? 'png' : 'jpg'}`;
      zip.file(target, raw);
      saved = { target, asset: { ...asset, width: size.width!, height: size.height! } };
      media.set(asset.id, saved);
    }
    set(sheet, row, col, '');
    const r = rows[sheet].find((r) => Number(r['@r']) === row);
    r['@ht'] = sheet === 1 ? 86 : 108;
    r['@customHeight'] = '1';
    pictures[sheet].push({ row, col, ...saved });
  };
  if (p.skus.length > 100) throw Error('每件商品最多导出 100 个规格');
  for (const [i, s] of p.skus.entries()) {
    const values = [
      s.options?.[0]?.name || '',
      s.options?.[0]?.value || '',
      s.options?.[1]?.name || '',
      s.options?.[1]?.value || '',
    ];
    const cells = taobao
      ? [...values, s.group, s.stock, '']
      : [
          s.code || (p.skus.length === 1 ? p.skuCode : ''),
          ...values,
          s.group,
          s.single,
          s.stock,
          '',
        ];
    cells.forEach((v, c) =>
      set(1, i + 5, c, v || '', taobao ? [4, 5].includes(c) : [5, 6, 7].includes(c)),
    );
    if (s.image) await picture(1, i + 5, taobao ? 6 : 8, s.image);
  }
  const groups = taobao
    ? ([
        ['1:1主图', p.main, 5],
        ['3:4主图', p.threeToFour || [], 5],
        ['详情图', p.detail, 20],
        ['白底图', p.whiteBg || [], 1],
        ['卖点图', p.usp || [], 1],
      ] as const)
    : ([
        ['轮播图', p.main, 10],
        ['详情图', p.detail, 50],
      ] as const);
  for (const [label, names, max] of groups) {
    if (names.length > max) throw Error(`${label}最多 ${max} 张`);
    const slots = rows[2].filter(
      (r) => content(array(r.c).find((c) => c['@r'] === `A${r['@r']}`)) === label,
    );
    if (slots.length < names.length) throw Error('模板图片格不足，请更新模板');
    for (const [i, name] of names.entries()) await picture(2, Number(slots[i]['@r']), 2, name);
  }
  const types = await zip.file('[Content_Types].xml')!.async('string');
  let additions = '';
  for (const ext of ['png', 'jpg'])
    if (!types.includes(`Extension="${ext}"`))
      additions += `<Default Extension="${ext}" ContentType="image/${ext === 'jpg' ? 'jpeg' : 'png'}"/>`;
  for (let i = 0; i < 3; i++) {
    rows[i].sort((a, b) => Number(a['@r']) - Number(b['@r']));
    sheets[i].worksheet.sheetData.row = rows[i];
    const worksheet = sheets[i].worksheet;
    const { dimension: _oldDimension, sheetPr, ...remaining } = worksheet;
    // OOXML places dimension before views/columns/data, including templates without it.
    sheets[i].worksheet = {
      ...(sheetPr ? { sheetPr } : {}),
      dimension: { '@ref': `A1:${i === 1 ? (taobao ? 'G' : 'I') : 'D'}${rows[i].at(-1)['@r']}` },
      ...remaining,
    };
    if (pictures[i].length) {
      const owner = `export${i + 1}`,
        relationships = pictures[i]
          .map(
            (p, k) =>
              `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${path.posix.basename(p.target)}"/>`,
          )
          .join('');
      const anchors = pictures[i]
        .map((p, k) => {
          const maxWidth = i === 1 ? 150 : 280,
            maxHeight = i === 1 ? 96 : 128;
          const scale = Math.min(maxWidth / p.asset.width, maxHeight / p.asset.height, 1),
            w = Math.round(p.asset.width * scale) * 9525,
            h = Math.round(p.asset.height * scale) * 9525;
          return `<xdr:oneCellAnchor><xdr:from><xdr:col>${p.col}</xdr:col><xdr:colOff>76200</xdr:colOff><xdr:row>${p.row - 1}</xdr:row><xdr:rowOff>76200</xdr:rowOff></xdr:from><xdr:ext cx="${w}" cy="${h}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${k + 1}" name="图片${k + 1}" descr="${xml(p.asset.name)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId${k + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
        })
        .join('');
      zip.file(
        `xl/drawings/${owner}.xml`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`,
      );
      zip.file(
        `xl/drawings/_rels/${owner}.xml.rels`,
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`,
      );
      zip.file(
        `xl/worksheets/_rels/sheet${i + 1}.xml.rels`,
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdExport" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/${owner}.xml"/></Relationships>`,
      );
      sheets[i].worksheet['@xmlns:r'] =
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
      sheets[i].worksheet.drawing = { '@r:id': 'rIdExport' };
      additions += `<Override PartName="/xl/drawings/${owner}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`;
    }
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, builder.build(sheets[i]));
  }
  zip.file('[Content_Types].xml', types.replace('</Types>', additions + '</Types>'));
  const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  if (output.length > 80 * 1024 * 1024) throw Error('导出的 Excel 超过 80MB，请减少图片');
  return output;
}

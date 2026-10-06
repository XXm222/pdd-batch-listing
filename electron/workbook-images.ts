import path from 'node:path';
import type JSZip from 'jszip';

export type WorkbookPicture = { raw: Buffer; media: string };
export type WorkbookPictures = { drawings: Map<string, Map<string, WorkbookPicture>>; cells: Map<string, WorkbookPicture> };
const list = (v: any): any[] => v == null || v === '' ? [] : Array.isArray(v) ? v : [v];

// Resolve only package-local relationships. An Excel import never downloads linked images.
export async function readWorkbookPictures(zip: JSZip, readXml: (name: string) => Promise<any>, sheets: string[]): Promise<WorkbookPictures> {
  const drawings = new Map<string, Map<string, WorkbookPicture>>();
  const cells = new Map<string, WorkbookPicture>();
  const cache = new Map<string, WorkbookPicture>();
  async function relationships(owner: string) {
    const rel = path.posix.join(path.posix.dirname(owner), '_rels', `${path.posix.basename(owner)}.rels`);
    const map = new Map<string, any>();
    if (zip.file(rel)) for (const item of list((await readXml(rel)).Relationships?.Relationship)) {
      if (map.has(item['@Id'])) throw new Error('Excel 图片关系重复，请重新保存');
      map.set(item['@Id'], item);
    }
    return map;
  }
  function target(owner: string, rel: any): string {
    if (!rel || rel['@TargetMode'] === 'External' || typeof rel['@Target'] !== 'string' || /[\\\u0000]|^[a-z]+:/i.test(rel['@Target']))
      throw new Error('图片必须插入并保存在 Excel 内，不能只提供外部图片链接');
    const name = rel['@Target'].startsWith('/') ? rel['@Target'].slice(1) : path.posix.join(path.posix.dirname(owner), rel['@Target']);
    const normalized = path.posix.normalize(name);
    if (!normalized.startsWith('xl/') || !zip.file(normalized)) throw new Error('Excel 图片资源缺失，请重新插入图片并保存');
    return normalized;
  }
  async function picture(owner: string, pic: any, rels: Map<string, any>) {
    const blip = pic?.blipFill?.blip;
    if (blip?.['@link']) throw new Error('图片必须保存在 Excel 内，不能使用链接图片');
    const media = target(owner, rels.get(blip?.['@embed']));
    let found = cache.get(media);
    if (!found) { found = { raw: await zip.file(media)!.async('nodebuffer'), media }; cache.set(media, found); }
    return found;
  }
  for (const sheet of sheets) {
    const doc = (await readXml(sheet)).worksheet;
    const rels = await relationships(sheet);
    const positions = new Map<string, WorkbookPicture>();
    for (const drawing of list(doc?.drawing)) {
      const file = target(sheet, rels.get(drawing['@id']));
      const dr = (await readXml(file)).wsDr;
      const drRels = await relationships(file);
      if (list(dr?.absoluteAnchor).some(a => a.pic)) throw new Error('请将图片放在图片列的对应行内，再保存 Excel');
      for (const anchor of [...list(dr?.oneCellAnchor), ...list(dr?.twoCellAnchor)]) {
        if (!anchor.pic) continue;
        const row = Number(anchor.from?.row), col = Number(anchor.from?.col);
        if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > 999 || col < 0 || col > 99)
          throw new Error('Excel 图片位置无效，请放入模板图片列');
        const key = `${row}:${col}`;
        if (positions.has(key)) throw new Error(`第 ${row + 1} 行同一图片格有多张图片，请每格只放一张`);
        positions.set(key, { ...await picture(file, anchor.pic, drRels) });
      }
    }
    drawings.set(sheet, positions);
  }
  // WPS "嵌入单元格" uses DISPIMG IDs and a separate image relationship part.
  if (zip.file('xl/cellimages.xml')) {
    const owner = 'xl/cellimages.xml', rels = await relationships(owner);
    const doc = await readXml(owner);
    for (const image of list((doc.cellImages || doc.cellimages)?.cellImage)) {
      const id = image.pic?.nvPicPr?.cNvPr?.['@name'];
      if (!id || cells.has(id)) throw new Error('Excel 单元格图片标识缺失或重复，请重新保存');
      cells.set(id, await picture(owner, image.pic, rels));
    }
  }
  return { drawings, cells };
}

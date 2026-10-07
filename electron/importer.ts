import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { imageSize } from 'image-size';
import {
  newProduct,
  safeImageName,
  TAOBAO_TEMPLATE_FORMAT,
  LOCAL_IMAGE_MAX_BYTES,
  imageProblems,
  isTaobaoProduct,
} from '../src/domain';
import type { Asset, Product } from '../src/types';
import { readWorkbookPictures, type WorkbookPicture } from './workbook-images';

const mapping: Record<string, keyof Product> = {
  商品编码: 'code',
  商家编码: 'outerId',
  商品标题: 'title',
  目标类目: 'category',
  商品品牌: 'brand',
  授权品牌: 'brand',
  材质: 'material',
  适用人群: 'audience',
  是否可折叠: 'foldable',
  '参考价（元）': 'reference',
  规格编码: 'skuCode',
  '满2件折扣（折）': 'discount',
  '满 2 件折扣': 'discount',
  发货承诺: 'shipping',
  运费模板: 'freight',
  目标店铺: 'expectedShop',
};
function text(value: any): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.map(text).join('');
  if (Object.hasOwn(value, '#text')) return text(value['#text']);
  if (Object.hasOwn(value, 't')) return text(value.t);
  if (Object.hasOwn(value, 'r')) return text(value.r);
  return '';
}
const list = (value: any): any[] =>
  value === undefined || value === null || value === ''
    ? []
    : Array.isArray(value)
      ? value
      : [value];
// Keep existing operator workbooks valid when the visible column wording changes.
function skuHeader(label: string): string {
  const compact = label.replace(/\s+/g, '');
  const aliases: Record<string, string> = {
    '区分方式1（如颜色）': '规格一名称',
    '具体选项1（如紫色）': '规格一值',
    '区分方式2（如尺寸）': '规格二名称',
    '具体选项2（如大号）': '规格二值',
    区分方式1: '规格一名称',
    具体选项1: '规格一值',
    区分方式2: '规格二名称',
    具体选项2: '规格二值',
    '规格编码（选填）': '规格编码',
  };
  return aliases[compact] || label;
}
export async function parseWorkbook(file: string, assetsDir?: string): Promise<Product[]> {
  const raw = await fs.readFile(file);
  if (raw.length > 80 * 1024 * 1024) throw new Error('含图片的单个 Excel 不能超过 80MB');
  const zip = await JSZip.loadAsync(raw);
  const entries = Object.values(zip.files);
  const inflated = entries.reduce(
    (n, entry) =>
      n +
      ((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ||
        0),
    0,
  );
  if (entries.length > 2000 || inflated > 120 * 1024 * 1024)
    throw new Error('Excel 展开内容过大，请精简表格或图片');
  for (const e of entries.filter((e) => /\.(xml|rels)$/.test(e.name))) {
    const content = await e.async('string');
    if (/<!DOCTYPE|<!ENTITY/i.test(content)) throw new Error('Excel 包含不支持的 XML 内容');
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: false,
    // Excel/WPS 把中文写成字面 UTF-8，openpyxl 等工具写成 &#NNNN; 数字实体。
    // 不解码会让「项目」「填写值」这类表头全部读成实体串，整份表格都认不出来。
    htmlEntities: true,
  });
  const readXml = async (name: string) => {
    const entry = zip.file(name);
    if (!entry) throw new Error('Excel 内部资料缺失，请重新保存表格');
    const xml = await entry.async('string');
    if (XMLValidator.validate(xml) !== true) throw new Error('Excel 内部数据损坏，请重新保存表格');
    return parser.parse(xml);
  };
  const shared = zip.file('xl/sharedStrings.xml')
    ? list((await readXml('xl/sharedStrings.xml')).sst?.si).map(text)
    : [];
  const sheetNames = entries
    .map((e) => e.name)
    .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name));
  if (!sheetNames.length || sheetNames.length > 20) throw new Error('Excel 工作表数量不正确');
  const pictures = await readWorkbookPictures(zip, readXml, sheetNames);
  const rowNumbers = new Map<string[], number>();
  const cellPictures = new Map<string[], Map<number, WorkbookPicture>>();
  const usedPictures = new Set<WorkbookPicture>();
  const rows: string[][][] = [];
  for (const name of sheetNames) {
    const sheet = list((await readXml(name)).worksheet?.sheetData?.row);
    if (sheet.length > 1000) throw new Error('表格行数过多，请使用商品资料模板');
    rows.push(
      sheet.map((row) => {
        const values: string[] = [];
        rowNumbers.set(values, Number(row['@r']) - 1);
        for (const cell of list(row.c)) {
          const col = /^[A-Z]+/.exec(cell['@r'] || '')?.[0];
          if (!col) continue;
          const index = [...col].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
          if (index > 99) throw new Error('表格列数过多，请使用商品资料模板');
          if (Object.hasOwn(cell, 'f')) {
            const match = /^(?:_xlfn\.)?DISPIMG\(\s*"([^"\r\n]+)"\s*,\s*[12]\s*\)$/i.exec(
              text(cell.f).trim(),
            );
            if (!match)
              throw new Error('请将公式转换成填写值后再导入；图片请通过插入图片功能放入图片列');
            const picture = pictures.cells.get(match[1]);
            if (!picture) throw new Error('单元格图片资源缺失，请重新插入图片并保存');
            if (!cellPictures.has(values)) cellPictures.set(values, new Map());
            cellPictures.get(values)!.set(index, { ...picture });
            values[index] = '';
            continue;
          }
          if (cell['@vm'])
            throw new Error(
              '此单元格图片格式暂不支持，请将图片转换为浮动图片，放在对应图片格内再保存',
            );
          const value =
            cell['@t'] === 's'
              ? shared[Number(text(cell.v))]
              : cell['@t'] === 'inlineStr'
                ? text(cell.is)
                : text(cell.v);
          values[index] = String(value || '').trim();
        }
        return values;
      }),
    );
  }
  function rowPicture(sheet: string[][], row: string[], col: number): WorkbookPicture | undefined {
    const drawing = pictures.drawings
      .get(sheetNames[rows.indexOf(sheet)])
      ?.get(`${rowNumbers.get(row)}:${col}`);
    const cell = cellPictures.get(row)?.get(col);
    if (drawing && cell)
      throw new Error(`第 ${(rowNumbers.get(row) || 0) + 1} 行图片格有多张图片，请保留一张`);
    return drawing || cell;
  }
  async function embeddedAsset(
    p: Product,
    picture: WorkbookPicture,
    prefix: string,
    givenName = '',
  ) {
    const id = createHash('sha256').update(picture.raw).digest('hex');
    const size = imageSize(picture.raw),
      ext = size.type === 'png' ? 'png' : 'jpg';
    const name = givenName || `${prefix}-${id.slice(0, 8)}.${ext}`;
    if (!safeName(name)) throw new Error('图片文件名无效，请只填写文件名');
    if (p.images[name] && p.images[name].id !== id)
      throw new Error(`不同图片使用了同一名称：${name}`);
    const a = await saveImageBytes(picture.raw, name, assetsDir);
    if (p.images[name] && p.images[name].id !== id)
      throw new Error(`不同图片使用了同一名称：${name}`);
    p.images[name] = a;
    usedPictures.add(picture);
    return name;
  }
  function checkPicturesInSheet(sheet: string[][]) {
    const floating = pictures.drawings.get(sheetNames[rows.indexOf(sheet)]);
    if (
      [
        ...(floating?.values() || []),
        ...sheet.flatMap((row) => [...(cellPictures.get(row)?.values() || [])]),
      ].some((pic) => !usedPictures.has(pic))
    )
      throw new Error(
        '有图片未对应到商品行：请把每张图片左上角放在对应行的“图片”或“规格图”格内，每格一张',
      );
  }
  const info = rows.find((sheet) => sheet.some((row) => row[0] === '项目' && row[1] === '填写值'));
  if (info) {
    const values: Record<string, string> = {};
    for (const row of info) {
      if (
        Object.hasOwn(mapping, row[0]) ||
        [
          '拼单价（元）',
          '单买价（元）',
          '一口价（元）',
          '库存',
          '是否测试素材',
          '模板版本',
          '7天无理由退货',
          '正品发票',
          '假一赔十',
          '发货地省份',
          '发货地城市',
          '提取方式',
          '运费承担',
          '发货时间',
          '上架时间',
          '返点比例（%）',
          '采集来源',
        ].includes(row[0])
      ) {
        if (Object.hasOwn(values, row[0])) throw new Error(`商品字段重复：${row[0]}`);
        values[row[0]] = row[1];
      }
    }
    if (!Object.hasOwn(values, '商品编码') || !Object.hasOwn(values, '商品标题'))
      throw new Error('商品资料页缺少编码或标题字段');
    const p = newProduct();
    const mapped = new Set<string>();
    for (const [label, key] of Object.entries(mapping))
      if (Object.hasOwn(values, label)) {
        if (mapped.has(key)) throw new Error(`商品字段重复：${label}`);
        mapped.add(key);
        (p as unknown as Record<string, unknown>)[key] = values[label] || '';
      }
    p.demo = values['是否测试素材'] === '是';
    p.source = values['采集来源'] || path.basename(file);
    p.services = {
      sevenDay: values['7天无理由退货'] || (values['采集来源'] ? '' : '按平台规则'),
      invoice: values['正品发票'] || (values['采集来源'] ? '' : '否'),
      authenticity: values['假一赔十'] || (values['采集来源'] ? '' : '否'),
    };
    p.skus = [
      {
        spec: '默认规格',
        group: values['拼单价（元）'] || values['一口价（元）'] || '',
        single: values['单买价（元）'] || values['一口价（元）'] || '',
        stock: values['库存'] || '',
      },
    ];
    const isSkuHeader = (row: string[]) => {
      const h = row.map(skuHeader);
      // 天猫 SKU 表没有编码列，淘宝模板已去掉「规格编码」；用一个两版都有的列做锚点。
      return h.includes('规格一名称') && (h.includes('规格编码') || h.includes('一口价（元）'));
    };
    const skuSheet = rows.find((sheet) => sheet.some(isSkuHeader));
    const TEMPLATE_VERSIONS = ['2', '3', '4'];
    const version = values['模板版本'] || '';
    if (version && !TEMPLATE_VERSIONS.includes(version))
      throw new Error('不支持此模板版本，请下载当前运营模板');
    const taobao = version === '4';
    if (TEMPLATE_VERSIONS.includes(version) && !skuSheet) throw new Error('模板缺少规格清单页');
    if (skuSheet) {
      p.templateFormat = {
        '2': '运营模板 v2',
        '3': '运营模板 v3',
        '4': TAOBAO_TEMPLATE_FORMAT,
      }[version as '2' | '3' | '4'];
      p.expectedShop = '';
      if (values['是否测试素材'] && !['是', '否'].includes(values['是否测试素材']))
        throw new Error('是否测试素材只能填写是或否');
      p.demoDeclared = ['是', '否'].includes(values['是否测试素材']);
      const headerIndex = skuSheet.findIndex(isSkuHeader);
      const header = skuSheet[headerIndex].map(skuHeader);
      // 拼多多是「拼单价 + 单买价」，天猫只有一个「一口价」。
      const priceColumns = taobao
        ? (['一口价（元）'] as const)
        : (['拼单价（元）', '单买价（元）'] as const);
      const required = [
        // 规格编码：天猫 SKU 表没有这一列，淘宝模板不提供，因此只对拼多多必填。
        ...(taobao ? [] : (['规格编码'] as const)),
        '规格一名称',
        '规格一值',
        '规格二名称',
        '规格二值',
        ...priceColumns,
        '库存',
      ];
      const imageColumn = header.findIndex((label) => ['规格图', '规格图文件名'].includes(label));
      if (
        new Set(header.filter(Boolean)).size !== header.filter(Boolean).length ||
        imageColumn < 0 ||
        required.some((label) => !header.includes(label))
      )
        throw new Error('规格清单表头缺失或重复，请使用完整模板');
      const entries = skuSheet.slice(headerIndex + 1).filter((row) => row.some(Boolean));
      if (entries.length > 100) throw new Error('每件商品最多导入 100 个规格');
      p.skus = await Promise.all(
        entries.map(async (row, i) => {
          const value = (label: string) => row[header.indexOf(label)] || '';
          const options = [1, 2]
            .map((i) => ({
              name: value(`规格${i === 1 ? '一' : '二'}名称`),
              value: value(`规格${i === 1 ? '一' : '二'}值`),
            }))
            .filter((o) => o.name || o.value);
          let image = row[imageColumn] || '';
          if (image && !safeName(image)) throw new Error('规格图只填写安全文件名，不填写目录');
          const embedded = rowPicture(skuSheet, row, imageColumn);
          if (embedded) image = await embeddedAsset(p, embedded, `规格图-${i + 1}`, image);
          return {
            spec: options.length
              ? options.map((o) => `${o.name}:${o.value}`).join(' / ')
              : '默认规格',
            options,
            code: value('规格编码'),
            image,
            // 淘宝模板只有一个「一口价」；两侧都写上，下游按平台各取所需。
            group: taobao ? value('一口价（元）') : value('拼单价（元）'),
            single: taobao ? value('一口价（元）') : value('单买价（元）'),
            stock: value('库存'),
          };
        }),
      );
      checkPicturesInSheet(skuSheet);
      p.skuCode = '';
      p.attributes = [];
      if (taobao)
        p.taobao = {
          originProvince: values['发货地省份'] || '',
          originCity: values['发货地城市'] || '',
          extractWay: values['提取方式'] || '邮寄',
          freightBearer: values['运费承担'] || '卖家承担',
          deliveryTime: values['发货时间'] || '48小时',
          shelfTime: values['上架时间'] || '放入仓库',
          auctionPoint: values['返点比例（%）'] || '0.5',
        };
      const attributeIndex = info.findIndex((row) => row[0] === '属性名称' && row[1] === '填写值');
      if (attributeIndex >= 0) {
        const extra = info.slice(attributeIndex + 1).filter((row) => row.slice(0, 3).some(Boolean));
        if (extra.length > 50) throw new Error('其他类目属性最多 50 项');
        p.attributes = extra.map((row) => {
          if (row[2] && !['是', '否'].includes(row[2]))
            throw new Error('类目属性必填列只能填写是或否');
          return { name: row[0] || '', value: row[1] || '', required: row[2] === '是' };
        });
      }
    }
    const images = rows.find((sheet) =>
      sheet.some(
        (row) => row[0] === '用途' && row[1] === '顺序' && ['文件名', '图片'].includes(row[2]),
      ),
    );
    if (!images) throw new Error('没有图片清单页，请使用完整原模板');
    // 淘宝模板按后台的图片位命名；拼多多模板沿用「轮播图 / 详情图」。
    const kinds = (
      taobao
        ? [
            ['1:1主图', 'main', 5],
            ['3:4主图', 'threeToFour', 5],
            ['详情图', 'detail', 20],
            ['白底图', 'whiteBg', 1],
            ['卖点图', 'usp', 1],
          ]
        : [
            ['轮播图', 'main', 10],
            ['详情图', 'detail', 50],
          ]
    ) as readonly (readonly [
      string,
      'main' | 'threeToFour' | 'detail' | 'whiteBg' | 'usp',
      number,
    ])[];
    const allowedKinds = ['用途', ...kinds.map(([kind]) => kind)];
    for (const [kind, key, max] of kinds) {
      const selected = images.filter(
        (row) => row[0] === kind && (row[2] || rowPicture(images, row, 2)),
      );
      const named = await Promise.all(
        selected.map(async (row) => {
          const embedded = rowPicture(images, row, 2);
          return {
            order: Number(row[1]),
            name: embedded ? await embeddedAsset(p, embedded, `${kind}-${row[1]}`, row[2]) : row[2],
          };
        }),
      );
      named.sort((a, b) => a.order - b.order);
      if (named.length > max) throw new Error(`${kind}数量超过 ${max} 张`);
      if (named.some((row, i) => !Number.isInteger(row.order) || row.order !== i + 1))
        throw new Error(`${kind}顺序须从 1 开始连续填写`);
      if (new Set(named.map((row) => row.name)).size !== named.length)
        throw new Error(`${kind}图片文件名重复`);
      for (const row of named)
        if (!safeName(row.name)) throw new Error('图片清单每行填写一个文件名，不填写目录');
      p[key] = named.map((row) => row.name);
    }
    if (
      images.some(
        (row) => (row[2] || rowPicture(images, row, 2)) && row[0] && !allowedKinds.includes(row[0]),
      )
    )
      throw new Error(`图片用途只能填写${kinds.map(([kind]) => kind).join('、')}`);
    checkPicturesInSheet(images);
    return [p];
  }
  const table = rows.find((sheet) =>
    sheet.some((row) => row.includes('商品编码') && row.includes('商品标题')),
  );
  if (!table) throw new Error('无法识别此表格，请使用商品资料模板');
  const index = table.findIndex((row) => row.includes('商品编码') && row.includes('商品标题'));
  const header = table[index];
  const labels = header.filter(Boolean);
  if (new Set(labels).size !== labels.length) throw new Error('表头存在重复字段');
  const grouped = new Map<string, Product>();
  const strings: Record<string, keyof Product> = {
    商品编码: 'code',
    商品标题: 'title',
    类目: 'category',
    品牌: 'brand',
    材质: 'material',
    适用人群: 'audience',
    可折叠: 'foldable',
    参考价: 'reference',
    发货承诺: 'shipping',
    运费模板: 'freight',
  };
  for (const row of table.slice(index + 1).filter((row) => row.some(Boolean))) {
    const value = (label: string) => row[header.indexOf(label)] || '';
    const code = value('商品编码');
    const key = code || crypto.randomUUID();
    let p = grouped.get(key);
    if (!p) {
      p = newProduct();
      p.templateFormat = '横向清单';
      p.source = path.basename(file);
      p.skus = [];
      for (const [label, prop] of Object.entries(strings))
        (p as unknown as Record<string, unknown>)[prop] = value(label);
      p.services = {
        sevenDay: value('7天无理由退货') || '按平台规则',
        invoice: value('正品发票') || '否',
        authenticity: value('假一赔十') || '否',
      };
      p.main = value('主图文件')
        .split(/[;；]/)
        .map((s) => s.trim())
        .filter(Boolean);
      p.detail = value('详情图文件')
        .split(/[;；]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if ([...p.main, ...p.detail].some((name) => !safeName(name)))
        throw new Error('图片文件名不能包含目录');
      grouped.set(key, p);
    } else if (p.title !== value('商品标题')) throw new Error(`编码 ${code} 有不同商品标题`);
    p.skus.push({
      spec: value('规格'),
      group: value('拼单价'),
      single: value('单买价'),
      stock: value('库存'),
    });
  }
  return [...grouped.values()];
}
const safeName = safeImageName;
export async function collectFiles(root: string, output: string[] = []): Promise<string[]> {
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name.startsWith('~$')) continue;
    if (e.isSymbolicLink()) throw new Error('资料文件夹不能包含符号链接，请复制原文件后选择');
    const file = path.join(root, e.name);
    if (e.isDirectory()) await collectFiles(file, output);
    else if (e.isFile() && /\.(xlsx|png|jpe?g)$/i.test(e.name)) output.push(file);
    if (output.length > 400) throw new Error('每次最多导入 400 个文件');
  }
  return output;
}
async function imageFileBytes(file: string, name: string): Promise<Buffer> {
  if (!safeName(name)) throw new Error('图片文件名不能包含目录或分号，请改名后导入');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${name} 须为普通图片文件，不支持符号链接`);
  if (stat.size > LOCAL_IMAGE_MAX_BYTES)
    throw new Error(`${name}：本机读取单张图片最多20MB，上传限制需按图片用途核验`);
  return fs.readFile(file);
}
export async function inspectImageFile(file: string, name = path.basename(file)): Promise<Asset> {
  return saveImageBytes(await imageFileBytes(file, name), name);
}
export async function saveImage(file: string, assetsDir: string): Promise<Asset> {
  return saveImageBytes(
    await imageFileBytes(file, path.basename(file)),
    path.basename(file),
    assetsDir,
  );
}
async function saveImageBytes(raw: Buffer, name: string, assetsDir?: string): Promise<Asset> {
  if (raw.length > LOCAL_IMAGE_MAX_BYTES) throw new Error(`${name}：超过本机单张读取上限 20MB`);
  let size: ReturnType<typeof imageSize>;
  try {
    size = imageSize(raw);
  } catch {
    throw Error(`无法读取 PNG 或 JPEG 图片：${name}`);
  }
  if (!size.width || !size.height || !['png', 'jpg'].includes(size.type || ''))
    throw new Error(`无法读取 PNG 或 JPEG 图片：${name}`);
  const id = createHash('sha256').update(raw).digest('hex');
  if (assetsDir) {
    await fs.mkdir(assetsDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(assetsDir, id), raw, { mode: 0o600 });
  }
  return {
    id,
    name,
    url: `media://asset/${id}`,
    width: size.width,
    height: size.height,
    bytes: raw.length,
    format: size.type === 'png' ? 'png' : 'jpg',
  };
}
export async function validateLocalImageFiles(p: Product, directory: string): Promise<void> {
  const groups = [
    ['main', p.main],
    ['detail', p.detail],
    ['sku', p.skus.map((s) => s.image).filter(Boolean)],
    ['threeToFour', p.threeToFour || []],
    ['whiteBg', p.whiteBg || []],
    ['usp', p.usp || []],
  ] as const;
  const checked = new Map<string, Asset>();
  for (const [kind, names] of groups)
    for (const name of names as string[]) {
      const declared = p.images[name];
      if (!declared || !/^[a-f0-9]{64}$/.test(declared.id))
        throw Error(`商品图片缺失或标识无效：${name}`);
      let actual = checked.get(declared.id);
      if (!actual) {
        actual = await inspectImageFile(path.join(directory, declared.id), name);
        checked.set(declared.id, actual);
      }
      if (
        actual.id !== declared.id ||
        actual.bytes !== declared.bytes ||
        actual.width !== declared.width ||
        actual.height !== declared.height
      )
        throw Error(`${name}：图片文件与已保存资料不同，请重新添加或导入`);
      const issues = imageProblems({ ...actual, name }, kind, isTaobaoProduct(p));
      if (issues.length) throw Error(issues.join('；'));
    }
}
export async function importFiles(
  files: string[],
  assetsDir: string,
  withImages: boolean,
): Promise<{ products: Product[]; assets: Asset[] }> {
  if (files.length > 400) throw new Error('每次最多导入 400 个文件');
  let total = 0;
  for (const file of files) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('请选择普通文件');
    total += stat.size;
  }
  if (total > 80 * 1024 * 1024) throw new Error('资料总大小不能超过 80MB');
  const books = files.filter((file) => /\.xlsx$/i.test(file));
  const pictures = withImages ? files.filter((file) => /\.(png|jpe?g)$/i.test(file)) : [];
  const pictureMap = new Map<string, Asset>();
  const assets: Asset[] = [];
  for (const file of pictures) {
    const a = await saveImage(file, assetsDir);
    pictureMap.set(file, a);
    assets.push(a);
  }
  let products: Product[] = [];
  for (const book of books) {
    const parsed = await parseWorkbook(book, assetsDir);
    for (const p of parsed) assets.push(...Object.values(p.images));
    for (const p of parsed)
      for (const name of new Set([
        ...p.main,
        ...p.detail,
        ...p.skus.map((s) => s.image || '').filter(Boolean),
      ])) {
        if (p.images[name]) continue;
        const a =
          pictureMap.get(path.join(path.dirname(book), 'images', name)) ||
          pictureMap.get(path.join(path.dirname(book), name));
        if (a) p.images[name] = a;
        else {
          const found = pictures.filter((file) => path.basename(file) === name);
          if (found.length === 1) p.images[name] = pictureMap.get(found[0])!;
        }
      }
    products.push(...parsed);
  }
  if (!books.length && pictures.length) {
    const p = newProduct('', path.basename(path.dirname(pictures[0])));
    p.source = '图片文件夹';
    for (const file of pictures) {
      const name = path.basename(file);
      if (p.images[name]) throw new Error('图片目录存在同名图片，请各商品分别提供表格');
      p.images[name] = pictureMap.get(file)!;
      (/详情|detail|scene/i.test(file) ? p.detail : p.main).push(name);
    }
    products = [p];
  }
  if (!products.length) throw new Error('未找到商品资料，请填写 Excel 模板后导入');
  if (products.length > 200) throw new Error('每次最多导入 200 件商品');
  const codes = products.map((p) => p.code).filter(Boolean);
  if (new Set(codes).size !== codes.length)
    throw new Error('多份模板中有重复商品编码，请修改后导入');
  return { products, assets };
}

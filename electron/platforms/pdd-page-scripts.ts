import { ExecutionError } from '../execution';

export type SkuTableCell = {
  text: string;
  value: string;
  selector: string;
  rowSpan: number;
  colSpan: number;
  control?: {
    type: string;
    placeholder: string;
    valueAttribute: string | null;
    disabled: boolean;
    readOnly: boolean;
  };
};
export type SkuTable = {
  headers: string[];
  requiredHeaders?: string[];
  rows: { index: number; cells: SkuTableCell[] }[];
};
export type RemoteImages = { main: string[]; detail: string[] };
export type SavedSettings = { reference?: string; shipping?: string; freight?: string };

export function pddCategoryLeaf(category: string): string {
  return (
    category
      .split(/[>＞]+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .at(-1) || ''
  );
}

// These functions are serialized into the page. Keep them self-contained:
// imports and module-local helpers are unavailable in the browser context.
export function readPddCategoryLeaf(selectionPage = false): string {
  const paths = [
    ...document.querySelectorAll<HTMLElement>(
      selectionPage ? '.bottom-container-v2 .cate-text' : '.category-area .sort-name',
    ),
  ].filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
  return paths.length === 1
    ? paths[0].innerText
        .split(/[>＞]+/)
        .map((part) => part.trim())
        .filter(Boolean)
        .at(-1) || ''
    : '';
}

export function clickPddCategoryResult(leaf: string): { count: number; path?: string } {
  const matches = [
    ...document.querySelectorAll<HTMLElement>('[data-testid="beast-core-search-panel"] li'),
  ].filter(
    (e) =>
      e.getClientRects().length &&
      getComputedStyle(e).visibility !== 'hidden' &&
      e.innerText
        .split(/[>＞]+/)
        .at(-1)
        ?.trim() === leaf,
  );
  if (matches.length !== 1) return { count: matches.length };
  const path = matches[0].innerText.trim();
  matches[0].click();
  return { count: 1, path };
}

export function readSkuTable(): SkuTable {
  const tables = [...document.querySelectorAll<HTMLTableElement>('table')].filter(
    (e) => e.innerText.includes('拼单价') && e.innerText.includes('库存'),
  );
  if (tables.length !== 1) throw Error('价格库存表无法唯一定位');
  const table = tables[0];
  table.setAttribute('data-goods-table', 'sku');
  const expand = (rows: HTMLTableRowElement[], bodyIndex: number): SkuTableCell[][] => {
    const grid: SkuTableCell[][] = Array.from({ length: rows.length }, () => []);
    rows.forEach((row, r) => {
      let col = 0;
      [...row.cells].forEach((cell, physicalCol) => {
        while (grid[r][col]) col++;
        const rowSpan = cell.rowSpan === 0 ? rows.length - r : cell.rowSpan || 1;
        const colSpan = cell.colSpan || 1;
        if (rowSpan > rows.length - r) throw Error('价格库存表合并单元格超出行范围');
        const input = cell.querySelector<HTMLInputElement>('input:not([type=file])');
        const item: SkuTableCell = {
          text: cell.innerText.trim(),
          value: input?.value ?? '',
          rowSpan,
          colSpan,
          ...(input
            ? {
                control: {
                  type: input.type || '',
                  placeholder: (input.placeholder || '').slice(0, 80),
                  valueAttribute: input.getAttribute?.('value') ?? null,
                  disabled: !!input.disabled,
                  readOnly: !!input.readOnly,
                },
              }
            : {}),
          selector:
            bodyIndex < 0
              ? ''
              : 'table[data-goods-table="sku"] > tbody:nth-of-type(' +
                (bodyIndex + 1) +
                ') > tr:nth-child(' +
                (r + 1) +
                ') > :is(td,th):nth-child(' +
                (physicalCol + 1) +
                ')',
        };
        for (let y = r; y < r + rowSpan; y++) {
          for (let x = col; x < col + colSpan; x++) {
            if (grid[y][x]) throw Error('价格库存表合并单元格重叠');
            grid[y][x] = item;
          }
        }
        col += colSpan;
      });
    });
    return grid;
  };
  const head = expand([...(table.tHead?.rows || [])], -1);
  const headers = (head.at(-1) || []).map((cell) => cell.text.replace(/\*/g, '').trim());
  const requiredHeaders = (head.at(-1) || [])
    .filter((cell) => /^\s*\*/.test(cell.text))
    .map((cell) => cell.text.replace(/\*/g, '').trim());
  if (!headers.length) throw Error('价格库存表未读取到表头');
  const rows = [...table.tBodies]
    .flatMap((body, index) => expand([...body.rows], index))
    .map((cells, index) => {
      if (
        cells.length !== headers.length ||
        Array.from({ length: headers.length }, (_, i) => !cells[i]).some(Boolean)
      )
        throw Error('价格库存表列数不完整');
      return { index, cells };
    });
  return { headers, requiredHeaders, rows };
}

export function readRemoteImages(): RemoteImages {
  const main = document.querySelector('[id="basic.carousel_gallery"]');
  const detail = document.querySelector('#detail_pic .decoration-operate');
  if (!main || !detail) throw Error('商品图片容器未读取到');
  return {
    main: [...main.querySelectorAll<HTMLElement>('[style]')]
      .map((e) => e.style.backgroundImage.match(/^url\(["']?(https:[^"')]+)["']?\)$/)?.[1])
      .filter((url): url is string => !!url),
    detail: [...detail.querySelectorAll('img')]
      .map((e) => e.getAttribute('src') || '')
      .filter((url) => /^https:\/\//.test(url)),
  };
}
export function readImageUploadFacts(kind: 'main' | 'detail') {
  const rootSelector = kind === 'main' ? '[id="basic.carousel_gallery"]' : '#detail_pic';
  const roots = document.querySelectorAll<HTMLElement>(rootSelector);
  const root = roots.length === 1 ? roots[0] : null;
  const track = kind === 'main' ? 'carousel_img_localfile_upload' : 'detail_img_localfile_upload';
  const trackedSelector = `input[type="file"][data-tracking-click-viewid="${track}"]:not(:disabled)`;
  const local = root ? [...root.querySelectorAll<HTMLInputElement>(trackedSelector)] : [];
  const generic = root
    ? [...root.querySelectorAll<HTMLInputElement>('input[type="file"]:not(:disabled)')]
    : [];
  const global = [...document.querySelectorAll<HTMLInputElement>(trackedSelector)];
  const selector =
    local.length === 1
      ? `${rootSelector} ${trackedSelector}`
      : local.length === 0 && generic.length === 1
        ? `${rootSelector} input[type="file"]:not(:disabled)`
        : local.length === 0 && generic.length === 0 && global.length === 1
          ? trackedSelector
          : '';
  const visible = (e: Element) =>
    !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  return {
    // At capacity or during upload the picker may disappear; the area remains readable.
    available: !!root,
    rootCount: roots.length,
    inputCount: selector ? 1 : local.length || generic.length || global.length,
    inputSelector: selector,
    text: (root?.innerText || '').slice(0, 5000),
    notices: [
      ...document.querySelectorAll<HTMLElement>(
        '[role=alert],[role=dialog],[class*=notice],[class*=Notice],[class*=toast],[class*=Toast]',
      ),
    ]
      .filter(visible)
      .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300))
      .filter((t) => /图片|图像|文件|上传/.test(t))
      .slice(0, 20),
  };
}

export function readSavedSettings(): SavedSettings {
  return {
    reference: document.querySelector<HTMLInputElement>(
      '[data-tracking-click-viewid="goods_advice_price"]',
    )?.value,
    shipping: document
      .querySelector<HTMLElement>('[id="service.shipment_limit_second"] label[data-checked="true"]')
      ?.innerText.trim(),
    freight:
      document.querySelector<HTMLElement>('[id="service.cost_template_id"]')?.innerText.trim() ||
      document
        .querySelector<HTMLElement>(
          '[id="service.is_default_template_id"] label[data-checked="true"]',
        )
        ?.innerText.replace('推荐', '')
        .trim(),
  };
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
function invalid(label: string): never {
  throw new ExecutionError(
    'platform_changed',
    `${label}返回结构不正确，已停止，请核对原页面`,
    'inspect_form',
  );
}

export function parseSkuTable(value: unknown): SkuTable {
  if (
    !isRecord(value) ||
    !strings(value.headers) ||
    !value.headers.length ||
    !Array.isArray(value.rows)
  )
    return invalid('价格库存表');
  const headers = value.headers;
  if (
    value.requiredHeaders !== undefined &&
    (!strings(value.requiredHeaders) ||
      value.requiredHeaders.some((header) => !headers.includes(header)))
  )
    return invalid('价格库存表必填列');
  const width = value.headers.length;
  for (const [index, row] of value.rows.entries()) {
    if (
      !isRecord(row) ||
      row.index !== index ||
      !Array.isArray(row.cells) ||
      row.cells.length !== width
    )
      return invalid('价格库存表');
    for (const cell of row.cells) {
      if (
        !isRecord(cell) ||
        typeof cell.text !== 'string' ||
        typeof cell.value !== 'string' ||
        typeof cell.selector !== 'string' ||
        !Number.isSafeInteger(cell.rowSpan) ||
        Number(cell.rowSpan) < 1 ||
        !Number.isSafeInteger(cell.colSpan) ||
        Number(cell.colSpan) < 1
      )
        return invalid('价格库存表');
      const control = cell.control;
      if (
        control !== undefined &&
        (!isRecord(control) ||
          typeof control.type !== 'string' ||
          typeof control.placeholder !== 'string' ||
          typeof control.disabled !== 'boolean' ||
          typeof control.readOnly !== 'boolean' ||
          (control.valueAttribute !== null && typeof control.valueAttribute !== 'string'))
      )
        return invalid('价格库存表输入控件');
    }
  }
  return value as SkuTable;
}

export function parseRemoteImages(value: unknown): RemoteImages {
  if (
    !isRecord(value) ||
    !strings(value.main) ||
    !strings(value.detail) ||
    [...value.main, ...value.detail].some((url) => !/^https:\/\/\S+$/.test(url))
  )
    return invalid('商品图片');
  return { main: value.main, detail: value.detail };
}

export function parseSavedSettings(value: unknown): SavedSettings {
  if (
    !isRecord(value) ||
    ['reference', 'shipping', 'freight'].some(
      (key) => value[key] !== undefined && typeof value[key] !== 'string',
    )
  )
    return invalid('参考价与发货设置');
  return value as SavedSettings;
}

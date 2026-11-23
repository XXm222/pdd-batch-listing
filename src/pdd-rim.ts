/**
 * 轮辋直径：轮胎类商品开启「到店安装（配送到店）」后，价格及库存表会多出一列必填的
 * `*轮辋直径`。平台只接受固定的 27 个选项（9 个尺寸档 × 普通/防爆胎/雪地胎），
 * 不接受自由数字，所以运营资料里的「205/45R17」这类规格必须翻译成选项文案才能提交。
 *
 * 尺寸档规则（与后台下拉一致）：
 *   13 英寸及以下 → 「13英寸及以下」
 *   14 ~ 20 英寸  → 「NN英寸」
 *   21 英寸及以上 → 「21英寸及以上」
 * 前缀规则：防爆胎加「防爆胎」，雪地胎加「雪地胎」，普通胎不加。
 */

export type TireKind = 'normal' | 'runflat' | 'snow';

const RUNFLAT = /防爆|缺气保用|rft|ssr|\bzp\b|run\s*flat/i;
const SNOW = /雪地|冰雪|winter|snow/i;
// 注意：R 前面通常是数字（205/45R17），只排除字母，不能排除数字，
// 否则「R17」会被当成单词的一部分漏读。
const RIM_IN_INCH = /(?:^|[^a-z])(?:zr|r)\s*(\d{2})(?![0-9])/i;
const RIM_WITH_UNIT = /(\d{2})\s*英寸/;

/** 判断轮胎类型，用来决定选项前缀。 */
export function tireKind(text: string): TireKind {
  if (RUNFLAT.test(text)) return 'runflat';
  if (SNOW.test(text)) return 'snow';
  return 'normal';
}

/** 从文本里读轮辋直径数字，读不到返回 undefined。 */
export function rimDiameter(text: string): number | undefined {
  const source = String(text ?? '');
  const withUnit = RIM_WITH_UNIT.exec(source);
  if (withUnit) {
    const value = Number(withUnit[1]);
    if (value > 0) return value;
  }
  const match = RIM_IN_INCH.exec(source);
  if (!match) return undefined;
  const value = Number(match[1]);
  return value > 0 ? value : undefined;
}

/** 把英寸数字翻译成后台下拉里的选项文案。 */
export function rimDiameterLabelOf(inches: number, kind: TireKind = 'normal'): string {
  const base = inches >= 21 ? '21英寸及以上' : inches <= 13 ? '13英寸及以下' : `${inches}英寸`;
  if (kind === 'runflat') return `防爆胎${base}`;
  if (kind === 'snow') return `雪地胎${base}`;
  return base;
}

/** 后台下拉里全部 27 个合法选项，顺序与页面一致（普通 / 防爆胎 / 雪地胎）。 */
export const RIM_OPTIONS: readonly string[] = (['normal', 'runflat', 'snow'] as const).flatMap(
  (kind) => [13, 14, 15, 16, 17, 18, 19, 20, 21].map((inches) => rimDiameterLabelOf(inches, kind)),
);

const RIM_OPTION_SET = new Set(RIM_OPTIONS);
// 运营可能写成「17」「17寸」「17英寸」「17" 」「R17」；也允许带「防爆胎 / 雪地胎」前缀。
const RIM_LOOSE = /^(防爆胎|雪地胎)?\s*(?:r)?\s*(\d{1,2})\s*(?:英寸|寸|"|”)?$/i;

/**
 * 把运营填的轮辋直径原文（可填「17」「17英寸」「防爆胎18英寸」或完整选项文案）
 * 规范成后台选项文案；不是合法选项返回 undefined。
 */
export function rimOptionLabel(text: string): string | undefined {
  const source = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!source) return undefined;
  if (RIM_OPTION_SET.has(source)) return source;
  const match = RIM_LOOSE.exec(source);
  if (!match) return undefined;
  const inches = Number(match[2]);
  if (!Number.isInteger(inches) || inches <= 0) return undefined;
  const kind: TireKind =
    match[1] === '防爆胎' ? 'runflat' : match[1] === '雪地胎' ? 'snow' : 'normal';
  const label = rimDiameterLabelOf(inches, kind);
  return RIM_OPTION_SET.has(label) ? label : undefined;
}

/**
 * 依次从候选文本里取轮辋直径（规格选项优先，取不到再看商品标题），
 * 返回后台可接受的选项文案；都读不到返回 undefined。
 */
export function rimDiameterLabel(...texts: Array<string | undefined>): string | undefined {
  for (const text of texts) {
    if (!text) continue;
    const inches = rimDiameter(text);
    if (inches === undefined) continue;
    return rimDiameterLabelOf(inches, tireKind(text));
  }
  return undefined;
}

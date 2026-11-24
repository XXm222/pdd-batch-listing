/**
 * 登录账号的归一化与形态识别。
 *
 * 商家在后台看到的账号有多种写法：`主账号:子账号(真实姓名)`、全角冒号、
 * 手机号主账号、邮箱主账号、纯数字 ID、复制粘贴带进来的零宽字符……这些差异
 * 只应该影响「第一次录入」，不应该让后面的核对永远失败。
 *
 * 所以这里做两件事：
 * 1. 把能确定的差异抹平（全角转半角、去零宽、剥尾部真实姓名、冒号两侧空白），
 *    得到一份稳定文本 `normalizePddAccount`；
 * 2. 判断账号形态 `accountKind`，用于店铺录入和账号状态提示。
 *
 * 归一化只做「确定安全」的变换：全角 ASCII 区（U+FF01–U+FF5E）与全角空格，
 * 刻意不用 NFKC —— NFKC 会把 ㈱、㎏ 这类字符折叠成别的形状，会让两个本来
 * 不同的账号被误判成同一个。
 */

export type AccountKind = 'main:sub' | 'mobile' | 'email' | 'numeric-id' | 'plain';

/** 全角 ASCII 与全角空格转半角，其余字符原样保留。 */
function toHalfWidth(value: string): string {
  return value
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/** 只折叠 ASCII 大小写，中文与其它文字不受影响。 */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/**
 * 归一化登录账号：
 * `邓禄普：珠珠（王玮珠） ` → `邓禄普:珠珠`
 *
 * 尾部括号里的真实姓名是后台的展示层信息，不属于账号本身，所以剥掉；
 * 多层括号（例如 `(王玮珠)(客服)`）一并剥掉。
 */
export function normalizePddAccount(raw: string): string {
  return toHalfWidth(String(raw ?? ''))
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/(?:\s*[（(][^()（）]*[)）])+\s*$/, '')
    .replace(/\s*:\s*/g, ':')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 判定账号形态。传入的账号会先归一化，调用方不必重复处理。 */
export function accountKind(account: string): AccountKind {
  const text = normalizePddAccount(account);
  if (!text) return 'plain';
  if (text.includes(':')) return 'main:sub';
  const digits = text.replace(/\D/g, '');
  if (/^(?:86)?1[3-9]\d{9}$/.test(digits)) return 'mobile';
  if (/^\d{6,}$/.test(text)) return 'numeric-id';
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)) return 'email';
  return 'plain';
}

/** 去重与比对用的稳定键：归一化后再折叠 ASCII 大小写。 */
export function accountKey(account: string): string {
  return asciiLower(normalizePddAccount(account));
}

/** 账号里是否含掩码字符（后台会把账号显示成 `邓*普:珠*`，那种不能当完整账号存）。 */
export function isMaskedAccount(account: string): boolean {
  return /[*]/.test(normalizePddAccount(account));
}

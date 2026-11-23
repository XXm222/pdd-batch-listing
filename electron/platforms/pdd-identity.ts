type ShopIdentity = { name: string; account: string; mallId?: number; userId?: number };
type PddIdentity = { account: string; display: string; shop: string };
// 后台写在页面里的结构化身份。数字编号不受显示形态影响：
// 「主账号:子账号(真实姓名)」、手机号主账号、改过昵称的账号都是同一对整数。
type PddAnchor = {
  mallId?: number;
  userId?: number;
  username?: string;
  nickname?: string;
  mallName?: string;
};
type LoginEvidence = {
  trusted: boolean;
  names: string[];
  loginPage: boolean;
  form: boolean;
  rejected: boolean;
  challenge: boolean;
  structure?: { logoutDomPresent?: boolean; logoutTextPresent?: boolean };
  anchor?: PddAnchor;
};

// The backend header renders a signed-in subaccount as "主账号:子账号(真实姓名)".
// The trailing parenthesised real name is presentation only and never part of a
// configured account, so identity comparison runs on the text without it.
// Kept self-contained so it can be injected into page-side guards as source.
const pddBareAccount = (value: string) =>
  value.replace(/(?:\s*[（(][^()（）]*[)）])+\s*$/, '').trim();
const pddAsciiLower = (value: string) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());

// 页面已经拿着身份：`localStorage.new_userinfo` 有 `mall_id`/`id`，
// `window.__user` 有一份精简副本。这两个整数是唯一不受文字花式影响的证据，
// 所以能在页面上读到就优先用它们。字符串自包含，会被拼进页面脚本。
export const PDD_ANCHOR_READ = `(() => {
  const num=(v)=>(typeof v==='number'&&Number.isSafeInteger(v)&&v>0)?v:undefined;
  const text=(v)=>(typeof v==='string'&&v.trim())?v.trim().slice(0,120):undefined;
  let raw=null;
  try{raw=JSON.parse(localStorage.getItem('new_userinfo')||'null');}catch(e){raw=null;}
  const user=(typeof window!=='undefined'&&window.__user&&typeof window.__user==='object')?window.__user:null;
  const mall=(raw&&typeof raw.mall==='object')?raw.mall:null;
  const mallId=num(mall&&mall.mall_id)||num(raw&&raw.mall_id)||num(user&&user.mallId);
  const userId=num(raw&&raw.id)||num(user&&user.id);
  if(!mallId&&!userId)return null;
  return {mallId,userId,username:text(raw&&raw.username),nickname:text(raw&&raw.nickname),mallName:text(mall&&mall.mall_name)};
})()`;

// 页面返回值不可信，进主进程前先按形状收敛一次。
export function readPddAnchor(value: unknown): PddAnchor | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const num = (candidate: unknown) =>
    typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0
      ? candidate
      : undefined;
  const text = (candidate: unknown) =>
    typeof candidate === 'string' && candidate.trim() ? candidate.trim().slice(0, 120) : undefined;
  const anchor: PddAnchor = {
    mallId: num(raw.mallId),
    userId: num(raw.userId),
    username: text(raw.username),
    nickname: text(raw.nickname),
    mallName: text(raw.mallName),
  };
  return anchor.mallId || anchor.userId ? anchor : undefined;
}

// 只有两边都齐全才敢下结论：`unknown` 永远不等于不一致，
// 读不到绑定就退回文字核对，绝不因为缺少一项就判店铺不对。
export function pddAnchorVerdict(
  anchor: PddAnchor | undefined | null,
  shop: { mallId?: number; userId?: number },
): 'bound' | 'mismatch' | 'unknown' {
  if (!anchor || !shop.mallId || !shop.userId) return 'unknown';
  if (!anchor.mallId || !anchor.userId) return 'unknown';
  if (anchor.mallId !== shop.mallId || anchor.userId !== shop.userId) return 'mismatch';
  return 'bound';
}

// One identity per unmasked account line: the account without its display name,
// the line as the header shows it, and the main account before the colon.
// A pair is only evidence when the header names something on its own: either the
// main account ("Mandla旗舰店" above "Mandla旗舰店:小秘"), or the configured shop,
// whose main account legitimately differs from the shop name
// ("邓禄普黑豆专卖店" above "邓禄普:珠珠(王玮珠)").
export function completePddIdentities(names: string[], shop?: ShopIdentity): PddIdentity[] {
  const identities: PddIdentity[] = [];
  for (const display of names) {
    if (display.includes('*') || !display.includes(':')) continue;
    const account = pddBareAccount(display);
    const main = account.slice(0, account.indexOf(':'));
    if (!main || account.length <= main.length + 1) continue;
    if (identities.some((identity) => identity.account === account)) continue;
    if (!names.includes(main) && !(shop && names.includes(shop.name))) continue;
    identities.push({ account, display, shop: main });
  }
  return identities;
}

const matchesAccount = (identity: PddIdentity, account: string) =>
  identity.account === account || identity.display === account;
const matchesAccountFold = (identity: PddIdentity, account: string) =>
  pddAsciiLower(identity.account) === pddAsciiLower(account) ||
  pddAsciiLower(identity.display) === pddAsciiLower(account);

export function matchesPddIdentity(names: string[], shop: ShopIdentity): boolean {
  if (!shop.account.includes(':')) return names.includes(shop.name);
  const identities = completePddIdentities(names, shop);
  if (identities.length !== 1) return false;
  const identity = identities[0];
  // A saved account may keep the display name the header once showed, so compare
  // both spellings on either side.
  const saved = [shop.account, pddBareAccount(shop.account)];
  if (saved.some((account) => matchesAccount(identity, account)) && names.includes(shop.name))
    return true;
  // The backend canonicalizes Latin letter casing after password login. Accept
  // this only for one complete, unmasked shop + subaccount pair; never for a
  // shop name alone, and never normalize punctuation or non-ASCII characters.
  return (
    pddAsciiLower(identity.shop) === pddAsciiLower(shop.name) &&
    saved.some((account) => matchesAccountFold(identity, account))
  );
}

const PAGE_HELPERS = `const pddBareAccount=${pddBareAccount.toString()};const pddAsciiLower=${pddAsciiLower.toString()};const matchesAccount=${matchesAccount.toString()};const matchesAccountFold=${matchesAccountFold.toString()};const pddAnchorVerdict=${pddAnchorVerdict.toString()};`;
export const PDD_IDENTITY_MATCH = `((names,shop)=>{const completePddIdentities=${completePddIdentities.toString()};${PAGE_HELPERS}return (${matchesPddIdentity.toString()})(names,shop);})`;

export function isPddLoginConfirmed(state: LoginEvidence, shop: ShopIdentity): boolean {
  if (!state.trusted || state.loginPage || state.form || state.rejected || state.challenge)
    return false;
  // 有绑定时整数说了算：命中即确认，不命中即不是这家店/这个子账号。
  const anchored = pddAnchorVerdict(state.anchor, shop);
  if (anchored === 'mismatch') return false;
  if (anchored === 'bound') return true;
  if (state.structure?.logoutDomPresent || state.structure?.logoutTextPresent) return true;
  if (!shop.account.includes(':')) return false;
  const identities = completePddIdentities(state.names, shop);
  return identities.length === 1 && matchesPddIdentity(state.names, shop);
}

// 身份核对分两级：先看绑定的整数，读不到再退回文字规则。
export function matchesPddLogin(state: LoginEvidence, shop: ShopIdentity): boolean {
  if (!isPddLoginConfirmed(state, shop)) return false;
  if (pddAnchorVerdict(state.anchor, shop) === 'bound') return true;
  return matchesPddIdentity(state.names, shop);
}

export const PDD_LOGIN_CONFIRMED = `((state,shop)=>{const completePddIdentities=${completePddIdentities.toString()};${PAGE_HELPERS}const matchesPddIdentity=${PDD_IDENTITY_MATCH};return (${isPddLoginConfirmed.toString()})(state,shop);})`;
export const PDD_LOGIN_MATCH = `((state,shop)=>{const completePddIdentities=${completePddIdentities.toString()};${PAGE_HELPERS}const matchesPddIdentity=${PDD_IDENTITY_MATCH};const isPddLoginConfirmed=${PDD_LOGIN_CONFIRMED};return (${matchesPddLogin.toString()})(state,shop);})`;
export type { PddAnchor, ShopIdentity };

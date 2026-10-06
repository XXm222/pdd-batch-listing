type ShopIdentity = { name: string; account: string };
type LoginEvidence = {
  trusted: boolean;
  names: string[];
  loginPage: boolean;
  form: boolean;
  rejected: boolean;
  challenge: boolean;
  structure?: { logoutDomPresent?: boolean; logoutTextPresent?: boolean };
};

export function completePddIdentities(names: string[]) {
  return names
    .filter((name) => name.includes(':') && !name.includes('*'))
    .map((account) => ({ account, shop: account.slice(0, account.indexOf(':')) }))
    .filter(
      (identity) =>
        identity.shop &&
        names.includes(identity.shop) &&
        identity.account.length > identity.shop.length + 1,
    );
}

export function matchesPddIdentity(names: string[], shop: ShopIdentity): boolean {
  if (!shop.account.includes(':')) return names.includes(shop.name);
  if (names.includes(shop.name) && names.includes(shop.account)) return true;
  // The backend canonicalizes Latin letter casing after password login. Accept
  // this only for one complete, unmasked shop + subaccount pair; never for a
  // shop name alone, and never normalize punctuation or non-ASCII characters.
  const identities = names
    .filter((name) => name.includes(':') && !name.includes('*'))
    .map((account) => ({ account, shop: account.slice(0, account.indexOf(':')) }))
    .filter(
      (identity) =>
        identity.shop &&
        names.includes(identity.shop) &&
        identity.account.length > identity.shop.length + 1,
    );
  if (identities.length !== 1) return false;
  const asciiLower = (value: string) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return (
    asciiLower(identities[0].shop) === asciiLower(shop.name) &&
    asciiLower(identities[0].account) === asciiLower(shop.account)
  );
}

// This self-contained compiled function is shared with page-side identity guards.
export const PDD_IDENTITY_MATCH = matchesPddIdentity.toString();

export function isPddLoginConfirmed(state: LoginEvidence, shop: ShopIdentity): boolean {
  if (!state.trusted || state.loginPage || state.form || state.rejected || state.challenge)
    return false;
  if (state.structure?.logoutDomPresent || state.structure?.logoutTextPresent) return true;
  if (!shop.account.includes(':')) return false;
  const identities = completePddIdentities(state.names);
  return (
    identities.length === 1 && matchesPddIdentity([identities[0].shop, identities[0].account], shop)
  );
}

export const PDD_LOGIN_CONFIRMED = `((state,shop)=>{const completePddIdentities=${completePddIdentities.toString()};const matchesPddIdentity=${PDD_IDENTITY_MATCH};return (${isPddLoginConfirmed.toString()})(state,shop);})`;

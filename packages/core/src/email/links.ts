/**
 * Linkurile din emailuri, construite din `APP_URL` (niciodată din header-ul Host al unei cereri).
 * Tokenul stă în FRAGMENT (`#token=…`): fragmentul nu e trimis niciodată serverului, deci nu apare
 * în logurile aplicației, ale proxy-ului sau ale CDN-ului și nu pleacă în antetul `Referer`.
 * Pagina îl citește în browser și îl trimite în corpul unui POST.
 */

function origin(appUrl: string): string {
  const url = new URL(appUrl);
  return url.origin;
}

export function buildVerifyEmailLink(appUrl: string, token: string): string {
  return `${origin(appUrl)}/verificare-email#token=${encodeURIComponent(token)}`;
}

export function buildResetPasswordLink(appUrl: string, token: string): string {
  return `${origin(appUrl)}/resetare-parola#token=${encodeURIComponent(token)}`;
}

/** Pagina produsului (`/produs/{slug}`), pentru emailul «Anunță-mă când revine»: fără token, fără query, slugul codificat. */
export function buildProductLink(appUrl: string, slug: string): string {
  return `${origin(appUrl)}/produs/${encodeURIComponent(slug)}`;
}

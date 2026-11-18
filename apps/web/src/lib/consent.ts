/**
 * Consimțământul pentru cookie-uri (docs/19 §1: «consimțământ implicit refuzat»). Logica pură, fără React și fără nucleul (o
 * folosesc și serverul, și componentele client). Regula: cât timp vizitatorul nu a ales, TOT ce nu e strict necesar rămâne oprit;
 * «necesar» (sesiune, coș, securitate) nu cere consimțământ și nu apare ca alegere. Alegerea se ține într-un cookie propriu,
 * `SameSite=Lax`, 12 luni, cu versiune: la schimbarea categoriilor (versiune nouă) alegerea veche nu mai e valabilă și
 * bannerul reapare.
 */
export const CONSENT_COOKIE = "ecom_consent";

/**
 * Cookie-ul coșului de oaspete: STRICT NECESAR (fără el coșul nu funcționează), deci nu cere consimțământ și nu apare ca alegere,
 * ci în categoria «necesare» din banner. Valoare aleatorie, `httpOnly`, `SameSite=Lax`, valabilitate din setări
 * (`docs/INTREBARI-AVOCAT.md` §3.4: formularea din politica de cookie-uri se confirmă cu avocatul).
 */
export const CART_COOKIE = "ecom_cart";

/** Cookie-urile strict necesare ale aplicației (lista din politica de cookie-uri); niciunul nu depinde de alegerea vizitatorului. */
export const NECESSARY_COOKIES = [CART_COOKIE] as const;
export const CONSENT_VERSION = 1;
export const CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Categoriile care cer consimțământ; «necesar» nu e aici (e mereu activ). */
export const CONSENT_CATEGORIES = ["analytics", "marketing"] as const;
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];

export type ConsentChoices = Record<ConsentCategory, boolean>;

export const REFUSE_ALL: ConsentChoices = { analytics: false, marketing: false };
export const ACCEPT_ALL: ConsentChoices = { analytics: true, marketing: true };

const FORMAT = new RegExp(`^v${CONSENT_VERSION}\\.a([01])\\.m([01])$`);

/** Valoarea cookie-ului (`v1.a0.m1`): fără caractere care cer codificare. */
export function serializeConsent(choices: ConsentChoices): string {
  return `v${CONSENT_VERSION}.a${choices.analytics ? 1 : 0}.m${choices.marketing ? 1 : 0}`;
}

/** Alegerea salvată, sau `null` când nu există una valabilă (lipsă, stricată, de altă versiune): atunci se aplică «refuzat» și se arată bannerul. */
export function parseConsent(raw: string | null | undefined): ConsentChoices | null {
  if (!raw) return null;
  const match = FORMAT.exec(raw);
  if (!match) return null;
  return { analytics: match[1] === "1", marketing: match[2] === "1" };
}

/** Are voie această categorie? Fără o alegere salvată: NU (implicit refuzat). */
export function isConsentGiven(
  choices: ConsentChoices | null | undefined,
  category: ConsentCategory,
): boolean {
  return choices?.[category] === true;
}

/** Cookie-ul gata de scris din browser (`document.cookie = …`). `Secure` doar pe HTTPS. */
export function consentCookieString(choices: ConsentChoices, secure: boolean): string {
  return [
    `${CONSENT_COOKIE}=${serializeConsent(choices)}`,
    `Max-Age=${CONSENT_MAX_AGE_SECONDS}`,
    "Path=/",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** Valoarea cookie-ului de consimțământ dintr-un antet `Cookie` (sau din `document.cookie`). */
export function readConsentCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === CONSENT_COOKIE) return rest.join("=");
  }
  return null;
}

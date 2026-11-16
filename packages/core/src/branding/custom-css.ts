/**
 * CSS-ul personalizat al vitrinei (editorul de temă, Nivel 2). Vine de la un administrator, dar NU e de încredere: o greșeală sau
 * un cont compromis nu are voie să trimită vizitatorii spre alte adrese (`url()`, `@import`, fonturi externe), să ruleze cod (vechile
 * `expression()`, `behavior`) sau să iasă din zona lui. Două bariere:
 *  1. `validateCustomCss` (la salvare ȘI la randare): listă scurtă de reguli permise (`@media`, `@supports`), fără adrese, fără
 *     escape-uri, cu acolade balansate și adâncime limitată;
 *  2. `renderCustomCss` împachetează totul într-un selector al vitrinei prin imbricare CSS nativă, deci regulile se aplică doar
 *     în interiorul `[data-surface="storefront"]` și nu pot atinge adminul (selectori ca `body` sau `:root` nu mai potrivesc nimic).
 * Generatorul temei (`css.ts`) rămâne cel care compune restul CSS-ului din valori validate; aici e singurul text liber.
 */
export const CUSTOM_CSS_MAX_LENGTH = 8000;

/** Selectorul zonei vitrinei; la fel de specific ca tokenii vitrinei, deci regulile utilizatorului pot suprascrie valorile implicite. */
export const CUSTOM_CSS_SCOPE = 'html [data-surface="storefront"]';

const ALLOWED_AT_RULES = new Set(["media", "supports"]);
const MAX_DEPTH = 3;

export type CustomCssCode =
  "CUSTOM_CSS_TOO_LONG" | "CUSTOM_CSS_FORBIDDEN" | "CUSTOM_CSS_AT_RULE" | "CUSTOM_CSS_UNBALANCED";

export type CustomCssResult =
  { ok: true; css: string } | { ok: false; code: CustomCssCode; message: string };

/** Fără comentarii; `null` dacă un comentariu rămâne nenchis. */
function stripComments(css: string): string | null {
  let out = "";
  let index = 0;
  while (index < css.length) {
    if (css.startsWith("/*", index)) {
      const end = css.indexOf("*/", index + 2);
      if (end < 0) return null;
      index = end + 2;
    } else {
      out += css.charAt(index);
      index += 1;
    }
  }
  return out;
}

/** Construcțiile interzise, căutate pe textul fără comentarii, cu litere mici și fără spații (prinde `URL( 'a' )` și `u/**\/rl(`). */
const FORBIDDEN: RegExp[] = [
  /url\(/,
  /image-set\(/,
  /(?:^|[^a-z])src\(/,
  /expression\(/,
  /behavior:/,
  /-moz-binding/,
  /javascript:/,
  /vbscript:/,
  /data:[\w+.-]*\//,
  /data:,/,
  /<\//,
  /<!--/,
  /\\/,
];

// eslint-disable-next-line no-control-regex -- caracterele de control sunt chiar ce se caută
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const fail = (code: CustomCssCode, message: string): CustomCssResult => ({
  ok: false,
  code,
  message,
});

export function validateCustomCss(input: string): CustomCssResult {
  if (input.length > CUSTOM_CSS_MAX_LENGTH) {
    return fail("CUSTOM_CSS_TOO_LONG", `CSS-ul depășește ${CUSTOM_CSS_MAX_LENGTH} de caractere`);
  }
  if (CONTROL_CHARS.test(input)) {
    return fail("CUSTOM_CSS_FORBIDDEN", "CSS-ul conține caractere de control");
  }
  const css = stripComments(input);
  if (css === null) return fail("CUSTOM_CSS_UNBALANCED", "Un comentariu nu e închis");

  const compact = css.toLowerCase().replace(/\s+/g, "");
  if (FORBIDDEN.some((pattern) => pattern.test(compact))) {
    return fail(
      "CUSTOM_CSS_FORBIDDEN",
      "CSS-ul conține o construcție interzisă (adrese url(), escape-uri, cod sau etichete)",
    );
  }
  for (const match of css.matchAll(/@([a-zA-Z-]*)/g)) {
    if (!ALLOWED_AT_RULES.has((match[1] ?? "").toLowerCase())) {
      return fail("CUSTOM_CSS_AT_RULE", "Sunt permise doar regulile @media și @supports");
    }
  }

  let depth = 0;
  for (const char of css) {
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    if (depth < 0) return fail("CUSTOM_CSS_UNBALANCED", "Acoladele nu sunt balansate");
    if (depth > MAX_DEPTH)
      return fail("CUSTOM_CSS_UNBALANCED", "Regulile sunt imbricate prea adânc");
  }
  if (depth !== 0) return fail("CUSTOM_CSS_UNBALANCED", "Acoladele nu sunt balansate");
  return { ok: true, css };
}

/**
 * Regulile utilizatorului, gata de pus în foaia de stil a temei: împachetate în `scope`. Gol sau invalid → șir gol (un CSS
 * strâmb ajuns în bază pe altă cale nu ajunge niciodată în pagină).
 */
export function renderCustomCss(input: string, scope: string = CUSTOM_CSS_SCOPE): string {
  if (input.trim() === "") return "";
  const result = validateCustomCss(input);
  if (!result.ok || result.css.trim() === "") return "";
  return `${scope}{${result.css}}`;
}

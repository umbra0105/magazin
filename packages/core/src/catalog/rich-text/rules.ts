/**
 * Regulile descrierii bogate a produsului (15c): UN SINGUR loc pentru lista albă, limite și tiparele de validare.
 * Sanitizatorul (`sanitize.ts`) și verificatorul de ieșire (`verify.ts`) le citesc de aici; testele au un oracol
 * independent (`oracle.ts`) cu lista scrisă separat, ca o greșeală de aici să nu treacă nevăzută.
 */

export const RICH_TEXT_LIMITS = {
  /** Cel mai lung HTML primit (înainte de sanitizare). */
  maxInputLength: 500_000,
  /** Cel mai lung HTML salvat (după sanitizare); aceeași limită ca `description` din scheme Zod. */
  maxOutputLength: 100_000,
  /** Adâncimea maximă de imbricare a etichetelor; mai jos, etichetele se aplatizează (textul rămâne). */
  maxNesting: 16,
  maxImages: 50,
  maxTableCells: 2000,
  maxAltLength: 300,
  maxTitleLength: 200,
} as const;

/** Etichetele permise și atributele fiecăreia. Orice altceva dispare. */
export const ALLOWED_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  p: [],
  br: [],
  strong: [],
  em: [],
  u: [],
  s: [],
  h2: [],
  h3: [],
  h4: [],
  ul: [],
  ol: [],
  li: [],
  blockquote: [],
  hr: [],
  div: [],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  sup: [],
  sub: [],
  a: ["href", "title", "target", "rel"],
  img: ["alt", "data-media-id"],
  th: ["colspan", "rowspan"],
  td: ["colspan", "rowspan"],
};

export const ALLOWED_TAGS: readonly string[] = Object.keys(ALLOWED_ATTRIBUTES);

/** Etichete echivalente, aduse la forma din lista albă. */
export const TAG_RENAMES: Readonly<Record<string, string>> = {
  b: "strong",
  i: "em",
  strike: "s",
  del: "s",
  h1: "h2",
  h5: "h4",
  h6: "h4",
};

/** Etichetele eliminate CU TOT CONȚINUTUL (inclusiv cele din interior). */
export const DROPPED_WITH_CONTENT: readonly string[] = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "form",
  "button",
  "textarea",
  "select",
  "option",
  "noscript",
  "template",
  "video",
  "audio",
  "canvas",
  "applet",
  "frame",
  "frameset",
  "noframes",
  "noembed",
  "xmp",
  "plaintext",
  "head",
  "title",
];

/** Un id din biblioteca media: doar caractere sigure, lungime mărginită. */
export const MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{8,40}$/;

/** colspan/rowspan: întreg între 1 și 20. */
export const SPAN_PATTERN = /^(?:[1-9]|1\d|20)$/;

export const ALLOWED_SCHEMES = ["http", "https", "mailto", "tel"] as const;

/** Valoarea atributului `rel` impusă pe linkurile externe. */
export const EXTERNAL_REL = "noopener noreferrer";

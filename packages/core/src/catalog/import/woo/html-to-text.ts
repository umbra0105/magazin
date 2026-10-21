/**
 * HTML (și shortcode-uri WordPress) → text simplu, FĂRĂ parser extern: o trecere cu expresii regulate pe
 * un set mic de etichete, destul pentru descrierile unui export WooCommerce. Câmpul `description` al
 * aplicației e text simplu (nu există încă un sanitizator HTML: descrierea bogată e un punct separat,
 * înainte de Faza 6), deci importul NU păstrează HTML: ce intră în baza de date nu conține etichete.
 *
 * Reguli:
 *  - blocurile `<style>`, `<script>`, `<noscript>`, `<template>`, `<iframe>`, `<video>`, `<audio>`, `<object>`,
 *    `<embed>`, `<svg>` și comentariile se elimină CU TOT CONȚINUTUL (un bloc nepereche se taie până la capăt);
 *  - `<img>` se elimină; linkurile (`<a>`) păstrează doar textul;
 *  - tabelele devin linii «Etichetă: valoare» (rând cu două celule), «celulă | celulă | …» (trei sau mai
 *    multe) sau text simplu (o celulă), deci specificațiile nu se pierd;
 *  - listele devin linii cu «- »; `p`, `div`, titlurile, `br` devin paragrafe/linii;
 *  - shortcode-urile WordPress (`[caption …]`, `[/vc_row]`, `[gallery ids="1,2"]`) se scot (textul dintre ele
 *    rămâne); un text între paranteze drepte obișnuit («[min 5 m]») NU se atinge;
 *  - entitățile (`&amp;`, `&nbsp;`, `&#x219;`) se decodează, apoi se mai trece o dată peste etichete, ca un
 *    `&lt;script&gt;` decodat să nu producă etichete în rezultat;
 *  - spațiile se normalizează, liniile goale multiple se strâng.
 *
 * Etichetele se caută cu cuantificatori MĂRGINIȚI (`[^>]{0,500}`), ca o intrare ostilă (mii de `<div` fără
 * `>`) să nu producă backtracking pătratic.
 */

export interface HtmlToTextStats {
  tables: number;
  links: number;
  images: number;
  /** Blocuri eliminate cu tot conținutul (`style`, `script`, `iframe`, `video`, comentarii etc.). */
  removedBlocks: number;
  shortcodes: number;
}

export interface HtmlToTextResult {
  text: string;
  stats: HtmlToTextStats;
  /** Textul rezultat diferă de intrare în afara unor spații de la capete (a fost HTML, entități sau shortcode-uri). */
  changed: boolean;
  /** Rezultatul a depășit `maxLength` și a fost tăiat. */
  truncated: boolean;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  euro: "€",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
  frac12: "½",
  frac14: "¼",
  sup2: "²",
  sup3: "³",
  micro: "µ",
  Acirc: "Â",
  acirc: "â",
  Icirc: "Î",
  icirc: "î",
  Abreve: "Ă",
  abreve: "ă",
};

/** Blocuri care se elimină cu tot conținutul. */
const DROPPED_BLOCKS = [
  "style",
  "script",
  "noscript",
  "template",
  "iframe",
  "video",
  "audio",
  "object",
  "embed",
  "svg",
  "head",
];

/** Nume de shortcode-uri cunoscute (se scot și fără atribute). */
const KNOWN_SHORTCODES = new Set([
  "caption",
  "gallery",
  "video",
  "audio",
  "embed",
  "playlist",
  "wpvideo",
  "product",
  "products",
  "product_page",
  "add_to_cart",
  "contact-form-7",
  "rev_slider",
  "gravityform",
  "button",
  "row",
  "column",
  "col",
  "section",
  "toggle",
  "tabs",
  "tab",
  "accordion",
]);

/** Caractere invizibile (spațiu de lățime zero, BOM) și spații speciale, scrise prin cod, nu literal. */
const chars = (codes: readonly number[]): string =>
  codes.map((code) => String.fromCharCode(code)).join("");
const ZERO_WIDTH = new RegExp(`[${chars([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff])}]`, "g");
const WIDE_SPACES = new RegExp(`[${chars([0xa0, 0x2007, 0x202f])}]`, "g");
const NUL = new RegExp(chars([0]), "g");

/** Marcaje de sfârșit de linie / de paragraf, puse de etichete și strânse la final (două etichete lipite dau o singură ruptură). */
const LB = chars([1]);
const PB = chars([2]);
/** Înlocuiește temporar un «<» care nu poate începe o etichetă (fără «>» în următoarele 500 de caractere). */
const LT = chars([3]);

/**
 * Un «<» fără «>» în următoarele ~500 de caractere nu poate începe nicio etichetă recunoscută (toate se caută cu
 * `[^>]{0,500}>`), dar fiecare asemenea apariție făcea regulile să parcurgă 500 de caractere: «<a » repetat de 33 000 de
 * ori costa ~0,2 s. O singură trecere de la coadă la cap le marchează, iar la final marcajul revine la «<».
 */
function markLooseLessThan(input: string): string {
  if (!input.includes("<")) return input;
  let nextGt = -1;
  const parts: string[] = new Array<string>(input.length);
  for (let i = input.length - 1; i >= 0; i--) {
    const ch = input[i] as string;
    if (ch === ">") nextGt = i;
    parts[i] = ch === "<" && (nextGt < 0 || nextGt - i > 501) ? LT : ch;
  }
  return parts.join("");
}

const MAX_ENTITY_CODEPOINT = 0x10ffff;

function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > MAX_ENTITY_CODEPOINT) return "";
      // caracterele de control și surogatele nu au loc într-o descriere
      if (code < 32 && code !== 9 && code !== 10) return " ";
      if (code >= 0xd800 && code <= 0xdfff) return "";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Elimină blocurile `tag` cu tot conținutul; un bloc deschis și neînchis se taie până la capătul textului.
 * O singură trecere de la stânga la dreapta: fiecare deschidere caută închiderea doar înainte de ea, iar când
 * nu mai există nicio închidere, restul se taie (înainte, o regulă cu «[\s\S]*?» recitea textul până la capăt pentru
 * FIECARE deschidere: timp pătratic pe «<svg>» repetat cu o închidere fără «>»).
 */
function dropBlocks(html: string, tag: string, stats: HtmlToTextStats): string {
  const opener = new RegExp(`<${tag}\\b[^>]{0,500}>`, "gi");
  const closer = new RegExp(`</${tag}\\s*>`, "gi");
  let out = "";
  let cursor = 0;
  for (;;) {
    opener.lastIndex = cursor;
    const open = opener.exec(html);
    if (!open) break;
    closer.lastIndex = open.index + open[0].length;
    const close = closer.exec(html);
    if (!close) {
      // nicio închidere de aici încolo: blocul nepereche se taie până la capăt
      stats.removedBlocks += 1;
      return stripLoose(out + html.slice(cursor, open.index), tag);
    }
    stats.removedBlocks += 1;
    out += html.slice(cursor, open.index) + " ";
    cursor = close.index + close[0].length;
  }
  // etichete rămase (închideri singure, forme cu «/>»)
  return stripLoose(out + html.slice(cursor), tag);
}

const stripLoose = (html: string, tag: string): string =>
  html.replace(new RegExp(`</?${tag}\\b[^>]{0,500}>`, "gi"), " ");

function dropComments(html: string, stats: HtmlToTextStats): string {
  let out = "";
  let cursor = 0;
  for (;;) {
    const open = html.indexOf("<!--", cursor);
    if (open < 0) return out + html.slice(cursor);
    stats.removedBlocks += 1;
    const close = html.indexOf("-->", open + 4);
    if (close < 0) return out + html.slice(cursor, open);
    out += html.slice(cursor, open) + " ";
    cursor = close + 3;
  }
}

const stripTags = (value: string): string => value.replace(/<\/?[a-z!][^>]{0,500}>/gi, " ");

/** Textul unei celule de tabel: fără etichete, cu spații normalizate pe o singură linie. */
function cellText(html: string): string {
  return decodeEntities(stripTags(html.replace(/<br\s*\/?>/gi, " ")))
    .replace(/\s+/g, " ")
    .trim();
}

function tableToLines(table: string): string {
  const lines: string[] = [];
  const rows = table.match(/<tr\b[^>]{0,500}>[\s\S]*?(?=<tr\b|<\/tr|$)/gi) ?? [];
  for (const row of rows) {
    const cells = (row.match(/<t[dh]\b[^>]{0,500}>[\s\S]*?(?=<t[dh]\b|<\/t[dh]|<\/tr|$)/gi) ?? [])
      .map(cellText)
      .filter((cell) => cell !== "");
    if (cells.length === 0) continue;
    if (cells.length === 1) lines.push(cells[0] as string);
    else if (cells.length === 2) lines.push(`${cells[0]}: ${cells[1]}`);
    else lines.push(cells.join(" | "));
  }
  return `${PB}${lines.join(LB)}${PB}`;
}

function stripShortcodes(text: string, stats: HtmlToTextStats): string {
  return text.replace(
    /\[(\/?)([a-z][a-z0-9_-]{1,40})((?:\s+[^\]]{0,500})?)\]/gi,
    (match, closing: string, name: string, attrs: string) => {
      const lower = name.toLowerCase();
      const looksLikeShortcode =
        closing === "/" ||
        KNOWN_SHORTCODES.has(lower) ||
        /[_-]/.test(lower) ||
        /\w+\s*=\s*["'\w]/.test(attrs);
      if (!looksLikeShortcode) return match;
      stats.shortcodes += 1;
      return "";
    },
  );
}

/**
 * Memorie mică pentru texte lungi identice: într-un XLSX, un singur șir partajat poate fi referit de mii de celule, iar
 * conversia aceluiași text s-ar relua de fiecare dată. Doar textele peste `MEMO_MIN_LENGTH`, cel mult
 * `MEMO_MAX_ENTRIES` intrări; se întoarce mereu o copie a rezultatului (apelantul poate modifica statisticile).
 */
const MEMO_MIN_LENGTH = 1000;
const MEMO_MAX_ENTRIES = 32;
const memo = new Map<string, HtmlToTextResult>();

const copyResult = (result: HtmlToTextResult): HtmlToTextResult => ({
  ...result,
  stats: { ...result.stats },
});

export function htmlToPlainText(input: string, maxLength = 100_000): HtmlToTextResult {
  if (input.length < MEMO_MIN_LENGTH) return convert(input, maxLength);
  const key = `${maxLength}:${input}`;
  const cached = memo.get(key);
  if (cached) return copyResult(cached);
  const result = convert(input, maxLength);
  if (memo.size >= MEMO_MAX_ENTRIES) memo.delete(memo.keys().next().value as string);
  memo.set(key, copyResult(result));
  return result;
}

function convert(input: string, maxLength: number): HtmlToTextResult {
  const stats: HtmlToTextStats = {
    tables: 0,
    links: 0,
    images: 0,
    removedBlocks: 0,
    shortcodes: 0,
  };
  let html = input.replace(/\r\n?/g, "\n").replace(NUL, "");

  // comentarii (inclusiv blocurile WordPress «<!-- wp:paragraph -->»); unul neînchis taie restul. O singură
  // trecere (indexOf înainte): un «<!--» repetat fără «-->» nu mai recitește textul de la fiecare deschidere.
  html = dropComments(html, stats);
  // abia după comentarii (un «<!--» neînchis nu are «>» și ar fi marcat ca «<» liber)
  html = markLooseLessThan(html);
  for (const tag of DROPPED_BLOCKS) html = dropBlocks(html, tag, stats);

  html = html.replace(/<img\b[^>]{0,500}>/gi, () => {
    stats.images += 1;
    return " ";
  });
  html = html.replace(/<a\b[^>]{0,500}>/gi, () => {
    stats.links += 1;
    return "";
  });
  html = html.replace(/<\/a\s*>/gi, "");

  html = html.replace(/<table\b[^>]{0,500}>[\s\S]*?(?:<\/table\s*>|$)/gi, (table) => {
    stats.tables += 1;
    return tableToLines(table);
  });

  html = html
    .replace(/<br\s*\/?>/gi, LB)
    .replace(/<hr\b[^>]{0,500}>/gi, PB)
    .replace(/<li\b[^>]{0,500}>/gi, `${LB}- `)
    .replace(/<\/li\s*>/gi, LB)
    .replace(/<\/?(?:ul|ol|dl)\b[^>]{0,500}>/gi, LB)
    .replace(
      /<\/?(?:p|h[1-6]|blockquote|section|article|header|footer|figure|figcaption|pre)\b[^>]{0,500}>/gi,
      PB,
    )
    .replace(/<\/?(?:div|tr|dt|dd|center)\b[^>]{0,500}>/gi, LB);

  let text = stripTags(html);
  text = stripShortcodes(text, stats);
  text = decodeEntities(text);
  // un `&lt;script&gt;` decodat nu are voie să lase etichete în rezultat
  text = stripShortcodes(stripTags(text), stats);

  text = text
    .replace(ZERO_WIDTH, "")
    .replace(WIDE_SPACES, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(new RegExp(` ?([\\n${LB}${PB}]) ?`, "g"), "$1")
    // o ruptură de paragraf (sau două linii noi) câștigă în fața uneia de linie
    .replace(new RegExp(`[\\n${LB}${PB}]+`, "g"), (run) =>
      run.includes(PB) || (run.match(/\n/g)?.length ?? 0) >= 2 ? "\n\n" : "\n",
    )
    .trim();

  text = text.replaceAll(LT, "<");
  let truncated = false;
  if (text.length > maxLength) {
    truncated = true;
    text = `${text.slice(0, maxLength - 1).trimEnd()}…`;
  }
  const changed = text !== input.trim();
  return { text, stats, changed, truncated };
}

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

/** Elimină blocurile `tag` cu tot conținutul; un bloc deschis și neînchis se taie până la capătul textului. */
function dropBlocks(html: string, tag: string, stats: HtmlToTextStats): string {
  const pair = new RegExp(`<${tag}\\b[^>]{0,500}>[\\s\\S]*?</${tag}\\s*>`, "gi");
  // fără nicio închidere nu are rost să căutăm perechi (ar fi pătratic pe multe deschideri)
  let out = html.toLowerCase().includes(`</${tag}`)
    ? html.replace(pair, () => {
        stats.removedBlocks += 1;
        return " ";
      })
    : html;
  const open = new RegExp(`<${tag}\\b[^>]{0,500}>`, "i");
  const rest = open.exec(out);
  if (rest) {
    stats.removedBlocks += 1;
    out = out.slice(0, rest.index);
  }
  // etichete rămase (închideri singure, forme cu «/>»)
  return out.replace(new RegExp(`</?${tag}\\b[^>]{0,500}>`, "gi"), " ");
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

export function htmlToPlainText(input: string, maxLength = 100_000): HtmlToTextResult {
  const stats: HtmlToTextStats = {
    tables: 0,
    links: 0,
    images: 0,
    removedBlocks: 0,
    shortcodes: 0,
  };
  let html = input.replace(/\r\n?/g, "\n").replace(NUL, "");

  // comentarii (inclusiv blocurile WordPress «<!-- wp:paragraph -->»); unul neînchis taie restul
  html = html.replace(/<!--[\s\S]*?-->/g, () => {
    stats.removedBlocks += 1;
    return " ";
  });
  const unclosedComment = html.indexOf("<!--");
  if (unclosedComment >= 0) {
    stats.removedBlocks += 1;
    html = html.slice(0, unclosedComment);
  }
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

  let truncated = false;
  if (text.length > maxLength) {
    truncated = true;
    text = `${text.slice(0, maxLength - 1).trimEnd()}…`;
  }
  const changed = text !== input.trim();
  return { text, stats, changed, truncated };
}

import { ValidationError } from "@ecom/shared";
import { sanitizeHtml, type Attributes, type IOptions } from "./html-engine";
import { classifyHref } from "./href";
import { plainTextToHtml, richTextToPlain } from "./plain-text";
import {
  ALLOWED_ATTRIBUTES,
  ALLOWED_SCHEMES,
  ALLOWED_TAGS,
  DROPPED_WITH_CONTENT,
  EXTERNAL_REL,
  MEDIA_ID_PATTERN,
  RICH_TEXT_LIMITS,
  SPAN_PATTERN,
  TAG_RENAMES,
} from "./rules";
import { findRichHtmlViolations } from "./verify";

export { RICH_TEXT_LIMITS } from "./rules";

/**
 * Sanitizatorul descrierii bogate a produsului (15c) — SINGURA cale prin care HTML ajunge în `Product.description`
 * (un test de arhitectură o impune). Serverul e sursa de adevăr: editorul din admin e doar comoditate.
 *
 * Model: LISTĂ ALBĂ. Biblioteca (`sanitize-html`, parser htmlparser2) reconstruiește HTML-ul doar din etichete și atribute
 * permise (vezi `rules.ts`); apoi `findRichHtmlViolations` verifică ieșirea pe o cale independentă (a doua plasă: la
 * orice încălcare se întoarce textul escapat, nu HTML). Fără expresii regulate pe date ostile în drumul critic.
 *
 *  - fără script, iframe, stiluri, gestionari de evenimente, `class`, `id`, `style`;
 *  - linkuri doar http/https/mailto/tel și căi interne «/…»; cele externe primesc `target="_blank"` și
 *    `rel="noopener noreferrer"` de la server, oricare ar fi fost intrarea;
 *  - imagini DOAR din media proprie: `<img data-media-id alt>`; `src`-ul se generează la randare;
 *  - blocurile periculoase se elimină cu tot conținutul; etichetele necunoscute își păstrează textul;
 *  - o descriere fără text și fără imagine valabilă iese `null`, niciodată un șir gol.
 */

export interface RichTextStats {
  tables: number;
  /** Linkuri valide păstrate. */
  links: number;
  /** Imagini păstrate. */
  images: number;
  /** Imagini eliminate (fără id de media valid sau necunoscut). */
  removedImages: number;
  /** Blocuri periculoase sau nefolositoare eliminate cu tot conținutul (script, style, iframe …). */
  removedBlocks: number;
  /** Verificarea finală a găsit o încălcare: rezultatul e doar text escapat. */
  failedClosed: boolean;
}

export interface RichTextResult {
  /** HTML sanitizat sau `null` când descrierea e goală. */
  html: string | null;
  /** Id-urile de media păstrate în HTML (fără dubluri), ca serviciul să le verifice și să le înregistreze. */
  mediaIds: string[];
  stats: RichTextStats;
  /** Rezultatul diferă de intrare (în afara spațiilor de la capete). */
  changed: boolean;
}

export interface RichTextOptions {
  /**
   * Id-urile de media care există și pot fi folosite. Dacă e dat, o imagine cu alt id se elimină;
   * dacă lipsește, orice id cu format valid rămâne (serviciul face a doua trecere cu setul verificat).
   */
  allowedMediaIds?: ReadonlySet<string>;
}

const chars = (codes: readonly number[]): string =>
  codes.map((code) => String.fromCharCode(code)).join("");
/** Caractere de control (în afară de tab, linie nouă, CR) și C1: scoase din intrare înainte de parsare. */
const CONTROL_CHARS = new RegExp(
  `[${chars([0])}-${chars([8])}${chars([11, 12])}${chars([14])}-${chars([31])}${chars([127])}-${chars([159])}]`,
  "g",
);
/** Spații și caractere invizibile care nu fac o descriere «nevidă». */
const BLANK = new RegExp(`[\\s${chars([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff])}]`, "g");

const tooLong = (
  reason: string,
  message: string,
  details: Record<string, unknown>,
): ValidationError => new ValidationError(message, { reason, ...details });

/** Paragrafele/liniile goale de la începutul și sfârșitul HTML-ului (starea «goală» a editorului: `<p></p>`). */
function trimEmptyEdges(html: string): string {
  let start = 0;
  let end = html.length;
  const isBlank = (from: number, to: number): boolean => {
    for (let i = from; i < to; i++) {
      const ch = html[i] as string;
      if (ch === "<") {
        if (html.startsWith("<br />", i)) {
          i += 5;
          continue;
        }
        return false;
      }
      if (ch.replace(BLANK, "") !== "") return false;
    }
    return true;
  };
  for (;;) {
    while (start < end && /\s/.test(html[start] as string)) start++;
    if (html.startsWith("<br />", start)) {
      start += 6;
      continue;
    }
    if (html.startsWith("<p>", start)) {
      const close = html.indexOf("</p>", start + 3);
      if (close >= 0 && close < end && isBlank(start + 3, close)) {
        start = close + 4;
        continue;
      }
    }
    break;
  }
  for (;;) {
    while (end > start && /\s/.test(html[end - 1] as string)) end--;
    if (end - start >= 6 && html.startsWith("<br />", end - 6)) {
      end -= 6;
      continue;
    }
    if (end - start >= 4 && html.startsWith("</p>", end - 4)) {
      const open = html.lastIndexOf("<p>", end - 4);
      if (open >= start && isBlank(open + 3, end - 4)) {
        end = open;
        continue;
      }
    }
    break;
  }
  return html.slice(start, end);
}

/** Textul vizibil dintr-un HTML bine format (de la sanitizator): fără etichete, entități sau spații. */
const hasVisibleText = (html: string): boolean =>
  html.replace(/<[^>]*>/g, "").replace(BLANK, "") !== "";

export function sanitizeRichHtml(input: string, options: RichTextOptions = {}): RichTextResult {
  if (input.length > RICH_TEXT_LIMITS.maxInputLength) {
    throw tooLong(
      "input_too_long",
      `Descrierea depășește ${RICH_TEXT_LIMITS.maxInputLength} de caractere`,
      { max: RICH_TEXT_LIMITS.maxInputLength },
    );
  }
  const stats: RichTextStats = {
    tables: 0,
    links: 0,
    images: 0,
    removedImages: 0,
    removedBlocks: 0,
    failedClosed: false,
  };
  const mediaIds = new Set<string>();
  let cells = 0;
  const dropped = new Set(DROPPED_WITH_CONTENT);
  /**
   * Elementele de scos, marcate prin IDENTITATEA obiectului de atribute întors de transform (nu printr-un atribut
   * din intrare, pe care clientul l-ar putea trimite). NU le redenumim într-o etichetă nepermisă: `sanitize-html`
   * păstrează atunci o redenumire veche pe acea adâncime și închide un frate cu numele greșit (`</span>`).
   */
  const removals = new WeakMap<object, "element" | "tag">();
  const removeTag = (
    tagName: string,
    mode: "element" | "tag",
  ): { tagName: string; attribs: Attributes } => {
    const attribs: Attributes = {};
    removals.set(attribs, mode);
    return { tagName, attribs };
  };

  const transformTags: Record<
    string,
    string | ((tagName: string, attribs: Attributes) => { tagName: string; attribs: Attributes })
  > = {
    ...TAG_RENAMES,
    a: (_tag, attribs) => {
      const href = classifyHref(attribs["href"]);
      if (!href) return removeTag("a", "tag");
      stats.links += 1;
      const out: Attributes = { href: href.value };
      const title = (attribs["title"] ?? "").trim().slice(0, RICH_TEXT_LIMITS.maxTitleLength);
      if (title !== "") out["title"] = title;
      if (href.external) {
        out["target"] = "_blank";
        out["rel"] = EXTERNAL_REL;
      }
      return { tagName: "a", attribs: out };
    },
    img: (_tag, attribs) => {
      const id = attribs["data-media-id"];
      const valid =
        id !== undefined &&
        MEDIA_ID_PATTERN.test(id) &&
        (options.allowedMediaIds === undefined || options.allowedMediaIds.has(id));
      if (!valid) {
        stats.removedImages += 1;
        return removeTag("img", "element");
      }
      stats.images += 1;
      mediaIds.add(id);
      return {
        tagName: "img",
        attribs: {
          alt: (attribs["alt"] ?? "").trim().slice(0, RICH_TEXT_LIMITS.maxAltLength),
          "data-media-id": id,
        },
      };
    },
    table: () => {
      stats.tables += 1;
      return { tagName: "table", attribs: {} };
    },
    td: (_tag, attribs) => cellTag("td", attribs),
    th: (_tag, attribs) => cellTag("th", attribs),
  };

  function cellTag(
    tagName: "td" | "th",
    attribs: Attributes,
  ): { tagName: string; attribs: Attributes } {
    cells += 1;
    const out: Attributes = {};
    for (const key of ["colspan", "rowspan"] as const) {
      const value = attribs[key];
      if (value !== undefined && SPAN_PATTERN.test(value)) out[key] = value;
    }
    return { tagName, attribs: out };
  }

  const config: IOptions = {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ALLOWED_SCHEMES,
    allowedSchemesAppliedToAttributes: ["href"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    nonTextTags: DROPPED_WITH_CONTENT,
    transformTags,
    exclusiveFilter: (frame) => {
      const mode = removals.get(frame.attribs);
      // «tag»: se scoate eticheta, textul rămâne (link invalid); «element»: se scoate tot (imagine invalidă)
      return mode === "tag" ? "excludeTag" : mode === "element";
    },
    nestingLimit: RICH_TEXT_LIMITS.maxNesting,
    parser: { decodeEntities: true },
    onOpenTag: (name) => {
      if (dropped.has(name)) stats.removedBlocks += 1;
    },
  };

  const cleaned = input.replace(CONTROL_CHARS, "");
  const sanitized = trimEmptyEdges(sanitizeHtml(cleaned, config));

  if (stats.images > RICH_TEXT_LIMITS.maxImages) {
    throw tooLong(
      "too_many_images",
      `Descrierea are prea multe imagini (maximum ${RICH_TEXT_LIMITS.maxImages})`,
      {
        max: RICH_TEXT_LIMITS.maxImages,
      },
    );
  }
  if (cells > RICH_TEXT_LIMITS.maxTableCells) {
    throw tooLong(
      "too_many_table_cells",
      `Tabelele din descriere au prea multe celule (maximum ${RICH_TEXT_LIMITS.maxTableCells})`,
      { max: RICH_TEXT_LIMITS.maxTableCells },
    );
  }
  if (sanitized.length > RICH_TEXT_LIMITS.maxOutputLength) {
    throw tooLong(
      "output_too_long",
      `Descrierea depășește ${RICH_TEXT_LIMITS.maxOutputLength} de caractere după curățare`,
      { max: RICH_TEXT_LIMITS.maxOutputLength },
    );
  }

  let html: string | null =
    hasVisibleText(sanitized) || sanitized.includes("<img") ? sanitized : null;
  let ids = [...mediaIds];
  if (html !== null && findRichHtmlViolations(html).length > 0) {
    // a doua plasă: nu întoarcem HTML pe care nu-l putem garanta, ci textul lui, escapat
    stats.failedClosed = true;
    html = plainTextToHtml(richTextToPlain(input));
    ids = [];
  }
  return { html, mediaIds: ids, stats, changed: (html ?? "") !== input.trim() };
}

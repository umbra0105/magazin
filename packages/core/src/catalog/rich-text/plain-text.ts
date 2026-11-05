import { sanitizeHtml } from "./html-engine";
import { DROPPED_WITH_CONTENT } from "./rules";

/**
 * Conversii între text simplu și descrierea HTML a produsului (15c).
 *
 *  - `plainTextToHtml`: descrierile vechi (text simplu) → HTML sigur. Aceeași regulă o aplică și migrația de date din
 *    baza de date (SQL), iar un test compară cele două: paragrafele se despart la una sau mai multe linii goale (doar
 *    spații/tab), liniile simple dintr-un paragraf se leagă cu `<br />`, doar `&`, `<` și `>` se escapează.
 *  - `richTextToPlain`: text derivat din HTML (meta descriere, căutare, feed-uri).
 */

const escapeText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function plainTextToHtml(text: string): string | null {
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length > 0) paragraphs.push(current);
      current = [];
    } else current.push(line);
  }
  if (current.length > 0) paragraphs.push(current);
  if (paragraphs.length === 0) return null;
  return paragraphs
    .map((paragraph) => `<p>${paragraph.map(escapeText).join("<br />")}</p>`)
    .join("");
}

/* Marcaje de structură (caractere de control, scoase din intrare înainte): rămân prin eliminarea etichetelor. */
const BLOCK = String.fromCharCode(1);
const LINE = String.fromCharCode(2);
const ITEM = String.fromCharCode(3);
const CELL = String.fromCharCode(4);
const ROW_START = String.fromCharCode(5);
const ROW_END = String.fromCharCode(6);
const MARKERS = new RegExp(
  `[${[1, 2, 3, 4, 5, 6].map((code) => String.fromCharCode(code)).join("")}]`,
  "g",
);

/** În interiorul unei celule, rupturile de paragraf, de linie și marcajele de listă devin spații. */
const STRUCTURE_MARKERS = new RegExp(`[${BLOCK}${LINE}${ITEM}]`, "g");

function tableRowsToLines(text: string): string {
  let out = "";
  let cursor = 0;
  for (;;) {
    const start = text.indexOf(ROW_START, cursor);
    if (start < 0) return out + text.slice(cursor);
    const end = text.indexOf(ROW_END, start + 1);
    if (end < 0) return out + text.slice(cursor);
    out += text.slice(cursor, start);
    const cells = text
      .slice(start + 1, end)
      .split(CELL)
      .map((cell) => cell.replace(STRUCTURE_MARKERS, " ").replace(/\s+/g, " ").trim())
      .filter((cell) => cell !== "");
    if (cells.length === 1) out += `${cells[0]}${LINE}`;
    else if (cells.length === 2) out += `${cells[0]}: ${cells[1]}${LINE}`;
    else if (cells.length > 2) out += `${cells.join(" | ")}${LINE}`;
    cursor = end + 1;
  }
}

/** Spații, tab și spațiul de nerupere. */
const SPACES = new RegExp(`[ \t${String.fromCharCode(0xa0)}]+`, "g");

const unescapeText = (text: string): string =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");

/**
 * HTML → text simplu: paragrafele se despart printr-o linie goală, `<br>` printr-o linie nouă, elementele de listă devin
 * «- …», rândurile de tabel «Etichetă: valoare» (două celule) sau «a | b | c». Funcționează și pe HTML nesanitizat:
 * etichetele se elimină la sfârșit cu biblioteca de sanitizare, deci nu poate ieși nicio etichetă.
 */
export function richTextToPlain(html: string | null, maxLength?: number): string {
  if (html === null || html === "") return "";
  const marked = html
    .replace(MARKERS, "")
    .replace(/<br\b[^>]{0,200}>/gi, LINE)
    .replace(/<\/(?:p|div|h[1-6]|blockquote|ul|ol|table)\s*>|<hr\b[^>]{0,200}>/gi, BLOCK)
    .replace(/<li\b[^>]{0,200}>/gi, ITEM)
    .replace(/<\/li\s*>/gi, LINE)
    .replace(/<tr\b[^>]{0,200}>/gi, ROW_START)
    .replace(/<\/tr\s*>/gi, ROW_END)
    .replace(/<\/t[dh]\s*>/gi, CELL);
  const stripped = unescapeText(
    sanitizeHtml(marked, {
      allowedTags: [],
      allowedAttributes: {},
      nonTextTags: DROPPED_WITH_CONTENT,
      parser: { decodeEntities: true },
    }),
  );
  let text = tableRowsToLines(stripped)
    .replaceAll(BLOCK, "\n\n")
    .replaceAll(LINE, "\n")
    .replaceAll(ITEM, "- ")
    .replaceAll(CELL, " ")
    .replaceAll(ROW_START, "")
    .replaceAll(ROW_END, "")
    .replace(SPACES, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (maxLength !== undefined && text.length > maxLength)
    text = `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  return text;
}

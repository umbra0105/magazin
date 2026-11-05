import { ALLOWED_ATTRIBUTES, EXTERNAL_REL, MEDIA_ID_PATTERN, SPAN_PATTERN } from "./rules";

/**
 * A doua plasă a sanitizatorului (15c): verifică FORMA ieșirii, pe o cale independentă de biblioteca de sanitizare.
 * Dacă o regresie sau o ocolire a bibliotecii ar lăsa ceva în afara listei albe, `sanitizeRichHtml` nu întoarce acel
 * HTML, ci textul lui escapat (eșec închis). Ieșirea corectă are exact forma: etichete și atribute din lista albă, ghilimele
 * duble, niciun «<» sau «>» în text, linkuri doar cu scheme sigure, linkurile externe cu target și rel impuse.
 */

const TAG = /<(\/?)([a-z][a-z0-9]*)((?:\s+[a-z][a-z-]*="[^"<>]*")*)\s*(\/?)>/gi;
const ATTRIBUTE = /\s+([a-z][a-z-]*)="([^"<>]*)"/gi;
const SAFE_HREF = /^(?:https?:\/\/[^\s"<>]+|mailto:[^\s"<>]+|tel:[^\s"<>]+|\/(?![/\\])[^\s"<>]*)$/i;
const SPACE_OR_CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(32)}${String.fromCharCode(127)}]`,
);

/** Lista încălcărilor găsite în `html` (goală = ieșire conformă). */
export function findRichHtmlViolations(html: string): string[] {
  const violations: string[] = [];
  let text = "";
  let last = 0;
  for (const match of html.matchAll(TAG)) {
    text += html.slice(last, match.index);
    last = (match.index ?? 0) + match[0].length;
    const closing = match[1] === "/";
    const name = (match[2] as string).toLowerCase();
    const attributes = match[3] ?? "";
    const allowed = ALLOWED_ATTRIBUTES[name];
    if (!allowed) {
      violations.push(`etichetă nepermisă: ${name}`);
      continue;
    }
    if (closing) {
      if (attributes.trim() !== "") violations.push(`atribute pe o etichetă de închidere: ${name}`);
      continue;
    }
    const seen = new Map<string, string>();
    for (const attribute of attributes.matchAll(ATTRIBUTE)) {
      const key = (attribute[1] as string).toLowerCase();
      const value = (attribute[2] as string).replaceAll("&amp;", "&");
      if (!allowed.includes(key)) violations.push(`atribut nepermis: ${name}[${key}]`);
      if (seen.has(key)) violations.push(`atribut repetat: ${name}[${key}]`);
      seen.set(key, value);
      if (key === "href" && (!SAFE_HREF.test(value) || SPACE_OR_CONTROL.test(value)))
        violations.push(`href nesigur: ${value.slice(0, 40)}`);
      if (key === "data-media-id" && !MEDIA_ID_PATTERN.test(value))
        violations.push(`id media nesigur: ${value.slice(0, 40)}`);
      if ((key === "colspan" || key === "rowspan") && !SPAN_PATTERN.test(value))
        violations.push(`${key} nesigur: ${value.slice(0, 10)}`);
      if (key === "target" && value !== "_blank") violations.push(`target nepermis: ${value}`);
      if (key === "rel" && value !== EXTERNAL_REL) violations.push(`rel nepermis: ${value}`);
    }
    if (name === "a" && /^https?:/i.test(seen.get("href") ?? "")) {
      if (seen.get("target") !== "_blank" || seen.get("rel") !== EXTERNAL_REL)
        violations.push("link extern fără target=_blank și rel=noopener noreferrer");
    }
    if (name === "img" && !seen.has("data-media-id")) violations.push("img fără data-media-id");
  }
  text += html.slice(last);
  if (/[<>]/.test(text)) violations.push("«<» sau «>» neescapat în text");
  return violations;
}

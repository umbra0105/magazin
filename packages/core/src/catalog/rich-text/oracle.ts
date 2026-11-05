/**
 * ORACOL INDEPENDENT pentru testele sanitizatorului de descrieri (15c): verifică forma ieșirii fără să
 * importe nimic din implementare. Lista albă de mai jos e scrisă a doua oară, intenționat: dacă
 * implementarea și oracolul ar împărți aceeași listă, o greșeală din ea ar trece nevăzută în ambele.
 *
 * Ieșirea unui sanitizator corect are exact această formă: etichete din lista albă, atribute din lista albă,
 * ghilimele duble, niciun «<» sau «>» în text (sunt escapate) și linkuri doar cu scheme sigure.
 */

export const ORACLE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
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

const TAG = /<(\/?)([a-z][a-z0-9]*)((?:\s+[a-z][a-z-]*="[^"<>]*")*)\s*(\/?)>/gi;
const ATTRIBUTE = /\s+([a-z][a-z-]*)="([^"<>]*)"/gi;
const SAFE_HREF = /^(?:https?:\/\/[^\s"<>]+|mailto:[^\s"<>]+|tel:[^\s"<>]+|\/(?!\/)[^\s"<>]*)$/i;
// caractere de control (inclusiv tab și linie nouă), scrise prin cod ca fișierul să rămână text curat
const CONTROL_OR_SPACE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(32)}${String.fromCharCode(127)}]`,
);

/** Lista încălcărilor găsite în `html` (goală = ieșire curată). */
export function oracleViolations(html: string): string[] {
  const violations: string[] = [];
  let rest = "";
  let last = 0;
  for (const match of html.matchAll(TAG)) {
    rest += html.slice(last, match.index);
    last = (match.index ?? 0) + match[0].length;
    const closing = match[1] === "/";
    const name = (match[2] as string).toLowerCase();
    const attributes = match[3] ?? "";
    const allowed = ORACLE_ATTRIBUTES[name];
    if (!allowed) {
      violations.push(`etichetă nepermisă: ${name}`);
      continue;
    }
    if (closing) {
      if (attributes.trim() !== "") violations.push(`atribute pe o etichetă de închidere: ${name}`);
      continue;
    }
    const seen = new Set<string>();
    for (const attribute of attributes.matchAll(ATTRIBUTE)) {
      const key = (attribute[1] as string).toLowerCase();
      const value = (attribute[2] as string).replaceAll("&amp;", "&");
      if (!allowed.includes(key)) violations.push(`atribut nepermis: ${name}[${key}]`);
      if (seen.has(key)) violations.push(`atribut repetat: ${name}[${key}]`);
      seen.add(key);
      if (key === "href" && (!SAFE_HREF.test(value) || CONTROL_OR_SPACE.test(value)))
        violations.push(`href nesigur: ${value.slice(0, 40)}`);
      if (key === "data-media-id" && !/^[A-Za-z0-9_-]{8,40}$/.test(value))
        violations.push(`id media nesigur: ${value.slice(0, 40)}`);
      if ((key === "colspan" || key === "rowspan") && !/^(?:[1-9]|1\d|20)$/.test(value))
        violations.push(`${key} nesigur: ${value.slice(0, 10)}`);
      if (key === "target" && value !== "_blank") violations.push(`target nepermis: ${value}`);
      if (key === "rel" && value !== "noopener noreferrer")
        violations.push(`rel nepermis: ${value}`);
    }
    if (
      name === "a" &&
      /^https?:/i.test((/href="([^"]*)"/i.exec(attributes)?.[1] ?? "").replaceAll("&amp;", "&"))
    ) {
      if (!/target="_blank"/.test(attributes) || !/rel="noopener noreferrer"/.test(attributes))
        violations.push("link extern fără target=_blank și rel=noopener noreferrer");
    }
    if (name === "img" && !seen.has("data-media-id")) violations.push("img fără data-media-id");
  }
  rest += html.slice(last);
  if (/[<>]/.test(rest)) violations.push("«<» sau «>» neescapat în text");
  return violations;
}

/**
 * Adresa unui link din editorul descrierii (15c). Aceeași regulă ca la server (`classifyHref` din `@ecom/core`: doar
 * http/https, mailto, tel și căi interne «/…»; fără spații sau caractere de control), copiată aici pentru că `@ecom/core`
 * nu poate intra într-un pachet de browser; un test compară cele două. Serverul rămâne sursa de adevăr: la salvare
 * oricum refiltrează fiecare link și impune `target`/`rel`.
 *
 * O adresă fără schemă care arată a domeniu («exemplu.ro/fisa») primește `https://`.
 */

const FORBIDDEN_IN_URL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(32)}${String.fromCharCode(127)}-${String.fromCharCode(159)}${[
    0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x2060, 0xfeff,
  ]
    .map((code) => String.fromCharCode(code))
    .join("")}]`,
);

const INTERNAL_PATH = /^\/(?![/\\])[^\s\\]*$/;
const MAILTO = /^mailto:[^\s<>"'\\]+$/i;
const TEL = /^tel:\+?[0-9().\-;,#*]+$/i;
const DOMAIN_LIKE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:[/?#].*)?$/i;
const MAX_LENGTH = 2048;

export function normalizeEditorHref(raw: string): string | null {
  const value = raw.trim();
  if (value === "" || value.length > MAX_LENGTH || FORBIDDEN_IN_URL.test(value)) return null;
  if (INTERNAL_PATH.test(value)) return value;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  if (scheme === undefined) {
    // fără schemă: doar ceva care arată a domeniu primește https://
    return DOMAIN_LIKE.test(value) ? validHttp(`https://${value}`) : null;
  }
  if (scheme === "mailto") return MAILTO.test(value) ? value : null;
  if (scheme === "tel") return TEL.test(value) ? value : null;
  if (scheme === "http" || scheme === "https") return validHttp(value);
  return null;
}

function validHttp(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return value;
}

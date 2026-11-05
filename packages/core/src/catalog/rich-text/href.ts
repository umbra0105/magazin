import { ALLOWED_SCHEMES } from "./rules";

export interface ClassifiedHref {
  value: string;
  /** Link spre alt site (http/https): se deschide într-o filă nouă, cu `rel="noopener noreferrer"`. */
  external: boolean;
}

/** Spații, caractere de control, spații de lățime zero și separatori Unicode: niciunul nu are loc într-un URL. */
const FORBIDDEN_IN_URL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(32)}${String.fromCharCode(127)}-${String.fromCharCode(159)}${[
    0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x2060, 0xfeff,
  ]
    .map((code) => String.fromCharCode(code))
    .join("")}]`,
);

const MAILTO = /^mailto:[^\s<>"'\\]+$/i;
const TEL = /^tel:\+?[0-9().\-;,#*]+$/i;
/** Cale internă: începe cu UN «/», nu cu «//» (relativ la protocol) și nu cu «/\». */
const INTERNAL_PATH = /^\/(?![/\\])[^\s\\]*$/;

/**
 * Decide dacă o valoare de `href` e acceptabilă și ce fel de link e. Permise: http/https (extern), mailto, tel și
 * căi interne care încep cu «/». Orice altceva (javascript:, data:, vbscript:, file:, blob:, //gazdă, căi relative,
 * ancore, gol, valori cu spații sau caractere de control) → `null`, iar linkul rămâne doar text.
 * Valoarea ajunge aici deja decodată din entități de parser, deci «java&#x09;script:» a devenit «java<TAB>script:».
 */
export function classifyHref(raw: string | undefined): ClassifiedHref | null {
  if (raw === undefined) return null;
  const value = raw.trim();
  if (value === "" || value.length > 2048 || FORBIDDEN_IN_URL.test(value)) return null;
  if (INTERNAL_PATH.test(value)) return { value, external: false };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  if (scheme === undefined || !(ALLOWED_SCHEMES as readonly string[]).includes(scheme)) return null;
  if (scheme === "mailto") return MAILTO.test(value) ? { value, external: false } : null;
  if (scheme === "tel") return TEL.test(value) ? { value, external: false } : null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") return null;
  } catch {
    return null;
  }
  return { value, external: true };
}

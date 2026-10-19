import { domainToASCII } from "node:url";

/**
 * Numele de gazdă normalizat al unei adrese de imagine: litere mici, fără punct final, IDNA/punycode.
 * Returnează `null` dacă nu e un nume de domeniu valid pentru lista de domenii permise sau pentru o
 * adresă de descărcat. Un IP (v4 în orice formă, v6) NU e un nume de domeniu: ultima etichetă a unui
 * nume are cel puțin o literă (TLD), iar un IP literal nu are, deci nu trece niciodată.
 *
 * Fără dependențe: se folosește și din registrul setărilor (validarea listei de domenii).
 */

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Simboluri care nu apar într-un nume de gazdă: cale, port, utilizator, wildcard, procent, paranteze. */
const FORBIDDEN_SYMBOLS = "/\\:@*?#%[]";

/** Spații, caractere de control (inclusiv Unicode) sau unul dintre simbolurile de mai sus. */
function hasForbiddenChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if (/\s/u.test(char) || FORBIDDEN_SYMBOLS.includes(char)) return true;
  }
  return false;
}

export function normalizeHostname(raw: string): string | null {
  const trimmed = raw.trim();
  // spații, caractere de control, scheme, porturi, căi, wildcard, utilizator: nu sunt nume de gazdă
  if (trimmed === "" || trimmed.length > 253 || hasForbiddenChar(trimmed)) {
    return null;
  }
  const withoutDot = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  const ascii = domainToASCII(withoutDot.toLowerCase());
  if (ascii === "" || ascii.length > 253) return null;
  const labels = ascii.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((label) => LABEL.test(label))) return null;
  if (!TLD.test(labels[labels.length - 1] as string)) return null;
  return ascii;
}

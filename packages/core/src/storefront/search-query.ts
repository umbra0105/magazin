/**
 * Interogarea de căutare (Faza 7): text liber din bara de căutare → forme sigure pentru Postgres FTS și pg_trgm. Funcții pure.
 * Textul se aduce la litere mici, fără diacritice (ă→a, ș→s…), ca la indexuri (`f_unaccent(lower(…))`); în `tsquery` intră doar
 * cuvinte formate din litere și cifre ASCII, deci nimic din textul vizitatorului nu poate schimba structura interogării.
 */

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 80;
const MAX_TOKENS = 8;

/** Litere mici, fără diacritice, spații normalizate, tăiat la lungimea maximă. */
export function normalizeSearchText(input: string): string {
  return (
    input
      // caracterele de control (inclusiv NUL, pe care Postgres îl respinge) nu au ce căuta într-o interogare
      .replace(/p{Cc}/gu, " ")
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[șş]/g, "s")
      .replace(/[țţ]/g, "t")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, SEARCH_MAX_LENGTH)
  );
}

/** Cuvintele de căutat: doar [a-z0-9], cel mult 8, fără duplicate. */
export function searchTokens(input: string): string[] {
  const words = normalizeSearchText(input)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  return [...new Set(words)].slice(0, MAX_TOKENS);
}

/** `tsquery` cu prefix pe fiecare cuvânt («pompa cal» → `pompa:* & cal:*`); gol dacă nu există niciun cuvânt. */
export function toPrefixTsQuery(input: string): string {
  return searchTokens(input)
    .map((word) => `${word}:*`)
    .join(" & ");
}

/** Interogarea e destul de lungă ca să fie căutată (evită sute de rezultate la o singură literă). */
export function isSearchable(input: string): boolean {
  return normalizeSearchText(input).length >= SEARCH_MIN_LENGTH && searchTokens(input).length > 0;
}

/** Textul pentru potrivire aproximativă (trigrame) și pentru început de cod: normalizat, fără caractere speciale de LIKE. */
export function likePrefix(input: string): string {
  return normalizeSearchText(input).replace(/[\\%_]/g, "");
}

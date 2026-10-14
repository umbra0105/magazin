import { DomainError } from "@ecom/shared";

/**
 * Adrese (slug-uri) de produs: litere mici, cifre și `-`, fără diacritice. Unicitatea e pe TOATE
 * produsele, inclusiv cele șterse (soft delete): o adresă a unui produs șters nu se refolosește, ca o
 * restaurare sau o redirecționare 301 să nu aterizeze pe alt produs. Indexul din bază
 * (`product_slug_key`, fără diferență de majuscule) impune același lucru.
 */

export const SLUG_MAX_LENGTH = 80;
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const DIACRITICS: Readonly<Record<string, string>> = {
  ă: "a",
  â: "a",
  î: "i",
  ș: "s",
  ş: "s",
  ț: "t",
  ţ: "t",
  é: "e",
  è: "e",
  ö: "o",
  ü: "u",
  ä: "a",
  ß: "ss",
};

/** „Pompă de căldură 12kW” → `pompa-de-caldura-12kw`. Șir fără litere/cifre → `produs`. */
export function slugify(text: string, fallback = "produs"): string {
  const folded = text
    .toLowerCase()
    .replace(/[ăâîșşțţéèöüäß]/g, (c) => DIACRITICS[c] ?? c)
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  const slug = folded
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  return slug === "" ? fallback : slug;
}

export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(slug);
}

/**
 * Prima adresă liberă pornind de la `base`: `base`, `base-2`, `base-3`... `isTaken` trebuie să
 * includă produsele șterse. Limita de încercări oprește o buclă la un `isTaken` defect.
 */
export async function generateUniqueSlug(
  base: string,
  isTaken: (slug: string) => Promise<boolean>,
  maxAttempts = 1000,
): Promise<string> {
  const root = slugify(base);
  for (let n = 1; n <= maxAttempts; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const candidate = `${root.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new DomainError(
    "CATALOG_SLUG_EXHAUSTED",
    "Nu am găsit o adresă liberă pentru acest titlu; alege manual o adresă",
  );
}

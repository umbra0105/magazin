import { ValidationError } from "@ecom/shared";

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 30;
export const MAX_ALT_LENGTH = 300;

/**
 * Tagurile se păstrează în litere mici, fără spații la capete, fără dubluri, cu litere (inclusiv
 * diacritice), cifre, spațiu, `-` și `_`. Căutarea după tag e exactă pe forma normalizată.
 */
export function normalizeTags(input: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of input) {
    const tag = raw.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
    if (tag === "") continue;
    if (tag.length > MAX_TAG_LENGTH) {
      throw new ValidationError(`Un tag poate avea cel mult ${MAX_TAG_LENGTH} de caractere`);
    }
    if (!/^[\p{L}\p{N} _-]+$/u.test(tag)) {
      throw new ValidationError("Tagurile pot conține doar litere, cifre, spațiu, - și _");
    }
    seen.add(tag);
  }
  if (seen.size > MAX_TAGS) {
    throw new ValidationError(`Cel mult ${MAX_TAGS} de taguri pe fișier`);
  }
  return [...seen];
}

export function normalizeAlt(alt: string): string {
  const value = alt.normalize("NFC").replace(/\s+/g, " ").trim();
  if (value.length > MAX_ALT_LENGTH) {
    throw new ValidationError(
      `Textul alternativ poate avea cel mult ${MAX_ALT_LENGTH} de caractere`,
    );
  }
  return value;
}

const FOLDER_NAME_MAX = 60;

export function normalizeFolderName(name: string): string {
  const value = name.normalize("NFC").replace(/\s+/g, " ").trim();
  if (value === "" || value.length > FOLDER_NAME_MAX) {
    throw new ValidationError(
      `Numele folderului trebuie să aibă între 1 și ${FOLDER_NAME_MAX} de caractere`,
    );
  }
  // eslint-disable-next-line no-control-regex -- scoatem caracterele de control din nume
  if (/[\u0000-\u001f\u007f/\\]/.test(value)) {
    throw new ValidationError("Numele folderului nu poate conține / \\ sau caractere de control");
  }
  return value;
}

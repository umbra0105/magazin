/**
 * Numele din SIRUTA: normalizarea diacriticelor (ș/ț cu virgulă dedesubt, nu sedilă) și numele de AFIȘARE.
 *
 * Numele normalizat (majuscule, cum vine din registru, cu diacriticele corectate) se păstrează pentru căutare și potrivire;
 * numele de afișare se calculează separat, aici, și nu se stochează ca sursă de adevăr.
 */

/** ş/Ş (sedilă, U+015F/U+015E) și ţ/Ţ (U+0163/U+0162) → ș/Ș (U+0219/U+0218) și ț/Ț (U+021B/U+021A); rezultatul e NFC. */
export function normalizeDiacritics(value: string): string {
  return value
    .normalize("NFC")
    .replace(/ş/g, "ș")
    .replace(/Ş/g, "Ș")
    .replace(/ţ/g, "ț")
    .replace(/Ţ/g, "Ț")
    .replace(/ş/g, "ș")
    .replace(/Ş/g, "Ș")
    .replace(/ţ/g, "ț")
    .replace(/Ţ/g, "Ț")
    .replace(/ș/g, "ș")
    .replace(/Ș/g, "Ș")
    .replace(/ț/g, "ț")
    .replace(/Ț/g, "Ț");
}

/** Cuvinte de legătură care rămân cu litere mici în mijlocul unui nume (primul cuvânt are mereu inițială mare). */
const SMALL_WORDS: ReadonlySet<string> = new Set([
  "de",
  "din",
  "la",
  "lui",
  "cel",
  "cea",
  "cu",
  "pe",
  "sub",
  "peste",
  "după",
  "între",
  "în",
  "și",
]);

/** Caracterele după care începe un cuvânt nou. */
const BOUNDARY = /[\s\-/(.]/;

/**
 * Nume de afișare: litere mici, inițiala mare la fiecare cuvânt (după spațiu, cratimă, punct, paranteză), cu cuvintele de
 * legătură mici în mijloc. Ex.: «SFÂNTU GHEORGHE» → «Sfântu Gheorghe», «TÂRGU-MUREȘ» → «Târgu-Mureș», «VALEA LUI MIHAI» →
 * «Valea lui Mihai». Primește numele deja normalizat (diacritice).
 */
export function displayName(normalized: string): string {
  const lower = normalized.toLocaleLowerCase("ro-RO");
  let result = "";
  let word = "";
  let first = true;
  const flush = () => {
    if (word === "") return;
    const small = !first && SMALL_WORDS.has(word);
    result += small ? word : word.charAt(0).toLocaleUpperCase("ro-RO") + word.slice(1);
    first = false;
    word = "";
  };
  for (const ch of lower) {
    if (BOUNDARY.test(ch)) {
      flush();
      result += ch;
    } else {
      word += ch;
    }
  }
  flush();
  return result;
}

const COUNTY_PREFIX = /^(JUDEȚUL|MUNICIPIUL)\s+/u;

/** Numele județului pentru liste: fără «Județul» / «Municipiul» (SIRUTA: «JUDEȚUL ALBA», «MUNICIPIUL BUCUREȘTI»). */
export function countyDisplayName(normalized: string): string {
  return displayName(normalized.replace(COUNTY_PREFIX, ""));
}

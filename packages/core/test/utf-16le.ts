/**
 * Ajutoare de test pentru fișiere UTF-16LE (formatul pe care îl scrie aplicația pentru Excel și pe care îl
 * salvează Excel ca «Unicode Text»). Independente de codul de producție: se folosesc `Buffer` și
 * `TextDecoder`, nu funcția din `import-csv.ts`, ca testele să nu repete o eroare a ei.
 */

const BOM = String.fromCharCode(0xfeff);

/** Text → octeți UTF-16LE, cu BOM `FF FE` în față (sau fără, dacă `bom` e false). */
export function encodeUtf16le(text: string, bom = true): Uint8Array {
  return new Uint8Array(Buffer.from(`${bom ? BOM : ""}${text}`, "utf16le"));
}

/** Octeți UTF-16LE → text, FĂRĂ să scoată BOM-ul (testele îl verifică separat, pe octeți). */
export function decodeUtf16le(bytes: Uint8Array): string {
  return new TextDecoder("utf-16le", { ignoreBOM: true, fatal: true }).decode(bytes);
}

/** Primii `count` octeți ca vector de numere, pentru comparații în teste. */
export const head = (bytes: Uint8Array, count: number): number[] => [...bytes.subarray(0, count)];

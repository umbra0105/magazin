/**
 * Numele unităților de măsură din contul furnizorului de facturare, ca text editabil: o pereche pe rând, «simbol = nume» (de
 * exemplu «mp = mp»). Funcții pure, folosite de formular (afișare) și de acțiunea de salvare (validare).
 */

/** Perechile din text; `null` dacă un rând nu are forma «simbol = nume» (ambele nevide, cel mult 40 de caractere). */
export function parseUnitNames(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const at = trimmed.indexOf("=");
    if (at < 1) return null;
    const key = trimmed.slice(0, at).trim();
    const value = trimmed.slice(at + 1).trim();
    if (key === "" || value === "" || key.length > 40 || value.length > 40) return null;
    out[key] = value;
  }
  return out;
}

/** Textul din formular pentru perechile salvate, în ordine alfabetică. */
export function formatUnitNames(names: Readonly<Record<string, string>>): string {
  return Object.keys(names)
    .sort()
    .map((key) => `${key} = ${names[key]}`)
    .join("\n");
}

/**
 * Extragerea TVA-ului dintr-un preț brut (cu TVA inclus), în bani, fără `float` în sume.
 *
 * Prețurile se stochează BRUTE; ce tastează adminul e ce vede clientul, iar TVA-ul se EXTRAGE din brut
 * (pentru factură și pentru previzualizarea din admin). Cota vine din setarea `tax.standardRate`
 * (procente, ex. `21`); niciodată hardcodată. Funcțiile sunt pure și rotunjesc o singură dată, la bani.
 */

/** Cota în puncte de bază din procente: `21` → `2100`, `5.5` → `550`. */
export function percentToBasisPoints(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0) {
    throw new RangeError("Cota de TVA trebuie să fie un număr ≥ 0");
  }
  return Math.round(percent * 100);
}

function assertMoney(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} trebuie să fie un număr întreg de bani, ≥ 0`);
  }
}

/** Valoarea fără TVA dintr-un preț brut: `brut / (1 + cotă)`, rotunjită la bani. */
export function netFromGross(grossMinor: number, rateBasisPoints: number): number {
  assertMoney(grossMinor, "Prețul brut");
  assertMoney(rateBasisPoints, "Cota de TVA (puncte de bază)");
  return Math.round((grossMinor * 10_000) / (10_000 + rateBasisPoints));
}

/** TVA-ul inclus într-un preț brut: diferența dintre brut și net (suma lor dă exact brutul). */
export function vatFromGross(grossMinor: number, rateBasisPoints: number): number {
  return grossMinor - netFromGross(grossMinor, rateBasisPoints);
}

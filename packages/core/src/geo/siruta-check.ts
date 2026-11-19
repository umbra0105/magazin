/**
 * Cifra de control a codului SIRUTA.
 *
 * Sursa algoritmului: INS, «Metodologie» SIRUTA (https://insse.ro/cms/files/siruta/2026/Metodologie.doc), secțiunea despre codul
 * de identificare SIRUTA: codul are 6 cifre, primele 5 sunt «numărul unic al unității», a 6-a e cifra de control. Ponderile sunt
 * 7, 5, 3, 2, 1, aplicate de la stânga la dreapta pe cele 5 cifre; produsele se adună CIFRĂ CU CIFRĂ (35 contează 3+5); restul
 * sumei la 10 se scade din 11, iar restul acelui rezultat la 10 e cifra de control. Exemplul din metodologie: 179132 → 17913 →
 * 7, 35, 27, 2, 3 → 7+8+9+2+3 = 29 → rest 9 → 11−9 = 2 → cifra 2.
 *
 * Codurile din fișierul INS vin fără zerouri la stânga (județul Alba e «10»): se completează la 6 cifre.
 * Metodologia nu spune ce se întâmplă la restul 0 (11 − 0 = 11); se aplică literal «restul la 10», deci cifra 1, iar datele
 * INS confirmă (1.685 din 1.693 de coduri cu rest 0 din semestrul 1 din 2026 respectă regula). Nu se inventează alt tratament.
 */

const WEIGHTS = [7, 5, 3, 2, 1] as const;
const MAX_CODE = 999_999;

/** Cifra de control a «numărului unic» (primele 5 cifre ale codului, ca întreg 0–99999). */
export function sirutaCheckDigit(uniqueNumber: number): number {
  if (!Number.isInteger(uniqueNumber) || uniqueNumber < 0 || uniqueNumber > 99_999) {
    throw new RangeError("Numărul unic SIRUTA trebuie să fie un întreg între 0 și 99999");
  }
  const digits = String(uniqueNumber).padStart(5, "0");
  let sum = 0;
  for (let i = 0; i < WEIGHTS.length; i++) {
    const product = Number(digits[i]) * (WEIGHTS[i] as number);
    sum += Math.floor(product / 10) + (product % 10);
  }
  return (11 - (sum % 10)) % 10;
}

/** Codul întreg (6 cifre, cu cifra de control la sfârșit) respectă algoritmul oficial? */
export function hasValidSirutaCheckDigit(code: number): boolean {
  if (!Number.isInteger(code) || code < 1 || code > MAX_CODE) return false;
  return sirutaCheckDigit(Math.floor(code / 10)) === code % 10;
}

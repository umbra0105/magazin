/**
 * Poziția unui hotspot pe imagine: puncte de bază (0–10000, ca procent ×100) ↔ procente cu cel mult
 * 2 zecimale, fără `float`. 12,34% = 1234 puncte de bază exact; „12,345” (3 zecimale) nu se acceptă,
 * ca valoarea salvată să fie exact cea tastată.
 */

export const BASIS_POINTS_MAX = 10_000;

/** „12,34”, „12.5”, „100”, „0” → 1234, 1250, 10000, 0; `null` dacă nu e valid sau iese din 0–100. */
export function percentToBasisPoints(input: string): number | null {
  const cleaned = input.trim().replace(/\s+/g, "").replace(/%$/, "");
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const bp = whole * 100 + fraction;
  return bp >= 0 && bp <= BASIS_POINTS_MAX ? bp : null;
}

/** 1234 → „12,34”; 1250 → „12,5”; 10000 → „100”; 0 → „0”. */
export function basisPointsToPercent(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const fraction = String(bp % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return fraction === "" ? String(whole) : `${whole},${fraction}`;
}

/** Mută o poziție cu `deltaBp`, rămânând în 0–10000. */
export function clampBasisPoints(bp: number, deltaBp: number): number {
  return Math.min(BASIS_POINTS_MAX, Math.max(0, bp + deltaBp));
}

/** Poziția unui click pe imagine (coordonate în pixeli față de colț) → puncte de bază rotunjite. */
export function pixelsToBasisPoints(offset: number, size: number): number {
  if (!(size > 0)) return 0;
  return Math.min(BASIS_POINTS_MAX, Math.max(0, Math.round((offset / size) * BASIS_POINTS_MAX)));
}

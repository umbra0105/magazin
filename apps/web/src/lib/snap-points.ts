/**
 * Valoarea cerută de câmpul de puncte, adusă la ce se poate folosi: 0 sau cel puțin minimul. Sub minim, urcând se sare la
 * minim, iar coborând se sare la 0 (altfel de la tastatură nu s-ar putea ieși din minim).
 */
export function snapPoints(raw: number, previous: number, min: number, max: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (raw < min) return raw < previous ? 0 : min;
  return Math.min(Math.floor(raw), max);
}

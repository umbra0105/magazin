/**
 * Unitatea de măsură efectivă a unei variante: a ei, altfel a produsului, altfel unitatea implicită («buc»).
 * O unitate nulă și «buc» sunt IDENTICE: acesta e singurul loc unde se rezolvă moștenirea.
 */
export function effectiveMeasureUnit<T>(
  variantUnit: T | null | undefined,
  productUnit: T | null | undefined,
  defaultUnit: T,
): T {
  return variantUnit ?? productUnit ?? defaultUnit;
}

/**
 * Două unități (id-uri, posibil nule) sunt aceeași unitate? Nulă = unitatea implicită, deci `null` și id-ul lui «buc»
 * sunt egale (ex.: o sumă de stoc pe produs se face doar dacă variantele au aceeași unitate).
 */
export function sameMeasureUnit(
  a: string | null | undefined,
  b: string | null | undefined,
  defaultUnitId: string,
): boolean {
  return (a ?? defaultUnitId) === (b ?? defaultUnitId);
}

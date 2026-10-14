/** Un preț public brut (int, în bani) în vigoare de la `effectiveFrom` încolo. */
export interface PricePoint {
  price: number;
  effectiveFrom: Date;
}

export const OMNIBUS_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * „Cel mai mic preț practicat în ultimele 30 de zile” (Directiva Omnibus), pentru afișarea unei reduceri.
 *
 * Fereastra e `[until - days, until)`: `until` e momentul de la care se aplică reducerea anunțată (nu
 * „acum”, altfel prețul redus ar deveni propria referință). Intră în calcul prețul în vigoare la
 * începutul ferestrei (ultimul punct cu `effectiveFrom <= început`) și toate schimbările din interiorul
 * ferestrei. Un punct cu `effectiveFrom >= until` nu intră. Returnează `null` dacă nu există niciun
 * preț cunoscut în fereastră (de ex. produs nou, fără istoric): afișarea reducerii cere atunci
 * decizia comercială a magazinului, nu o valoare inventată.
 */
export function lowestPriceInWindow(
  history: readonly PricePoint[],
  options: { until: Date; days?: number },
): number | null {
  const days = options.days ?? OMNIBUS_WINDOW_DAYS;
  if (!Number.isInteger(days) || days <= 0) {
    throw new RangeError("Fereastra Omnibus trebuie să fie un număr întreg pozitiv de zile");
  }
  const untilMs = options.until.getTime();
  const startMs = untilMs - days * DAY_MS;

  let inEffectAtStart: PricePoint | undefined;
  let lowest: number | null = null;
  for (const point of history) {
    if (!Number.isInteger(point.price) || point.price < 0) {
      throw new RangeError("Prețurile din istoric sunt întregi nenegative, în bani");
    }
    const from = point.effectiveFrom.getTime();
    if (from >= untilMs) continue;
    if (from <= startMs) {
      if (!inEffectAtStart || from > inEffectAtStart.effectiveFrom.getTime()) {
        inEffectAtStart = point;
      }
      continue;
    }
    lowest = lowest === null ? point.price : Math.min(lowest, point.price);
  }
  if (inEffectAtStart) {
    lowest = lowest === null ? inEffectAtStart.price : Math.min(lowest, inEffectAtStart.price);
  }
  return lowest;
}

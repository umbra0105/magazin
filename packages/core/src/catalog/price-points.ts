import { effectivePrice, type PriceWindow } from "./catalog-support";
import type { PricePoint } from "./price-history";

/**
 * Istoricul de preț pentru Omnibus (C-18, Faza 7): ce puncte noi trebuie scrise în `PriceHistory` pentru o variantă, între ultimul
 * punct cunoscut și momentul rulării. Funcție PURĂ (fără bază de date, fără ceas propriu).
 *
 * Reguli:
 * - se înregistrează DOAR ce s-a observat: la prima observație un singur punct, la momentul rulării, fără istoric inventat înapoi
 *   (de la ce dată curge perioada de 30 de zile pentru produsele migrate e o decizie legală deschisă, `docs/INTREBARI-AVOCAT.md` §2.3);
 * - tranzițiile programate (`saleStartsAt`, `saleEndsAt`) dintre două rulări se scriu la momentul LOR exact, nu la cel al rulării,
 *   ca „cel mai mic preț din 30 de zile” să nu depindă de ora la care a rulat jobul;
 * - începutul promoției e inclusiv, sfârșitul e exclusiv (aceeași regulă ca `effectivePrice`); capătul superior al intervalului
 *   analizat (momentul rulării) e inclusiv, cel inferior (ultimul punct) e exclusiv;
 * - un punct se scrie doar când prețul efectiv diferă de precedentul (idempotent: o a doua rulare nu scrie nimic).
 */

export type PriceWindowVariant = PriceWindow;

export function planPricePoints(
  variant: PriceWindowVariant,
  last: PricePoint | null,
  now: Date,
): PricePoint[] {
  if (last === null) return [{ price: effectivePrice(variant, now), effectiveFrom: now }];

  const lastMs = last.effectiveFrom.getTime();
  const nowMs = now.getTime();
  const transitions = [variant.saleStartsAt, variant.saleEndsAt]
    .filter((moment): moment is Date => moment !== null)
    .filter((moment) => moment.getTime() > lastMs && moment.getTime() <= nowMs)
    .sort((a, b) => a.getTime() - b.getTime());

  const points: PricePoint[] = [];
  let previous = last.price;
  for (const moment of [...transitions, now]) {
    if (moment.getTime() <= lastMs) continue;
    const price = effectivePrice(variant, moment);
    if (price === previous) continue;
    points.push({ price, effectiveFrom: moment });
    previous = price;
  }
  return points;
}

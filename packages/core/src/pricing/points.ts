import { ValidationError, allocateMinor, netFromGross } from "@ecom/shared";
import type { PricedLine, PricingResult } from "./engine";

/**
 * Punctele de loialitate în motorul de prețuri (Faza 15b). Funcții PURE, în bani întregi (`bigint` la împărțiri), fără virgulă
 * mobilă. Punctele sunt ULTIMA reducere din lanț și ating DOAR produsele.
 *
 *  - Câte se pot folosi (decizia 2026-11-26): `min(produse după reduceri, total comandă − max(transport, minim în bani))`, unde
 *    totalul include transportul și NU include taxa de ramburs; plus plafonul procentual pe produse, dacă e setat (câștigă cel mai
 *    restrictiv). Așa suma în bani e mereu cel puțin `max(transport, minim)`: comanda de 0 lei nu poate apărea.
 *  - Repartizarea pe linii: reducerea (puncte × valoarea punctului) se împarte în BANI, proporțional cu totalul fiecărei linii,
 *    cu metoda restului cel mai mare (`allocateMinor`, aceeași ca la cupoanele cu sumă fixă); egalitatea o decide ordinea liniilor.
 *    Totalul liniei și TVA-ul ei rămân cele dinaintea punctelor; reducerea e un rând separat, cu TVA-ul extras din brutul EI
 *    (decizia 2026-11-26: TVA produs − TVA reducere, pe fiecare rând de factură).
 *  - Retur: partea de reducere a bucăților returnate se ia cumulat (în jos), ultima bucată ia restul exact; punctele întoarse =
 *    reducerea cumulată pe toată comanda / valoarea punctului, în jos; când s-a întors toată reducerea, se întorc toate punctele.
 *  - Acumulare: `floor(bani plătiți pe produse / rată)`.
 */

export interface RedeemRules {
  /** Cât valorează un punct, în bani. */
  pointValueMinor: number;
  /** Minimul de plătit în bani când transportul e mai mic (regula dură). */
  minCashMinor: number;
  /** Plafon procentual din valoarea produselor; `null` = fără plafon. */
  maxRedeemPercent: number | null;
  /** Sub acest număr de puncte nu se poate folosi nimic. */
  minRedeemPoints: number;
}

function assertAmount(value: number, label: string, min = 0): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new ValidationError(`${label} trebuie să fie un număr întreg, cel puțin ${min}.`);
  }
}

const smaller = (a: bigint, b: bigint): bigint => (a < b ? a : b);

export function maxRedeemablePoints(input: {
  productsMinor: number;
  shippingMinor: number;
  /** Punctele care se pot cheltui acum (sold fără loturile expirate). */
  balancePoints: number;
  rules: RedeemRules;
}): number {
  const { rules } = input;
  assertAmount(input.productsMinor, "Valoarea produselor");
  assertAmount(input.shippingMinor, "Transportul");
  assertAmount(rules.pointValueMinor, "Valoarea punctului", 1);
  assertAmount(rules.minCashMinor, "Minimul în bani", 1);
  assertAmount(rules.minRedeemPoints, "Minimul de puncte", 1);
  if (!Number.isSafeInteger(input.balancePoints) || input.balancePoints <= 0) return 0;

  const products = BigInt(input.productsMinor);
  const shipping = BigInt(input.shippingMinor);
  const minCash = BigInt(rules.minCashMinor);
  const cashFloor = shipping > minCash ? shipping : minCash;
  let cap = smaller(products, products + shipping - cashFloor);
  if (rules.maxRedeemPercent !== null) {
    assertAmount(rules.maxRedeemPercent, "Plafonul procentual", 1);
    cap = smaller(cap, (products * BigInt(rules.maxRedeemPercent)) / 100n);
  }
  if (cap <= 0n) return 0;
  const points = smaller(cap / BigInt(rules.pointValueMinor), BigInt(input.balancePoints));
  return points < BigInt(rules.minRedeemPoints) ? 0 : Number(points);
}

/**
 * Ultimul pas al lanțului de prețuri: pune reducerea din puncte pe liniile deja calculate. Cu 0 întoarce rezultatul neschimbat.
 */
export function applyPointsDiscount(result: PricingResult, discountMinor: number): PricingResult {
  assertAmount(discountMinor, "Reducerea din puncte");
  if (discountMinor === 0) return result;
  if (discountMinor > result.totals.totalMinor) {
    throw new ValidationError("Reducerea din puncte depășește valoarea produselor.");
  }
  const parts = allocateMinor(
    BigInt(discountMinor),
    result.lines.map((line) => BigInt(line.totalMinor)),
  );
  const lines: PricedLine[] = result.lines.map((line, index) => {
    const share = Number(parts[index] as bigint);
    return Object.freeze({
      ...line,
      pointsDiscountMinor: share,
      pointsDiscountVatMinor: share - netFromGross(share, line.taxRateBps),
    });
  });
  return Object.freeze({
    ...result,
    lines: Object.freeze(lines),
    totals: Object.freeze({
      ...result.totals,
      pointsDiscountMinor: discountMinor,
      pointsDiscountVatMinor: lines.reduce((sum, l) => sum + (l.pointsDiscountVatMinor ?? 0), 0),
    }),
    pointsDiscountMinor: discountMinor,
  });
}

/** Partea de reducere din puncte a bucăților returnate acum dintr-o linie (cumulat, în jos; ultima bucată ia restul). */
export function discountShareForReturn(input: {
  lineDiscountMinor: number;
  /** Valoarea liniei dinaintea punctelor. */
  lineGrossMinor: number;
  /** Brutul deja returnat din linie, prin retururi încheiate. */
  grossBeforeMinor: number;
  /** Brutul returnat acum. */
  grossNowMinor: number;
}): number {
  assertAmount(input.lineDiscountMinor, "Reducerea liniei");
  assertAmount(input.lineGrossMinor, "Valoarea liniei", 1);
  assertAmount(input.grossBeforeMinor, "Brutul deja returnat");
  assertAmount(input.grossNowMinor, "Brutul returnat");
  const gross = BigInt(input.lineGrossMinor);
  const discount = BigInt(input.lineDiscountMinor);
  const before = BigInt(input.grossBeforeMinor);
  const after = before + BigInt(input.grossNowMinor);
  if (after > gross || discount > gross) {
    throw new ValidationError("Se returnează mai mult decât valoarea liniei.");
  }
  return Number((discount * after) / gross - (discount * before) / gross);
}

/** Câte puncte trebuie să se fi întors în total, după reducerea returnată până acum pe toată comanda. */
export function returnedPoints(input: {
  returnedDiscountMinor: number;
  totalDiscountMinor: number;
  pointValueMinor: number;
  pointsUsed: number;
}): number {
  assertAmount(input.returnedDiscountMinor, "Reducerea returnată");
  assertAmount(input.pointValueMinor, "Valoarea punctului", 1);
  assertAmount(input.pointsUsed, "Punctele folosite");
  if (input.returnedDiscountMinor >= input.totalDiscountMinor) return input.pointsUsed;
  const points = BigInt(input.returnedDiscountMinor) / BigInt(input.pointValueMinor);
  return Number(smaller(points, BigInt(input.pointsUsed)));
}

/** Punctele aduse de banii plătiți pe produse: `floor(bani / rată)`, niciodată sub 0. */
export function earnedPoints(cashProductsMinor: number, earnRateMinor: number): number {
  assertAmount(earnRateMinor, "Rata de acumulare", 1);
  if (cashProductsMinor <= 0) return 0;
  assertAmount(cashProductsMinor, "Banii plătiți");
  return Number(BigInt(cashProductsMinor) / BigInt(earnRateMinor));
}

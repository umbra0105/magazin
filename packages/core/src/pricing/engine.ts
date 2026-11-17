import {
  ValidationError,
  allocateMinor,
  compareExact,
  exactFromMinor,
  lineByStepPrice,
  lineByUnitPrice,
  minorToNumber,
  netFromGross,
  roundHalfUp,
  scaleExact,
  stepsIn,
  type ExactMoney,
  type Quantity,
} from "@ecom/shared";
import type { PriceBasis } from "../inventory/constants";

/**
 * Motorul de prețuri (Faza 8): UN SINGUR loc care calculează prețul unei linii, apelat din coș (și, în fazele următoare, din
 * checkout și factură; vitrina arată prețul public prin `displayedPrice`, care folosește aceleași câmpuri). Funcții PURE:
 * nicio citire de date, ceasul e injectat (`now`), cotele de TVA vin ca intrare (din setări, niciodată hardcodate).
 *
 * Lanțul (docs/09 §3): preț brut → promoție (`salePrice`) → preț de grup (`none` / `discount` / `cost_plus`) → cupon → puncte
 * de loialitate (pas cu valoare 0 până în Faza 15b) → total de linie (rotunjit O SINGURĂ DATĂ) → extragerea TVA din brut.
 *
 * Rotunjirea (decisă 2026-11-17): o singură rotunjire pe linie, half-up la bani, în `@ecom/shared/money`. Reducerile
 * procentuale se aplică pe valoarea EXACTĂ; cupoanele cu sumă fixă se repartizează în bani întregi pe liniile eligibile. Totalul
 * e suma liniilor. Rezultatul e date simple și înghețat (fără `bigint`), deci poate fi serializat și păstrat ca snapshot.
 *
 * ⚠️ Prețul de achiziție (`costNetMinor`) intră DOAR ca parametru, de la un apelant autorizat (grupuri `cost_plus`, Faza 15);
 * coșul public nu îl citește și nu îl primește (testul de arhitectură al costului).
 */

export type PriceSource = "public" | "sale" | "group_discount" | "group_cost_plus";

export type PriceGroup =
  | { pricingType: "none" }
  | { pricingType: "discount"; discountBps: number; stacksWithSalePrice: boolean }
  | { pricingType: "cost_plus"; markupBps: number };

export interface PricingLineInput {
  /** Identificatorul liniei în rezultat (de obicei id-ul variantei). */
  key: string;
  productId: string;
  categoryIds: readonly string[];
  /** La ce se referă prețul: «unit» (pe unitate, R1) sau «step» (pe pas, R2). */
  basis: PriceBasis;
  /** Prețul public brut (cu TVA), în bani, pe bază. */
  priceMinor: number;
  /** Prețul promoțional brut ACTIV acum (fereastra de valabilitate verificată de apelant), sau `null`. */
  salePriceMinor: number | null;
  quantity: Quantity;
  /** Pasul de vânzare efectiv; la baza «pe pas» cantitatea trebuie să fie multiplu exact. */
  step: Quantity;
  /** Cota de TVA a liniei, în puncte de bază (din setarea `tax.standardRate` sau din clasa de taxare). */
  taxRateBps: number;
  /** Produsul sau o categorie a lui exclud prețul de grup (vezi `excludedFromGroupPricing`). */
  excludeFromGroupDiscount: boolean;
  /** Prețul de intrare NET pe aceeași bază; doar pentru `cost_plus`, de la un apelant autorizat. */
  costNetMinor: number | null;
}

export interface PricingCoupon {
  code: string;
  discount: { type: "percent"; bps: number } | { type: "fixed"; amountMinor: number };
  /** Blocat pentru orice grup cu `pricingType ≠ none`. */
  notForDiscountedGroups: boolean;
  excludedProductIds: readonly string[];
  excludedCategoryIds: readonly string[];
  /** Subtotalul (după prețul de grup, înainte de cupon) de la care cuponul se aplică. */
  minSubtotalMinor: number | null;
  startsAt: Date | null;
  /** Exclusiv: cuponul nu mai e valabil din acest moment. */
  endsAt: Date | null;
}

export interface PricingOptions {
  /**
   * Aplică prețul promoțional? Coșul îl ia din `catalog.showSalePricing`: cât vitrina nu arată reduceri, coșul percepe prețul
   * întreg (un singur preț, în vitrină și în coș).
   */
  applySale: boolean;
  group: PriceGroup;
  coupon?: PricingCoupon | null;
  now: Date;
  /** Plafonul unei linii, în bani (`MAX_MONEY`): peste el se refuză, nu se taie. */
  maxLineMinor: number;
}

export type CouponRejection =
  "not_started" | "expired" | "blocked_for_group" | "min_subtotal" | "no_eligible_lines";

export type CouponOutcome =
  | { status: "applied"; code: string; discountMinor: number }
  | { status: "rejected"; code: string; reason: CouponRejection };

export interface PricedLine {
  key: string;
  basis: PriceBasis;
  /** Prețul efectiv pe bază după promoție și grup, rotunjit (informativ; contează `totalMinor`). */
  unitPriceMinor: number;
  priceSource: PriceSource;
  /** Valoarea liniei la prețul public curent (după promoție), rotunjită. */
  publicLineMinor: number;
  /** Valoarea liniei după prețul de grup, înainte de cupon, rotunjită. */
  afterGroupMinor: number;
  /** Avantajul de grup față de prețul public curent (informativ, ≥ 0). */
  groupAdvantageMinor: number;
  couponMinor: number;
  /** Totalul liniei, brut (cu TVA): ce plătește clientul. */
  totalMinor: number;
  netMinor: number;
  vatMinor: number;
  taxRateBps: number;
}

export interface PricingTotals {
  /** Suma liniilor după prețul de grup, înainte de cupon. */
  subtotalMinor: number;
  couponMinor: number;
  groupAdvantageMinor: number;
  totalMinor: number;
  netMinor: number;
  vatMinor: number;
}

export interface PricingResult {
  lines: readonly PricedLine[];
  totals: PricingTotals;
  coupon: CouponOutcome | null;
  /** Pasul «puncte de loialitate»: valoare zero până în Faza 15b (nu există registru de puncte în Faza 8). */
  pointsDiscountMinor: number;
}

/** Excluderea din prețul de grup: a produsului SAU a oricăreia dintre categoriile lui. */
export function excludedFromGroupPricing(
  productFlag: boolean,
  categoryFlags: readonly boolean[],
): boolean {
  return productFlag || categoryFlags.some(Boolean);
}

const BPS = 10_000;

function assertBps(value: number, label: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`${label} trebuie să fie un număr întreg între ${min} și ${max}.`);
  }
}

interface ResolvedPrice {
  /** Prețul efectiv pe bază, exact. */
  price: ExactMoney;
  /** Prețul public curent (după promoție) pe bază, exact. */
  publicCurrent: ExactMoney;
  source: PriceSource;
}

function resolvePrice(input: PricingLineInput, options: PricingOptions): ResolvedPrice {
  const list = exactFromMinor(input.priceMinor);
  const sale =
    options.applySale && input.salePriceMinor !== null && input.salePriceMinor < input.priceMinor
      ? exactFromMinor(input.salePriceMinor)
      : null;
  const publicCurrent = sale ?? list;
  const publicSource: PriceSource = sale ? "sale" : "public";
  const group = options.group;

  if (input.excludeFromGroupDiscount || group.pricingType === "none") {
    return { price: publicCurrent, publicCurrent, source: publicSource };
  }

  if (group.pricingType === "discount") {
    assertBps(group.discountBps, "Reducerea grupului (puncte de bază)", 0, BPS);
    const stacks = group.stacksWithSalePrice && sale !== null;
    const base = stacks ? sale : list;
    const candidate = scaleExact(base, BPS - group.discountBps, BPS);
    // fără cumul se ia prețul cel mai mic dintre cel de grup și prețul public curent (promoția inclusă)
    const price = stacks || compareExact(candidate, publicCurrent) < 0 ? candidate : publicCurrent;
    const wins = compareExact(price, publicCurrent) < 0;
    return { price, publicCurrent, source: wins ? "group_discount" : publicSource };
  }

  // cost_plus: preț brut = costNet × (1 + adaos) × (1 + TVA), plafonat la prețul public curent
  assertBps(group.markupBps, "Adaosul grupului (puncte de bază)", 0, 1_000_000);
  if (input.costNetMinor === null) {
    return { price: publicCurrent, publicCurrent, source: publicSource };
  }
  const gross = scaleExact(
    exactFromMinor(input.costNetMinor),
    (BPS + group.markupBps) * (BPS + input.taxRateBps),
    BPS * BPS,
  );
  const wins = compareExact(gross, publicCurrent) < 0;
  return {
    price: wins ? gross : publicCurrent,
    publicCurrent,
    source: wins ? "group_cost_plus" : publicSource,
  };
}

function lineValue(
  input: PricingLineInput,
  price: ExactMoney,
  options: PricingOptions,
): ExactMoney {
  if (input.basis === "step") {
    // R2: preț pe pas × număr de pași; cantitatea trebuie să fie multiplu exact al pasului
    return lineByStepPrice(price, stepsIn(input.quantity, input.step), {
      maxLineMinor: options.maxLineMinor,
    });
  }
  // R1: preț pe unitate × cantitate, rotunjit o singură dată
  return lineByUnitPrice(price, input.quantity, { maxLineMinor: options.maxLineMinor });
}

function validateCoupon(coupon: PricingCoupon): void {
  if (coupon.discount.type === "percent") {
    assertBps(coupon.discount.bps, "Procentul cuponului (puncte de bază)", 1, BPS);
  } else {
    assertBps(coupon.discount.amountMinor, "Valoarea cuponului (bani)", 1, Number.MAX_SAFE_INTEGER);
  }
  if (coupon.minSubtotalMinor !== null) {
    assertBps(
      coupon.minSubtotalMinor,
      "Valoarea minimă a cuponului (bani)",
      0,
      Number.MAX_SAFE_INTEGER,
    );
  }
}

function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return Object.freeze(value);
}

interface Working {
  input: PricingLineInput;
  resolved: ResolvedPrice;
  afterGroup: ExactMoney;
  afterGroupMinor: bigint;
  publicLineMinor: bigint;
}

/** Calculează liniile coșului după lanțul din docs/09 §3. Aruncă `MoneyError` la depășirea plafonului liniei. */
export function priceLines(
  inputs: readonly PricingLineInput[],
  options: PricingOptions,
): PricingResult {
  const coupon = options.coupon ?? null;
  if (coupon) validateCoupon(coupon);

  const working: Working[] = inputs.map((input) => {
    assertBps(input.taxRateBps, "Cota de TVA (puncte de bază)", 0, BPS);
    const resolved = resolvePrice(input, options);
    // plafonul se verifică pe valoarea publică (cea mai mare): orice preț de grup e ≤ ea
    const publicLine = lineValue(input, resolved.publicCurrent, options);
    const afterGroup = lineValue(input, resolved.price, options);
    return {
      input,
      resolved,
      afterGroup,
      afterGroupMinor: roundHalfUp(afterGroup),
      publicLineMinor: roundHalfUp(publicLine),
    };
  });

  const outcome = coupon ? evaluateCoupon(coupon, working, options) : null;
  const couponByIndex = new Map<number, bigint>();
  const totalByIndex = new Map<number, bigint>();

  if (coupon && outcome?.status === "applied") {
    const eligible = working
      .map((w, index) => ({ w, index }))
      .filter(({ w }) => isEligible(coupon, w.input));
    if (coupon.discount.type === "percent") {
      const keep = BPS - coupon.discount.bps;
      for (const { w, index } of eligible) {
        // procentul se aplică pe valoarea EXACTĂ, cu o singură rotunjire
        const total = roundHalfUp(scaleExact(w.afterGroup, keep, BPS));
        totalByIndex.set(index, total);
        couponByIndex.set(index, w.afterGroupMinor - total);
      }
    } else {
      const weights = eligible.map(({ w }) => w.afterGroupMinor);
      const cap = weights.reduce((acc, weight) => acc + weight, 0n);
      const wanted = BigInt(coupon.discount.amountMinor);
      const parts = allocateMinor(wanted < cap ? wanted : cap, weights);
      eligible.forEach(({ w, index }, position) => {
        const part = parts[position] as bigint;
        couponByIndex.set(index, part);
        totalByIndex.set(index, w.afterGroupMinor - part);
      });
    }
  }

  const lines: PricedLine[] = working.map((w, index) => {
    const totalMinor = totalByIndex.get(index) ?? w.afterGroupMinor;
    const total = minorToNumber(totalMinor);
    const net = netFromGross(total, w.input.taxRateBps);
    return {
      key: w.input.key,
      basis: w.input.basis,
      unitPriceMinor: minorToNumber(roundHalfUp(w.resolved.price)),
      priceSource: w.resolved.source,
      publicLineMinor: minorToNumber(w.publicLineMinor),
      afterGroupMinor: minorToNumber(w.afterGroupMinor),
      groupAdvantageMinor: minorToNumber(w.publicLineMinor - w.afterGroupMinor),
      couponMinor: minorToNumber(couponByIndex.get(index) ?? 0n),
      totalMinor: total,
      netMinor: net,
      vatMinor: total - net,
      taxRateBps: w.input.taxRateBps,
    };
  });

  const sum = (pick: (line: PricedLine) => number): number =>
    lines.reduce((acc, line) => acc + pick(line), 0);
  const totals: PricingTotals = {
    subtotalMinor: sum((l) => l.afterGroupMinor),
    couponMinor: sum((l) => l.couponMinor),
    groupAdvantageMinor: sum((l) => l.groupAdvantageMinor),
    totalMinor: sum((l) => l.totalMinor),
    netMinor: sum((l) => l.netMinor),
    vatMinor: sum((l) => l.vatMinor),
  };

  return deepFreeze({
    lines,
    totals,
    coupon: outcome
      ? outcome.status === "applied"
        ? { ...outcome, discountMinor: totals.couponMinor }
        : outcome
      : null,
    pointsDiscountMinor: 0,
  });
}

function isEligible(coupon: PricingCoupon, input: PricingLineInput): boolean {
  return (
    !coupon.excludedProductIds.includes(input.productId) &&
    !input.categoryIds.some((id) => coupon.excludedCategoryIds.includes(id))
  );
}

function evaluateCoupon(
  coupon: PricingCoupon,
  working: readonly Working[],
  options: PricingOptions,
): CouponOutcome {
  const reject = (reason: CouponRejection): CouponOutcome => ({
    status: "rejected",
    code: coupon.code,
    reason,
  });
  const at = options.now.getTime();
  if (coupon.startsAt !== null && at < coupon.startsAt.getTime()) return reject("not_started");
  if (coupon.endsAt !== null && at >= coupon.endsAt.getTime()) return reject("expired");
  if (coupon.notForDiscountedGroups && options.group.pricingType !== "none") {
    return reject("blocked_for_group");
  }
  if (coupon.minSubtotalMinor !== null) {
    const subtotal = working.reduce((acc, w) => acc + w.afterGroupMinor, 0n);
    if (subtotal < BigInt(coupon.minSubtotalMinor)) return reject("min_subtotal");
  }
  if (!working.some((w) => isEligible(coupon, w.input))) return reject("no_eligible_lines");
  return { status: "applied", code: coupon.code, discountMinor: 0 };
}

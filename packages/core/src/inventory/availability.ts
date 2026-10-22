import {
  floorSteps,
  remainderAfterSteps,
  subtractQuantity,
  sumQuantities,
  type Quantity,
} from "@ecom/shared";

/**
 * Disponibilitatea și starea vizibilă a unei variante (Faza 5, D1/D6/D11): funcții PURE, fără acces la date, apelate
 * din vitrină, coș, plată, admin, import și joburi. Trei ramuri explicite (nimic nu simulează o ramură cu alta):
 *
 * - **digital**: mereu disponibil, fără stoc;
 * - **negestionat** (`manageStock = false`): doar `stockStatus` (în stoc / epuizat / la comandă), fără cantități;
 * - **gestionat**: `Disponibil = Fizică − Angajat − Rezervat` (niciodată sub 0), apoi tamponul de siguranță; cantitatea
 *   vandabilă se exprimă în PAȘI întregi, iar restul (mai puțin de un pas) e «rest nevandabil», vizibil doar în admin.
 *
 * Stările vizibile: În stoc / Stoc limitat / La comandă (cu termen) / Indisponibil. Hibrid: un produs gestionat epuizat
 * devine «La comandă» doar cu `allowBackorder` (altfel e indisponibil). «La comandă» nu are rezervare și nu are limită de
 * cantitate. Toată aritmetica trece prin `Quantity`.
 */

export type StockBranch = "digital" | "unmanaged" | "managed";
export type VisibleStockState = "in_stock" | "limited" | "on_order" | "unavailable";
export type StockStatusValue = "instock" | "outofstock" | "onbackorder";

export interface ManagedInventory {
  physical: Quantity;
  committed: Quantity;
  reserved: Quantity;
  /** Tamponul de siguranță: cantitate ținută în rezervă la calculul vandabilului (D1) */
  safetyBuffer: Quantity;
  /** Pragul «stoc mic» în PAȘI; `null` = pragul global */
  lowStockSteps: number | null;
}

export interface LeadTimeSources {
  productDays: number | null;
  brandDays: number | null;
  globalDays: number;
}

export interface AvailabilityInput {
  isDigital: boolean;
  /** Valoarea EFECTIVĂ (varianta suprascrie produsul, care suprascrie setarea globală) */
  manageStock: boolean;
  /** Folosit doar când `manageStock = false` */
  stockStatus: StockStatusValue;
  /** Hibrid: produsul gestionat epuizat devine «La comandă» (implicit oprit) */
  allowBackorder: boolean;
  /** Pasul de vânzare EFECTIV, în zecimi de miime */
  step: Quantity;
  /** Minimul comandat, în pași (`null` = 1) */
  minSteps?: number | null;
  /** Rândul de stoc al variantei; `null` = încă neinventariat (zero) */
  inventory: ManagedInventory | null;
  /** Pragul global «stoc mic» / «Stoc limitat», în pași (setarea `inventory.lowStockSteps`) */
  defaultLowStockSteps: number;
  leadTime: LeadTimeSources;
}

export interface Availability {
  branch: StockBranch;
  state: VisibleStockState;
  /** Se poate pune în coș și comanda (orice stare în afară de «Indisponibil») */
  purchasable: boolean;
  /** Pași comandabili; `null` = fără limită («La comandă», negestionat în stoc, digital) */
  orderableSteps: bigint | null;
  /** «Mai sunt N»: numărul de pași, doar la «Stoc limitat» */
  showCount: bigint | null;
  /** Termenul estimat în zile, doar la «La comandă» */
  leadTimeDays: number | null;
  /** Fizică − Angajat − Rezervat (≥ 0); `null` fără gestiune */
  available: Quantity | null;
  /** Disponibil după tamponul de siguranță (≥ 0): ce se poate vinde */
  sellable: Quantity | null;
  /** Pașii ÎNTREGI din cantitatea vandabilă (înainte de minim) */
  availableSteps: bigint | null;
  /** Restul nevandabil: ce rămâne după pașii întregi */
  remainder: Quantity | null;
  /** Alerta internă «stoc mic»: pași ≤ prag (inclusiv la epuizare) */
  lowStock: boolean;
  /** A mai rămas doar un rest nevandabil (cantitate > 0, dar sub un pas) */
  remainderOnly: boolean;
}

const ZERO = 0n as Quantity;
const MAX_LEAD_TIME_DAYS = 365;

function assertDays(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_LEAD_TIME_DAYS) {
    throw new RangeError(
      `${label} trebuie să fie un număr întreg de zile între 0 și ${MAX_LEAD_TIME_DAYS}`,
    );
  }
}

/** Termenul «La comandă»: al produsului, altfel implicitul brandului, altfel setarea globală. 0 zile e o valoare. */
export function resolveLeadTimeDays(sources: LeadTimeSources): number {
  assertDays(sources.globalDays, "Termenul global");
  if (sources.productDays !== null) assertDays(sources.productDays, "Termenul produsului");
  if (sources.brandDays !== null) assertDays(sources.brandDays, "Termenul brandului");
  return sources.productDays ?? sources.brandDays ?? sources.globalDays;
}

/** Termenul cel mai lung dintr-un coș mixt («toată odată») și linia care îl cauzează; la egalitate, prima. */
export function longestLeadTime(
  lines: readonly { key: string; leadTimeDays: number }[],
): { days: number; key: string } | null {
  let best: { days: number; key: string } | null = null;
  for (const line of lines) {
    assertDays(line.leadTimeDays, "Termenul liniei");
    if (best === null || line.leadTimeDays > best.days) {
      best = { days: line.leadTimeDays, key: line.key };
    }
  }
  return best;
}

function minimumSteps(minSteps: number | null | undefined): bigint {
  if (minSteps === null || minSteps === undefined) return 1n;
  if (!Number.isInteger(minSteps) || minSteps < 1) {
    throw new RangeError("Minimul comandat trebuie să fie un număr întreg de pași, cel puțin 1");
  }
  return BigInt(minSteps);
}

const NO_QUANTITIES = {
  available: null,
  sellable: null,
  availableSteps: null,
  remainder: null,
  lowStock: false,
  remainderOnly: false,
} as const;

export function computeAvailability(input: AvailabilityInput): Availability {
  if (input.isDigital) {
    return {
      branch: "digital",
      state: "in_stock",
      purchasable: true,
      orderableSteps: null,
      showCount: null,
      leadTimeDays: null,
      ...NO_QUANTITIES,
    };
  }

  if (!input.manageStock) {
    if (input.stockStatus === "outofstock") {
      return {
        branch: "unmanaged",
        state: "unavailable",
        purchasable: false,
        orderableSteps: 0n,
        showCount: null,
        leadTimeDays: null,
        ...NO_QUANTITIES,
      };
    }
    const onOrder = input.stockStatus === "onbackorder";
    return {
      branch: "unmanaged",
      state: onOrder ? "on_order" : "in_stock",
      purchasable: true,
      orderableSteps: null,
      showCount: null,
      leadTimeDays: onOrder ? resolveLeadTimeDays(input.leadTime) : null,
      ...NO_QUANTITIES,
    };
  }

  // gestionat
  const stock = input.inventory;
  const physical = stock?.physical ?? ZERO;
  const used = sumQuantities([stock?.committed ?? ZERO, stock?.reserved ?? ZERO]);
  const available = used >= physical ? ZERO : subtractQuantity(physical, used);
  const buffer = stock?.safetyBuffer ?? ZERO;
  const sellable = buffer >= available ? ZERO : subtractQuantity(available, buffer);
  const steps = floorSteps(sellable, input.step);
  const remainder = remainderAfterSteps(sellable, input.step);

  const threshold = stock?.lowStockSteps ?? input.defaultLowStockSteps;
  if (!Number.isInteger(threshold) || threshold < 0) {
    throw new RangeError("Pragul «stoc mic» trebuie să fie un număr întreg de pași, cel puțin 0");
  }
  const orderable = steps >= minimumSteps(input.minSteps) ? steps : 0n;
  const quantities = {
    available,
    sellable,
    availableSteps: steps,
    remainder,
    lowStock: steps <= BigInt(threshold),
    remainderOnly: steps === 0n && sellable > ZERO,
  };

  if (orderable > 0n) {
    const limited = orderable <= BigInt(threshold);
    return {
      branch: "managed",
      state: limited ? "limited" : "in_stock",
      purchasable: true,
      orderableSteps: orderable,
      showCount: limited ? orderable : null,
      leadTimeDays: null,
      ...quantities,
    };
  }
  if (input.allowBackorder) {
    return {
      branch: "managed",
      state: "on_order",
      purchasable: true,
      orderableSteps: null,
      showCount: null,
      leadTimeDays: resolveLeadTimeDays(input.leadTime),
      ...quantities,
    };
  }
  return {
    branch: "managed",
    state: "unavailable",
    purchasable: false,
    orderableSteps: 0n,
    showCount: null,
    leadTimeDays: null,
    ...quantities,
  };
}

export type OrderableCheck =
  { ok: true } | { ok: false; reason: "unavailable" | "exceeds_available"; maxSteps: bigint };

/**
 * Se pot comanda `requestedSteps` pași? Verificarea de disponibilitate dinaintea rezervării (pasul și minimul se
 * validează separat, cu `assertOrderQuantity`). Refuzul spune câți pași se pot comanda.
 */
export function checkOrderable(availability: Availability, requestedSteps: bigint): OrderableCheck {
  if (requestedSteps < 1n) throw new RangeError("Se cere cel puțin un pas");
  if (!availability.purchasable) return { ok: false, reason: "unavailable", maxSteps: 0n };
  if (availability.orderableSteps === null || requestedSteps <= availability.orderableSteps) {
    return { ok: true };
  }
  return { ok: false, reason: "exceeds_available", maxSteps: availability.orderableSteps };
}

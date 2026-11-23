import {
  compareQuantity,
  isMultipleOf,
  quantityFromTicks,
  subtractQuantity,
  type Quantity,
} from "@ecom/shared";
import type { ReturnStatus } from "./return-constants";

/**
 * Regulile PURE ale returului: fereastra de retur și cantitățile. Fără acces la date și fără ceas propriu (ora se dă din afară,
 * ca testele să nu depindă de «acum»). Cantitățile trec doar prin modulul `Quantity`.
 */

const ZERO = quantityFromTicks(0n);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Sfârșitul ferestrei: momentul livrării + `windowDays` zile întregi (24 h fiecare). */
export function returnWindowEnd(deliveredAt: Date, windowDays: number): Date {
  if (!Number.isInteger(windowDays) || windowDays < 1) {
    throw new RangeError("Fereastra de retur trebuie să fie un număr întreg de zile, cel puțin 1");
  }
  return new Date(deliveredAt.getTime() + windowDays * DAY_MS);
}

/** Fereastra e deschisă până la sfârșitul ei inclusiv. */
export function isReturnWindowOpen(now: Date, deliveredAt: Date, windowDays: number): boolean {
  return now.getTime() <= returnWindowEnd(deliveredAt, windowDays).getTime();
}

/**
 * Cantitatea unui retur care «ocupă» linia comenzii: cea cerută cât nu e inspectat, cea acceptată după inspecție, zero dacă e
 * respins sau anulat (aceeași regulă ca triggerul din bază).
 */
export function activeReturnQuantity(
  status: ReturnStatus,
  requested: Quantity,
  accepted: Quantity | null,
): Quantity {
  switch (status) {
    case "requested":
    case "approved":
    case "awaiting_shipment":
    case "received":
      return requested;
    case "inspected":
    case "refunded":
      return accepted ?? ZERO;
    default:
      return ZERO;
  }
}

/** Ce a rămas returnabil dintr-o linie: comandat minus ce ocupă retururile active (niciodată sub zero). */
export function returnableQuantity(ordered: Quantity, active: Quantity): Quantity {
  return compareQuantity(active, ordered) >= 0 ? ZERO : subtractQuantity(ordered, active);
}

export type ReturnQuantityProblem = "not_positive" | "not_step_multiple" | "exceeds_returnable";

/** Verifică o cantitate cerută: pozitivă, multiplu exact al pasului de vânzare, cel mult cât a rămas. */
export function checkReturnQuantity(
  requested: Quantity,
  returnable: Quantity,
  step: Quantity,
): ReturnQuantityProblem | null {
  if (compareQuantity(requested, ZERO) <= 0) return "not_positive";
  if (!isMultipleOf(requested, step)) return "not_step_multiple";
  if (compareQuantity(requested, returnable) > 0) return "exceeds_returnable";
  return null;
}

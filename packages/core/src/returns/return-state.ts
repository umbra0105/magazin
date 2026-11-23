import { DomainError } from "@ecom/shared";
import type { ReturnStatus } from "./return-constants";

/**
 * State machine-ul returului (docs/04 §2): requested → approved → awaiting_shipment → received → inspected → refunded; respins din
 * requested și din inspected; anulat din requested, approved și awaiting_shipment. Nicio cale din aplicație nu scrie `status = x`
 * direct: schimbarea trece prin `transitionReturn` (`return-transition.ts`); un trigger din bază păzește aceleași tranziții.
 */
export const RETURN_TRANSITIONS: Readonly<Record<ReturnStatus, readonly ReturnStatus[]>> = {
  requested: ["approved", "rejected", "cancelled"],
  approved: ["awaiting_shipment", "cancelled"],
  awaiting_shipment: ["received", "cancelled"],
  received: ["inspected"],
  inspected: ["refunded", "rejected"],
  refunded: [],
  rejected: [],
  cancelled: [],
};

const table = RETURN_TRANSITIONS as Readonly<Record<string, readonly string[]>>;

export function canTransitionReturn(from: string, to: string): boolean {
  return table[from]?.includes(to) ?? false;
}

export function assertReturnTransition(from: string, to: string): void {
  if (!canTransitionReturn(from, to)) {
    throw new DomainError(
      "RETURN_TRANSITION_INVALID",
      `Tranziția returului ${from} → ${to} nu este permisă`,
      { from, to },
    );
  }
}

export const isFinalReturnStatus = (status: string): boolean => table[status]?.length === 0;

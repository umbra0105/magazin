import type { PublicAvailability, VisibleStockState } from "@ecom/core";
import { StorePill, type StorePillTone } from "@ecom/ui";
import { getMessages } from "@/messages";

const m = getMessages().storefront.catalog.availability;

const TONE: Record<VisibleStockState, StorePillTone> = {
  in_stock: "success",
  limited: "warning",
  on_order: "info",
  unavailable: "problem",
};

/** Eticheta stării vizibile (D6): «În stoc», «Stoc limitat», «La comandă», «Indisponibil». */
export function availabilityLabel(state: VisibleStockState): string {
  return m[state];
}

export function availabilityTone(state: VisibleStockState): StorePillTone {
  return TONE[state];
}

/** Detaliul de lângă etichetă: «Mai sunt N» la stoc limitat, termenul în zile la «La comandă». */
export function availabilityDetail(availability: PublicAvailability): string | null {
  if (availability.state === "limited" && availability.remainingSteps !== null) {
    return m.limitedCount(availability.remainingSteps);
  }
  if (availability.state === "on_order" && availability.leadTimeDays !== null) {
    return m.onOrderDays(availability.leadTimeDays);
  }
  return null;
}

export function AvailabilityPill({ availability }: { availability: PublicAvailability }) {
  const detail = availabilityDetail(availability);
  const label = availabilityLabel(availability.state);
  return (
    <StorePill tone={TONE[availability.state]}>{detail ? `${label} · ${detail}` : label}</StorePill>
  );
}

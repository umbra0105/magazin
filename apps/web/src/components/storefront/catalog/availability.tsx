import type { PublicAvailability } from "@ecom/core";
import { StorePill } from "@ecom/ui";
import { describeAvailability, type AvailabilityText } from "@/lib/availability-text";

/**
 * Disponibilitatea unui produs din vitrină, pe un singur drum: `describeAvailability` (`lib/availability-text.ts`). Produsele
 * fizice au stările D6 («În stoc», «Stoc limitat», «La comandă», «Indisponibil»); produsul digital arată doar «Disponibil» sau
 * «Indisponibil» (Faza 14c, decizia 3).
 */
export function availabilityText(availability: PublicAvailability): AvailabilityText {
  return describeAvailability({
    state: availability.state,
    purchasable: availability.purchasable,
    remainingSteps: availability.remainingSteps,
    leadTimeDays: availability.leadTimeDays,
    ...(availability.isDigital === true ? { isDigital: true } : {}),
  });
}

export function AvailabilityPill({ availability }: { availability: PublicAvailability }) {
  const text = availabilityText(availability);
  return <StorePill tone={text.tone}>{text.label}</StorePill>;
}

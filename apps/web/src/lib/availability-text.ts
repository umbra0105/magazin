import type { VisibleStockState } from "@ecom/core";
import { getMessages } from "@/messages";

/**
 * Eticheta COMUNĂ de disponibilitate a vitrinei (Faza 14c, decizia 3): un singur loc pentru carduri, căutare, favorite, pagina de
 * produs și coș. Produsele fizice păstrează cele patru stări vizibile (D6): «În stoc», «Stoc limitat», «La comandă», «Indisponibil».
 * Produsul DIGITAL nu are stoc: arată DOAR «Disponibil» (când regulile existente îl consideră comandabil) sau «Indisponibil», fără
 * «Mai sunt N» și fără termen de livrare. Nu există nicio regulă nouă de disponibilitate aici, doar etichetele.
 */

export type AvailabilityTone = "success" | "warning" | "info" | "problem";

export interface AvailabilityTextInput {
  state: VisibleStockState;
  /** Produs digital (`PublicAvailability.isDigital`, `CartLineView.isDigital`); lipsa înseamnă produs fizic. */
  isDigital?: boolean;
  /** Se poate comanda; lipsa înseamnă «după stare» (orice stare în afară de «Indisponibil»). */
  purchasable?: boolean;
  remainingSteps?: number | null;
  leadTimeDays?: number | null;
}

export interface AvailabilityText {
  label: string;
  tone: AvailabilityTone;
  detail: string | null;
}

const TONE: Record<VisibleStockState, AvailabilityTone> = {
  in_stock: "success",
  limited: "warning",
  on_order: "info",
  unavailable: "problem",
};

export function describeAvailability(input: AvailabilityTextInput): AvailabilityText {
  const m = getMessages().storefront.catalog.availability;
  if (input.isDigital === true) {
    const orderable = input.state !== "unavailable" && input.purchasable !== false;
    return orderable
      ? { label: m.digitalAvailable, tone: "success", detail: null }
      : { label: m.unavailable, tone: "problem", detail: null };
  }
  const detail =
    input.state === "limited" && input.remainingSteps != null
      ? m.limitedCount(input.remainingSteps)
      : input.state === "on_order" && input.leadTimeDays != null
        ? m.onOrderDays(input.leadTimeDays)
        : null;
  return { label: m[input.state], tone: TONE[input.state], detail };
}

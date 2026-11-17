import type { VisibleStockState } from "../inventory/availability";

/**
 * Disponibilitatea așa cum o vede cumpărătorul (Faza 7): doar starea vizibilă (D6), termenul la «La comandă» și, la «Stoc
 * limitat», câți pași mai sunt. Nicio cantitate fizică, angajată, rezervată sau rest nevandabil nu iese din acest tip (acelea
 * rămân în admin). Starea vine din rândul de stoc calculat de `buildStockOverviewRow` (aceeași regulă ca în admin și, mai târziu,
 * în coș): vitrina NU recalculează stocul.
 */
export interface PublicAvailability {
  state: VisibleStockState;
  /** Se poate comanda (orice stare în afară de «Indisponibil»). */
  purchasable: boolean;
  /** Termenul estimat în zile, doar la «La comandă». */
  leadTimeDays: number | null;
  /** «Mai sunt N», doar la «Stoc limitat». */
  remainingSteps: number | null;
}

export function publicAvailabilityOfRow(row: {
  state: VisibleStockState;
  leadTimeDays: number | null;
  availableSteps: bigint | null;
}): PublicAvailability {
  return {
    state: row.state,
    purchasable: row.state !== "unavailable",
    leadTimeDays: row.state === "on_order" ? row.leadTimeDays : null,
    remainingSteps:
      row.state === "limited" && row.availableSteps !== null ? Number(row.availableSteps) : null,
  };
}

const RANK: Record<VisibleStockState, number> = {
  in_stock: 0,
  limited: 1,
  on_order: 2,
  unavailable: 3,
};

/** Starea produsului în listă: cea mai bună dintre variante; la «La comandă», termenul cel mai scurt. */
export function summarizeProductAvailability(
  variants: readonly PublicAvailability[],
): PublicAvailability {
  if (variants.length === 0) {
    return { state: "unavailable", purchasable: false, leadTimeDays: null, remainingSteps: null };
  }
  let best = variants[0] as PublicAvailability;
  for (const v of variants) if (RANK[v.state] < RANK[best.state]) best = v;
  if (best.state === "on_order") {
    const days = variants
      .filter((v) => v.state === "on_order" && v.leadTimeDays !== null)
      .map((v) => v.leadTimeDays as number);
    return { ...best, leadTimeDays: days.length > 0 ? Math.min(...days) : null };
  }
  return { ...best, remainingSteps: variants.length === 1 ? best.remainingSteps : null };
}

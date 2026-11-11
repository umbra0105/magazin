import type { BadgeProps } from "@ecom/ui";

/**
 * Tonul pastilei de stare a produsului (docs/17 §2.2): activ = Succes, ciornă = Informare, arhivat = neutru. Același în listă
 * și în pagina de editare, ca aceeași stare să arate la fel peste tot.
 */
const STATUS_VARIANT: Record<string, NonNullable<BadgeProps["variant"]>> = {
  active: "success",
  draft: "info",
  archived: "neutral",
};

export function statusVariant(status: string): NonNullable<BadgeProps["variant"]> {
  return STATUS_VARIANT[status] ?? "neutral";
}

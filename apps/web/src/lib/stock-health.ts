import type { LowStockCounts } from "@ecom/core";
import type { Segment } from "@ecom/ui";
import { getMessages } from "@/messages";

/**
 * Bara de stoc segmentată din Panou și din pagina Stoc (funcție PURĂ): variantele gestionate, în patru segmente care folosesc
 * EXACT cuvintele și cifrele cardurilor din vederea «Stoc mic»: «În stoc», «Sub prag», «Doar rest nevandabil» (ton neutru) și
 * «Epuizat». Cele trei de la urmă sunt chiar motivele din «Stoc mic (N)», deci însumează acel N; împreună cu «În stoc»
 * însumează exact numărul de variante gestionate (fiecare variantă e într-un singur segment). Negestionatul și digitalul nu
 * au cantități și nu intră. «Stoc mic» e numele tab-ului și al cardului din Panou, nu al unui segment.
 */
export interface StockHealthView {
  label: string;
  /** «20 de variante gestionate»: pe ce se bazează bara */
  caption: string;
  segments: Segment[];
}

export function stockHealthView(
  lowStock: Pick<LowStockCounts, "outOfStock" | "remainderOnly" | "belowThreshold">,
  managedVariants: number,
): StockHealthView | null {
  if (managedVariants <= 0) return null;
  const text = getMessages().admin.inventory.health;
  const reasons = getMessages().admin.inventory.lowStock.summary;
  const { belowThreshold, remainderOnly, outOfStock } = lowStock;
  return {
    label: text.label,
    caption: text.managed(managedVariants),
    segments: [
      {
        key: "in-stock",
        label: text.inStock,
        value: Math.max(0, managedVariants - belowThreshold - remainderOnly - outOfStock),
        tone: "ok",
      },
      {
        key: "below_threshold",
        label: reasons.below_threshold,
        value: belowThreshold,
        tone: "low",
      },
      {
        key: "remainder_only",
        label: reasons.remainder_only,
        value: remainderOnly,
        tone: "neutral",
      },
      { key: "out_of_stock", label: reasons.out_of_stock, value: outOfStock, tone: "out" },
    ],
  };
}

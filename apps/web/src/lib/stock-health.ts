import type { LowStockCounts } from "@ecom/core";
import type { Segment } from "@ecom/ui";
import { getMessages } from "@/messages";

/**
 * Bara de stoc segmentată din Panou și din pagina Stoc (funcție PURĂ): variantele gestionate, împărțite în «În stoc», «Stoc mic»
 * (sub prag) și «Epuizat» (epuizate și cele cu doar un rest nevandabil: nu se pot vinde). Segmentele însumează exact numărul de
 * variante gestionate; negestionatul și digitalul nu au cantități și nu intră.
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
  const out = lowStock.outOfStock + lowStock.remainderOnly;
  const low = lowStock.belowThreshold;
  return {
    label: text.label,
    caption: text.managed(managedVariants),
    segments: [
      {
        key: "in-stock",
        label: text.inStock,
        value: Math.max(0, managedVariants - low - out),
        tone: "ok",
      },
      { key: "low", label: text.low, value: low, tone: "low" },
      { key: "out", label: text.out, value: out, tone: "out" },
    ],
  };
}

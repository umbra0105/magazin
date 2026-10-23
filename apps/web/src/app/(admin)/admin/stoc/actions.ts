"use server";

import { formatQuantity, formatSignedDelta } from "@ecom/shared/quantity";
import { getStockAdjustmentService } from "@/lib/inventory";
import { productFailure as failure } from "@/lib/product-action-support";
import { withPermission } from "@/lib/session";

/**
 * Acțiunea ecranului de stoc. Scrierea cere `inventory.write` (verificată aici și din nou în serviciu); regulile (motiv,
 * semn, precizia unității, sub zero, ora efectivă) și auditul sunt în `StockAdjustmentService` din `@ecom/core`. Rezultatul
 * conține doar text și date simple (serializabile), inclusiv avertismentele.
 */

export const adjustStock = withPermission(
  "inventory.write",
  async (input: unknown, subject) => {
    try {
      const result = await getStockAdjustmentService().adjust(subject, input);
      return {
        ok: true as const,
        physicalBefore: formatQuantity(result.physicalBefore),
        physicalAfter: formatQuantity(result.physicalAfter),
        delta: formatSignedDelta(result.delta),
        effectiveAt: result.effectiveAt.toISOString(),
        warnings: result.warnings,
      };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "stock.adjust", entity: "inventory_item" },
);

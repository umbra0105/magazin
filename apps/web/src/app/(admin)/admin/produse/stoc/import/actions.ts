"use server";

import { productFailure as failure } from "@/lib/product-action-support";
import { withPermission } from "@/lib/session";
import { getStockReportImportService } from "@/lib/stock-imports";

/**
 * Alegerea gestiunilor SmartBill din care se citește stocul (setarea `inventory.smartbillWarehouses`).
 * Cere `inventory.write` (verificat aici și din nou în serviciu); validarea și auditul cu valoarea dinainte și de după sunt
 * în `StockReportImportService`. Rezultatul conține doar text (serializabil).
 */
export const saveStockImportWarehouses = withPermission(
  "inventory.write",
  async (input: unknown, subject) => {
    try {
      const warehouses = await getStockReportImportService().setWarehouses(subject, input);
      return { ok: true as const, warehouses };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "stock.import.warehouses.update", entity: "setting" },
);

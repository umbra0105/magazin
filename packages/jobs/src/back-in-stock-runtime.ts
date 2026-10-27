import { BackInStockService, type SettingsService } from "@ecom/core";
import type { getDb } from "@ecom/db";

/**
 * Serviciul «Anunță-mă când revine» cu setările reale. Folosit de procesorul de emailuri (claim → trimitere → ștergere) și
 * de jobul `stock-back-in-stock` (selecția); setările se citesc din nou la FIECARE apel, nu o dată la pornire.
 */
export function createBackInStockService(
  db: ReturnType<typeof getDb>,
  settings: SettingsService,
): BackInStockService {
  return new BackInStockService({
    db,
    readSettings: async () => {
      const inventory = await settings.getGroup("inventory");
      return {
        lowStockSteps: inventory.lowStockSteps,
        defaultLeadTimeDays: inventory.defaultLeadTimeDays,
        maxPerEmail: inventory.backInStockMaxPerEmail,
        maxPerVariant: inventory.backInStockMaxPerVariant,
      };
    },
  });
}

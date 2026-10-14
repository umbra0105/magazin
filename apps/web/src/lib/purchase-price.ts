import { CostPriceService, createPrismaCostPriceStore } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { getAudit } from "./admin-writes";

/**
 * Singurul punct din aplicație prin care se ajunge la serviciul prețului de achiziție (NIR). Fișierul
 * e pe lista deliberată a testului de arhitectură al costului: îl pot importa DOAR componente de
 * server și server actions din zona de admin; valoarea nu devine niciodată props pentru o componentă
 * client (testul o impune).
 */
const globalForPurchase = globalThis as unknown as { __ecomPurchase?: CostPriceService };

export function getPurchasePriceService(): CostPriceService {
  globalForPurchase.__ecomPurchase ??= new CostPriceService({
    store: createPrismaCostPriceStore(getDb()),
    audit: getAudit(),
    logger: getLogger(),
  });
  return globalForPurchase.__ecomPurchase;
}

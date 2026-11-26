import { LoyaltyAdminService } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getAudit } from "./admin-writes";

const globalForLoyalty = globalThis as unknown as { __ecomLoyaltyAdmin?: LoyaltyAdminService };

/** Punctele de loialitate în admin (Faza 15b). Un singur serviciu per proces; permisiunile se verifică în serviciu. */
export function getLoyaltyAdminService(): LoyaltyAdminService {
  globalForLoyalty.__ecomLoyaltyAdmin ??= new LoyaltyAdminService({
    db: getDb(),
    audit: getAudit(),
  });
  return globalForLoyalty.__ecomLoyaltyAdmin;
}

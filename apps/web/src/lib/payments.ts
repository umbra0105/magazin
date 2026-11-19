import { loadEnv } from "@ecom/config";
import { PaymentConfigService, readDemoGuardEnv } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getSettings } from "./services";

/**
 * Plățile cu cardul pe partea de aplicație (Faza 10): configurarea furnizorilor (credențiale criptate, mod test/live,
 * garda «verificat în sandbox»), citită din baza de date la fiecare cerere. Logica rămâne în `@ecom/core`.
 */
const globalForPayments = globalThis as unknown as { __ecomPaymentConfig?: PaymentConfigService };

export function getPaymentConfig(): PaymentConfigService {
  if (!globalForPayments.__ecomPaymentConfig) {
    globalForPayments.__ecomPaymentConfig = new PaymentConfigService({
      db: getDb(),
      appKey: loadEnv().APP_KEY,
      env: readDemoGuardEnv(),
      readCardProvider: async () => (await getSettings().getGroup("payment")).cardProvider,
    });
  }
  return globalForPayments.__ecomPaymentConfig;
}

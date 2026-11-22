import { loadEnv } from "@ecom/config";
import { InvoiceService, InvoicingConfigService, readDemoGuardEnv } from "@ecom/core";
import { getDb } from "@ecom/db";

/**
 * Facturarea pe partea de aplicație (Faza 13): configurarea furnizorului (credențiale criptate, mod test/live, garda «testat cu cont
 * real») și serviciul documentelor fiscale, un exemplar per proces. Logica stă în `@ecom/core`; emiterea o face workerul.
 */
const globalForInvoicing = globalThis as unknown as {
  __ecomInvoicingConfig?: InvoicingConfigService;
  __ecomInvoiceService?: InvoiceService;
};

export function getInvoicingConfig(): InvoicingConfigService {
  globalForInvoicing.__ecomInvoicingConfig ??= new InvoicingConfigService({
    db: getDb(),
    appKey: loadEnv().APP_KEY,
    env: readDemoGuardEnv(),
  });
  return globalForInvoicing.__ecomInvoicingConfig;
}

export function getInvoiceService(): InvoiceService {
  globalForInvoicing.__ecomInvoiceService ??= new InvoiceService({
    db: getDb(),
    source: getInvoicingConfig(),
  });
  return globalForInvoicing.__ecomInvoiceService;
}

import { loadEnv } from "@ecom/config";
import {
  MediaUploadGuard,
  createProductExportService,
  type ProductExportRouteDeps,
  type ProductExportService,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { getAudit } from "./admin-writes";
import { getCounterStore, getSettings } from "./services";
import { getCurrentSubject } from "./session";

/**
 * Exportul de produse (CSV/XLSX). Serviciul NU se păstrează pe `globalThis` (e un obiect ieftin, iar un
 * singleton ar ține în dezvoltare codul vechi după o modificare, ca la import). Datele vin din
 * `export-store.ts` din `@ecom/core`, care nu selectează prețul de achiziție.
 */
export function getProductExportService(): ProductExportService {
  return createProductExportService({
    db: getDb(),
    settings: getSettings(),
    audit: getAudit(),
    logger: getLogger(),
  });
}

/** Dependențele rutei de export, legate la serviciile reale. Contoarele au spațiu de nume propriu. */
export function getProductExportRouteDeps(): ProductExportRouteDeps {
  return {
    getSubject: getCurrentSubject,
    getSettings: async () => {
      const settings = getSettings();
      const [group, auth] = await Promise.all([
        settings.getGroup("productExport"),
        settings.getGroup("auth"),
      ]);
      return { productExport: group, trustedProxyHops: auth.trustedProxyHops };
    },
    appUrl: loadEnv().APP_URL,
    createGuard: (group) => new MediaUploadGuard(getCounterStore(), group, "product-export"),
    service: getProductExportService(),
    audit: getAudit(),
  };
}

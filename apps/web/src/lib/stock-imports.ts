import { loadEnv } from "@ecom/config";
import { MediaUploadGuard, StockReportImportService, type StockReportUploadDeps } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getAudit } from "./admin-writes";
import { getCounterStore, getSettings } from "./services";
import { getCurrentSubject } from "./session";

/**
 * Importul «stoc la zi» din SmartBill. Serviciul NU se păstrează pe `globalThis` (e un obiect ieftin, iar un singleton ar
 * ține în dezvoltare codul vechi după o modificare). Setările se citesc din nou la fiecare cerere (se pot schimba din admin).
 */
export function getStockReportImportService(): StockReportImportService {
  const settings = getSettings();
  return new StockReportImportService({
    db: getDb(),
    audit: getAudit(),
    settings: {
      read: async () => {
        const [inventory, regional] = await Promise.all([
          settings.getGroup("inventory"),
          settings.getGroup("regional"),
        ]);
        return {
          warehouses: inventory.smartbillWarehouses,
          timeZone: regional.timezone,
          safetyWindowMinutes: inventory.snapshotSafetyWindowMinutes,
        };
      },
      writeWarehouses: (names) => settings.set("inventory.smartbillWarehouses", names),
    },
  });
}

/** Dependențele rutei de încărcare, legate la serviciile reale. Contoarele au spațiu de nume propriu. */
export function getStockReportUploadDeps(): StockReportUploadDeps {
  return {
    getSubject: getCurrentSubject,
    getSettings: async () => {
      const settings = getSettings();
      const [group, auth] = await Promise.all([
        settings.getGroup("import"),
        settings.getGroup("auth"),
      ]);
      return { import: group, trustedProxyHops: auth.trustedProxyHops };
    },
    appUrl: loadEnv().APP_URL,
    createGuard: (group) => new MediaUploadGuard(getCounterStore(), group, "stock-import"),
    service: getStockReportImportService(),
    audit: getAudit(),
  };
}

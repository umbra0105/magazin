import { loadEnv } from "@ecom/config";
import {
  MediaUploadGuard,
  StockActivationService,
  StockReportImportService,
  type StockActivationUploadDeps,
  type StockImportSettingsPort,
  type StockReportUploadDeps,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { revalidateTag } from "next/cache";
import { getAudit } from "./admin-writes";
import { getCounterStore, getSettings } from "./services";
import { getCurrentSubject } from "./session";

/**
 * Importul «stoc la zi» din SmartBill și pornirea în masă a gestionării stocului din același fișier. Serviciile NU se păstrează
 * pe `globalThis` (sunt obiecte ieftine, iar un singleton ar ține în dezvoltare codul vechi după o modificare). Setările se
 * citesc din nou la fiecare cerere (se pot schimba din admin).
 */
function stockImportSettings(): StockImportSettingsPort {
  const settings = getSettings();
  return {
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
  };
}

export function getStockReportImportService(): StockReportImportService {
  return new StockReportImportService({
    db: getDb(),
    audit: getAudit(),
    settings: stockImportSettings(),
  });
}

/** Pornirea în masă a gestionării stocului (12e): bifele și cantitățile, într-o singură tranzacție. */
export function getStockActivationService(): StockActivationService {
  return new StockActivationService({
    db: getDb(),
    audit: getAudit(),
    settings: stockImportSettings(),
    // nucleul nu știe de Next: cheamă acest callback cu etichetele de cache ale catalogului
    invalidate: (tags) => {
      for (const tag of tags) revalidateTag(tag);
    },
  });
}

async function uploadSettings() {
  const settings = getSettings();
  const [group, auth] = await Promise.all([settings.getGroup("import"), settings.getGroup("auth")]);
  return { import: group, trustedProxyHops: auth.trustedProxyHops };
}

/** Dependențele rutei de încărcare, legate la serviciile reale. Contoarele au spațiu de nume propriu. */
export function getStockReportUploadDeps(): StockReportUploadDeps {
  return {
    getSubject: getCurrentSubject,
    getSettings: uploadSettings,
    appUrl: loadEnv().APP_URL,
    createGuard: (group) => new MediaUploadGuard(getCounterStore(), group, "stock-import"),
    service: getStockReportImportService(),
    audit: getAudit(),
  };
}

/** Dependențele rutei de pornire a gestionării (spațiu de nume propriu pentru contoare). */
export function getStockActivationUploadDeps(): StockActivationUploadDeps {
  return {
    getSubject: getCurrentSubject,
    getSettings: uploadSettings,
    appUrl: loadEnv().APP_URL,
    createGuard: (group) => new MediaUploadGuard(getCounterStore(), group, "stock-activation"),
    service: getStockActivationService(),
    audit: getAudit(),
  };
}

import { loadEnv } from "@ecom/config";
import {
  MediaUploadGuard,
  createProductImportService,
  type ProductImportDownloadDeps,
  type ProductImportService,
  type ProductImportUploadDeps,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { createImportQueue, importJobQueue, type ImportQueue } from "@ecom/jobs";
import { getLogger } from "@ecom/shared";
import { revalidateTag } from "next/cache";
import { getAudit } from "./admin-writes";
import { getStorage } from "./media";
import { getCounterStore, getSettings } from "./services";
import { getCurrentSubject } from "./session";

const globalForImports = globalThis as unknown as { __ecomImportQueue?: ImportQueue };

/** O singură coadă `product-import` (și conexiune Redis) per proces. */
function getImportQueue(): ImportQueue {
  if (!globalForImports.__ecomImportQueue) {
    const queue = createImportQueue(loadEnv().REDIS_URL);
    // Fără handler, o eroare de conexiune ar opri procesul; punerea în coadă are propriul timeout.
    queue.on("error", () => undefined);
    globalForImports.__ecomImportQueue = queue;
  }
  return globalForImports.__ecomImportQueue;
}

/**
 * Importul de produse (CSV/XLSX). Fișierul stă privat în stocare sub `private/product-imports/`;
 * importurile mari rulează în fundal (workerul `product-import`). Rândurile se scriu prin serviciile
 * catalogului, cu un singur eveniment de audit agregat.
 *
 * Serviciul NU se păstrează pe `globalThis` (spre deosebire de coadă și de conexiunea la bază, care sunt
 * resurse): e un obiect ieftin, iar un singleton ar ține în dezvoltare codul vechi după o modificare
 * (reîncărcarea la cald înlocuiește modulele, dar nu și instanța deja creată), de exemplu un raport CSV
 * generat cu funcția de dinainte de o corecție.
 */
export function getProductImportService(): ProductImportService {
  return createProductImportService({
    db: getDb(),
    storage: getStorage(),
    settings: getSettings(),
    audit: getAudit(),
    logger: getLogger(),
    queue: importJobQueue(getImportQueue()),
    invalidate: (tags) => {
      for (const tag of tags) revalidateTag(tag);
    },
  });
}

/** Dependențele rutei de încărcare, legate la serviciile reale. Contoarele au spațiu de nume propriu. */
export function getProductImportUploadDeps(): ProductImportUploadDeps {
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
    createGuard: (group) => new MediaUploadGuard(getCounterStore(), group, "product-import"),
    service: getProductImportService(),
    audit: getAudit(),
  };
}

export function getProductImportDownloadDeps(): ProductImportDownloadDeps {
  return { getSubject: getCurrentSubject, service: getProductImportService() };
}

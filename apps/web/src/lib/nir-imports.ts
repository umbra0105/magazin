import { loadEnv } from "@ecom/config";
import {
  MediaUploadGuard,
  NirImportService,
  createPrismaNirStore,
  type NirUploadDeps,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { createNirImportQueue, nirJobQueue, type NirImportQueue } from "@ecom/jobs";
import { getLogger } from "@ecom/shared";
import { getAudit } from "./admin-writes";
import { getCounterStore, getSettings } from "./services";
import { getCurrentSubject } from "./session";

const globalForNir = globalThis as unknown as { __ecomNirQueue?: NirImportQueue };

/** O singură coadă `nir-import` (și conexiune Redis) per proces. */
function getNirQueue(): NirImportQueue {
  if (!globalForNir.__ecomNirQueue) {
    const queue = createNirImportQueue(loadEnv().REDIS_URL);
    // fără handler, o eroare de conexiune ar opri procesul; punerea în coadă are propriul timeout
    queue.on("error", () => undefined);
    globalForNir.__ecomNirQueue = queue;
  }
  return globalForNir.__ecomNirQueue;
}

/**
 * Importul prețurilor de achiziție (NIR, Faza 15): serviciul cu coada din fundal (workerul `nir-import`). Nu se păstrează pe
 * `globalThis` (un obiect ieftin; un singleton ar ține codul vechi după o modificare în dezvoltare).
 */
export function getNirImportService(): NirImportService {
  return new NirImportService({
    store: createPrismaNirStore(getDb()),
    audit: getAudit(),
    queue: nirJobQueue(getNirQueue()),
    logger: getLogger(),
  });
}

/** Dependențele rutei de încărcare, legate la serviciile reale; contoarele au spațiu de nume propriu. */
export function getNirUploadDeps(): NirUploadDeps {
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
    createGuard: (group) => new MediaUploadGuard(getCounterStore(), group, "nir-import"),
    service: getNirImportService(),
    audit: getAudit(),
  };
}

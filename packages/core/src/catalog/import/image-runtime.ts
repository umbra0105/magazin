import type { PrismaClient } from "@ecom/db";
import type { StorageDriver } from "@ecom/integrations";
import type { getLogger } from "@ecom/shared";
import { AuditService } from "../../audit/audit-service";
import type { DecodeLimiter } from "../../media/decode-limiter";
import { MediaService } from "../../media/media-service";
import { createPrismaMediaStore } from "../../media/media-store";
import { safeFetchImage } from "../../media/safe-fetch";
import { PermissionService } from "../../rbac/permission-service";
import type { SettingsService } from "../../settings/settings-service";
import {
  ProductAssignmentsService,
  createPrismaProductAssignmentStore,
} from "../product-assignments";
import { ProductImageImporter, type ImageProcessOutcome } from "./woo/image-importer";
import { createPrismaProductImportStore } from "./import-store";

/**
 * Fabrica importatorului de imagini, folosită de workerul din fundal. Dependențele de rețea sunt LEGATE AICI,
 * fără parametri: descărcarea trece mereu prin `safeFetchImage` cu rezolvarea DNS și conectarea reale. Nu există
 * comutator, variabilă de mediu sau opțiune care să dezactiveze verificările; testele construiesc direct
 * `ProductImageImporter` cu un rezolvator și un conector false.
 */

/** Auditul rândurilor e înlocuit de evenimentul agregat `product.import.images`. */
const SILENT_AUDIT = new AuditService({
  async append() {
    /* agregat */
  },
  async list() {
    return [];
  },
});

export interface ProductImageImporterRuntimeDeps {
  db: PrismaClient;
  storage: StorageDriver;
  settings: Pick<SettingsService, "getGroup" | "getGroupUncached">;
  /** Auditul real, doar pentru evenimentul agregat. */
  audit: AuditService;
  logger: Pick<ReturnType<typeof getLogger>, "warn" | "error">;
  /** Limita globală de decodări de imagini (aceeași ca la încărcarea din admin). */
  limiter?: DecodeLimiter;
  /** Procesarea media (variante) pentru un fișier proaspăt încărcat. */
  processMedia: (mediaId: string) => Promise<ImageProcessOutcome>;
  invalidate?: (tags: readonly string[]) => Promise<void> | void;
}

export function createProductImageImporter(
  deps: ProductImageImporterRuntimeDeps,
): ProductImageImporter {
  const { db, settings } = deps;
  const store = createPrismaProductImportStore(db);
  const permissions = new PermissionService(db);
  return new ProductImageImporter({
    tasks: store.images,
    imports: store,
    fetchImage: (url, policy) => safeFetchImage(url, policy),
    media: new MediaService({
      store: createPrismaMediaStore(db),
      storage: deps.storage,
      ...(deps.limiter && { limiter: deps.limiter }),
      // fără `onCreated`: procesarea o face importatorul direct (are nevoie de fișierul `ready` ca să-l atașeze)
    }),
    processMedia: deps.processMedia,
    assignments: new ProductAssignmentsService({
      store: createPrismaProductAssignmentStore(db),
      audit: SILENT_AUDIT,
      logger: deps.logger,
      storage: deps.storage,
    }),
    getPolicy: async () => {
      // lista de domenii permise e o setare de securitate: fără cache
      const group = await settings.getGroupUncached("imageImport");
      return {
        allowedHosts: group.allowedHosts,
        maxUrlLength: group.maxUrlLength,
        maxDownloadBytes: group.maxDownloadBytes,
        connectTimeoutSeconds: group.connectTimeoutSeconds,
        totalTimeoutSeconds: group.totalTimeoutSeconds,
        maxRedirects: group.maxRedirects,
        concurrency: group.concurrency,
        perHostConcurrency: group.perHostConcurrency,
      };
    },
    getMediaLimits: async () => {
      const group = await settings.getGroup("media");
      return { allowedMimeTypes: group.allowedMimeTypes, maxInputPixels: group.maxInputPixels };
    },
    loadSubject: (userId) => permissions.loadSubject(userId),
    audit: deps.audit,
    ...(deps.invalidate && { invalidate: deps.invalidate }),
    logger: deps.logger,
  });
}

import type { PrismaClient } from "@ecom/db";
import type { StorageDriver } from "@ecom/integrations";
import type { getLogger } from "@ecom/shared";
import { AuditService } from "../../audit/audit-service";
import { PermissionService } from "../../rbac/permission-service";
import type { SettingsService } from "../../settings/settings-service";
import {
  ProductAssignmentsService,
  createPrismaProductAssignmentStore,
} from "../product-assignments";
import { ProductService } from "../product-service";
import { createPrismaProductStore } from "../product-store";
import type { ImportJobQueue } from "./import-service";
import { ProductImportService } from "./import-service";
import { createPrismaProductImportStore } from "./import-store";

/**
 * Fabrica serviciului de import, folosită de aplicația web și de workerul din fundal ca să aibă
 * exact aceeași configurare. Importul scrie UN singur eveniment de audit agregat, deci serviciile
 * catalogului pe care le chemă pe rând (`ProductService`, atribuirea categoriilor) primesc un audit
 * „tăcut”; auditul real (`audit`) e folosit doar de import.
 */

const SILENT_AUDIT = new AuditService({
  async append() {
    /* auditul rândurilor e înlocuit de evenimentul agregat `product.import` */
  },
  async list() {
    return [];
  },
});

export interface ProductImportRuntimeDeps {
  db: PrismaClient;
  storage: StorageDriver;
  settings: Pick<SettingsService, "getGroup">;
  /** Auditul real, doar pentru evenimentul agregat. */
  audit: AuditService;
  logger: Pick<ReturnType<typeof getLogger>, "warn" | "error">;
  /** Coada jobului din fundal; fără ea, importurile se aplică mereu pe loc. */
  queue?: ImportJobQueue;
  invalidate?: (tags: readonly string[]) => Promise<void> | void;
}

export function createProductImportService(deps: ProductImportRuntimeDeps): ProductImportService {
  const { db, settings } = deps;
  const products = new ProductService({
    store: createPrismaProductStore(db),
    audit: SILENT_AUDIT,
    defaultManageStock: async () => (await settings.getGroup("inventory")).manageStock,
    defaultWarrantyMonths: async () => (await settings.getGroup("catalog")).defaultWarrantyMonths,
    logger: deps.logger,
  });
  const assignments = new ProductAssignmentsService({
    store: createPrismaProductAssignmentStore(db),
    audit: SILENT_AUDIT,
    logger: deps.logger,
    storage: deps.storage,
  });
  const permissions = new PermissionService(db);
  return new ProductImportService({
    store: createPrismaProductImportStore(db),
    storage: deps.storage,
    audit: deps.audit,
    products,
    assignments,
    getSettings: async () => {
      const group = await settings.getGroup("import");
      return {
        maxUploadBytes: group.maxUploadBytes,
        maxRows: group.maxRows,
        maxColumns: group.maxColumns,
        maxCellLength: group.maxCellLength,
        maxUncompressedBytes: group.maxUncompressedBytes,
        maxZipEntries: group.maxZipEntries,
        syncMaxRows: group.syncMaxRows,
        retentionHours: group.retentionHours,
      };
    },
    loadSubject: (userId) => permissions.loadSubject(userId),
    ...(deps.queue && { queue: deps.queue }),
    ...(deps.invalidate && { invalidate: deps.invalidate }),
    logger: deps.logger,
  });
}

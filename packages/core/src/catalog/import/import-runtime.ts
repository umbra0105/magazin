import type { PrismaClient } from "@ecom/db";
import type { StorageDriver } from "@ecom/integrations";
import type { getLogger } from "@ecom/shared";
import { AuditService } from "../../audit/audit-service";
import { PermissionService } from "../../rbac/permission-service";
import type { SettingsService } from "../../settings/settings-service";
import { AttributeService, createPrismaAttributeStore } from "../attribute-service";
import { BrandService, createPrismaBrandStore } from "../brand-service";
import { CategoryService } from "../category-service";
import { createPrismaCategoryStore } from "../category-store";
import { ProductAttributesService, createPrismaProductAttributeStore } from "../product-attributes";
import { ProductRelationsService, createPrismaProductRelationStore } from "../product-relations";
import {
  ProductAssignmentsService,
  createPrismaProductAssignmentStore,
} from "../product-assignments";
import { ProductService } from "../product-service";
import { createPrismaProductStore } from "../product-store";
import type { ImageJobQueue, ImportJobQueue } from "./import-service";
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
  settings: Pick<SettingsService, "getGroup" | "getGroupUncached">;
  /** Auditul real, doar pentru evenimentul agregat. */
  audit: AuditService;
  logger: Pick<ReturnType<typeof getLogger>, "warn" | "error">;
  /** Coada jobului din fundal; fără ea, importurile se aplică mereu pe loc. */
  queue?: ImportJobQueue;
  /** Coada descărcării imaginilor; fără ea, imaginile rămân în așteptare până la «Reia imaginile». */
  imageQueue?: ImageJobQueue;
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
  // profilul WooCommerce: categorii, branduri, atribute și relații, tot cu audit tăcut
  const wooLogger = { warn: deps.logger.warn };
  const woo = {
    categories: new CategoryService({
      store: createPrismaCategoryStore(db),
      audit: SILENT_AUDIT,
      logger: wooLogger,
    }),
    brands: new BrandService({
      store: createPrismaBrandStore(db),
      audit: SILENT_AUDIT,
      logger: wooLogger,
    }),
    attributeDefs: new AttributeService({
      store: createPrismaAttributeStore(db),
      audit: SILENT_AUDIT,
      logger: wooLogger,
    }),
    attributeValues: new ProductAttributesService({
      store: createPrismaProductAttributeStore(db),
      attributes: createPrismaAttributeStore(db),
      audit: SILENT_AUDIT,
      logger: wooLogger,
    }),
    relations: new ProductRelationsService({
      store: createPrismaProductRelationStore(db),
      audit: SILENT_AUDIT,
      logger: wooLogger,
    }),
    getTimezone: async () => (await settings.getGroup("regional")).timezone,
  };
  return new ProductImportService({
    store: createPrismaProductImportStore(db),
    storage: deps.storage,
    audit: deps.audit,
    products,
    assignments,
    woo,
    getSettings: async () => {
      const group = await settings.getGroup("import");
      return {
        maxUploadBytes: group.maxUploadBytes,
        maxRows: group.maxRows,
        // exporturile WooCommerce au 80+ de coloane; valoarea implicită veche (60) a rămas în instalările
        // existente, deci pragul real nu coboară sub 200
        maxColumns: Math.max(group.maxColumns, 200),
        maxCellLength: group.maxCellLength,
        maxUncompressedBytes: group.maxUncompressedBytes,
        maxZipEntries: group.maxZipEntries,
        syncMaxRows: group.syncMaxRows,
        retentionHours: group.retentionHours,
        historyRetentionDays: group.historyRetentionDays,
        interruptedAfterMinutes: group.interruptedAfterMinutes,
      };
    },
    loadSubject: (userId) => permissions.loadSubject(userId),
    // lista de domenii permise e o setare de securitate: se citește mereu din baza de date, fără cache
    getImageSettings: async () => {
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
        maxImagesPerProduct: group.maxImagesPerProduct,
        maxImagesPerImport: group.maxImagesPerImport,
      };
    },
    ...(deps.imageQueue && { imageQueue: deps.imageQueue }),
    ...(deps.queue && { queue: deps.queue }),
    ...(deps.invalidate && { invalidate: deps.invalidate }),
    logger: deps.logger,
  });
}

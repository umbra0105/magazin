import type { PrismaClient } from "@ecom/db";
import type { getLogger } from "@ecom/shared";
import type { AuditService } from "../../audit/audit-service";
import type { SettingsService } from "../../settings/settings-service";
import { ProductExportService } from "./export-service";
import { createPrismaProductExportStore } from "./export-store";

/** Fabrica serviciului de export, legat la baza de date, setări și auditul real. */
export interface ProductExportRuntimeDeps {
  db: PrismaClient;
  settings: Pick<SettingsService, "getGroup">;
  audit: AuditService;
  logger: Pick<ReturnType<typeof getLogger>, "error">;
}

export function createProductExportService(deps: ProductExportRuntimeDeps): ProductExportService {
  const { settings } = deps;
  return new ProductExportService({
    store: createPrismaProductExportStore(deps.db),
    audit: deps.audit,
    getSettings: async () => {
      const group = await settings.getGroup("productExport");
      return { maxRows: group.maxRows };
    },
    getTimezone: async () => (await settings.getGroup("regional")).timezone,
    logger: deps.logger,
  });
}

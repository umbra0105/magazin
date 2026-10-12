import { loadEnv } from "@ecom/config";
import {
  AuditService,
  IntegrationService,
  createAdminWrites,
  createPrismaAuditStore,
  createPrismaIntegrationStore,
  type AdminWrites,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { getBranding, getFeatureFlags, getSettings } from "./services";

const globalForAdmin = globalThis as unknown as { __ecomAdminWrites?: AdminWrites };

/** Jurnalul de audit al aplicației (doar adăugare). */
export function getAudit(): AuditService {
  return new AuditService(createPrismaAuditStore(getDb()));
}

/**
 * Scrierile din admin (setări, flag-uri, branding, integrări), cu audit. Se apelează DOAR din
 * server actions împachetate cu `withPermission`; actorul vine din sesiune.
 */
export function getAdminWrites(): AdminWrites {
  globalForAdmin.__ecomAdminWrites ??= createAdminWrites({
    audit: getAudit(),
    settings: getSettings(),
    flags: getFeatureFlags(),
    branding: getBranding(),
    integrations: new IntegrationService(createPrismaIntegrationStore(getDb()), loadEnv().APP_KEY),
  });
  return globalForAdmin.__ecomAdminWrites;
}

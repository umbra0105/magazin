import { loadEnv } from "@ecom/config";
import {
  MediaUploadGuard,
  ProductDocumentsService,
  createPrismaProductDocumentStore,
  type ProductDocumentDownloadDeps,
  type ProductDocumentUploadDeps,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { revalidateTag } from "next/cache";
import { getAudit } from "./admin-writes";
import { getStorage } from "./media";
import { getCounterStore, getSettings } from "./services";
import { getCurrentSubject } from "./session";

const globalForDocuments = globalThis as unknown as { __ecomDocuments?: ProductDocumentsService };

/**
 * Documentele de produs (fișe, manuale, declarații, etichete). Stau în stocare sub
 * `private/product-documents/`, nu în biblioteca media; descărcarea trece prin linkuri semnate.
 */
export function getProductDocumentsService(): ProductDocumentsService {
  globalForDocuments.__ecomDocuments ??= new ProductDocumentsService({
    store: createPrismaProductDocumentStore(getDb()),
    storage: getStorage(),
    audit: getAudit(),
    // aceeași limită de pixeli ca la biblioteca media
    getMaxInputPixels: async () => (await getSettings().getGroup("media")).maxInputPixels,
    invalidate: (tags) => {
      for (const tag of tags) revalidateTag(tag);
    },
    logger: getLogger(),
  });
  return globalForDocuments.__ecomDocuments;
}

/** Dependențele rutei de încărcare, legate la serviciile reale. Contoarele au spațiu de nume propriu. */
export function getProductDocumentUploadDeps(): ProductDocumentUploadDeps {
  return {
    getSubject: getCurrentSubject,
    getSettings: async () => {
      const settings = getSettings();
      const [documents, auth] = await Promise.all([
        settings.getGroup("documents"),
        settings.getGroup("auth"),
      ]);
      return { documents, trustedProxyHops: auth.trustedProxyHops };
    },
    appUrl: loadEnv().APP_URL,
    createGuard: (documents) => new MediaUploadGuard(getCounterStore(), documents, "documents"),
    service: getProductDocumentsService(),
    audit: getAudit(),
  };
}

export function getProductDocumentDownloadDeps(): ProductDocumentDownloadDeps {
  return { getSubject: getCurrentSubject, service: getProductDocumentsService() };
}

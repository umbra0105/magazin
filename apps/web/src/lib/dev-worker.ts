import {
  startEmailWorkerFromEnv,
  startImageImportWorkerFromEnv,
  startImportWorkerFromEnv,
  startInvoiceJobsFromEnv,
  startLoyaltyJobsFromEnv,
  startMediaWorkerFromEnv,
  startNirImportWorkerFromEnv,
  startCartJobsFromEnv,
  startOfferJobsFromEnv,
  startOrderEmailJobsFromEnv,
  startOrderJobsFromEnv,
  startPaymentJobsFromEnv,
  startStockJobsFromEnv,
} from "@ecom/jobs";
import { getLogger } from "@ecom/shared";

const globalForWorker = globalThis as unknown as { __ecomDevWorker?: boolean };

/**
 * Doar în dezvoltare: pornește workerii (emailuri, media, importuri) în procesul serverului Next, ca `pnpm dev:web`
 * să fie de ajuns. Un singur worker per proces (chiar și la hot reload). În producție workerul
 * rulează separat (`pnpm worker`).
 */
export function startDevEmailWorker(): void {
  if (globalForWorker.__ecomDevWorker) return;
  globalForWorker.__ecomDevWorker = true;
  try {
    startEmailWorkerFromEnv();
    startMediaWorkerFromEnv();
    startImportWorkerFromEnv();
    startNirImportWorkerFromEnv();
    startImageImportWorkerFromEnv();
    startStockJobsFromEnv();
    startCartJobsFromEnv();
    startOrderJobsFromEnv();
    startPaymentJobsFromEnv();
    startOrderEmailJobsFromEnv();
    startOfferJobsFromEnv();
    startInvoiceJobsFromEnv();
    startLoyaltyJobsFromEnv();
    getLogger().info(
      {
        queues: ["emails", "media", "product-import", "nir-import", "product-import-images"],
        jobs: [
          "stock-expire-reservations",
          "stock-snapshot-freshness",
          "stock-alerts-cleanup",
          "stock-back-in-stock",
          "cart-purge-expired",
          "order-expire-transfers",
          "payment-events (coadă)",
          "payment-events-sweep",
          "payment-refunds-sweep",
          "order-expire-card",
          "order-email-sweep",
          "offer-expire",
          "payment-reconcile",
          "invoices (coadă)",
          "invoice-sweep",
          "invoice-efactura",
          "loyalty-grant",
          "loyalty-expire",
          "loyalty-expiry-warning",
        ],
      },
      "workeri porniți în procesul de dezvoltare",
    );
  } catch (error) {
    globalForWorker.__ecomDevWorker = false;
    getLogger().warn(
      { reason: error instanceof Error ? error.message : String(error) },
      "nu am putut porni workerii în dezvoltare",
    );
  }
}

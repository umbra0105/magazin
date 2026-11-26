/**
 * Procesul de worker: `pnpm worker`. Consumă cozile `emails`, `media`, `product-import`, `product-import-images` și `payment-events` (plăți, Faza 10), și rulează periodic retenția conturilor neverificate și joburile de stoc (expirarea rezervărilor, prospețimea pozei, curățarea cererilor «Anunță-mă» și trimiterea emailurilor «Anunță-mă când revine»). În dezvoltare, `pnpm dev:web`
 * pornește aceiași workeri în procesul aplicației, deci nu trebuie rulat separat.
 */
import { getLogger } from "@ecom/shared";
import { startAuthRetentionFromEnv } from "./auth-retention";
import { startImageImportWorkerFromEnv } from "./image-import-runtime";
import { startImportWorkerFromEnv } from "./import-runtime";
import { startMediaWorkerFromEnv } from "./media-runtime";
import { startNirImportWorkerFromEnv } from "./nir-runtime";
import { startEmailWorkerFromEnv } from "./runtime";
import { startPriceJobsFromEnv } from "./price-jobs";
import { startStockJobsFromEnv } from "./stock-jobs";
import { startCartJobsFromEnv } from "./cart-jobs";
import { startDigitalJobsFromEnv } from "./digital-jobs";
import { startLoyaltyJobsFromEnv } from "./loyalty-jobs";
import { startOrderJobsFromEnv } from "./order-jobs";
import { startPaymentJobsFromEnv } from "./payment-jobs";
import { startOfferJobsFromEnv } from "./offer-jobs";
import { startShippingJobsFromEnv } from "./shipping-jobs";
import { startInvoiceJobsFromEnv } from "./invoice-jobs";
import { startOrderEmailJobsFromEnv } from "./order-email-jobs";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // fără .env: variabilele vin din mediu
}

const logger = getLogger();
const email = startEmailWorkerFromEnv();
const media = startMediaWorkerFromEnv();
const imports = startImportWorkerFromEnv();
const nirImports = startNirImportWorkerFromEnv();
const importImages = startImageImportWorkerFromEnv();
const authRetention = startAuthRetentionFromEnv();
const stockJobs = startStockJobsFromEnv();
const priceJobs = startPriceJobsFromEnv();
const cartJobs = startCartJobsFromEnv();
const digitalJobs = startDigitalJobsFromEnv();
const loyaltyJobs = startLoyaltyJobsFromEnv();
const orderJobs = startOrderJobsFromEnv();
const paymentJobs = startPaymentJobsFromEnv();
const orderEmailJobs = startOrderEmailJobsFromEnv();
const offerJobs = startOfferJobsFromEnv();
const shippingJobs = startShippingJobsFromEnv();
const invoiceJobs = startInvoiceJobsFromEnv();
logger.info(
  {
    queues: [
      "emails",
      "media",
      "product-import",
      "nir-import",
      "product-import-images",
      "payment-events",
      "invoices",
    ],
  },
  "worker pornit (Ctrl+C pentru oprire)",
);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "worker: opresc după joburile în curs");
  try {
    authRetention.close();
    stockJobs.close();
    priceJobs.close();
    cartJobs.close();
    digitalJobs.close();
    loyaltyJobs.close();
    orderJobs.close();
    offerJobs.close();
    shippingJobs.close();
    await paymentJobs.close();
    await invoiceJobs.close();
    await orderEmailJobs.close();
    await Promise.all([
      email.close(),
      media.close(),
      imports.close(),
      nirImports.close(),
      importImages.close(),
    ]);
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

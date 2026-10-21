/**
 * Procesul de worker: `pnpm worker`. Consumă cozile `emails`, `media`, `product-import` și `product-import-images`, și rulează periodic retenția conturilor neverificate. În dezvoltare, `pnpm dev:web`
 * pornește aceiași workeri în procesul aplicației, deci nu trebuie rulat separat.
 */
import { getLogger } from "@ecom/shared";
import { startAuthRetentionFromEnv } from "./auth-retention";
import { startImageImportWorkerFromEnv } from "./image-import-runtime";
import { startImportWorkerFromEnv } from "./import-runtime";
import { startMediaWorkerFromEnv } from "./media-runtime";
import { startEmailWorkerFromEnv } from "./runtime";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // fără .env: variabilele vin din mediu
}

const logger = getLogger();
const email = startEmailWorkerFromEnv();
const media = startMediaWorkerFromEnv();
const imports = startImportWorkerFromEnv();
const importImages = startImageImportWorkerFromEnv();
const authRetention = startAuthRetentionFromEnv();
logger.info(
  { queues: ["emails", "media", "product-import", "product-import-images"] },
  "worker pornit (Ctrl+C pentru oprire)",
);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "worker: opresc după joburile în curs");
  try {
    authRetention.close();
    await Promise.all([email.close(), media.close(), imports.close(), importImages.close()]);
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

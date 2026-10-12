/**
 * Procesul de worker: `pnpm worker`. Consumă coada de emailuri. În dezvoltare, `pnpm dev:web`
 * pornește același worker în procesul aplicației, deci nu trebuie rulat separat.
 */
import { getLogger } from "@ecom/shared";
import { startEmailWorkerFromEnv } from "./runtime";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // fără .env: variabilele vin din mediu
}

const logger = getLogger();
const running = startEmailWorkerFromEnv();
logger.info({ queue: "emails" }, "worker pornit (Ctrl+C pentru oprire)");

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "worker: opresc după joburile în curs");
  try {
    await running.close();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

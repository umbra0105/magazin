import { startEmailWorkerFromEnv, startMediaWorkerFromEnv } from "@ecom/jobs";
import { getLogger } from "@ecom/shared";

const globalForWorker = globalThis as unknown as { __ecomDevWorker?: boolean };

/**
 * Doar în dezvoltare: pornește workerii (emailuri, media) în procesul serverului Next, ca `pnpm dev:web`
 * să fie de ajuns. Un singur worker per proces (chiar și la hot reload). În producție workerul
 * rulează separat (`pnpm worker`).
 */
export function startDevEmailWorker(): void {
  if (globalForWorker.__ecomDevWorker) return;
  globalForWorker.__ecomDevWorker = true;
  try {
    startEmailWorkerFromEnv();
    startMediaWorkerFromEnv();
    getLogger().info({ queues: ["emails", "media"] }, "workeri porniți în procesul de dezvoltare");
  } catch (error) {
    globalForWorker.__ecomDevWorker = false;
    getLogger().warn(
      { reason: error instanceof Error ? error.message : String(error) },
      "nu am putut porni workerii în dezvoltare",
    );
  }
}

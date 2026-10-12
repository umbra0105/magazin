import type { Instrumentation } from "next";

// Importurile sunt dinamice și păzite de runtime, ca bundle-ul edge (middleware)
// să nu tragă după el Postgres/Redis: DSN-ul se citește doar în runtime Node.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { sentry } = await import("./lib/sentry");
    await sentry.sync();
    // Doar în dezvoltare: workerul de emailuri rulează în procesul serverului (`pnpm dev:web`).
    if (process.env.NODE_ENV === "development") {
      const { startDevEmailWorker } = await import("./lib/dev-worker");
      startDevEmailWorker();
    }
  }
}

export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { sentry } = await import("./lib/sentry");
    await sentry.captureRequestError(...args);
  }
};

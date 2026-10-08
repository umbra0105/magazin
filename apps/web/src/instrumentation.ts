import type { Instrumentation } from "next";

// Importurile sunt dinamice și păzite de runtime, ca bundle-ul edge (middleware)
// să nu tragă după el Postgres/Redis: DSN-ul se citește doar în runtime Node.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { sentry } = await import("./lib/sentry");
    await sentry.sync();
  }
}

export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { sentry } = await import("./lib/sentry");
    await sentry.captureRequestError(...args);
  }
};

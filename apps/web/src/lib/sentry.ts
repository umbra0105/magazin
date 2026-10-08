import { createSentryController } from "./sentry-controller";

/** Instanța Sentry a aplicației. DSN-ul vine din `Setting` (`monitoring.sentryDsn`), nu din .env. */
export const sentry = createSentryController({
  getDsn: async () => {
    // Import dinamic: instrumentation.ts se încarcă și în runtime edge, unde nu există DB.
    const { getSettings } = await import("./services");
    return getSettings().get("monitoring.sentryDsn");
  },
  loadSentry: () => import("@sentry/nextjs"),
});

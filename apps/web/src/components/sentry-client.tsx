"use client";

import { useEffect } from "react";

/**
 * Pornește Sentry în browser doar dacă setările au un DSN. Fără DSN nu se încarcă SDK-ul
 * și nu se trimite nimic către Sentry; singura cerere e către propriul server.
 */
export function SentryClient() {
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      const response = await fetch("/api/monitoring/config", { signal: controller.signal });
      if (!response.ok) return;
      const { dsn } = (await response.json()) as { dsn?: string };
      if (!dsn) return;
      const Sentry = await import("@sentry/nextjs");
      Sentry.init({ dsn, tracesSampleRate: 0, dataCollection: { userInfo: false } });
    })().catch(() => undefined);
    return () => controller.abort();
  }, []);

  return null;
}

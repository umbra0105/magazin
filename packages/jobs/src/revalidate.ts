import { loadEnv } from "@ecom/config";
import { createRemoteRevalidator } from "@ecom/core";
import { getLogger } from "@ecom/shared";

/**
 * Invalidarea cache-ului vitrinei pentru joburile din worker (C-37): cerere semnată spre aplicația web (`APP_URL`), cu cheia
 * derivată din `APP_KEY`. Nu aruncă: dacă aplicația nu răspunde, TTL-ul paginilor acoperă diferența.
 */
export function createWorkerRevalidator(): (tags: readonly string[]) => Promise<void> {
  const env = loadEnv();
  return createRemoteRevalidator({ appUrl: env.APP_URL, appKey: env.APP_KEY, logger: getLogger() });
}

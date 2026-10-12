import type { ConnectionOptions } from "bullmq";

/**
 * BullMQ își creează singur conexiunile Redis (cu propriul `ioredis`), din opțiuni. Construim
 * opțiunile din `REDIS_URL`: gazdă, port, DB, utilizator, parolă și TLS pentru `rediss://`.
 */
export function redisConnectionFromUrl(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const db = Number(url.pathname.replace(/^\//, "") || 0);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    db: Number.isFinite(db) ? db : 0,
    ...(url.username && { username: decodeURIComponent(url.username) }),
    ...(url.password && { password: decodeURIComponent(url.password) }),
    ...(url.protocol === "rediss:" && { tls: {} }),
  };
}

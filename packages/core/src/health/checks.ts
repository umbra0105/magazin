import { Client } from "pg";
import { Redis } from "ioredis";

export interface CheckResult {
  ok: boolean;
  latencyMs: number;
  /** Mesaj tehnic, doar pentru loguri. Nu se expune în răspunsul public. */
  error?: string;
}

export const CHECK_TIMEOUT_MS = 2000;

/** Rulează `probe` cu timeout și transformă orice excepție într-un CheckResult. */
export async function runCheck(
  probe: () => Promise<void>,
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<CheckResult> {
  const startedAt = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout după ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    return { ok: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function checkDatabase(databaseUrl: string): Promise<CheckResult> {
  return runCheck(async () => {
    const client = new Client({
      connectionString: databaseUrl,
      connectionTimeoutMillis: CHECK_TIMEOUT_MS,
    });
    // Fără handler, o eroare asincronă a conexiunii ar opri procesul.
    client.on("error", () => undefined);
    try {
      await client.connect();
      await client.query("SELECT 1");
    } finally {
      await client.end().catch(() => undefined);
    }
  });
}

export function checkRedis(redisUrl: string): Promise<CheckResult> {
  return runCheck(async () => {
    const redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      connectTimeout: CHECK_TIMEOUT_MS,
    });
    redis.on("error", () => undefined);
    try {
      await redis.connect();
      await redis.ping();
    } finally {
      redis.disconnect();
    }
  });
}

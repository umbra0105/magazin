import { checkDatabase, checkRedis, type CheckResult } from "./checks";

export { checkDatabase, checkRedis, runCheck, type CheckResult } from "./checks";

export interface HealthReport {
  status: "ok" | "degraded";
  checks: { database: CheckResult; redis: CheckResult };
}

export interface HealthDependencies {
  databaseUrl: string;
  redisUrl: string;
}

export function summarizeHealth(checks: HealthReport["checks"]): HealthReport {
  const allOk = Object.values(checks).every((check) => check.ok);
  return { status: allOk ? "ok" : "degraded", checks };
}

export interface HealthOptions {
  /** Probele; implicit `checkDatabase`/`checkRedis` pe adresele din dependențe (injectabile în teste). */
  probes?: { database: () => Promise<CheckResult>; redis: () => Promise<CheckResult> };
  /** Cât timp rămâne valabil un rezultat bun. */
  ttlMs?: number;
  /** Cât timp rămâne valabil un rezultat degradat (mai scurt: revenirea trebuie să se vadă repede). */
  degradedTtlMs?: number;
  now?: () => number;
}

/** Rezultat valabil 5 s (1 s dacă e degradat): cererile publice nu mai deschid conexiuni noi la fiecare apel. */
const DEFAULT_TTL_MS = 5_000;
const DEFAULT_DEGRADED_TTL_MS = 1_000;

interface CacheEntry {
  expiresAt: number;
  report: Promise<HealthReport>;
}
const cache = new Map<string, CacheEntry>();

/**
 * Verifică în paralel dependențele critice (Postgres, Redis). `/api/health` este public și deschidea o conexiune
 * nouă de fiecare dată: câteva sute de cereri paralele epuizau `max_connections` (Blocul C, C-09). Acum verificarea
 * rulează cel mult o dată pe fereastră per pereche de adrese, iar cererile simultane așteaptă aceeași verificare.
 */
export async function checkHealth(
  dependencies: HealthDependencies,
  options: HealthOptions = {},
): Promise<HealthReport> {
  const now = options.now ?? Date.now;
  const key = `${dependencies.databaseUrl}|${dependencies.redisUrl}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now()) return cached.report;

  const probes = options.probes ?? {
    database: () => checkDatabase(dependencies.databaseUrl),
    redis: () => checkRedis(dependencies.redisUrl),
  };
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const degradedTtl = options.degradedTtlMs ?? DEFAULT_DEGRADED_TTL_MS;
  const entry: CacheEntry = {
    // valabil cât timp rulează verificarea; la final primește termenul real
    expiresAt: Number.POSITIVE_INFINITY,
    report: Promise.all([probes.database(), probes.redis()]).then(([database, redis]) => {
      const report = summarizeHealth({ database, redis });
      entry.expiresAt = now() + (report.status === "ok" ? ttl : degradedTtl);
      return report;
    }),
  };
  // o verificare care aruncă nu rămâne în memorie
  entry.report.catch(() => cache.delete(key));
  cache.set(key, entry);
  return entry.report;
}

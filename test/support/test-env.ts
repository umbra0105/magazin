/**
 * Mediul testelor de integrare: bază Postgres și DB Redis SEPARATE de cele de dezvoltare, ca
 * `pnpm test:integration` să nu atingă datele locale (seed, setări, flag-uri, branding).
 */

const TEST_NAME = /test/i;

/** `postgresql://u:p@host:5432/ecom` → `postgresql://u:p@host:5432/ecom_test`. */
export function deriveTestDatabaseUrl(databaseUrl: string, override?: string): string {
  if (override) return override;
  const url = new URL(databaseUrl);
  const name = url.pathname.replace(/^\//, "");
  if (!name) throw new Error("DATABASE_URL nu conține numele bazei de date");
  url.pathname = TEST_NAME.test(name) ? `/${name}` : `/${name}_test`;
  return url.toString();
}

/** Redis: alt index de DB (1 sau, dacă dezvoltarea îl folosește deja, următorul). */
export function deriveTestRedisUrl(redisUrl: string, override?: string): string {
  if (override) return override;
  const url = new URL(redisUrl);
  const devDb = Number(url.pathname.replace(/^\//, "") || 0);
  url.pathname = `/${devDb === 1 ? 2 : 1}`;
  return url.toString();
}

export function databaseName(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.replace(/^\//, "");
}

export function redisDbIndex(redisUrl: string): number {
  return Number(new URL(redisUrl).pathname.replace(/^\//, "") || 0);
}

/** Refuză orice bază care nu are „test” în nume. Aruncă o eroare cu mesaj clar. */
export function assertTestDatabase(databaseUrl: string | undefined): asserts databaseUrl is string {
  if (!databaseUrl) {
    throw new Error("Testele de integrare cer DATABASE_URL (sau TEST_DATABASE_URL) setat.");
  }
  const name = databaseName(databaseUrl);
  if (!TEST_NAME.test(name)) {
    throw new Error(
      `REFUZ să rulez testele de integrare pe baza „${name}”: numele ei nu conține „test”. ` +
        "Testele șterg date. Folosește o bază de test (implicit <nume>_test) sau setează " +
        "TEST_DATABASE_URL către una.",
    );
  }
}

/** Refuză Redis-ul de pe indexul 0 (al dezvoltării). */
export function assertTestRedis(redisUrl: string | undefined): asserts redisUrl is string {
  if (!redisUrl) throw new Error("Testele de integrare cer REDIS_URL (sau TEST_REDIS_URL) setat.");
  if (redisDbIndex(redisUrl) === 0) {
    throw new Error(
      "REFUZ să rulez testele de integrare pe Redis DB 0 (cel de dezvoltare). " +
        "Folosește un alt index (implicit 1) sau setează TEST_REDIS_URL.",
    );
  }
}

export interface IntegrationEnv {
  DATABASE_URL: string;
  REDIS_URL: string;
}

/**
 * Valorile pe care le primesc testele de integrare. Nu aruncă dacă lipsește DATABASE_URL/REDIS_URL
 * (rularea doar a testelor unitare nu le cere); gărzile din `integration-guard.ts` refuză apoi.
 */
export function integrationEnv(env: NodeJS.ProcessEnv = process.env): Partial<IntegrationEnv> {
  const out: Partial<IntegrationEnv> = {};
  if (env["TEST_DATABASE_URL"] || env["DATABASE_URL"]) {
    out.DATABASE_URL = deriveTestDatabaseUrl(
      env["DATABASE_URL"] ?? env["TEST_DATABASE_URL"] ?? "",
      env["TEST_DATABASE_URL"],
    );
  }
  if (env["TEST_REDIS_URL"] || env["REDIS_URL"]) {
    out.REDIS_URL = deriveTestRedisUrl(
      env["REDIS_URL"] ?? env["TEST_REDIS_URL"] ?? "",
      env["TEST_REDIS_URL"],
    );
  }
  return out;
}

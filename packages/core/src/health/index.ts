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

/** Verifică în paralel dependențele critice (Postgres, Redis). */
export async function checkHealth(dependencies: HealthDependencies): Promise<HealthReport> {
  const [database, redis] = await Promise.all([
    checkDatabase(dependencies.databaseUrl),
    checkRedis(dependencies.redisUrl),
  ]);
  return summarizeHealth({ database, redis });
}

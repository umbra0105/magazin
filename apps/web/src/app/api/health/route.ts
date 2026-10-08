import { NextResponse } from "next/server";
import { APP_VERSION, loadEnv } from "@ecom/config";
import { checkHealth } from "@ecom/core";
import {
  REQUEST_ID_HEADER,
  getLogger,
  resolveRequestId,
  runWithRequestContext,
} from "@ecom/shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));

  return runWithRequestContext({ requestId }, async () => {
    const env = loadEnv();
    const report = await checkHealth({ databaseUrl: env.DATABASE_URL, redisUrl: env.REDIS_URL });

    const logger = getLogger();
    for (const [name, check] of Object.entries(report.checks)) {
      if (!check.ok) logger.error({ check: name, error: check.error }, "health check eșuat");
    }

    // Răspunsul public nu conține mesajele de eroare, doar starea.
    const checks = Object.fromEntries(
      Object.entries(report.checks).map(([name, { ok, latencyMs }]) => [name, { ok, latencyMs }]),
    );
    return NextResponse.json(
      { status: report.status, version: APP_VERSION, checks },
      { status: report.status === "ok" ? 200 : 503, headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  });
}

import { NextResponse } from "next/server";
import { getLogger } from "@ecom/shared";
import { getSettings } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * DSN-ul Sentry pentru browser. Nu e secret (oricum ajunge în clientul public), dar vine din
 * setări, nu din .env, deci browserul îl cere de aici în loc să fie copt în build.
 */
export async function GET() {
  let dsn = "";
  try {
    dsn = await getSettings().get("monitoring.sentryDsn");
  } catch (error) {
    getLogger().warn({ err: error }, "nu pot citi DSN-ul Sentry pentru client");
  }
  return NextResponse.json(
    { dsn },
    { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=60" } },
  );
}

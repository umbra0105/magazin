import { loadEnv } from "@ecom/config";
import { serveSignedObject } from "@ecom/core";
import { deriveSigningKey } from "@ecom/integrations";
import { getStorage } from "@/lib/media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Fișiere private cu link semnat (driverul `local`). Fără semnătură HMAC validă și neexpirată
 * nu se citește nimic. Pe S3, linkurile semnate sunt cele native (presigned) și nu trec pe aici.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const storage = getStorage();
  if (storage.kind !== "local") {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  const { path } = await context.params;
  return serveSignedObject(storage, path, new URL(request.url).searchParams, {
    signingKey: deriveSigningKey(loadEnv().APP_KEY),
  });
}

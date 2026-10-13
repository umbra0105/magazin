import { handleMediaUpload } from "@ecom/core";
import { getMediaUploadDeps } from "@/lib/media";

export const dynamic = "force-dynamic";
// sharp e un modul nativ: rulează în Node.js, nu în Edge.
export const runtime = "nodejs";

/**
 * Încărcare imagine în biblioteca media. Toată logica (origine, sesiune, `media.write`, rate limit,
 * mărime în timpul stream-ului, tip real, audit) e în `handleMediaUpload` din `@ecom/core`.
 */
export async function POST(request: Request): Promise<Response> {
  return handleMediaUpload(request, getMediaUploadDeps());
}

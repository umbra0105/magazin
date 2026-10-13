import { servePublicObject } from "@ecom/core";
import { getStorage } from "@/lib/media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Fișiere publice (`public/…` din storage): imagini din biblioteca media. Cu `S3_PUBLIC_URL` setat,
 * adresele nu mai trec pe aici (merg direct la CDN / bucket). Din această rută nu se poate ajunge
 * la `private/`: prefixul `public/` îl pune serverul, iar cheile cu `..` sau caractere
 * periculoase dau 404 (vezi `servePublicObject`).
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await context.params;
  return servePublicObject(getStorage(), path);
}

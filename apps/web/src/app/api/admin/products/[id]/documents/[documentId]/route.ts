import { handleProductDocumentDownload } from "@ecom/core";
import { getProductDocumentDownloadDeps } from "@/lib/product-documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Descărcarea unui document: sesiune + `products.read`, apoi redirecționare la un link semnat cu
 * expirare scurtă și `Content-Disposition: attachment`. Fișierul nu se servește inline din
 * originea magazinului.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; documentId: string }> },
): Promise<Response> {
  const { id, documentId } = await context.params;
  return handleProductDocumentDownload(id, documentId, getProductDocumentDownloadDeps());
}

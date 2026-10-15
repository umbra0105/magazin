import { handleProductDocumentUpload } from "@ecom/core";
import { getProductDocumentUploadDeps } from "@/lib/product-documents";

export const dynamic = "force-dynamic";
// sharp (curățarea imaginilor) e un modul nativ: rulează în Node.js, nu în Edge.
export const runtime = "nodejs";

/**
 * Încărcare document de produs. Toată logica (origine, sesiune, `products.content.write`, rate limit,
 * mărime în timpul stream-ului, tip real din octeți, conținut activ în PDF, audit) e în
 * `handleProductDocumentUpload` din `@ecom/core`; testul de arhitectură al rutelor de upload cere
 * ca handlerul să conțină verificarea de origine și cea de permisiune.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleProductDocumentUpload(request, id, getProductDocumentUploadDeps());
}

import { handleProductImportUpload } from "@ecom/core";
import { getProductImportUploadDeps } from "@/lib/product-imports";

export const dynamic = "force-dynamic";
// parsarea XLSX și citirea fișierului rulează în Node.js, nu în Edge.
export const runtime = "nodejs";

/**
 * Încărcarea fișierului unui import de produse. Toată logica (origine, sesiune, `products.write`,
 * rate limit, mărime în timpul stream-ului, format real din octeți, limite, arhivă XLSX curățată,
 * stocare privată) e în `handleProductImportUpload` din `@ecom/core`; testul de arhitectură al
 * rutelor de upload cere ca handlerul să conțină verificarea de origine și cea de permisiune.
 */
export async function POST(request: Request): Promise<Response> {
  return handleProductImportUpload(request, getProductImportUploadDeps());
}

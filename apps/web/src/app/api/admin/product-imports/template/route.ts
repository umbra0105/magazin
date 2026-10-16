import { handleProductImportTemplate } from "@ecom/core";
import { getProductImportDownloadDeps } from "@/lib/product-imports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Șablonul de import (`?format=csv|xlsx`), cu sesiune și `products.write`. */
export async function GET(request: Request): Promise<Response> {
  return handleProductImportTemplate(request, getProductImportDownloadDeps());
}

import { handleProductExport } from "@ecom/core";
import { getProductExportRouteDeps } from "@/lib/product-exports";

export const dynamic = "force-dynamic";
// scrierea XLSX și citirea din bază rulează în Node.js, nu în Edge.
export const runtime = "nodejs";

/**
 * Exportul de produse (CSV în flux, XLSX). Toată logica (origine, sesiune, `products.export`, rate limit
 * propriu, cerere validă, limită de rânduri, audit) e în `handleProductExport` din `@ecom/core`; testul
 * de arhitectură al rutelor care scriu cere ca handlerul să conțină verificarea de origine și cea de
 * permisiune. POST, nu GET: cere verificarea originii (un GET ar putea fi declanșat de o pagină străină).
 */
export async function POST(request: Request): Promise<Response> {
  return handleProductExport(request, getProductExportRouteDeps());
}

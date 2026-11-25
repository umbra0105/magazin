import { handleNirUpload } from "@ecom/core";
import { getNirUploadDeps } from "@/lib/nir-imports";

export const dynamic = "force-dynamic";
// citirea .xls / .xlsx rulează în Node.js, nu în Edge.
export const runtime = "nodejs";

/**
 * Încărcarea exportului SmartBill «mișcări produse» pentru importul prețurilor de achiziție (previzualizare, fără modificări în
 * catalog). Toată logica (origine, sesiune, `products.cost.import` și `products.cost.view`, rate limit, mărime, format real) e în
 * `handleNirUpload` din `@ecom/core`; confirmarea e o acțiune de server separată.
 */
export async function POST(request: Request): Promise<Response> {
  return handleNirUpload(request, getNirUploadDeps());
}

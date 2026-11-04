import { handleStockActivationUpload } from "@ecom/core";
import { getStockActivationUploadDeps } from "@/lib/stock-imports";

export const dynamic = "force-dynamic";
// citirea .xls / .xlsx rulează în Node.js, nu în Edge.
export const runtime = "nodejs";

/**
 * Încărcarea raportului SmartBill «Stoc la zi» pentru pornirea în masă a gestionării stocului (previzualizare și aplicare).
 * Toată logica (origine, sesiune, `products.write` ȘI `inventory.write`, rate limit, mărime în timpul stream-ului, format real
 * din octeți, plan, tranzacție) e în `handleStockActivationUpload` din `@ecom/core`; testele de arhitectură ale rutelor cer ca
 * handlerul să conțină verificarea de origine și cea de permisiune.
 */
export async function POST(request: Request): Promise<Response> {
  return handleStockActivationUpload(request, getStockActivationUploadDeps());
}

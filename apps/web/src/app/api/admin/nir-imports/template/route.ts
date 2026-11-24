import { can, csvResponse } from "@ecom/core";
import { getNirImportService } from "@/lib/nir-imports";
import { getCurrentSubject } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Șablonul de import NIR (CSV pentru Excel: UTF-16LE cu BOM, TAB, fără linia de separator, antet în română, rânduri-exemplu inventate). Cere
 * sesiune și `products.cost.view` (aceeași regulă ca raportul).
 */
export async function GET(): Promise<Response> {
  const subject = await getCurrentSubject();
  if (!subject)
    return Response.json({ code: "AUTH_UNAUTHENTICATED" }, { status: 401, headers: NO_STORE });
  if (!can(subject, "products.cost.view")) {
    return Response.json({ code: "AUTH_FORBIDDEN" }, { status: 403, headers: NO_STORE });
  }
  return csvResponse(getNirImportService().templateRows(subject), "sablon-import-pret-nir.csv");
}

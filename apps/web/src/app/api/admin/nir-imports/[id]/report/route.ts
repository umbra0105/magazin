import { can, csvResponse } from "@ecom/core";
import { getNirImportService } from "@/lib/nir-imports";
import { getCurrentSubject } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };
const ID = /^[a-z0-9]{10,40}$/;

/**
 * Raportul unui import NIR (CSV pentru Excel). Conține prețuri de achiziție, deci cere sesiune și `products.cost.view`; fără ele,
 * 401 / 403 și niciun octet din raport.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const subject = await getCurrentSubject();
  if (!subject)
    return Response.json({ code: "AUTH_UNAUTHENTICATED" }, { status: 401, headers: NO_STORE });
  if (!can(subject, "products.cost.view")) {
    return Response.json({ code: "AUTH_FORBIDDEN" }, { status: 403, headers: NO_STORE });
  }
  const { id } = await context.params;
  if (!ID.test(id))
    return Response.json({ code: "NIR_IMPORT_NOT_FOUND" }, { status: 404, headers: NO_STORE });
  try {
    const rows = await getNirImportService().reportRows(subject, id);
    return csvResponse(rows, `raport-import-pret-nir-${id}.csv`);
  } catch (error) {
    if ((error as { code?: string }).code === "NIR_IMPORT_NOT_FOUND") {
      return Response.json({ code: "NIR_IMPORT_NOT_FOUND" }, { status: 404, headers: NO_STORE });
    }
    throw error;
  }
}

import { handleProductImportReport } from "@ecom/core";
import { getProductImportDownloadDeps } from "@/lib/product-imports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Raportul unui import ca CSV: sesiune, `products.write`, doar importul propriu. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleProductImportReport(id, getProductImportDownloadDeps());
}

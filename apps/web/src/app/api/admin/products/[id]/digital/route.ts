import { handleDigitalAssetUpload } from "@ecom/core";
import { getDigitalUploadDeps } from "@/lib/digital";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Încărcare modul digital (fișier sau video) al unui produs. Toată logica (origine, sesiune, `digital.manage`, limită de cereri,
 * mărime în timpul stream-ului, extensii refuzate, furnizor din setări, stocare, audit) e în `handleDigitalAssetUpload` din
 * `@ecom/core`; testul de arhitectură al rutelor de upload cere ca handlerul să conțină verificarea de origine și cea de permisiune.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleDigitalAssetUpload(request, id, getDigitalUploadDeps());
}

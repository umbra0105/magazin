import { requestPreview } from "@ecom/core";
import { getLogger } from "@ecom/shared";
import { getDigitalAccessDeps } from "@/lib/digital";
import { allowCheckoutRequest } from "@/lib/checkout";
import { getMessages } from "@/messages";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

/**
 * Lecția de PREVIEW gratuită a unui produs digital (Faza 14b): fără cont, fără contor, fără jurnal. Doar modulele marcate pentru
 * previzualizare, gata, ale unui produs activ; orice altceva dă 404 (`requestPreview`). Limită de cereri pe IP. Doar citire (nu
 * schimbă nimic), deci GET; linkul are expirare scurtă și nu se pune în cache.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ assetId: string }> },
): Promise<Response> {
  const { assetId } = await context.params;
  const errors = getMessages().digital.errors;
  if (!(await allowCheckoutRequest("geo"))) {
    return Response.json(
      { ok: false, code: "rateLimited", message: errors["rateLimited"] },
      { status: 429, headers: NO_STORE },
    );
  }
  try {
    const grant = await requestPreview(getDigitalAccessDeps(), assetId);
    return Response.json(
      {
        ok: true,
        kind: grant.kind,
        url: grant.url,
        expiresAt: grant.expiresAt?.toISOString() ?? null,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "DIGITAL_NOT_FOUND") {
      return Response.json(
        { ok: false, code, message: errors["DIGITAL_NOT_FOUND"] },
        { status: 404, headers: NO_STORE },
      );
    }
    if (code === "DIGITAL_PROVIDER_UNAVAILABLE") {
      return Response.json(
        { ok: false, code, message: errors["DIGITAL_PROVIDER_UNAVAILABLE"] },
        { status: 503, headers: NO_STORE },
      );
    }
    getLogger().error({ err: error }, "previzualizarea digitală a eșuat");
    return Response.json(
      { ok: false, code: "failed", message: errors["failed"] },
      { status: 500, headers: NO_STORE },
    );
  }
}

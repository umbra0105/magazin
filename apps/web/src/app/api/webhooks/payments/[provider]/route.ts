import { ingestPaymentWebhook, isProviderCode } from "@ecom/core";
import { getLogger } from "@ecom/shared";
import { getPaymentProcessorDeps } from "@/lib/payments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Notificările de plată sunt mici; peste limită se refuză fără să se citească. */
const MAX_BODY_BYTES = 256 * 1024;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Webhook/IPN de la procesatorii de plăți (Faza 10), server-la-server: `POST /api/webhooks/payments/<furnizor>`.
 *
 *  - citește corpul BRUT (octeții primiți: semnătura se verifică pe ei, nu pe o reserializare);
 *  - NU are cale fără semnătură: `ingestPaymentWebhook` verifică semnătura prin adaptorul furnizorului, în timp constant;
 *    o notificare fără semnătură validă e respinsă (401), înregistrată FĂRĂ conținut și fără niciun efect;
 *  - o notificare validă se înregistrează (unicitate pe furnizor + eveniment) și se pune în coadă; răspunsul pleacă imediat, în
 *    formatul cerut de procesator (EuPlătesc: text simplu `OK`, doar după înregistrare); procesarea e asincronă;
 *  - nu loghează corpul, antetele sau valori de plată: doar furnizorul și rezultatul.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await context.params;
  if (!isProviderCode(provider))
    return new Response("Not found", { status: 404, headers: NO_STORE });

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES)
    return new Response("Too large", { status: 413, headers: NO_STORE });
  const rawBody = Buffer.from(await request.arrayBuffer());
  if (rawBody.length > MAX_BODY_BYTES)
    return new Response("Too large", { status: 413, headers: NO_STORE });

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  try {
    const result = await ingestPaymentWebhook(getPaymentProcessorDeps(), provider, {
      headers,
      rawBody,
    });
    if (result.outcome === "rejected") {
      getLogger().warn({ provider }, "plăți: notificare respinsă (semnătură sau configurare)");
    }
    return new Response(result.body, {
      status: result.status,
      headers: { "content-type": result.contentType, ...NO_STORE },
    });
  } catch {
    // eroare internă (de exemplu baza de date): 500, ca procesatorul să retrimită; nimic din corp nu intră în log
    getLogger().error({ provider }, "plăți: eroare la înregistrarea notificării");
    return new Response("Error", { status: 500, headers: NO_STORE });
  }
}

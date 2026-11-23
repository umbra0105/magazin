import { headers } from "next/headers";
import { loadEnv } from "@ecom/config";
import { isSameOriginRequest, requestAccess, resolveClientIp } from "@ecom/core";
import { getLogger } from "@ecom/shared";
import { allowAccountRequest, getCustomer } from "@/lib/account";
import { getDigitalAccessDeps } from "@/lib/digital";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

const STATUS: Record<string, number> = {
  DIGITAL_NOT_FOUND: 404,
  DIGITAL_REVOKED: 403,
  DIGITAL_EXPIRED: 403,
  DIGITAL_LIMIT_REACHED: 403,
  DIGITAL_ASSET_UNAVAILABLE: 409,
  DIGITAL_PROVIDER_UNAVAILABLE: 503,
  DIGITAL_INPUT_INVALID: 400,
};

const codeOf = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("DIGITAL_") ? code : null;
};

/** Jetonul dreptului și modulul cerut, din JSON (playerul) sau din formular (descărcarea); `null` dacă cererea nu se poate citi. */
async function readBody(request: Request): Promise<{ token: string; asset: string } | null> {
  try {
    if ((request.headers.get("content-type") ?? "").includes("application/json")) {
      const json = (await request.json()) as { token?: unknown; asset?: unknown };
      return {
        token: typeof json.token === "string" ? json.token : "",
        asset: typeof json.asset === "string" ? json.asset : "",
      };
    }
    const form = await request.formData();
    return { token: String(form.get("token") ?? ""), asset: String(form.get("asset") ?? "") };
  } catch {
    return null;
  }
}

/**
 * Emite un link de acces pentru un modul al unui produs digital al clientului AUTENTIFICAT (Faza 14b). Doar POST (nu se poate
 * previzualiza sau «pre-încărca» de un browser: fiecare descărcare consumă din limită), cu verificare de origine și limită de cereri
 * pe client. Toată logica (proprietate în aceeași interogare, revocare, expirare, limită atomică, jurnal) e în `requestAccess`.
 *
 *  - cerere de formular (descărcare): 303 spre linkul semnat; la eroare, înapoi la pagina produsului, cu codul erorii;
 *  - `Accept: application/json` (playerul): `{ ok, kind, url, expiresAt, remainingDownloads }`.
 * Răspunsurile nu se pun în cache și nu poartă `Referer`; cheia de stocare nu apare niciodată.
 */
export async function POST(request: Request): Promise<Response> {
  const wantsJson = (request.headers.get("accept") ?? "").includes("application/json");
  if (!isSameOriginRequest(request.headers, loadEnv().APP_URL)) {
    return new Response("Cerere refuzată", { status: 403, headers: NO_STORE });
  }
  const customer = await getCustomer();
  if (!customer) return new Response("Autentificare necesară", { status: 401, headers: NO_STORE });

  const body = await readBody(request);
  if (!body) return new Response("Cerere invalidă", { status: 400, headers: NO_STORE });
  const { token, asset } = body;

  const errors = getMessages().digital.errors;
  const back = (code: string): Response =>
    Response.redirect(
      new URL(
        `/cont/produsele-mele/${encodeURIComponent(token)}?eroare=${encodeURIComponent(code)}`,
        loadEnv().APP_URL,
      ),
      303,
    );
  const fail = (code: string, status: number): Response =>
    wantsJson
      ? Response.json(
          { ok: false, code, message: errors[code] ?? errors["failed"] },
          { status, headers: NO_STORE },
        )
      : back(code);

  if (!(await allowAccountRequest("digital", customer.user.id))) {
    return fail("rateLimited", 429);
  }
  try {
    const auth = await getSettings().getGroup("auth");
    const result = await requestAccess(
      getDigitalAccessDeps(),
      { userId: customer.user.id, token, assetId: asset },
      {
        ip: resolveClientIp(await headers(), auth.trustedProxyHops) ?? null,
        userAgent: request.headers.get("user-agent"),
      },
    );
    if (wantsJson) {
      return Response.json(
        {
          ok: true,
          kind: result.kind,
          url: result.url,
          expiresAt: result.expiresAt?.toISOString() ?? null,
          remainingDownloads: result.remainingDownloads,
          watermarked: result.watermarked,
        },
        { headers: NO_STORE },
      );
    }
    return new Response(null, { status: 303, headers: { ...NO_STORE, location: result.url } });
  } catch (error) {
    const code = codeOf(error);
    if (code) return fail(code, STATUS[code] ?? 400);
    getLogger().error({ err: error }, "emiterea linkului de acces digital a eșuat");
    return fail("failed", 500);
  }
}

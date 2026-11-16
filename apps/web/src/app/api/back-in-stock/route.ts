import { z } from "zod";
import { loadEnv } from "@ecom/config";
import { BackInStockError, BackInStockService, resolveClientIp } from "@ecom/core";
import { getDb } from "@ecom/db";
import { ValidationError, getLogger } from "@ecom/shared";
import { getCounterStore, getSettings } from "@/lib/services";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 2 * 1024;
/** Cereri pe oră de la aceeași adresă IP; fără IP de încredere (fără proxy) se folosește o cheie comună, mai largă. */
const PER_IP_PER_HOUR = 20;
const UNKNOWN_IP_PER_HOUR = 300;
const WINDOW_SECONDS = 3600;

const bodySchema = z.object({
  variantId: z.string().min(1).max(64),
  email: z.string().min(3).max(254),
  /** Capcana pentru roboți: un om nu o completează. */
  website: z.string().max(200).optional(),
});

const reply = (status: number, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...NO_STORE, ...extra } });

/**
 * «Anunță-mă când revine» (public). Serverul (`BackInStockService`) validează varianta, adresa și plafoanele (pe adresă și pe
 * variantă) și e idempotent; aici: aceeași origine (nu se acceptă cereri din alte site-uri), corp mic, capcană pentru roboți
 * (răspuns identic cu un succes, fără nicio înregistrare) și limită pe IP. Răspunsurile nu dezvăluie dacă o adresă mai există.
 */
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(loadEnv().APP_URL).origin) {
    return reply(403, { code: "FORBIDDEN_ORIGIN" });
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return reply(413, { code: "TOO_LARGE" });

  const settings = getSettings();
  const { trustedProxyHops } = await settings.getGroup("auth");
  const ip = resolveClientIp(request.headers, trustedProxyHops);
  const counter = await getCounterStore().increment(`bis:${ip ?? "unknown"}`, WINDOW_SECONDS);
  if (counter.count > (ip ? PER_IP_PER_HOUR : UNKNOWN_IP_PER_HOUR)) {
    return reply(429, { code: "RATE_LIMITED" }, { "Retry-After": String(counter.ttlSeconds) });
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return reply(413, { code: "TOO_LARGE" });
  let input: z.infer<typeof bodySchema>;
  try {
    input = bodySchema.parse(JSON.parse(text));
  } catch {
    return reply(400, { code: "VALIDATION" });
  }
  if (input.website) return reply(200, { status: "registered" });

  const service = new BackInStockService({
    db: getDb(),
    readSettings: async () => {
      const inventory = await settings.getGroup("inventory");
      return {
        lowStockSteps: inventory.lowStockSteps,
        defaultLeadTimeDays: inventory.defaultLeadTimeDays,
        maxPerEmail: inventory.backInStockMaxPerEmail,
        maxPerVariant: inventory.backInStockMaxPerVariant,
      };
    },
  });
  try {
    const result = await service.subscribe({ variantId: input.variantId, email: input.email });
    return reply(200, { status: result.status });
  } catch (error) {
    if (error instanceof BackInStockError) {
      // «cererea nu poate fi înregistrată» (plafoane, variantă inexistentă): fără detalii despre adrese sau stoc
      return reply(error.code === "BACK_IN_STOCK_VARIANT_NOT_FOUND" ? 404 : 400, {
        code: "NOT_REGISTERED",
      });
    }
    if (error instanceof ValidationError) {
      return reply(400, { code: "VALIDATION" });
    }
    getLogger().error({ err: error }, "înregistrarea «Anunță-mă» a eșuat");
    return reply(500, { code: "INTERNAL" });
  }
}

"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { loadEnv } from "@ecom/config";
import { readDemoGuardEnv } from "@ecom/core";
import { getDb } from "@ecom/db";
import {
  DEMO_SIGNATURE_HEADER,
  buildDemoEvent,
  demoSigningKey,
  isDemoPaymentAllowed,
} from "@ecom/integrations";

/**
 * Pagina de plată a furnizorului FALS «DEMO» (doar dezvoltare și teste). Acțiunea trimite, prin HTTP, către propria rută de
 * webhook, o notificare semnată cu cheia de test: EXACT aceeași cale (semnătură, înregistrare, coadă, procesare) ca la un
 * procesator real. Dacă garda DEMO nu e îndeplinită (producție), nu face nimic.
 */
const form = z.object({
  paymentId: z.string().min(8).max(64),
  scenario: z.enum(["paid", "wrong", "failed", "triple"]),
});

let counter = 0;

export async function demoPayAction(formData: FormData): Promise<void> {
  if (!isDemoPaymentAllowed(readDemoGuardEnv())) return;
  const parsed = form.safeParse({
    paymentId: formData.get("paymentId"),
    scenario: formData.get("scenario"),
  });
  if (!parsed.success) return;
  const payment = await getDb().payment.findUnique({
    where: { id: parsed.data.paymentId },
    select: { id: true, provider: true, amountMinor: true },
  });
  if (!payment || payment.provider !== "demo") return;

  const env = loadEnv();
  const key = demoSigningKey(env.APP_KEY);
  const send = async (suffix: string, scenario: string, same?: string) => {
    const eventId = same ?? `demo-${payment.id}-${scenario}-${Date.now()}-${++counter}${suffix}`;
    const { rawBody, signature } = buildDemoEvent(
      {
        eventId,
        paymentRef: payment.id,
        outcome: scenario === "failed" ? "failed" : "paid",
        amountMinor:
          scenario === "failed"
            ? null
            : scenario === "wrong"
              ? Math.max(payment.amountMinor - 1, 1)
              : payment.amountMinor,
        currency: "RON",
        cardLast4: "4242",
      },
      key,
    );
    await fetch(new URL("/api/webhooks/payments/demo", env.APP_URL), {
      method: "POST",
      headers: { "content-type": "application/json", [DEMO_SIGNATURE_HEADER]: signature },
      body: new Uint8Array(rawBody),
      signal: AbortSignal.timeout(10_000),
    });
  };

  if (parsed.data.scenario === "triple") {
    // același eveniment (același eventId) de 3 ori, în paralel: un singur efect
    const sameId = `demo-${payment.id}-triple-${Date.now()}`;
    await Promise.all([1, 2, 3].map(() => send("", "paid", sameId)));
  } else {
    await send("", parsed.data.scenario);
  }
  redirect(`/comanda/plata/${encodeURIComponent(payment.id)}`);
}

import {
  DEMO_SIGNATURE_HEADER,
  DemoPaymentProvider,
  buildDemoEvent,
  demoSigningKey,
  type DemoEventBody,
} from "@ecom/integrations";
import type { PaymentProvider, WebhookRequest } from "@ecom/shared";
import { CHECKOUT_SETTINGS, NOW, harness, q, type Harness } from "./checkout-fixtures";
import type { CheckoutSettings } from "../orders/checkout-service";
import {
  ingestPaymentWebhook,
  processPaymentEvent,
  type IngestResult,
  type PaymentProcessorDeps,
} from "../payments/payment-processor";

/**
 * Utilitare pentru testele plăților (Faza 10): comenzi cu card prin furnizorul DEMO, evenimente semnate cu cheia de test (aceeași
 * cale de verificare a semnăturii ca la furnizorii reali) și dependențele procesorului. Cheile sunt generate în test.
 */
export const DEMO_ENV = { E2E_HARNESS: "1" } as const;
export const TEST_APP_KEY = Buffer.alloc(32, 5).toString("base64");
export const SIGNING_KEY = demoSigningKey(TEST_APP_KEY);

export const CARD_SETTINGS: Partial<CheckoutSettings> = {
  cardProvider: { code: "demo", mode: "demo" },
  cardRetryHours: CHECKOUT_SETTINGS.cardRetryHours,
};

export function cardHarness<T>(
  fn: (h: Harness) => Promise<T>,
  settings: Partial<CheckoutSettings> = {},
): Promise<T> {
  return harness(fn, { settings: { ...CARD_SETTINGS, ...settings } });
}

export async function placeCardOrder(
  h: Harness,
  opts: { quantity?: string; physical?: string; price?: number } = {},
) {
  const product = await h.product({
    physical: opts.physical ?? "100",
    ...(opts.price ? { price: opts.price } : {}),
  });
  const owner = await h.fill([
    {
      variantId: product.variantId,
      ...(opts.quantity ? { quantity: q(opts.quantity) } : {}),
    },
  ]);
  const result = await h.checkout.place(owner, await h.input(owner, { paymentMethod: "card" }));
  if (!result.paymentId) throw new Error("comanda cu card trebuia să aibă o plată");
  const payment = await h.tx.payment.findUniqueOrThrow({ where: { id: result.paymentId } });
  return {
    orderId: result.orderId,
    paymentId: result.paymentId,
    variantId: product.variantId,
    amountMinor: payment.amountMinor,
  };
}

export function demoRequest(body: DemoEventBody, key = SIGNING_KEY): WebhookRequest {
  const { rawBody, signature } = buildDemoEvent(body, key);
  return { headers: { [DEMO_SIGNATURE_HEADER]: signature }, rawBody };
}

let eventSeq = 0;
export function paidEvent(
  paymentId: string,
  amountMinor: number,
  over: Partial<DemoEventBody> = {},
): DemoEventBody {
  return {
    eventId: `ev-${++eventSeq}`,
    paymentRef: paymentId,
    outcome: "paid",
    amountMinor,
    currency: "RON",
    cardLast4: "4242",
    ...over,
  };
}

export interface TestDeps extends PaymentProcessorDeps {
  provider: PaymentProvider;
  verified: string[];
  audits: string[];
  clock: { now: Date };
}

export function processorDeps(
  h: Harness,
  over: {
    now?: Date;
    refundBehavior?: "confirmed" | "pending" | "failed" | "manual_required";
  } = {},
): TestDeps {
  const clock = { now: over.now ?? NOW };
  const provider = new DemoPaymentProvider({
    env: DEMO_ENV,
    signingKey: SIGNING_KEY,
    ...(over.refundBehavior ? { refundBehavior: over.refundBehavior } : {}),
  });
  const verified: string[] = [];
  const audits: string[] = [];
  return {
    db: h.tx,
    getProvider: async (code) => (code === "demo" ? provider : null),
    now: () => clock.now,
    markVerifiedInSandbox: async (code) => {
      verified.push(code);
    },
    audit: async (entry) => {
      audits.push(entry.action);
    },
    provider,
    verified,
    audits,
    clock,
  };
}

/** Ingest + procesare, ca în producție (ruta HTTP, apoi coada). */
export async function deliver(
  deps: PaymentProcessorDeps,
  body: DemoEventBody,
  options: { key?: string; providerCode?: string } = {},
): Promise<{ ingest: IngestResult; processed: boolean }> {
  const ingest = await ingestPaymentWebhook(
    deps,
    options.providerCode ?? "demo",
    demoRequest(body, options.key),
  );
  if (!ingest.eventId) return { ingest, processed: false };
  const result = await processPaymentEvent(deps, ingest.eventId);
  return { ingest, processed: result.status === "processed" };
}

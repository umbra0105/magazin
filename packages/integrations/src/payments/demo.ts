import { createHmac, timingSafeEqual } from "node:crypto";
import {
  IntegrationError,
  WebhookRejectedError,
  type CaptureOutcome,
  type ConnectionTestResult,
  type CreatePaymentInput,
  type CreatePaymentResult,
  type PaymentOutcome,
  type PaymentProvider,
  type ProviderStatus,
  type RefundOutcome,
  type RefundRequest,
  type VerifiedWebhook,
  type WebhookRequest,
} from "@ecom/shared";
import { isDemoPaymentAllowed, type DemoGuardEnv } from "./demo-guard";
import { isRecord } from "./http";

/**
 * Furnizorul FALS «DEMO» de plată: marcat «DEMO» într-un singur loc (codul `demo`), doar pentru dezvoltare și teste. Construirea
 * lui aruncă dacă garda (`isDemoPaymentAllowed`) nu e îndeplinită, deci nu poate exista într-o instalare de producție.
 * Webhook-urile lui trec EXACT pe aceeași cale de verificare a semnăturii ca ale furnizorilor reali: HMAC-SHA256 cu o cheie de
 * test, în antetul `x-demo-signature`.
 */

export const DEMO_SIGNATURE_HEADER = "x-demo-signature";
export const DEMO_PROVIDER_LABEL = "DEMO";

export interface DemoEventBody {
  eventId: string;
  paymentRef: string;
  outcome: PaymentOutcome;
  amountMinor: number | null;
  currency?: string;
  cardLast4?: string | null;
}

export function signDemoBody(rawBody: Buffer, signingKey: string): string {
  return createHmac("sha256", signingKey).update(rawBody).digest("hex");
}

/** Corpul brut și semnătura unui eveniment DEMO (folosit de pagina de plată demo și de teste). */
export function buildDemoEvent(
  body: DemoEventBody,
  signingKey: string,
): { rawBody: Buffer; signature: string } {
  const rawBody = Buffer.from(JSON.stringify(body), "utf8");
  return { rawBody, signature: signDemoBody(rawBody, signingKey) };
}

export interface DemoOptions {
  env: DemoGuardEnv;
  signingKey: string;
  /** Cum răspunde la rambursare (pentru a parcurge toate stările în teste și E2E). */
  refundBehavior?: "confirmed" | "pending" | "failed" | "manual_required";
}

export class DemoPaymentProvider implements PaymentProvider {
  readonly code = "demo" as const;
  readonly mode = "demo" as const;
  private readonly signingKey: string;
  private readonly refundBehavior: NonNullable<DemoOptions["refundBehavior"]>;

  constructor(options: DemoOptions) {
    if (!isDemoPaymentAllowed(options.env)) {
      throw new IntegrationError(
        "PAYMENT_DEMO_FORBIDDEN",
        "Furnizorul DEMO de plată nu poate fi folosit în această instalare",
      );
    }
    if (options.signingKey.length < 16) {
      throw new IntegrationError("PAYMENT_DEMO_FORBIDDEN", "Cheia de test DEMO lipsește");
    }
    this.signingKey = options.signingKey;
    this.refundBehavior = options.refundBehavior ?? "confirmed";
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const origin = new URL(input.returnUrl).origin;
    return {
      providerRef: `demo-${input.paymentRef}`,
      redirect: {
        url: `${origin}/plata-demo/${encodeURIComponent(input.paymentRef)}`,
        method: "GET",
      },
    };
  }

  async verifyWebhook(request: WebhookRequest): Promise<VerifiedWebhook> {
    const given = request.headers[DEMO_SIGNATURE_HEADER];
    if (!given) throw new WebhookRejectedError("signature_missing");
    const expected = signDemoBody(request.rawBody, this.signingKey);
    const a = Buffer.from(given.toLowerCase(), "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new WebhookRejectedError("signature_invalid");
    }
    let json: unknown;
    try {
      json = JSON.parse(request.rawBody.toString("utf8"));
    } catch {
      throw new WebhookRejectedError("body_invalid");
    }
    if (
      !isRecord(json) ||
      typeof json["eventId"] !== "string" ||
      typeof json["paymentRef"] !== "string" ||
      typeof json["outcome"] !== "string"
    ) {
      throw new WebhookRejectedError("body_invalid");
    }
    const outcome = json["outcome"];
    if (!["paid", "failed", "pending", "credit", "unknown"].includes(outcome)) {
      throw new WebhookRejectedError("body_invalid");
    }
    const amount = json["amountMinor"];
    const last4 = json["cardLast4"];
    return {
      event: {
        eventId: json["eventId"],
        paymentRef: json["paymentRef"],
        providerRef: `demo-${json["paymentRef"]}`,
        outcome: outcome as PaymentOutcome,
        rawStatus: `demo:${outcome}`,
        amountMinor: typeof amount === "number" && Number.isSafeInteger(amount) ? amount : null,
        currency: typeof json["currency"] === "string" ? json["currency"] : "RON",
        cardLast4: typeof last4 === "string" && /^\d{4}$/.test(last4) ? last4 : null,
      },
      response: { status: 200, contentType: "text/plain; charset=utf-8", body: "OK" },
    };
  }

  async capture(): Promise<CaptureOutcome> {
    return { status: "confirmed" };
  }

  async refund(request: RefundRequest): Promise<RefundOutcome> {
    const providerRef = `demo-refund-${request.refundRef}`;
    switch (this.refundBehavior) {
      case "confirmed":
        return { status: "confirmed", providerRef };
      case "pending":
        return { status: "pending", providerRef };
      case "failed":
        return { status: "failed", message: "DEMO: rambursare refuzată (simulare)" };
      case "manual_required":
        return { status: "manual_required", message: "DEMO: rambursare manuală (simulare)" };
    }
  }

  async getStatus(): Promise<ProviderStatus | null> {
    return null;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    return { ok: true, message: "Furnizor DEMO: nu există conexiune reală de verificat." };
  }
}

import { createHmac } from "node:crypto";
import {
  IntegrationError,
  type PaymentMode,
  type PaymentProvider,
  type PaymentProviderCode,
} from "@ecom/shared";
import { DemoPaymentProvider } from "./demo";
import type { DemoGuardEnv } from "./demo-guard";
import { EuplatescProvider } from "./euplatesc";
import type { FetchLike } from "./http";
import { NetopiaProvider } from "./netopia";

/**
 * Singura fabrică de furnizori de plată: din codul furnizorului, credențialele decriptate (doar pe server) și modul. Nimic
 * altceva din aplicație nu construiește un adaptor.
 */
export interface BuildProviderInput {
  code: PaymentProviderCode;
  credentials: Readonly<Record<string, string>>;
  /** `test` sau `live` pentru furnizorii reali; ignorat la DEMO. */
  mode: Exclude<PaymentMode, "demo">;
  env: DemoGuardEnv;
  appKey: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** Doar DEMO: comportamentul rambursării. */
  demoRefundBehavior?: "confirmed" | "pending" | "failed" | "manual_required";
}

/** Cheia de test a furnizorului DEMO, derivată din `APP_KEY` (nu e o valoare scrisă în cod). */
export function demoSigningKey(appKey: string): string {
  return createHmac("sha256", appKey).update("demo-payments-signing-key").digest("hex");
}

export function buildPaymentProvider(input: BuildProviderInput): PaymentProvider {
  const c = input.credentials;
  const common = {
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.now ? { now: input.now } : {}),
  };
  switch (input.code) {
    case "netopia":
      return new NetopiaProvider({
        credentials: {
          apiKey: c["apiKey"] ?? "",
          posSignature: c["posSignature"] ?? "",
          publicKey: c["publicKey"] ?? "",
        },
        mode: input.mode,
        ...common,
      });
    case "euplatesc":
      return new EuplatescProvider({
        credentials: {
          merchantId: c["merchantId"] ?? "",
          secretKey: c["secretKey"] ?? "",
          ...(c["userKey"] ? { userKey: c["userKey"] } : {}),
          ...(c["userApi"] ? { userApi: c["userApi"] } : {}),
        },
        mode: input.mode,
        ...common,
      });
    case "demo":
      return new DemoPaymentProvider({
        env: input.env,
        signingKey: demoSigningKey(input.appKey),
        ...(input.demoRefundBehavior ? { refundBehavior: input.demoRefundBehavior } : {}),
      });
    default:
      throw new IntegrationError("PAYMENT_PROVIDER_UNKNOWN", "Furnizor de plată necunoscut");
  }
}

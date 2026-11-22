import type { InvoiceProvider, InvoiceProviderCode } from "@ecom/shared";
import type { DemoGuardEnv } from "../payments/demo-guard";
import { DemoInvoiceProvider } from "./demo";
import type { FetchLike } from "./http";
import { SmartbillProvider } from "./smartbill";

/** Singura fabrică de furnizori de facturare: din cod, credențialele decriptate (doar pe server) și mod. */
export interface BuildInvoiceProviderInput {
  code: InvoiceProviderCode;
  credentials: Readonly<Record<string, string>>;
  env: DemoGuardEnv;
  fetch?: FetchLike;
  now?: () => Date;
  /** Doar teste: emiterea DEMO eșuează cu acest cod. */
  demoFailWith?: { code: string; message: string } | null;
}

export function buildInvoiceProvider(input: BuildInvoiceProviderInput): InvoiceProvider {
  const c = input.credentials;
  switch (input.code) {
    case "smartbill":
      return new SmartbillProvider({
        credentials: {
          email: c["email"] ?? "",
          token: c["token"] ?? "",
          companyVatCode: c["companyVatCode"] ?? "",
          invoiceSeries: c["invoiceSeries"] ?? "",
          proformaSeries: c["proformaSeries"] ?? "",
          taxName: c["taxName"] ?? "",
          warehouseName: c["warehouseName"] ?? "",
        },
        ...(input.fetch ? { fetch: input.fetch } : {}),
      });
    case "demo":
      return new DemoInvoiceProvider({
        env: input.env,
        ...(input.now ? { now: input.now } : {}),
        ...(input.demoFailWith ? { failWith: input.demoFailWith } : {}),
      });
  }
}

import type { ShippingCarrier, ShippingProviderCode } from "@ecom/shared";
import type { DemoGuardEnv } from "../payments/demo-guard";
import { DemoCarrier } from "./demo";
import type { FetchLike } from "./http";
import { SamedayCarrier } from "./sameday";
import { WootproCarrier } from "./wootpro";

/** Singura fabrică de curieri: din codul furnizorului, credențialele decriptate (doar pe server) și modul. */
export interface BuildCarrierInput {
  code: ShippingProviderCode;
  credentials: Readonly<Record<string, string>>;
  mode: "test" | "live";
  env: DemoGuardEnv;
  fetch?: FetchLike;
  now?: () => Date;
}

export function buildShippingCarrier(input: BuildCarrierInput): ShippingCarrier {
  const c = input.credentials;
  const common = {
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.now ? { now: input.now } : {}),
  };
  switch (input.code) {
    case "wootpro":
      return new WootproCarrier({
        credentials: {
          publicKey: c["publicKey"] ?? "",
          secretKey: c["secretKey"] ?? "",
          senderAddressId: c["senderAddressId"] ?? "",
        },
        mode: input.mode,
        ...common,
      });
    case "sameday":
      return new SamedayCarrier({
        credentials: {
          username: c["username"] ?? "",
          password: c["password"] ?? "",
          pickupPointId: c["pickupPointId"] ?? "",
          defaultServiceId: c["defaultServiceId"] ?? "",
        },
        mode: input.mode,
        ...common,
      });
    case "demo":
      return new DemoCarrier({ env: input.env, ...(input.now ? { now: input.now } : {}) });
  }
}

import type { AnafLookup } from "@ecom/integrations";
import { validateCui } from "./cui";

/**
 * Verificarea CUI la checkout: formatul și cifra de control se verifică LOCAL, mereu, și o greșeală se respinge fără niciun apel
 * extern. ANAF (API public, cu timp limită) completează denumirea și adresa și dă starea «verificat». Dacă ANAF e picat, lent sau
 * nu cunoaște CUI-ul, comanda NU se blochează: CUI-ul se marchează «neverificat» (ghid pentru contabilitate), nu respins.
 */

export interface CuiLookupPort {
  lookup(cui: string, today: string): Promise<AnafLookup>;
}

export type CuiVerification =
  | { ok: false; reason: "format" | "check_digit" }
  | {
      ok: true;
      digits: string;
      verification: "verified" | "unverified";
      company: { name: string; address: string; tradeRegisterNo: string | null } | null;
    };

export async function verifyCuiForCheckout(
  input: string,
  port: CuiLookupPort,
  today: string,
): Promise<CuiVerification> {
  const local = validateCui(input);
  if (!local.ok) return { ok: false, reason: local.reason };
  let result: AnafLookup;
  try {
    result = await port.lookup(local.digits, today);
  } catch {
    result = { status: "unavailable", reason: "network" };
  }
  if (result.status === "found") {
    return {
      ok: true,
      digits: local.digits,
      verification: "verified",
      company: {
        name: result.name,
        address: result.address,
        tradeRegisterNo: result.tradeRegisterNo,
      },
    };
  }
  return { ok: true, digits: local.digits, verification: "unverified", company: null };
}

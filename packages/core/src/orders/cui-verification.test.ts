import { describe, expect, it } from "vitest";
import type { AnafLookup } from "@ecom/integrations";
import { verifyCuiForCheckout } from "./cui-verification";

const lookupReturning = (result: AnafLookup) => {
  const calls: string[] = [];
  return {
    calls,
    port: {
      lookup: async (cui: string) => {
        calls.push(cui);
        return result;
      },
    },
  };
};

describe("verifyCuiForCheckout", () => {
  it("un CUI cu format sau cifră de control greșită se respinge LOCAL, fără apel ANAF", async () => {
    const anaf = lookupReturning({ status: "not_found" });
    expect(await verifyCuiForCheckout("14399841", anaf.port, "2026-11-18")).toEqual({
      ok: false,
      reason: "check_digit",
    });
    expect(await verifyCuiForCheckout("abc", anaf.port, "2026-11-18")).toEqual({
      ok: false,
      reason: "format",
    });
    expect(anaf.calls).toEqual([]);
  });

  it("ANAF a găsit firma: verificat, cu denumirea și adresa din registru", async () => {
    const anaf = lookupReturning({
      status: "found",
      name: "FIRMA SRL",
      address: "Str. X",
      tradeRegisterNo: "J01/1/2010",
    });
    expect(await verifyCuiForCheckout("RO14399840", anaf.port, "2026-11-18")).toEqual({
      ok: true,
      digits: "14399840",
      verification: "verified",
      company: { name: "FIRMA SRL", address: "Str. X", tradeRegisterNo: "J01/1/2010" },
    });
    expect(anaf.calls).toEqual(["14399840"]);
  });

  it("ANAF picat, lent sau cu răspuns ciudat: NU blochează, CUI-ul rămâne «neverificat»", async () => {
    for (const reason of ["timeout", "http", "network", "invalid_response"] as const) {
      const anaf = lookupReturning({ status: "unavailable", reason });
      expect(await verifyCuiForCheckout("14399840", anaf.port, "2026-11-18")).toEqual({
        ok: true,
        digits: "14399840",
        verification: "unverified",
        company: null,
      });
    }
  });

  it("ANAF nu cunoaște CUI-ul: tot «neverificat» (nu blocăm comanda unei firme noi)", async () => {
    const anaf = lookupReturning({ status: "not_found" });
    expect(await verifyCuiForCheckout("14399840", anaf.port, "2026-11-18")).toMatchObject({
      ok: true,
      verification: "unverified",
    });
  });

  it("o excepție din port nu iese afară: tot «neverificat»", async () => {
    const port = {
      lookup: async () => {
        throw new Error("neprevăzut");
      },
    };
    expect(await verifyCuiForCheckout("14399840", port, "2026-11-18")).toMatchObject({
      ok: true,
      verification: "unverified",
    });
  });
});

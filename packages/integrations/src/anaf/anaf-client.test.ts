import { describe, expect, it } from "vitest";
import { ANAF_ENDPOINT, AnafClient } from "./anaf-client";

type FetchLike = typeof fetch;

function client(handler: (url: string, init: RequestInit) => Promise<Response>, timeoutMs = 200) {
  return new AnafClient({
    fetch: ((url: string, init: RequestInit) => handler(url, init)) as unknown as FetchLike,
    timeoutMs,
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const found = {
  found: [
    {
      date_generale: {
        cui: 14399840,
        denumire: "FIRMA EXEMPLU SRL",
        adresa: "JUD. ALBA, MUN. ALBA IULIA, STR. EXEMPLU NR. 1",
        nrRegCom: "J01/123/2010",
      },
      inregistrare_scop_Tva: { scpTVA: true },
    },
  ],
  notFound: [],
};

describe("AnafClient", () => {
  it("trimite UN POST către adresa publică ANAF, cu CUI numeric și data", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const result = await client(async (url, init) => {
      seen.push({ url, init });
      return json(found);
    }).lookup("14399840", "2026-11-18");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(ANAF_ENDPOINT);
    expect(seen[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual([{ cui: 14399840, data: "2026-11-18" }]);
    expect(result).toEqual({
      status: "found",
      name: "FIRMA EXEMPLU SRL",
      address: "JUD. ALBA, MUN. ALBA IULIA, STR. EXEMPLU NR. 1",
      tradeRegisterNo: "J01/123/2010",
    });
  });

  it("acceptă și plicul cu «cod: 200»", async () => {
    const result = await client(async () =>
      json({ cod: 200, message: "SUCCESS", ...found }),
    ).lookup("14399840", "2026-11-18");
    expect(result.status).toBe("found");
  });

  it("CUI-ul din notFound → not_found (răspuns sigur, nu o eroare)", async () => {
    const result = await client(async () => json({ found: [], notFound: [14399840] })).lookup(
      "14399840",
      "2026-11-18",
    );
    expect(result).toEqual({ status: "not_found" });
  });

  it("un răspuns pentru ALT CUI nu se ia drept răspuns pentru cel cerut", async () => {
    const other = {
      found: [{ date_generale: { cui: 999, denumire: "ALTA FIRMA", adresa: "x", nrRegCom: "" } }],
    };
    const result = await client(async () => json(other)).lookup("14399840", "2026-11-18");
    expect(result.status).toBe("unavailable");
  });

  it("timp depășit → unavailable/timeout, fără să arunce", async () => {
    const result = await client(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("abort", "AbortError")),
          );
        }),
      30,
    ).lookup("14399840", "2026-11-18");
    expect(result).toEqual({ status: "unavailable", reason: "timeout" });
  });

  it("HTTP 5xx și 429 → unavailable/http", async () => {
    for (const status of [429, 500, 503]) {
      const result = await client(async () => json({}, status)).lookup("14399840", "2026-11-18");
      expect(result, String(status)).toEqual({ status: "unavailable", reason: "http" });
    }
  });

  it("eroare de rețea → unavailable/network", async () => {
    const result = await client(async () => {
      throw new TypeError("fetch failed");
    }).lookup("14399840", "2026-11-18");
    expect(result).toEqual({ status: "unavailable", reason: "network" });
  });

  it("JSON stricat sau formă necunoscută → unavailable/invalid_response", async () => {
    const broken = await client(async () => new Response("<html>", { status: 200 })).lookup(
      "14399840",
      "2026-11-18",
    );
    expect(broken).toEqual({ status: "unavailable", reason: "invalid_response" });
    const weird = await client(async () => json({ ceva: 1 })).lookup("14399840", "2026-11-18");
    expect(weird).toEqual({ status: "unavailable", reason: "invalid_response" });
  });

  it("refuză un CUI care nu e format din cifre, fără să facă vreo cerere", async () => {
    let calls = 0;
    const result = await client(async () => {
      calls++;
      return json(found);
    }).lookup("14399840; DROP", "2026-11-18");
    expect(calls).toBe(0);
    expect(result.status).toBe("unavailable");
  });
});

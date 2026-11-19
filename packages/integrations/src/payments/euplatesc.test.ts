import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WebhookRejectedError } from "@ecom/shared";
import { EuplatescProvider } from "./euplatesc";
import { sameSignature, signFields, signedString } from "./euplatesc-signature";

/** Chei inventate pentru test (NU sunt chei reale și nu vin din biblioteca EuPlătesc). */
const SECRET = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const USER_API = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

describe("semnătura EuPlătesc: vectori construiți de mână", () => {
  it("șirul semnat = lungimea valorii urmată de valoare, «-» pentru gol", () => {
    expect(
      signedString([
        ["amount", "123.45"],
        ["curr", "RON"],
        ["invoice_id", "pay_1"],
        ["order_desc", "Comanda T-0001"],
        ["merch_id", "MID0001"],
        ["timestamp", "20301115120000"],
        ["nonce", "abcdef"],
      ]),
    ).toBe("6123.453RON5pay_114Comanda T-00017MID000114203011151200006abcdef");
    expect(
      signedString([
        ["a", "123.45"],
        ["b", ""],
        ["c", undefined],
        ["d", "RON"],
      ]),
    ).toBe("6123.45--3RON");
  });

  it("HMAC-MD5 cu cheia hexazecimală, în majuscule (vector fix)", () => {
    const fields = [
      ["amount", "123.45"],
      ["curr", "RON"],
      ["invoice_id", "pay_1"],
      ["order_desc", "Comanda T-0001"],
      ["merch_id", "MID0001"],
      ["timestamp", "20301115120000"],
      ["nonce", "abcdef"],
    ] as const;
    expect(signFields(fields, SECRET)).toBe("668F775FF258FC492D6E1D67A239586D");
    // aceeași valoare, calculată independent cu node:crypto
    expect(
      createHmac("md5", Buffer.from(SECRET, "hex"))
        .update("6123.453RON5pay_114Comanda T-00017MID000114203011151200006abcdef")
        .digest("hex")
        .toUpperCase(),
    ).toBe("668F775FF258FC492D6E1D67A239586D");
  });

  it("o cheie care nu e hexazecimală e refuzată", () => {
    expect(() => signFields([["a", "1"]], "nu-e-hex")).toThrow(RangeError);
  });

  it("compararea ignoră majusculele și respinge lungimi diferite", () => {
    expect(sameSignature("abcdef", "ABCDEF")).toBe(true);
    expect(sameSignature("abcdef", "ABCDE")).toBe(false);
    expect(sameSignature("", "ABCDEF")).toBe(false);
  });
});

const NOW = new Date("2030-11-15T12:00:00.000Z");

function provider(over: Partial<ConstructorParameters<typeof EuplatescProvider>[0]> = {}) {
  return new EuplatescProvider({
    credentials: { merchantId: "MID0001", secretKey: SECRET },
    mode: "test",
    now: () => NOW,
    nonce: () => "abcdef",
    ...over,
  });
}

/** Construiește un corp de callback semnat corect, cu câmpurile de bază (și, opțional, suplimentare). */
function callback(
  over: Record<string, string> = {},
  extra: Array<[string, string]> = [],
  key = SECRET,
): Buffer {
  const defaults: Array<[string, string]> = [
    ["amount", "123.45"],
    ["curr", "RON"],
    ["invoice_id", "pay_1"],
    ["ep_id", "EP123"],
    ["merch_id", "MID0001"],
    ["action", "0"],
    ["message", "Approved"],
    ["approval", "A1"],
    ["timestamp", "20301115120000"],
    ["nonce", "n0nce"],
  ];
  const base = defaults.map(([k, v]): [string, string] => [k, over[k] ?? v]);
  const all = [...base, ...extra];
  const hash = signFields(all, key);
  const params = new URLSearchParams();
  for (const [k, v] of all) params.set(k, v);
  params.set("fp_hash", hash);
  return Buffer.from(params.toString());
}

const verify = (body: Buffer, p = provider()) => p.verifyWebhook({ headers: {}, rawBody: body });
const reasonOf = async (body: Buffer, p = provider()) => {
  try {
    await verify(body, p);
    return "acceptat";
  } catch (error) {
    return error instanceof WebhookRejectedError ? error.reason : "altă eroare";
  }
};

describe("EuPlătesc: callback-ul server-la-server", () => {
  it("un callback semnat corect e acceptat și normalizat; răspunsul e textul simplu OK", async () => {
    const result = await verify(callback({}, [["mcard", "4242"]]));
    expect(result.event).toMatchObject({
      paymentRef: "pay_1",
      providerRef: "EP123",
      outcome: "paid",
      amountMinor: 12_345,
      currency: "RON",
      cardLast4: "4242",
    });
    expect(result.response).toEqual({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      body: "OK",
    });
  });

  it("aceeași notificare retrimisă are același eventId", async () => {
    const body = callback();
    expect((await verify(body)).event.eventId).toBe((await verify(body)).event.eventId);
  });

  it("acțiune diferită de «0» = eșec", async () => {
    const result = await verify(callback({ action: "5", message: "Declined" }));
    expect(result.event.outcome).toBe("failed");
  });

  it("câmpurile suplimentare intră în hash exact cum au fost primite", async () => {
    const extra: Array<[string, string]> = [
      ["rrn", "123456"],
      ["mcard", "4242"],
      ["payment_channel", "CARD"],
    ];
    expect(await reasonOf(callback({}, extra))).toBe("acceptat");
    // un câmp suplimentar adăugat după semnare, în afara hash-ului, strică semnătura
    const tampered = Buffer.from(callback().toString() + "&rrn=999");
    expect(await reasonOf(tampered)).toBe("signature_invalid");
  });

  it("acceptă și numele camelCase ale câmpurilor", async () => {
    const snake = new URLSearchParams(callback().toString());
    const camel = new URLSearchParams();
    const rename: Record<string, string> = {
      invoice_id: "invoiceId",
      ep_id: "epId",
      merch_id: "merchantId",
      fp_hash: "fpHash",
      curr: "currency",
    };
    for (const [k, v] of snake) camel.set(rename[k] ?? k, v);
    expect(await reasonOf(Buffer.from(camel.toString()))).toBe("acceptat");
  });

  it("respinge: fără semnătură, semnătură greșită, altă cheie, sumă modificată, MID străin, câmp lipsă, corp gol", async () => {
    const good = new URLSearchParams(callback().toString());
    const without = new URLSearchParams(good);
    without.delete("fp_hash");
    expect(await reasonOf(Buffer.from(without.toString()))).toBe("signature_missing");

    const wrong = new URLSearchParams(good);
    wrong.set("fp_hash", "0".repeat(32));
    expect(await reasonOf(Buffer.from(wrong.toString()))).toBe("signature_invalid");

    expect(await reasonOf(callback({}, [], USER_API))).toBe("signature_invalid");

    const amount = new URLSearchParams(good);
    amount.set("amount", "1.00");
    expect(await reasonOf(Buffer.from(amount.toString()))).toBe("signature_invalid");

    // semnat corect, dar pentru alt comerciant: nu e al nostru
    expect(await reasonOf(callback({ merch_id: "ALT" }))).toBe("body_invalid");

    const missing = new URLSearchParams(good);
    missing.delete("nonce");
    expect(await reasonOf(Buffer.from(missing.toString()))).toBe("body_invalid");

    expect(await reasonOf(Buffer.alloc(0))).toBe("signature_missing");
  });

  it("același câmp sub două nume cu valori diferite = respins", async () => {
    const params = new URLSearchParams(callback().toString());
    params.set("invoiceId", "pay_ALTA");
    expect(await reasonOf(Buffer.from(params.toString()))).toBe("body_invalid");
  });

  it("fără configurare completă nu acceptă nimic", async () => {
    const p = provider({ credentials: { merchantId: "", secretKey: SECRET } });
    expect(await reasonOf(callback(), p)).toBe("not_configured");
  });

  it("o sumă care nu e un zecimal exact devine null (fail-closed la apelant)", async () => {
    const result = await verify(callback({ amount: "123.456" }));
    expect(result.event.amountMinor).toBeNull();
  });

  it("ultimele 4 cifre apar doar dacă sunt exact 4 cifre", async () => {
    expect(
      (await verify(callback({}, [["mcard", "424242******4242"]]))).event.cardLast4,
    ).toBeNull();
  });
});

describe("EuPlătesc: inițierea plății", () => {
  const input = {
    paymentRef: "pay_1",
    orderNumber: "T-0001",
    amountMinor: 12_345,
    currency: "RON" as const,
    description: "Comanda T-0001",
    customer: {
      firstName: "Ion",
      lastName: "Popescu",
      email: "ion@exemplu.ro",
      phone: "0722123456",
      street: "Str. Exemplu 1",
      city: "Sat",
      county: "Județ",
      postalCode: "123456",
    },
    returnUrl: "https://magazin.test/comanda/retur/pay_1",
    notifyUrl: "https://magazin.test/api/webhooks/payments/euplatesc",
  };

  it("redirect GET cu semnătura peste cele 7 câmpuri, suma în zecimale exacte, MID-ul magazinului", async () => {
    const result = await provider().createPayment(input);
    expect(result.redirect.method).toBe("GET");
    const url = new URL(result.redirect.url);
    expect(url.origin + url.pathname).toBe("https://secure.euplatesc.ro/tdsprocess/tranzactd.php");
    const q = url.searchParams;
    expect(q.get("amount")).toBe("123.45");
    expect(q.get("merch_id")).toBe("MID0001");
    expect(q.get("invoice_id")).toBe("pay_1");
    expect(q.get("timestamp")).toBe("20301115120000");
    expect(q.get("fp_hash")).toBe(
      signFields(
        [
          ["amount", "123.45"],
          ["curr", "RON"],
          ["invoice_id", "pay_1"],
          ["order_desc", "Comanda T-0001"],
          ["merch_id", "MID0001"],
          ["timestamp", "20301115120000"],
          ["nonce", "abcdef"],
        ],
        SECRET,
      ),
    );
    expect(q.get("ExtraData[silenturl]")).toBe(input.notifyUrl);
    // cheia secretă nu apare niciodată în adresă
    expect(result.redirect.url).not.toContain(SECRET);
  });

  it("modul test NU forțează suma și nu schimbă comerciantul", async () => {
    const result = await provider({ mode: "test" }).createPayment({
      ...input,
      amountMinor: 99_999,
    });
    expect(new URL(result.redirect.url).searchParams.get("amount")).toBe("999.99");
  });

  it("fără configurare completă nu inițiază", async () => {
    const p = provider({ credentials: { merchantId: "MID", secretKey: "nu-e-hex" } });
    await expect(p.createPayment(input)).rejects.toMatchObject({
      code: "PAYMENT_PROVIDER_NOT_CONFIGURED",
    });
  });
});

describe("EuPlătesc: rambursare și verificări", () => {
  const request = {
    providerRef: "EP123",
    paymentRef: "pay_1",
    refundRef: "refund-1",
    amountMinor: 5_000,
    paymentAmountMinor: 12_345,
    currency: "RON" as const,
    reason: "Produs returnat",
  };
  const withUser = { merchantId: "MID0001", secretKey: SECRET, userKey: "UKEY", userApi: USER_API };

  function fakeFetch(body: unknown, status = 200) {
    const calls: Array<{ url: string; body: string }> = [];
    const fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    };
    return { fetch, calls };
  }

  it("rambursarea: cerere semnată cu cheia utilizatorului API, sumă exactă, motiv de 5–55 de caractere", async () => {
    const { fetch, calls } = fakeFetch({ success: "1" });
    const result = await provider({ credentials: withUser, fetch }).refund(request);
    expect(result).toEqual({ status: "confirmed", providerRef: null });
    const sent = new URLSearchParams(calls[0]?.body);
    expect(sent.get("method")).toBe("refund");
    expect(sent.get("amount")).toBe("50.00");
    expect(sent.get("epid")).toBe("EP123");
    expect(sent.get("ukey")).toBe("UKEY");
    expect(sent.get("fp_hash")).toBe(
      signFields(
        [
          ["method", "refund"],
          ["ukey", "UKEY"],
          ["amount", "50.00"],
          ["reason", "Produs returnat"],
          ["epid", "EP123"],
          ["timestamp", "20301115120000"],
          ["nonce", "abcdef"],
        ],
        USER_API,
      ),
    );
    expect(calls[0]?.body).not.toContain(USER_API);
    expect(calls[0]?.body).not.toContain(SECRET);
  });

  it("motiv prea scurt sau prea lung se ajustează la limitele procesatorului", async () => {
    const { fetch, calls } = fakeFetch({ success: "1" });
    await provider({ credentials: withUser, fetch }).refund({ ...request, reason: "ok" });
    await provider({ credentials: withUser, fetch }).refund({
      ...request,
      reason: "x".repeat(100),
    });
    expect(new URLSearchParams(calls[0]?.body).get("reason")?.length).toBeGreaterThanOrEqual(5);
    expect(new URLSearchParams(calls[1]?.body).get("reason")?.length).toBe(55);
  });

  it("fără utilizator API: «manuală necesară», fără niciun apel", async () => {
    const { fetch, calls } = fakeFetch({ success: "1" });
    const result = await provider({ fetch }).refund(request);
    expect(result.status).toBe("manual_required");
    expect(calls).toHaveLength(0);
  });

  it("eroare explicită = refuzată; răspuns neașteptat sau timp depășit = manuală necesară (nu se presupune succesul)", async () => {
    const refused = await provider({
      credentials: withUser,
      fetch: fakeFetch({ error: "Suma depășește", ecode: "12" }).fetch,
    }).refund(request);
    expect(refused.status).toBe("failed");
    const odd = await provider({
      credentials: withUser,
      fetch: fakeFetch("<html>").fetch,
    }).refund(request);
    expect(odd.status).toBe("manual_required");
    const down = await provider({
      credentials: withUser,
      fetch: async () => {
        throw new Error("rețea");
      },
    }).refund(request);
    expect(down.status).toBe("manual_required");
  });

  it("getStatus: acțiunea «0» = plătit; fără sumă în răspuns, suma rămâne necunoscută", async () => {
    const { fetch } = fakeFetch({
      success: JSON.stringify([{ invoice_id: "pay_1", ep_id: "EP123", action: "0" }]),
    });
    expect(
      await provider({ fetch }).getStatus({ providerRef: "EP123", paymentRef: "pay_1" }),
    ).toMatchObject({ outcome: "paid", amountMinor: null, providerRef: "EP123" });
  });

  it("testConnection: LIVE cu cont încă în «test» e refuzat; datele greșite dau mesaj clar fără secrete", async () => {
    const live = await provider({
      mode: "live",
      fetch: fakeFetch({ name: "X", status: "test" }).fetch,
    }).testConnection();
    expect(live.ok).toBe(false);
    const ok = await provider({
      fetch: fakeFetch({ name: "X", status: "test" }).fetch,
    }).testConnection();
    expect(ok.ok).toBe(true);
    const bad = await provider({
      credentials: { merchantId: "M", secretKey: "xx" },
    }).testConnection();
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain('"xx"');
  });
});

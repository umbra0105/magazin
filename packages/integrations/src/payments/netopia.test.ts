import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WebhookRejectedError } from "@ecom/shared";
import { NetopiaProvider, netopiaOutcome } from "./netopia";

/** Chei RSA generate în test (nu sunt chei reale). */
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_PEM = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const POS = "POS-TEST-AAAA-1111";
const NOW = new Date("2030-11-15T12:00:00.000Z");
const nowSeconds = Math.floor(NOW.getTime() / 1000);

const b64u = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const sha512 = (body: Buffer) => createHash("sha512").update(body).digest("base64");

interface TokenOptions {
  alg?: string;
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  signWith?: typeof keys.privateKey;
}

/** Construiește un JWT RS512 semnat de «Netopia» (cheia privată generată în test). */
function token(body: Buffer, options: TokenOptions = {}): string {
  const header = b64u({ alg: options.alg ?? "RS512", typ: "JWT" });
  const payload = b64u({
    iss: options.iss ?? "NETOPIA Payments",
    aud: options.aud ?? POS,
    sub: options.sub ?? sha512(body),
    iat: nowSeconds,
    ...(options.exp === undefined ? {} : { exp: options.exp }),
  });
  const signer = createSign("RSA-SHA512");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(options.signWith ?? keys.privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

const ipnBody = (
  over: { status?: number; amount?: string; orderID?: string; account?: string } = {},
) =>
  Buffer.from(
    `{"payment":{"method":"card","ntpID":"99003322","status":${over.status ?? 3},"amount":${over.amount ?? "123.45"},"currency":"RON","instrument":{"account":${JSON.stringify(over.account ?? "4***********1234")}}},"order":{"orderID":${JSON.stringify(over.orderID ?? "pay_1")}}}`,
  );

function provider(over: Partial<ConstructorParameters<typeof NetopiaProvider>[0]> = {}) {
  return new NetopiaProvider({
    credentials: { apiKey: "API-KEY-TEST", posSignature: POS, publicKey: PUBLIC_PEM },
    mode: "test",
    now: () => NOW,
    ...over,
  });
}

const reasonOf = async (body: Buffer, tokenValue: string | undefined, p = provider()) => {
  try {
    await p.verifyWebhook({
      headers: tokenValue === undefined ? {} : { "verification-token": tokenValue },
      rawBody: body,
    });
    return "acceptat";
  } catch (error) {
    return error instanceof WebhookRejectedError ? error.reason : "altă eroare";
  }
};

describe("Netopia: verificarea IPN (JWT RS512)", () => {
  it("un token valid pentru corpul exact e acceptat și normalizat", async () => {
    const body = ipnBody();
    const result = await provider().verifyWebhook({
      headers: { "verification-token": token(body) },
      rawBody: body,
    });
    expect(result.event).toMatchObject({
      paymentRef: "pay_1",
      providerRef: "99003322",
      outcome: "paid",
      amountMinor: 12_345,
      currency: "RON",
      cardLast4: "1234",
    });
    expect(result.event.eventId).toBe(createHash("sha256").update(body).digest("hex"));
    expect(result.response.status).toBe(200);
  });

  it("același corp retrimis => același eventId; alt corp => alt eventId", async () => {
    const a = ipnBody();
    const b = ipnBody({ status: 5 });
    const verify = (body: Buffer) =>
      provider().verifyWebhook({ headers: { "verification-token": token(body) }, rawBody: body });
    expect((await verify(a)).event.eventId).toBe((await verify(a)).event.eventId);
    expect((await verify(a)).event.eventId).not.toBe((await verify(b)).event.eventId);
  });

  it("corp modificat după semnare => respins (hash-ul din sub nu se potrivește)", async () => {
    const signed = ipnBody();
    const tampered = ipnBody({ amount: "1.00" });
    expect(await reasonOf(tampered, token(signed))).toBe("body_hash_mismatch");
  });

  it("hash-ul se calculează pe corpul BRUT: un spațiu în plus schimbă rezultatul", async () => {
    const body = ipnBody();
    const spaced = Buffer.concat([body, Buffer.from(" ")]);
    expect(await reasonOf(spaced, token(body))).toBe("body_hash_mismatch");
  });

  it("aud greșit, iss greșit => respins", async () => {
    const body = ipnBody();
    expect(await reasonOf(body, token(body, { aud: "ALT-POS" }))).toBe("audience_invalid");
    expect(await reasonOf(body, token(body, { iss: "Altcineva" }))).toBe("issuer_invalid");
    expect(await reasonOf(body, token(body, { aud: ["ALT", POS] }))).toBe("acceptat");
  });

  it("semnat cu altă cheie => respins", async () => {
    const body = ipnBody();
    expect(await reasonOf(body, token(body, { signWith: otherKeys.privateKey }))).toBe(
      "signature_invalid",
    );
  });

  it("orice algoritm în afară de RS512 e respins, inclusiv none, HS512 și RS256", async () => {
    const body = ipnBody();
    for (const alg of [
      "none",
      "None",
      "HS256",
      "HS384",
      "HS512",
      "RS256",
      "ES512",
      "PS512",
      "rs512",
    ]) {
      expect(await reasonOf(body, token(body, { alg })), alg).toBe("algorithm_not_allowed");
    }
  });

  it("atacul de confuzie de algoritm: HS512 semnat cu cheia publică ca secret e respins", async () => {
    const body = ipnBody();
    const { createHmac } = await import("node:crypto");
    const header = b64u({ alg: "HS512", typ: "JWT" });
    const payload = b64u({ iss: "NETOPIA Payments", aud: POS, sub: sha512(body) });
    const mac = createHmac("sha512", PUBLIC_PEM).update(`${header}.${payload}`).digest("base64url");
    expect(await reasonOf(body, `${header}.${payload}.${mac}`)).toBe("algorithm_not_allowed");
  });

  it("token lipsă, gol sau malformat => respins", async () => {
    const body = ipnBody();
    expect(await reasonOf(body, undefined)).toBe("signature_missing");
    expect(await reasonOf(body, "   ")).toBe("signature_missing");
    expect(await reasonOf(body, "doar.doua")).toBe("signature_malformed");
    expect(await reasonOf(body, "a.b.c.d")).toBe("signature_malformed");
    expect(await reasonOf(body, "!!!.@@@.###")).toBe("signature_malformed");
    expect(await reasonOf(body, `${b64u("nu-obiect")}.${b64u({})}.AAAA`)).toBe(
      "signature_malformed",
    );
    const good = token(body).split(".");
    expect(await reasonOf(body, `${good[0]}.${good[1]}.`)).toBe("signature_malformed");
  });

  it("token expirat (exp) => respins, cu toleranță mică", async () => {
    const body = ipnBody();
    expect(await reasonOf(body, token(body, { exp: nowSeconds - 3_600 }))).toBe(
      "signature_invalid",
    );
    expect(await reasonOf(body, token(body, { exp: nowSeconds - 10 }))).toBe("acceptat");
    expect(await reasonOf(body, token(body, { exp: nowSeconds + 3_600 }))).toBe("acceptat");
  });

  it("fără cheie publică sau fără semnătură POS nu acceptă nimic", async () => {
    const body = ipnBody();
    const noKey = provider({ credentials: { apiKey: "k", posSignature: POS, publicKey: "" } });
    expect(await reasonOf(body, token(body), noKey)).toBe("not_configured");
    const noPos = provider({
      credentials: { apiKey: "k", posSignature: "", publicKey: PUBLIC_PEM },
    });
    expect(await reasonOf(body, token(body), noPos)).toBe("not_configured");
    const notRsa = provider({
      credentials: {
        apiKey: "k",
        posSignature: POS,
        publicKey: generateKeyPairSync("ec", { namedCurve: "P-256" })
          .publicKey.export({ type: "spki", format: "pem" })
          .toString(),
      },
    });
    expect(await reasonOf(body, token(body), notRsa)).toBe("not_configured");
  });

  it("cheia publică poate fi lipită fără antet PEM", async () => {
    const body = ipnBody();
    const bare = PUBLIC_PEM.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    const p = provider({ credentials: { apiKey: "k", posSignature: POS, publicKey: bare } });
    expect(await reasonOf(body, token(body), p)).toBe("acceptat");
  });

  it("un corp semnat corect dar fără câmpurile necesare => body_invalid", async () => {
    const body = Buffer.from('{"payment":{"status":3}}');
    expect(await reasonOf(body, token(body))).toBe("body_invalid");
    const notJson = Buffer.from("nu e json");
    expect(await reasonOf(notJson, token(notJson))).toBe("body_invalid");
  });

  it("suma nu trece prin float: «19.99» => 1999, «0.29» => 29; o sumă cu 3 zecimale => null", async () => {
    const verify = async (amount: string) => {
      const body = ipnBody({ amount });
      return (
        await provider().verifyWebhook({
          headers: { "verification-token": token(body) },
          rawBody: body,
        })
      ).event.amountMinor;
    };
    expect(await verify("19.99")).toBe(1_999);
    expect(await verify("0.29")).toBe(29);
    expect(await verify("100")).toBe(10_000);
    expect(await verify("1.005")).toBeNull();
    expect(await verify("1e2")).toBeNull();
  });

  it("numărul de card nemascat nu se păstrează, nici ultimele 4 cifre", async () => {
    const body = ipnBody({ account: "4111111111111111" });
    const result = await provider().verifyWebhook({
      headers: { "verification-token": token(body) },
      rawBody: body,
    });
    expect(result.event.cardLast4).toBeNull();
  });
});

describe("Netopia: statusurile (neconfirmat)", () => {
  it("3 și 5 plătit; 15 intermediar; 4, 11, 12, 23 eșec; 8 credit; restul necunoscut", () => {
    expect([3, 5].map(netopiaOutcome)).toEqual(["paid", "paid"]);
    expect(netopiaOutcome(15)).toBe("pending");
    expect([4, 11, 12, 23].map(netopiaOutcome)).toEqual(["failed", "failed", "failed", "failed"]);
    expect(netopiaOutcome(8)).toBe("credit");
    expect([0, 1, 2, 6, 7, 9, 99].map(netopiaOutcome)).toEqual(Array(7).fill("unknown"));
  });
});

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
  notifyUrl: "https://magazin.test/api/webhooks/payments/netopia",
};

function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: String(init.body ?? ""),
    });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

describe("Netopia: inițierea plății", () => {
  it("POST pe adresa sandbox, cheia API în antet, suma zecimală exactă, referința noastră ca orderID", async () => {
    const { fetch, calls } = fakeFetch({
      payment: {
        ntpID: "99003322",
        paymentURL: "https://secure.sandbox.netopia-payments.com/pay/abc",
      },
      error: { code: "00" },
    });
    const result = await provider({ fetch }).createPayment(input);
    expect(result).toEqual({
      providerRef: "99003322",
      redirect: { url: "https://secure.sandbox.netopia-payments.com/pay/abc", method: "GET" },
    });
    expect(calls[0]?.url).toBe("https://secure.sandbox.netopia-payments.com/payment/card/start");
    expect(calls[0]?.headers["authorization"]).toBe("API-KEY-TEST");
    const sent = JSON.parse(calls[0]?.body ?? "{}");
    expect(sent.order.orderID).toBe("pay_1");
    expect(sent.order.amount).toBe(123.45);
    expect(sent.order.posSignature).toBe(POS);
    expect(sent.config.notifyUrl).toBe(input.notifyUrl);
    // cheia API nu intră în corpul trimis
    expect(calls[0]?.body).not.toContain("API-KEY-TEST");
  });

  it("modul live folosește adresa live", async () => {
    const { fetch, calls } = fakeFetch({
      payment: { paymentURL: "https://secure.mobilpay.ro/pay/x" },
    });
    await provider({ mode: "live", fetch }).createPayment(input);
    expect(calls[0]?.url).toBe("https://secure.mobilpay.ro/pay/payment/card/start");
  });

  it("răspuns fără adresă https de plată, eroare HTTP sau configurare lipsă => eroare, fără secrete în mesaj", async () => {
    for (const body of [
      { payment: {} },
      { payment: { paymentURL: "http://nesigur.example" } },
      "nu e json",
    ]) {
      await expect(
        provider({ fetch: fakeFetch(body).fetch }).createPayment(input),
      ).rejects.toMatchObject({
        code: "PAYMENT_PROVIDER_BAD_RESPONSE",
      });
    }
    const refused = provider({
      fetch: fakeFetch({ error: { code: "99" } }, 400).fetch,
    }).createPayment(input);
    await expect(refused).rejects.toMatchObject({ code: "PAYMENT_PROVIDER_REJECTED" });
    const noKey = provider({
      credentials: { apiKey: "", posSignature: POS, publicKey: PUBLIC_PEM },
    });
    await expect(noKey.createPayment(input)).rejects.toMatchObject({
      code: "PAYMENT_PROVIDER_NOT_CONFIGURED",
    });
    try {
      await refused;
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("API-KEY-TEST");
    }
  });
});

describe("Netopia: rambursarea nu presupune succesul", () => {
  const request = {
    providerRef: "99003322",
    paymentRef: "pay_1",
    refundRef: "r1",
    amountMinor: 5_000,
    paymentAmountMinor: 12_345,
    currency: "RON" as const,
    reason: "Produs returnat",
  };

  it("răspuns «credit» (status 8) cu cod 00 = confirmată; fără status 8 = în așteptare", async () => {
    const confirmed = await provider({
      fetch: fakeFetch({ payment: { ntpID: "99003322", status: 8 }, error: { code: "00" } }).fetch,
    }).refund(request);
    expect(confirmed).toEqual({ status: "confirmed", providerRef: "99003322" });
    const pending = await provider({
      fetch: fakeFetch({ payment: { ntpID: "99003322", status: 3 }, error: { code: "00" } }).fetch,
    }).refund(request);
    expect(pending.status).toBe("pending");
  });

  it("eroare, 4xx/5xx, «viitor», răspuns ciudat sau timp depășit => manuală necesară", async () => {
    const cases = [
      fakeFetch({ error: { code: "99", message: "will be available at a future date" } }, 501)
        .fetch,
      fakeFetch({ error: { code: "99" } }, 200).fetch,
      fakeFetch("<html>", 200).fetch,
      async () => {
        throw new Error("rețea");
      },
    ];
    for (const fetch of cases) {
      const result = await provider({ fetch }).refund(request);
      expect(result.status).toBe("manual_required");
    }
  });

  it("trimite ntpID și suma exactă, cu cheia API în antet", async () => {
    const { fetch, calls } = fakeFetch({ error: { code: "99" } }, 400);
    await provider({ fetch }).refund(request);
    expect(calls[0]?.url).toBe("https://secure.sandbox.netopia-payments.com/operation/credit");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ ntpID: "99003322", amount: 50 });
    expect(calls[0]?.headers["authorization"]).toBe("API-KEY-TEST");
  });

  it("getStatus nu se folosește (null), captura nu e disponibilă", async () => {
    expect(await provider().getStatus()).toBeNull();
    expect((await provider().capture()).status).toBe("unsupported");
  });
});

describe("Netopia: testarea conexiunii", () => {
  it("date incomplete => mesaj clar în română, fără apel", async () => {
    const { fetch, calls } = fakeFetch("ok");
    const result = await provider({
      fetch,
      credentials: { apiKey: "", posSignature: "", publicKey: "nu e cheie" },
    }).testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("cheia API lipsește");
    expect(result.message).toContain("semnătura POS lipsește");
    expect(calls).toHaveLength(0);
  });

  it("server care răspunde = ok, cu avertisment că cheia nu se poate verifica; fără secrete în mesaj", async () => {
    const ok = await provider({ fetch: fakeFetch("ok").fetch }).testConnection();
    expect(ok.ok).toBe(true);
    expect(ok.message).toContain("neconfirmat");
    expect(ok.message).not.toContain("API-KEY-TEST");
    const down = await provider({ fetch: fakeFetch("x", 503).fetch }).testConnection();
    expect(down.ok).toBe(false);
  });
});

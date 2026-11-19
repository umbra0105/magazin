import { describe, expect, it } from "vitest";
import { WebhookRejectedError } from "@ecom/shared";
import { DEMO_SIGNATURE_HEADER, DemoPaymentProvider, buildDemoEvent, signDemoBody } from "./demo";
import { isDemoPaymentAllowed } from "./demo-guard";
import { buildPaymentProvider, demoSigningKey } from "./registry";

const KEY = "chei-de-test-demo-generata-in-test-0123456789";

describe("garda DEMO: imposibil în producție", () => {
  const cases: Array<[string, Parameters<typeof isDemoPaymentAllowed>[0], boolean]> = [
    ["producție, fără nimic", { NODE_ENV: "production" }, false],
    [
      "producție cu flagul de dezvoltare",
      { NODE_ENV: "production", ECOM_DEMO_PAYMENTS: "1" },
      false,
    ],
    [
      "producție cu E2E_HARNESS=1 (suita E2E rulează pe build de producție)",
      { NODE_ENV: "production", E2E_HARNESS: "1" },
      true,
    ],
    ["dezvoltare fără flag", { NODE_ENV: "development" }, false],
    ["dezvoltare cu flag", { NODE_ENV: "development", ECOM_DEMO_PAYMENTS: "1" }, true],
    ["fără NODE_ENV, fără flag", {}, false],
    ["fără NODE_ENV, cu flag", { ECOM_DEMO_PAYMENTS: "1" }, true],
    ["flag cu altă valoare", { NODE_ENV: "development", ECOM_DEMO_PAYMENTS: "true" }, false],
    ["E2E_HARNESS cu altă valoare", { NODE_ENV: "production", E2E_HARNESS: "true" }, false],
    ["test", { NODE_ENV: "test", ECOM_DEMO_PAYMENTS: "1" }, true],
  ];
  for (const [name, env, allowed] of cases) {
    it(`${name} → ${allowed ? "permis" : "interzis"}`, () => {
      expect(isDemoPaymentAllowed(env)).toBe(allowed);
    });
  }

  it("furnizorul nu se poate construi când garda nu e îndeplinită (nici direct, nici prin registru)", () => {
    expect(
      () => new DemoPaymentProvider({ env: { NODE_ENV: "production" }, signingKey: KEY }),
    ).toThrowError(/DEMO/);
    expect(() =>
      buildPaymentProvider({
        code: "demo",
        credentials: {},
        mode: "test",
        env: { NODE_ENV: "production", ECOM_DEMO_PAYMENTS: "1" },
        appKey: "x".repeat(32),
      }),
    ).toThrow();
    expect(
      buildPaymentProvider({
        code: "demo",
        credentials: {},
        mode: "test",
        env: { E2E_HARNESS: "1" },
        appKey: "x".repeat(32),
      }).code,
    ).toBe("demo");
  });

  it("refuză o cheie de test scurtă", () => {
    expect(
      () => new DemoPaymentProvider({ env: { E2E_HARNESS: "1" }, signingKey: "scurta" }),
    ).toThrow();
  });
});

describe("DEMO: aceeași cale de verificare a semnăturii ca furnizorii reali", () => {
  const provider = () => new DemoPaymentProvider({ env: { E2E_HARNESS: "1" }, signingKey: KEY });
  const body = {
    eventId: "e1",
    paymentRef: "pay_1",
    outcome: "paid" as const,
    amountMinor: 12_345,
    currency: "RON",
    cardLast4: "4242",
  };

  it("un eveniment semnat cu cheia de test e acceptat și normalizat", async () => {
    const { rawBody, signature } = buildDemoEvent(body, KEY);
    const result = await provider().verifyWebhook({
      headers: { [DEMO_SIGNATURE_HEADER]: signature },
      rawBody,
    });
    expect(result.event).toMatchObject({
      eventId: "e1",
      paymentRef: "pay_1",
      outcome: "paid",
      amountMinor: 12_345,
      cardLast4: "4242",
    });
  });

  it("fără semnătură, cu semnătură greșită sau cu corp modificat => respins", async () => {
    const { rawBody, signature } = buildDemoEvent(body, KEY);
    const reason = async (headers: Record<string, string>, raw: Buffer) => {
      try {
        await provider().verifyWebhook({ headers, rawBody: raw });
        return "acceptat";
      } catch (error) {
        return error instanceof WebhookRejectedError ? error.reason : "altă eroare";
      }
    };
    expect(await reason({}, rawBody)).toBe("signature_missing");
    expect(await reason({ [DEMO_SIGNATURE_HEADER]: "0".repeat(64) }, rawBody)).toBe(
      "signature_invalid",
    );
    expect(
      await reason(
        { [DEMO_SIGNATURE_HEADER]: signature },
        Buffer.from(rawBody.toString().replace("12345", "1")),
      ),
    ).toBe("signature_invalid");
    const other = signDemoBody(rawBody, "alta-cheie-de-test-generata-in-test-9999");
    expect(await reason({ [DEMO_SIGNATURE_HEADER]: other }, rawBody)).toBe("signature_invalid");
    const bad = Buffer.from('{"eventId":1}');
    expect(await reason({ [DEMO_SIGNATURE_HEADER]: signDemoBody(bad, KEY) }, bad)).toBe(
      "body_invalid",
    );
  });

  it("cheia de test e derivată din APP_KEY (nu scrisă în cod) și diferă de la o instalare la alta", () => {
    expect(demoSigningKey("a".repeat(32))).not.toBe(demoSigningKey("b".repeat(32)));
    expect(demoSigningKey("a".repeat(32))).toBe(demoSigningKey("a".repeat(32)));
  });

  it("inițierea trimite clientul la pagina de plată demo a aceleiași origini", async () => {
    const result = await provider().createPayment({
      paymentRef: "pay_1",
      orderNumber: "T-0001",
      amountMinor: 100,
      currency: "RON",
      description: "d",
      customer: {
        firstName: "A",
        lastName: "B",
        email: "a@b.ro",
        phone: "0",
        street: "s",
        city: "c",
        county: "j",
        postalCode: "123456",
      },
      returnUrl: "https://magazin.test/comanda/retur/pay_1",
      notifyUrl: "https://magazin.test/api/webhooks/payments/demo",
    });
    expect(result.redirect.url).toBe("https://magazin.test/plata-demo/pay_1");
  });

  it("rambursarea DEMO respectă comportamentul configurat", async () => {
    const request = {
      providerRef: "demo-pay_1",
      paymentRef: "pay_1",
      refundRef: "r1",
      amountMinor: 100,
      paymentAmountMinor: 200,
      currency: "RON" as const,
      reason: "test",
    };
    for (const behavior of ["confirmed", "pending", "failed", "manual_required"] as const) {
      const p = new DemoPaymentProvider({
        env: { E2E_HARNESS: "1" },
        signingKey: KEY,
        refundBehavior: behavior,
      });
      expect((await p.refund(request)).status).toBe(behavior);
    }
  });
});

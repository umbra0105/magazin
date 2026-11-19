import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, type PrismaClient } from "@ecom/db";
import { signFields } from "@ecom/integrations";
import { NOW, orderOf } from "../test-utils/checkout-fixtures";
import {
  cardHarness,
  placeCardOrder,
  processorDeps,
  TEST_APP_KEY,
} from "../test-utils/payment-fixtures";
import { CardPaymentService } from "./card-payment-service";
import { PaymentConfigService } from "./payment-config";
import { ingestPaymentWebhook, processPaymentEvent } from "./payment-processor";
import { requestRefund } from "./refund-service";

/**
 * Cheile de plată nu ajung nicăieri unde nu au ce căuta: nici în baza de date în clar, nici în starea publică, nici în adresa de
 * plată, nici în cererile de rambursare trimise altfel decât semnate, nici în `rawPayload`, evenimente, cronologie, rambursări,
 * erori sau jurnalul de audit. Testul generează chei FALSE, le trece prin tot fluxul și caută valorile lor în tot ce s-a scris.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const SECRETS = {
  secretKey: hex(16),
  userApi: hex(16),
  userKey: `UKEY-${hex(6)}`,
  merchantId: `MID-${hex(4)}`,
};
const NETOPIA = {
  apiKey: `NTP-API-${hex(10)}`,
  posSignature: `POS-${hex(8)}`,
  publicKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
    .publicKey.export({ type: "spki", format: "pem" })
    .toString(),
};
const SECRET_VALUES = [
  SECRETS.secretKey,
  SECRETS.userApi,
  SECRETS.userKey,
  NETOPIA.apiKey,
  NETOPIA.posSignature,
  NETOPIA.publicKey.replace(/-----[A-Z ]+-----|\s/g, ""),
];

describe("secretele nu apar în niciun loc", () => {
  it("de la salvare la rambursare, nicio valoare de cheie nu ajunge în afara coloanei criptate", async () => {
    await cardHarness(async (h) => {
      const config = new PaymentConfigService({
        db: h.tx as unknown as PrismaClient,
        appKey: TEST_APP_KEY,
        env: { E2E_HARNESS: "1" },
        readCardProvider: async () => "euplatesc",
        now: () => NOW,
        fetch: async (_url, init) => {
          // simulează un procesator: răspunde la `check_mid` și la `refund`
          const body = new URLSearchParams(String(init.body));
          const method = body.get("method");
          return new Response(
            JSON.stringify(
              method === "refund" ? { success: "1" } : { name: "Magazin", status: "test" },
            ),
            { status: 200 },
          );
        },
      });
      await config.save("euplatesc", { credentials: SECRETS, isActive: true });
      await config.save("netopia", { credentials: NETOPIA });

      // 1. în baza de date: criptat
      const rows = await h.tx.integration.findMany({ where: { type: "payment" } });
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const row of rows) {
        const dump = JSON.stringify(row);
        for (const value of SECRET_VALUES) expect(dump).not.toContain(value);
        expect(row.credentials).toMatch(/^v1:/);
      }

      // 2. starea publică: doar «salvat / nesalvat»
      const states = JSON.stringify(await config.list());
      for (const value of SECRET_VALUES) expect(states).not.toContain(value);

      // 3. testarea conexiunii: mesaj clar, fără chei
      const test = await config.testConnection("euplatesc");
      expect(test.ok).toBe(true);
      expect(JSON.stringify(test)).not.toContain(SECRETS.secretKey);

      // 4. o comandă cu card prin EuPlătesc: adresa de plată, plata, notificarea, rambursarea
      const placed = await placeCardOrder(h);
      await h.tx.payment.update({
        where: { id: placed.paymentId },
        data: { provider: "euplatesc", mode: "test" },
      });
      const euplatesc = await config.getProvider("euplatesc");
      expect(euplatesc).not.toBeNull();
      const deps = processorDeps(h);
      deps.getProvider = async (code) => (code === "euplatesc" ? euplatesc : null);
      const cards = new CardPaymentService({
        db: h.tx,
        getProvider: deps.getProvider,
        readSettings: async () => ({
          reservationMinutes: 15,
          transferReservationWorkdays: 3,
          timeZone: "Europe/Bucharest",
          nonWorkingDates: [],
          cardRetryHours: 24,
          cardProvider: { code: "euplatesc", mode: "test" },
        }),
        now: () => NOW,
        returnUrl: (id) => `https://magazin.test/comanda/plata/${id}`,
        notifyUrl: (p) => `https://magazin.test/api/webhooks/payments/${p}`,
      });
      const started = await cards.initiate(placed.paymentId);
      expect(started.kind).toBe("redirect");
      if (started.kind === "redirect") {
        for (const value of SECRET_VALUES) expect(started.redirect.url).not.toContain(value);
      }

      // notificarea EuPlătesc semnată cu cheia secretă (falsă)
      const fields: Array<[string, string]> = [
        ["amount", `${(placed.amountMinor / 100).toFixed(2)}`],
        ["curr", "RON"],
        ["invoice_id", placed.paymentId],
        ["ep_id", `EP${hex(6)}`],
        ["merch_id", SECRETS.merchantId],
        ["action", "0"],
        ["message", "Approved"],
        ["approval", "A1"],
        ["timestamp", "20301115120000"],
        ["nonce", hex(8)],
      ];
      const params = new URLSearchParams(fields);
      params.set("fp_hash", signFields(fields, SECRETS.secretKey));
      const ingest = await ingestPaymentWebhook(deps, "euplatesc", {
        headers: {},
        rawBody: Buffer.from(params.toString()),
      });
      expect(ingest.outcome).toBe("accepted");
      expect(ingest.body).toBe("OK");
      await processPaymentEvent(deps, ingest.eventId!);
      expect((await orderOf(h.tx, placed.orderId)).paymentStatus).toBe("paid");

      await requestRefund(
        { db: h.tx, getProvider: deps.getProvider, now: () => NOW },
        {
          paymentId: placed.paymentId,
          amountMinor: 1_000,
          reason: "Produs returnat",
          idempotencyKey: "secrets-1",
          actorLabel: "admin@exemplu.ro",
        },
      );

      // 5. tot ce s-a scris în urma fluxului
      const written = JSON.stringify({
        payments: await h.tx.payment.findMany({ where: { orderId: placed.orderId } }),
        events: await h.tx.paymentWebhookEvent.findMany(),
        orderEvents: await h.tx.orderEvent.findMany({ where: { orderId: placed.orderId } }),
        refunds: await h.tx.refund.findMany({ where: { orderId: placed.orderId } }),
        audit: await h.tx.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
      });
      for (const value of SECRET_VALUES) expect(written, value.slice(0, 8)).not.toContain(value);
      const payment = await h.tx.payment.findUniqueOrThrow({ where: { id: placed.paymentId } });
      expect(payment.rawPayload).toBeNull();
      expect(payment.cardLast4).toBeNull();
    });
  });

  it("erorile adaptoarelor nu conțin cheile, nici când procesatorul pică cu un mesaj care le-ar conține", async () => {
    await cardHarness(async (h) => {
      const config = new PaymentConfigService({
        db: h.tx as unknown as PrismaClient,
        appKey: TEST_APP_KEY,
        env: { E2E_HARNESS: "1" },
        readCardProvider: async () => "netopia",
        fetch: async () => {
          throw new Error(`conexiune refuzată pentru ${NETOPIA.apiKey} și ${NETOPIA.posSignature}`);
        },
      });
      await config.save("netopia", { credentials: NETOPIA });
      const provider = await config.getProvider("netopia");
      const test = await provider!.testConnection();
      expect(test.ok).toBe(false);
      expect(JSON.stringify(test)).not.toContain(NETOPIA.apiKey);
      expect(JSON.stringify(test)).not.toContain(NETOPIA.posSignature);
      const attempt = await provider!
        .createPayment({
          paymentRef: "p1",
          orderNumber: "T-1",
          amountMinor: 100,
          currency: "RON",
          description: "x",
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
          returnUrl: "https://magazin.test/r",
          notifyUrl: "https://magazin.test/n",
        })
        .catch((error: Error) => error);
      expect(attempt).toBeInstanceOf(Error);
      expect(String((attempt as Error).message)).not.toContain(NETOPIA.apiKey);
      expect(JSON.stringify(attempt)).not.toContain(NETOPIA.posSignature);
      const refund = await provider!.refund({
        providerRef: "1",
        paymentRef: "p1",
        refundRef: "r1",
        amountMinor: 100,
        paymentAmountMinor: 200,
        currency: "RON",
        reason: "x",
      });
      expect(JSON.stringify(refund)).not.toContain(NETOPIA.apiKey);
    });
  });
});

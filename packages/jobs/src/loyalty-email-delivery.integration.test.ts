import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import type { EmailTheme } from "@ecom/emails";
import { LOYALTY_WARNING_TEMPLATE, sendExpiryWarnings, type MailerConfig } from "@ecom/core";
import { NOW, harness, type Harness } from "../../core/src/test-utils/checkout-fixtures";
import { addTo } from "../../core/src/test-utils/digital-checkout";
import { givePoints, loyaltyWorld } from "../../core/src/test-utils/loyalty-fixtures";
import type { JobLogger, OutgoingMessage } from "./email-processor";
import type { StoreEmailSettings } from "./order-email-context";
import { createOrderEmailDelivery } from "./order-email-delivery";

/**
 * Emailurile punctelor (Faza 15b), de la outbox la mesajul trimis, pe Postgres real (tranzacție anulată): avertizarea de
 * expirare și confirmarea comenzii cu punctele folosite și cele de primit.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const MAILER: MailerConfig = {
  host: "smtp.test",
  port: 587,
  secure: false,
  fromName: "Magazin Test",
  fromAddress: "noreply@magazin.test",
};
const THEME: EmailTheme = {
  storeName: "Magazin Test",
  logoUrl: null,
  colors: {
    bg: "#ffffff",
    fg: "#111111",
    muted: "#555555",
    border: "#dddddd",
    primary: "#0b5fff",
    primaryFg: "#ffffff",
  },
  fontFamily: "Arial, sans-serif",
  radiusPx: 6,
};
const STORE: StoreEmailSettings = {
  storeName: "Magazin Test",
  currency: "RON",
  locale: "ro-RO",
  timeZone: "Europe/Bucharest",
  company: {
    legalName: "Firma Test SRL",
    vatId: "RO12345678",
    tradeRegisterNo: "J01/001/2020",
    address: {
      street: "Strada Firmei 3",
      city: "Alba Iulia",
      county: "Alba",
      postalCode: "510000",
      country: "RO",
    },
    email: "contact@magazin.test",
    phone: "0700 111 222",
    iban: "RO49AAAA1B31007593840000",
    bankName: "Banca Test",
  },
  legal: { anpcUrl: "https://anpc.test", salUrl: "https://sal.test", odrUrl: "https://sol.test" },
};
const logger: JobLogger = { info: () => {}, warn: () => {}, error: () => {} };
const DAY = 86_400_000;

function setup(h: Harness, now: Date = NOW) {
  const sent: OutgoingMessage[] = [];
  const delivery = createOrderEmailDelivery({
    db: h.tx,
    appUrl: "https://magazin.test",
    now: () => now,
    loadMailer: async () => MAILER,
    loadTheme: async () => THEME,
    loadStore: async () => STORE,
    loadOverride: async () => null,
    sendMail: async (_config, message) => {
      sent.push(message);
    },
    logger,
  });
  const run = (dispatchId: string) =>
    delivery(dispatchId, { jobId: `j-${randomUUID()}`, attempt: 1, maxAttempts: 5 });
  return { sent, run };
}

describe("emailul de avertizare a expirării", () => {
  it("spune câte puncte, valoarea lor, data și linkul din cont", async () => {
    await harness(async (h) => {
      const world = await loyaltyWorld(h, 0);
      await givePoints(h.tx, world.userId, 47, 20);
      await sendExpiryWarnings(h.tx, { now: NOW });
      const user = await h.tx.user.findUniqueOrThrow({ where: { id: world.userId } });
      const row = await h.tx.emailDispatch.findFirstOrThrow({
        where: { template: LOYALTY_WARNING_TEMPLATE, recipient: user.email },
      });
      const { sent, run } = setup(h);
      await run(row.id);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe(user.email);
      expect(sent[0]!.text).toContain("47 de puncte");
      expect(sent[0]!.text.replace(/\s/g, " ")).toContain("47,00 RON");
      expect(sent[0]!.text).toContain("5 iulie 2030");
      expect(sent[0]!.html).toContain("https://magazin.test/cont/puncte");
      expect(sent[0]!.text).not.toContain("puncte de test");
    });
  });

  it("nu mai pleacă dacă punctele au expirat între timp sau contul a fost anonimizat", async () => {
    await harness(async (h) => {
      const world = await loyaltyWorld(h, 0);
      await givePoints(h.tx, world.userId, 47, 20);
      await sendExpiryWarnings(h.tx, { now: NOW });
      const row = await h.tx.emailDispatch.findFirstOrThrow({
        where: { template: LOYALTY_WARNING_TEMPLATE },
        orderBy: { createdAt: "desc" },
      });
      const late = setup(h, new Date(NOW.getTime() + 25 * DAY));
      await late.run(row.id);
      expect(late.sent).toHaveLength(0);
      expect((await h.tx.emailDispatch.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
        "skipped",
      );
    });
  });
});

describe("confirmarea comenzii cu puncte", () => {
  it("arată reducerea din puncte, punctele folosite și cele de primit", async () => {
    await harness(async (h) => {
      const world = await loyaltyWorld(h, 500);
      const product = await h.product({ price: 100_000 });
      await addTo(world, [{ variantId: product.variantId }]);
      const preview = await h.checkout.preview({
        owner: world.owner,
        destination: {
          countyCode: h.geo.countyCode,
          localityCode: h.geo.localityCode,
          postalCode: "123456",
        },
        offerCode: "demo:courier",
        paymentMethod: "cod",
        loyaltyPoints: 100,
      });
      const input = await h.input(world.owner, {
        loyaltyPoints: 100,
        expectedTotalMinor: preview.totals!.totalMinor,
      });
      const { orderId } = await h.checkout.place(world.owner, input);
      const row = await h.tx.emailDispatch.findFirstOrThrow({
        where: { orderId, template: "order.confirmation" },
      });
      const { sent, run } = setup(h);
      await run(row.id);
      const text = sent[0]!.text.replace(/\s/g, " ");
      expect(text).toContain("Reducere din puncte de loialitate");
      expect(text).toContain("-100,00 RON");
      expect(text).toContain("ai folosit 100 de puncte");
      expect(text).toContain("vei primi 9 puncte");
    });
  });
});

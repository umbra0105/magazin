import { UnrecoverableError } from "bullmq";
import { afterAll, describe, expect, it } from "vitest";
import { OfferService, type MailerConfig } from "@ecom/core";
import { getDb } from "@ecom/db";
import type { EmailTheme } from "@ecom/emails";
import { NOW, type Harness } from "../../core/src/test-utils/checkout-fixtures";
import { cardHarness } from "../../core/src/test-utils/payment-fixtures";
import type { JobLogger, OutgoingMessage } from "./email-processor";
import { createOfferEmailDelivery } from "./offer-email-delivery";
import type { StoreEmailSettings } from "./order-email-context";

/**
 * Livrarea linkului unei oferte de plată (Faza 11), pe Postgres real, în tranzacție anulată (SMTP-ul e înlocuit de o funcție care
 * păstrează mesajele): o trimitere cu linkul corect, nimic pentru o ofertă care nu mai e activă sau pentru un jeton înlocuit,
 * erori curățate de adresă și jeton, eveniment și notificare la eșecul definitiv.
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
const ACTOR = { id: "user-1", label: "Manager Test" };
const TO = "client.oferta@exemplu.ro";

async function withOffer<T>(
  fn: (env: {
    h: Harness;
    offers: OfferService;
    offer: Awaited<ReturnType<OfferService["create"]>>;
    sent: OutgoingMessage[];
    logs: string[];
    run: (over?: { token?: string; attempt?: number; maxAttempts?: number }) => Promise<void>;
  }) => Promise<T>,
  over: { mailer?: MailerConfig | null; send?: () => Promise<void> } = {},
): Promise<T> {
  return cardHarness(async (h) => {
    const offers = new OfferService({
      db: h.tx,
      cart: h.cart,
      checkout: h.checkout,
      readSettings: async () => ({ validityHours: 72, numberPrefix: "OF-" }),
      now: () => NOW,
    });
    const product = await h.product({ physical: "10" });
    const offer = await offers.create(
      {
        email: TO,
        phone: "0722123456",
        shipping: {
          fullName: "Ana Popescu",
          phone: "0722123456",
          countyCode: h.geo.countyCode,
          localityCode: h.geo.localityCode,
          street: "Str. Exemplu 1",
          postalCode: "123456",
        },
        billing: { sameAsShipping: true },
        company: null,
        shippingOfferCode: "demo:courier",
        lines: [{ variantId: product.variantId, quantity: "1" }],
      },
      ACTOR,
    );
    const sent: OutgoingMessage[] = [];
    const logs: string[] = [];
    const logger: JobLogger = {
      info: (obj, msg) => logs.push(`${JSON.stringify(obj)} ${msg}`),
      warn: (obj, msg) => logs.push(`${JSON.stringify(obj)} ${msg}`),
      error: (obj, msg) => logs.push(`${JSON.stringify(obj)} ${msg}`),
    };
    const delivery = createOfferEmailDelivery({
      db: h.tx,
      appUrl: "https://magazin.test/orice/cale",
      now: () => NOW,
      loadMailer: async () => (over.mailer === undefined ? MAILER : over.mailer),
      loadTheme: async () => THEME,
      loadStore: async () => STORE,
      loadOverride: async () => null,
      sendMail: async (_config, message) => {
        if (over.send) await over.send();
        sent.push(message);
      },
      logger,
    });
    const run = (o: { token?: string; attempt?: number; maxAttempts?: number } = {}) =>
      delivery(
        { offerId: offer.offerId, to: TO, token: o.token ?? offer.token },
        { jobId: "j-1", attempt: o.attempt ?? 1, maxAttempts: o.maxAttempts ?? 5 },
      );
    return fn({ h, offers, offer, sent, logs, run });
  });
}

describe("livrarea linkului ofertei", () => {
  it("trimite către adresa din ofertă, cu linkul personal, numărul și totalul; fără jeton în loguri", async () => {
    await withOffer(async ({ offer, sent, logs, run }) => {
      await run();
      expect(sent).toHaveLength(1);
      const message = sent[0] as OutgoingMessage;
      expect(message.to).toBe(TO);
      expect(message.from).toEqual({ name: "Magazin Test", address: "noreply@magazin.test" });
      expect(message.subject).toContain(offer.number);
      const link = `https://magazin.test/oferta/${offer.token}`;
      expect(message.html).toContain(link);
      expect(message.text).toContain(link);
      expect(message.html).toContain("Ana Popescu");
      expect(message.text).toContain("Magazin Test");
      const log = logs.join("\n");
      expect(log).not.toContain(offer.token);
      expect(log).not.toContain(TO);
    });
  });

  it("oferta anulată sau expirată nu se mai trimite (un link mort ar induce în eroare)", async () => {
    await withOffer(async ({ offers, offer, sent, run }) => {
      await offers.cancel(offer.offerId, ACTOR);
      await run();
      expect(sent).toHaveLength(0);
    });
    await withOffer(async ({ h, offer, sent, run }) => {
      await h.tx.orderOffer.update({ where: { id: offer.offerId }, data: { status: "expired" } });
      await run();
      expect(sent).toHaveLength(0);
    });
  });

  it("un job cu jetonul vechi, după o retrimitere, nu trimite nimic (linkul vechi nu mai merge)", async () => {
    await withOffer(async ({ offers, offer, sent, run }) => {
      const again = await offers.reissueToken(offer.offerId, ACTOR);
      await run({ token: offer.token });
      expect(sent).toHaveLength(0);
      await run({ token: again.token });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.html).toContain(again.token);
    });
  });

  it("eșecul de trimitere se reîncearcă fără date în eroare; abia ultima încercare scrie evenimentul și notificarea", async () => {
    await withOffer(
      async ({ h, offer, sent, logs, run }) => {
        const early = await run({ attempt: 1 }).catch((e: unknown) => e as Error);
        expect(early).toBeInstanceOf(Error);
        expect((early as Error).name).toBe("EmailSendError");
        expect((early as Error).message).not.toContain(TO);
        expect((early as Error).message).not.toContain(offer.token);
        expect(
          await h.tx.orderOfferEvent.count({
            where: { offerId: offer.offerId, type: "offer.email_failed" },
          }),
        ).toBe(0);
        expect(
          await h.tx.adminNotification.count({
            where: {
              kind: "email_failed",
              dedupKey: { startsWith: `offer_email_failed:${offer.offerId}:` },
            },
          }),
        ).toBe(0);

        const last = await run({ attempt: 5, maxAttempts: 5 }).catch((e: unknown) => e as Error);
        expect((last as Error).message).not.toContain(TO);
        expect((last as Error).message).not.toContain(offer.token);
        const events = await h.tx.orderOfferEvent.findMany({
          where: { offerId: offer.offerId, type: "offer.email_failed" },
        });
        expect(events).toHaveLength(1);
        const notes = await h.tx.adminNotification.findMany({
          where: {
            kind: "email_failed",
            dedupKey: { startsWith: `offer_email_failed:${offer.offerId}:` },
          },
        });
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatchObject({
          permission: "orders.offers",
          href: `/admin/comenzi/oferte/${offer.offerId}`,
        });
        const text = JSON.stringify([events, notes, logs]);
        expect(text).not.toContain(TO);
        expect(text).not.toContain(offer.token);
        expect(sent).toHaveLength(0);
      },
      {
        send: async () => {
          throw Object.assign(new Error(`550 refuz pentru ${TO} cu ${"x"}`), { code: "EENVELOPE" });
        },
      },
    );
  });

  it("SMTP neconfigurat: eșec definitiv (fără reîncercare), cu notificare pentru admin", async () => {
    await withOffer(
      async ({ h, offer, sent, run }) => {
        const error = await run().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(UnrecoverableError);
        expect(sent).toHaveLength(0);
        expect(
          await h.tx.orderOfferEvent.count({
            where: { offerId: offer.offerId, type: "offer.email_failed" },
          }),
        ).toBe(1);
        expect(
          await h.tx.adminNotification.count({
            where: {
              kind: "email_failed",
              dedupKey: { startsWith: `offer_email_failed:${offer.offerId}:` },
            },
          }),
        ).toBe(1);
      },
      { mailer: null },
    );
  });
});

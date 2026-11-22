import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import type { EmailTheme } from "@ecom/emails";
import type { MailerConfig } from "@ecom/core";
import { harness, q, type Harness } from "../../core/src/test-utils/checkout-fixtures";
import { approveReturn, rejectReturn, setReturnAwb } from "../../core/src/returns/return-admin";
import { cancelReturnByCustomer, initiateReturn } from "../../core/src/returns/return-customer";
import type { JobLogger, OutgoingMessage } from "./email-processor";
import type { StoreEmailSettings } from "./order-email-context";
import { createOrderEmailDelivery } from "./order-email-delivery";

/**
 * Emailurile returului (Faza 14), de la tranziție la mesajul trimis, pe Postgres real (tranzacție anulată). Dovedește: un email per
 * tranziție, către clientul care a cerut returul, cu AWB-ul și adresa de retur când există, cu motivul respingerii, și NICIODATĂ cu
 * nota internă a adminului sau cu alte date interne.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const NOW = new Date("2030-06-15T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const SECRET = "NOTA-INTERNA-SECRETA-DE-RETUR";
const ADMIN = { label: "admin@test.ro" };
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

function setup(h: Harness) {
  const sent: OutgoingMessage[] = [];
  const delivery = createOrderEmailDelivery({
    db: h.tx,
    appUrl: "https://magazin.test",
    now: () => NOW,
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
    delivery(dispatchId, { jobId: `j-${dispatchId}`, attempt: 1, maxAttempts: 5 });
  return { sent, run };
}

async function returnFor(h: Harness) {
  const product = await h.product();
  const owner = await h.fill([{ variantId: product.variantId, quantity: q("2") }]);
  const { orderId } = await h.checkout.place(owner, await h.input(owner));
  const order = await h.tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { lines: true },
  });
  await h.tx.orderEvent.create({
    data: {
      orderId,
      type: "order.delivered",
      message: "Livrată",
      createdAt: new Date(NOW.getTime() - DAY),
    },
  });
  const user = await h.tx.user.create({
    data: {
      id: `u_${randomUUID().slice(0, 8)}`,
      name: "Client",
      email: order.email,
      emailVerified: true,
    },
  });
  const created = await initiateReturn(
    h.tx,
    { id: user.id, email: user.email, emailVerified: true },
    {
      orderId,
      clientKey: randomUUID(),
      items: [{ orderLineId: order.lines[0]!.id, quantity: "1", reasonCode: "defective" }],
    },
    NOW,
  );
  return { orderId, returnId: created.returnId, email: order.email, number: created.number };
}

const dispatchOf = (h: Harness, returnId: string, template: string) =>
  h.tx.emailDispatch.findMany({
    where: { template, data: { path: ["returnId"], equals: returnId } },
  });

describe("emailurile returului", () => {
  it("cererea primită: un email către clientul care a cerut returul, cu numărul returului", async () => {
    await harness(async (h) => {
      const r = await returnFor(h);
      const rows = await dispatchOf(h, r.returnId, "return.received");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        audience: "customer",
        orderId: r.orderId,
        status: "queued",
      });
      const { sent, run } = setup(h);
      await run(rows[0]!.id);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe(r.email.toLowerCase());
      expect(sent[0]!.text).toContain(`R-${r.number}`);
      expect(sent[0]!.html).toContain(`https://magazin.test/cont/retururi/${r.returnId}`);
    });
  });

  it("aprobarea: instrucțiuni cu adresa de retur; nota internă NU apare nici în outbox, nici în email", async () => {
    await harness(async (h) => {
      const r = await returnFor(h);
      await approveReturn(h.tx, r.returnId, ADMIN, NOW, SECRET);
      const rows = await dispatchOf(h, r.returnId, "return.approved");
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0]!.data)).not.toContain(SECRET);
      const { sent, run } = setup(h);
      await run(rows[0]!.id);
      const message = sent[0]!;
      for (const part of [message.html, message.text, message.subject]) {
        expect(part).not.toContain(SECRET);
        expect(part).not.toContain("admin@test.ro");
      }
      expect(message.text).toContain("Strada Firmei 3");
    });
  });

  it("AWB-ul de retur: număr, curier și link de urmărire în email", async () => {
    await harness(async (h) => {
      const r = await returnFor(h);
      await approveReturn(h.tx, r.returnId, ADMIN, NOW);
      await setReturnAwb(
        h.tx,
        r.returnId,
        ADMIN,
        { carrier: "Curier Test", awb: "AWB-777", trackingUrl: "https://curier.test/awb/777" },
        NOW,
      );
      const rows = await dispatchOf(h, r.returnId, "return.awb");
      expect(rows).toHaveLength(1);
      const { sent, run } = setup(h);
      await run(rows[0]!.id);
      expect(sent[0]!.text).toContain("AWB-777");
      expect(sent[0]!.text).toContain("Curier Test");
      expect(sent[0]!.text).toContain("https://curier.test/awb/777");
    });
  });

  it("respingerea: motivul vizibil clientului apare în email", async () => {
    await harness(async (h) => {
      const r = await returnFor(h);
      await rejectReturn(h.tx, r.returnId, ADMIN, "Produsul a fost folosit", NOW);
      const rows = await dispatchOf(h, r.returnId, "return.rejected");
      expect(rows).toHaveLength(1);
      const { sent, run } = setup(h);
      await run(rows[0]!.id);
      expect(sent[0]!.text).toContain("Produsul a fost folosit");
    });
  });

  it("anularea de către client trimite emailul de anulare; nicio tranziție nu produce două emailuri pentru același eveniment", async () => {
    await harness(async (h) => {
      const r = await returnFor(h);
      const user = await h.tx.user.findFirstOrThrow({ where: { email: r.email } });
      await cancelReturnByCustomer(
        h.tx,
        { id: user.id, email: user.email, emailVerified: true },
        r.returnId,
        NOW,
      );
      expect(await dispatchOf(h, r.returnId, "return.cancelled")).toHaveLength(1);
      // fiecare eveniment are cheia lui: cererea inițială a dat exact un email «primită»
      expect(await dispatchOf(h, r.returnId, "return.received")).toHaveLength(1);
    });
  });

  it("un cont anonimizat nu primește emailuri de retur", async () => {
    await harness(async (h) => {
      const r = await returnFor(h);
      const user = await h.tx.user.findFirstOrThrow({ where: { email: r.email } });
      await h.tx.user.update({ where: { id: user.id }, data: { anonymizedAt: NOW } });
      await approveReturn(h.tx, r.returnId, ADMIN, NOW);
      expect(await dispatchOf(h, r.returnId, "return.approved")).toHaveLength(0);
    });
  });
});

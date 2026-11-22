import { UnrecoverableError } from "bullmq";
import { afterAll, describe, expect, it } from "vitest";
import { claimDispatch, enqueueDispatches, type MailerConfig } from "@ecom/core";
import { getDb } from "@ecom/db";
import type { EmailTheme } from "@ecom/emails";
import { harness, q, type Harness } from "../../core/src/test-utils/checkout-fixtures";
import { createManualShipment } from "../../core/src/shipping/shipment-service";
import {
  cardHarness,
  deliver as deliverPaymentEvent,
  paidEvent,
  placeCardOrder,
  processorDeps,
} from "../../core/src/test-utils/payment-fixtures";
import type { JobLogger, OutgoingMessage } from "./email-processor";
import type { StoreEmailSettings } from "./order-email-context";
import { createOrderEmailDelivery } from "./order-email-delivery";

/**
 * Livrarea emailurilor de comenzi (Faza 11): de la rândul `EmailDispatch` la mesajul trimis, pe Postgres real, în tranzacție
 * anulată (SMTP-ul e înlocuit de o funcție care păstrează mesajele). Dovedește: o singură trimitere per rând, ridicarea cu adresa
 * magazinului din snapshot (niciodată adresa clientului), erori curățate de date personale, dead-letter la ultima încercare.
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
const NOW = new Date("2030-06-15T12:00:00.000Z");

interface Sent {
  config: MailerConfig;
  message: OutgoingMessage;
}

function setup(
  h: Harness,
  over: {
    mailer?: MailerConfig | null;
    send?: (message: OutgoingMessage) => Promise<void>;
    override?: { subject: string; intro: string } | null;
  } = {},
) {
  const sent: Sent[] = [];
  const logs: string[] = [];
  const logger: JobLogger = {
    info: (obj, msg) => logs.push(`${JSON.stringify(obj)} ${msg}`),
    warn: (obj, msg) => logs.push(`${JSON.stringify(obj)} ${msg}`),
    error: (obj, msg) => logs.push(`${JSON.stringify(obj)} ${msg}`),
  };
  const delivery = createOrderEmailDelivery({
    db: h.tx,
    appUrl: "https://magazin.test/orice/cale",
    now: () => NOW,
    loadMailer: async () => (over.mailer === undefined ? MAILER : over.mailer),
    loadTheme: async () => THEME,
    loadStore: async () => STORE,
    loadOverride: async () => over.override ?? null,
    sendMail: async (config, message) => {
      if (over.send) await over.send(message);
      sent.push({ config, message });
    },
    logger,
  });
  const run = (dispatchId: string, attempt = 1, maxAttempts = 5) =>
    delivery(dispatchId, { jobId: `j-${dispatchId}`, attempt, maxAttempts });
  return { sent, logs, run };
}

async function placed(
  h: Harness,
  over: { paymentMethod?: string; shippingOfferCode?: string; quantity?: string } = {},
  productOver: { shippingClass?: "standard" | "oversized" | "pallet" } = {},
) {
  const product = await h.product({ physical: "100", ...productOver });
  const owner = await h.fill([{ variantId: product.variantId, quantity: q(over.quantity ?? "1") }]);
  const input = await h.input(owner, {
    ...(over.paymentMethod ? { paymentMethod: over.paymentMethod } : {}),
    ...(over.shippingOfferCode ? { shippingOfferCode: over.shippingOfferCode } : {}),
  });
  return { ...(await h.checkout.place(owner, input)), input };
}

const rowOf = (h: Harness, orderId: string, template: string) =>
  h.tx.emailDispatch.findFirstOrThrow({ where: { orderId, template } });

describe("livrarea emailului de confirmare", () => {
  it("trimite o dată, către clientul comenzii, cu informațiile precontractuale din setări; rândul devine «sent»", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      const order = await h.tx.order.findUniqueOrThrow({ where: { id: orderId } });
      const row = await rowOf(h, orderId, "order.confirmation");
      const { sent, run } = setup(h);
      await run(row.id);
      expect(sent).toHaveLength(1);
      const { message, config } = sent[0] as Sent;
      expect(config).toEqual(MAILER);
      expect(message.to).toBe(order.email.toLowerCase());
      expect(message.from).toEqual({ name: "Magazin Test", address: "noreply@magazin.test" });
      expect(message.subject).toContain(order.number);
      for (const part of [message.html, message.text]) {
        expect(part).toContain(order.number);
        expect(part.toLowerCase()).toContain("firma test srl");
        expect(part).toContain("RO12345678");
        expect(part).toContain("Strada Firmei 3, 510000 Alba Iulia, Alba");
        expect(part).toContain("https://anpc.test");
        expect(part.toLowerCase()).toContain("formularul-model de retragere");
      }
      const done = await h.tx.emailDispatch.findUniqueOrThrow({ where: { id: row.id } });
      expect(done).toMatchObject({ status: "sent", attempts: 1, lastError: null });
      expect(done.sentAt).toEqual(NOW);
    });
  });

  it("a doua procesare a aceluiași rând NU trimite nimic (o singură dată), nici la apeluri simultane", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      const row = await rowOf(h, orderId, "order.confirmation");
      const { sent, run } = setup(h);
      await Promise.all([run(row.id), run(row.id), run(row.id)]);
      await run(row.id);
      expect(sent).toHaveLength(1);
    });
  });

  it("un rând deja revendicat de alt worker nu se trimite din nou", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      const row = await rowOf(h, orderId, "order.confirmation");
      await claimDispatch(h.tx, row.id, NOW);
      const { sent, run } = setup(h);
      await run(row.id);
      expect(sent).toHaveLength(0);
      expect((await h.tx.emailDispatch.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
        "sending",
      );
    });
  });

  it("proforma (transfer bancar): IBAN-ul și banca din setări, termenul rezervării", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h, { paymentMethod: "bank_transfer" });
      const { sent, run } = setup(h);
      await run((await rowOf(h, orderId, "order.proforma")).id);
      const { text } = (sent[0] as Sent).message;
      expect(text).toContain("RO49AAAA1B31007593840000");
      expect(text).toContain("Banca Test");
      expect(text).toMatch(/Termen/);
    });
  });
});

describe("ridicare personală: adresa magazinului, nu a clientului (decizia 2026-11-19, punctul e)", () => {
  it("emailul de confirmare folosește adresa din snapshot; rândul Address de livrare (adresa clientului) nu apare", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h, { shippingOfferCode: "pickup" });
      const order = await h.tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { addresses: true },
      });
      expect(order.shippingMethodCode).toBe("pickup");
      const customerAddress = order.addresses.find((a) => a.kind === "shipping");
      expect(customerAddress?.street).toBeTruthy();
      const snapshot = order.shippingSnapshot as { pickupAddress?: { text?: string } };
      const storeText = snapshot.pickupAddress?.text ?? "";
      expect(storeText).toContain("Strada Magazinului 7");

      const { sent, run } = setup(h);
      await run((await rowOf(h, orderId, "order.confirmation")).id);
      const { text, html } = (sent[0] as Sent).message;
      for (const part of [text, html]) {
        expect(part).toContain(storeText);
        expect(part).not.toContain(customerAddress?.street ?? "<lipsește>");
        expect(part).not.toContain(customerAddress?.localityName ?? "<lipsește>");
      }
      expect(text).toContain("Ridicare personală de la");
      expect(text).toContain("Plătești în magazin la ridicare");
      expect(text).not.toMatch(/curierului/i);
    });
  });
});

describe("transport paletizat și expediere (Faza 12)", () => {
  it("rambursul la transport paletizat: «doar cu cardul», nu «Plătești curierului»", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(
        h,
        { shippingOfferCode: "pallet" },
        { shippingClass: "pallet" },
      );
      expect(
        (await h.tx.order.findUniqueOrThrow({ where: { id: orderId } })).shippingMethodCode,
      ).toBe("pallet");
      const { sent, run } = setup(h);
      await run((await rowOf(h, orderId, "order.confirmation")).id);
      const { text, html } = (sent[0] as Sent).message;
      for (const part of [text, html]) {
        expect(part).toContain("Plata la livrare doar cu cardul; curierul nu acceptă numerar");
        expect(part).not.toMatch(/Plătești curierului/);
      }
    });
  });

  it("emailul «expediată» poartă AWB-ul și transportatorul, și pleacă o singură dată", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      await createManualShipment(h.tx, orderId, {
        actorLabel: "admin@test.ro",
        now: NOW,
        carrier: "Transport Palet SRL",
        awb: "PAL-777",
      });
      const row = await rowOf(h, orderId, "order.shipped");
      const { sent, run } = setup(h);
      await run(row.id);
      await run(row.id);
      expect(sent).toHaveLength(1);
      const { text, html } = (sent[0] as Sent).message;
      for (const part of [text, html]) {
        expect(part).toContain("PAL-777");
        expect(part).toContain("Transport Palet SRL");
      }
    });
  });
});

describe("eșecuri: curățate de date personale, reîncercare, dead-letter", () => {
  const failing = (address: string) => async (message: OutgoingMessage) => {
    throw Object.assign(new Error(`550 destinatar respins ${address} / ${message.subject}`), {
      code: "EENVELOPE",
    });
  };

  it("eșec reîncercabil: rândul revine în coadă, eroarea nu conține adresa, subiectul sau corpul; jobul aruncă eroarea curățată", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      const order = await h.tx.order.findUniqueOrThrow({ where: { id: orderId } });
      const row = await rowOf(h, orderId, "order.confirmation");
      const { run, logs } = setup(h, { send: failing(order.email) });
      const error = await run(row.id, 1, 5).catch((e: unknown) => e as Error);
      expect(error).toMatchObject({ name: "EmailSendError" });
      expect((error as Error).message).not.toContain(order.email);
      expect((error as Error).message).toContain("EENVELOPE");
      const after = await h.tx.emailDispatch.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.status).toBe("queued");
      expect(after.lastError).not.toContain(order.email);
      expect(after.lastError).not.toContain(order.number);
      expect(logs.join("\n")).not.toContain(order.email);
    });
  });

  it("la ULTIMA încercare rândul devine «failed» (dead-letter), cu eroarea curățată; un rând «failed» nu se mai trimite singur", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      const order = await h.tx.order.findUniqueOrThrow({ where: { id: orderId } });
      const row = await rowOf(h, orderId, "order.confirmation");
      const failingSetup = setup(h, { send: failing(order.email) });
      await failingSetup.run(row.id, 5, 5).catch(() => undefined);
      const dead = await h.tx.emailDispatch.findUniqueOrThrow({ where: { id: row.id } });
      expect(dead.status).toBe("failed");
      expect(dead.lastError).not.toContain(order.email);
      const ok = setup(h);
      await ok.run(row.id);
      expect(ok.sent).toHaveLength(0);
    });
  });

  it("SMTP neconfigurat: rândul devine «failed» cu motivul, jobul nu se reîncearcă (UnrecoverableError)", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      const row = await rowOf(h, orderId, "order.confirmation");
      const { run } = setup(h, { mailer: null });
      await expect(run(row.id)).rejects.toBeInstanceOf(UnrecoverableError);
      const after = await h.tx.emailDispatch.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.status).toBe("failed");
      expect(after.lastError).toMatch(/SMTP neconfigurat/);
    });
  });
});

describe("plată eșuată, anulare și stoc pierdut", () => {
  it("plată eșuată: linkul «reîncearcă plata» are un jeton valid, emis la trimitere", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId, paymentId, amountMinor } = await placeCardOrder(h);
      await deliverPaymentEvent(deps, paidEvent(paymentId, amountMinor, { outcome: "failed" }));
      const row = await rowOf(h, orderId, "order.payment_failed");
      const { sent, run } = setup(h);
      await run(row.id);
      const { text } = (sent[0] as Sent).message;
      const token = /https:\/\/magazin\.test\/comanda\/plateste\/([A-Za-z0-9_-]{20,100})/.exec(
        text,
      )?.[1];
      expect(token, text).toBeTruthy();
      const { createHash } = await import("node:crypto");
      const stored = await h.tx.paymentRetryToken.findUnique({
        where: {
          tokenHash: createHash("sha256")
            .update(token ?? "")
            .digest("hex"),
        },
      });
      expect(stored?.orderId).toBe(orderId);
      expect(stored?.usedAt).toBeNull();
    });
  });

  it("plată eșuată după ce comanda s-a anulat: rândul e «skipped» (fără link mort), nu «failed»", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const { orderId, paymentId, amountMinor } = await placeCardOrder(h);
      await deliverPaymentEvent(deps, paidEvent(paymentId, amountMinor, { outcome: "failed" }));
      await h.tx.order.update({
        where: { id: orderId },
        data: { paymentRetryDeadlineAt: new Date(NOW.getTime() - 1000) },
      });
      const row = await rowOf(h, orderId, "order.payment_failed");
      const { sent, run } = setup(h);
      await run(row.id);
      expect(sent).toHaveLength(0);
      expect(await h.tx.emailDispatch.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
        status: "skipped",
        lastError: "plata nu mai poate fi reîncercată",
      });
    });
  });

  it("anulare automată: motivul în clar, fără nota despre rambursare (nu fusese plătită)", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h, { paymentMethod: "bank_transfer" });
      await enqueueDispatches(h.tx, [
        {
          template: "order.cancelled",
          eventKey: "event:test-auto",
          recipient: "client@exemplu.invalid",
          audience: "customer",
          orderId,
          data: { eventType: "order.auto_cancelled", reason: "auto", paid: false },
        },
      ]);
      const row = await rowOf(h, orderId, "order.cancelled");
      const { sent, run } = setup(h);
      await run(row.id);
      const { text } = (sent[0] as Sent).message;
      expect(text).toContain("Termenul de plată prin transfer bancar a expirat");
      expect(text).not.toContain("te anunțăm printr-un email separat când rambursarea");
    });
  });

  it("anulare a unei comenzi plătite: nota «te anunțăm când rambursarea este confirmată» (nicio promisiune de suma rambursată)", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      await enqueueDispatches(h.tx, [
        {
          template: "order.cancelled",
          eventKey: "event:test-paid",
          recipient: "client@exemplu.invalid",
          audience: "customer",
          orderId,
          data: { eventType: "order.cancelled", reason: "Produs indisponibil", paid: true },
        },
      ]);
      const { sent, run } = setup(h);
      await run((await rowOf(h, orderId, "order.cancelled")).id);
      const { text } = (sent[0] as Sent).message;
      expect(text).toContain("Produs indisponibil");
      expect(text).toContain("te anunțăm printr-un email separat când rambursarea este confirmată");
    });
  });

  it("STOCK_RESERVATION_LOST: formularea din INTREBARI-AVOCAT §8.1, fără «rambursat»", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      await enqueueDispatches(h.tx, [
        {
          template: "order.stock_lost",
          eventKey: "event:test-lost",
          recipient: "client@exemplu.invalid",
          audience: "customer",
          orderId,
        },
      ]);
      const { sent, run } = setup(h);
      await run((await rowOf(h, orderId, "order.stock_lost")).id);
      const message = (sent[0] as Sent).message;
      expect(message.text).toContain(
        "Plata a ajuns după expirarea rezervării, iar produsele nu mai sunt în stoc.",
      );
      expect(message.text).toContain("iar suma plătită va fi returnată");
      expect(`${message.subject} ${message.text}`).not.toMatch(/rambursat[ăa]?\b/i);
    });
  });

  it("rambursare confirmată: suma din eveniment, formatată cu moneda din setări", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      await enqueueDispatches(h.tx, [
        {
          template: "order.refunded",
          eventKey: "event:test-ref",
          recipient: "client@exemplu.invalid",
          audience: "customer",
          orderId,
          data: { eventType: "payment.refunded", amountMinor: 123_45 },
        },
      ]);
      const { sent, run } = setup(h);
      await run((await rowOf(h, orderId, "order.refunded")).id);
      expect((sent[0] as Sent).message.text).toMatch(/123,45\s*RON/);
    });
  });
});

describe("suprascrierea și notificările interne", () => {
  it("suprascrierea din admin se aplică la subiect și început, nu scoate informațiile obligatorii", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      const { sent, run } = setup(h, {
        override: { subject: "Mulțumim! Comanda {{numar}}", intro: "Salutare {{client}}!" },
      });
      await run((await rowOf(h, orderId, "order.confirmation")).id);
      const { subject, html } = (sent[0] as Sent).message;
      expect(subject).toMatch(/^Mulțumim! Comanda /);
      expect(html).toContain("Salutare");
      expect(html).toContain("Cine ți-a vândut");
      expect(html).toContain("RO12345678");
    });
  });

  it("notificare internă: către destinatarul din setare, cu linkul comenzii din admin", async () => {
    await harness(async (h) => {
      await h.tx.setting.upsert({
        where: { key: "email.internalRecipients" },
        create: { key: "email.internalRecipients", group: "email", value: ["echipa@magazin.test"] },
        update: { value: ["echipa@magazin.test"] },
      });
      const { orderId } = await placed(h);
      const row = await rowOf(h, orderId, "internal.order_new");
      const { sent, run } = setup(h);
      await run(row.id);
      const { message } = sent[0] as Sent;
      expect(message.to).toBe("echipa@magazin.test");
      expect(message.text).toContain(`https://magazin.test/admin/comenzi/${orderId}`);
    });
  });

  it("stoc epuizat: numele produsului și SKU-ul, către echipă", async () => {
    await harness(async (h) => {
      await h.tx.setting.upsert({
        where: { key: "email.internalRecipients" },
        create: { key: "email.internalRecipients", group: "email", value: ["echipa@magazin.test"] },
        update: { value: ["echipa@magazin.test"] },
      });
      const product = await h.product({ physical: "1" });
      const owner = await h.fill([{ variantId: product.variantId, quantity: q("1") }]);
      const { orderId } = await h.checkout.place(owner, await h.input(owner));
      const row = await rowOf(h, orderId, "internal.stock_out");
      const { sent, run } = setup(h);
      await run(row.id);
      expect((sent[0] as Sent).message.text).toContain(product.sku);
    });
  });
});

describe("alerta «sincronizarea SmartBill e neactualizată»: reverificarea la trimitere", () => {
  const TEMPLATE = "internal.stock_sync_stale";
  let seq = 0;

  async function queueAlert(h: Harness, roles: string[], verified = true) {
    const email = `alerta-trimitere-${++seq}-${Date.now()}@exemplu.test`;
    const user = await h.tx.user.create({
      data: {
        id: `u-alerta-t-${seq}-${Date.now()}`,
        name: "Alertă",
        email,
        emailVerified: verified,
      },
    });
    for (const key of roles) {
      const role = await h.tx.role.findUniqueOrThrow({ where: { key } });
      await h.tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    }
    await enqueueDispatches(h.tx, [
      {
        template: TEMPLATE,
        eventKey: `stock-sync:test:${seq}`,
        recipient: email,
        audience: "internal",
        data: { takenAt: new Date(NOW.getTime() - 30 * 3_600_000).toISOString() },
      },
    ]);
    const row = await h.tx.emailDispatch.findFirstOrThrow({
      where: { template: TEMPLATE, recipient: email },
    });
    return { user, email, row };
  }

  it("destinatar încă eligibil: emailul pleacă, cu data ultimei sincronizări în text", async () => {
    await harness(async (h) => {
      const { email, row } = await queueAlert(h, ["manager"]);
      const { sent, run } = setup(h);
      await run(row.id);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.message.to).toBe(email);
      expect(sent[0]?.message.subject).toContain("Sincronizarea stocului din SmartBill");
      expect((await h.tx.emailDispatch.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
        "sent",
      );
    });
  });

  it("rol retras după punerea în coadă: nu se trimite, rândul e «skipped» cu motiv", async () => {
    await harness(async (h) => {
      const { user, row } = await queueAlert(h, ["manager"]);
      await h.tx.userRole.deleteMany({ where: { userId: user.id } });
      const { sent, run } = setup(h);
      await run(row.id);
      expect(sent).toHaveLength(0);
      expect(await h.tx.emailDispatch.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
        status: "skipped",
      });
    });
  });

  it("email neverificat sau fără inventory.write (Suport): nu se trimite", async () => {
    await harness(async (h) => {
      const unverified = await queueAlert(h, ["manager"], false);
      const support = await queueAlert(h, ["support"]);
      const { sent, run } = setup(h);
      await run(unverified.row.id);
      await run(support.row.id);
      expect(sent).toHaveLength(0);
    });
  });
});

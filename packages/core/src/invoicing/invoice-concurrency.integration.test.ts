import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { DemoInvoiceProvider } from "@ecom/integrations";
import type { DocumentRef, InvoiceProvider } from "@ecom/shared";
import { InvoiceService } from "./invoice-service";
import { scheduleOrderInvoices } from "./invoice-schedule";

/**
 * Facturarea la cereri SIMULTANE, pe date COMISE și conexiuni separate (pool), pe Postgres real: două evenimente de plată pentru
 * aceeași comandă nu dau două facturi, iar mai mulți lucrători nu emit același document de două ori. Fișier propriu (datele comise
 * nu se amestecă cu testele în tranzacție anulată); ce se creează aici se șterge la sfârșit.
 */
const pool = getDb();
const created: {
  orderIds: string[];
  channelId: string | null;
  settingExisted: boolean | null;
} = {
  orderIds: [],
  channelId: null,
  settingExisted: null,
};

afterAll(async () => {
  // documentele de aici sunt simulate (DEMO), deci triggerul permite ștergerea lor
  await pool.invoice
    .updateMany({ where: { orderId: { in: created.orderIds } }, data: {} })
    .catch(() => undefined);
  await pool.invoice.deleteMany({
    where: { orderId: { in: created.orderIds }, kind: "storno" },
  });
  await pool.invoice.deleteMany({ where: { orderId: { in: created.orderIds } } });
  await pool.order.deleteMany({ where: { id: { in: created.orderIds } } });
  if (created.channelId)
    await pool.salesChannel.delete({ where: { id: created.channelId } }).catch(() => undefined);
  if (created.settingExisted === false) {
    await pool.setting.deleteMany({ where: { key: "invoicing.provider" } });
  }
  await pool.$disconnect();
});

const env = { NODE_ENV: "development", ECOM_DEMO_PAYMENTS: "1" };

class CountingProvider extends DemoInvoiceProvider {
  cancelled: DocumentRef[] = [];
  override async cancelProforma(proforma: DocumentRef): Promise<void> {
    this.cancelled.push(proforma);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function ensureProviderSetting(): Promise<void> {
  const existing = await pool.setting.findUnique({ where: { key: "invoicing.provider" } });
  if (created.settingExisted === null) created.settingExisted = existing !== null;
  await pool.setting.upsert({
    where: { key: "invoicing.provider" },
    create: { key: "invoicing.provider", group: "invoicing", value: "demo" },
    update: { value: "demo" },
  });
}

async function newOrder(paymentMethod: string): Promise<string> {
  if (!created.channelId) {
    const channel = await pool.salesChannel.create({
      data: { code: `inv_cc_${randomUUID().slice(0, 8)}`, name: "Canal test facturare" },
    });
    created.channelId = channel.id;
  }
  const order = await pool.order.create({
    data: {
      number: `INVCC-${randomUUID().slice(0, 10)}`,
      channelId: created.channelId,
      email: "client@exemplu.invalid",
      phone: "0722000000",
      subtotalMinor: 10_000,
      shippingMinor: 0,
      taxMinor: 1_736,
      totalMinor: 10_000,
      taxRateBps: 2100,
      shippingMethodCode: "pickup",
      shippingSnapshot: { kind: "pickup" },
      paymentMethod,
      termsAcceptedAt: new Date(),
      termsConsentText: "Sunt de acord",
      termsConsentVersion: "t",
      idempotencyKey: randomUUID(),
      lines: {
        create: {
          sku: "INVCC-1",
          title: "Produs test",
          quantity: 10_000n,
          unitSymbol: "buc",
          unitDecimals: 0,
          unitPriceMinor: 10_000,
          lineTotalMinor: 10_000,
          netMinor: 8_264,
          taxMinor: 1_736,
          taxRateBps: 2100,
          stockState: "in_stock",
          shippingClass: "standard",
          productSnapshot: {},
        },
      },
      // cerute de CHECK-urile comenzii: rezervare la transfer și card, termen de reîncercare la card
      ...(paymentMethod === "cod"
        ? {}
        : { reservationExpiresAt: new Date(Date.now() + 3_600_000) }),
      ...(paymentMethod === "card"
        ? { paymentRetryDeadlineAt: new Date(Date.now() + 86_400_000) }
        : {}),
    },
  });
  created.orderIds.push(order.id);
  return order.id;
}

describe("două evenimente de plată simultane pe aceeași comandă", () => {
  it("dau UN SINGUR document în coadă (unicitate pe comandă și tip)", async () => {
    await ensureProviderSetting();
    const orderId = await newOrder("card");
    const fire = (type: string) =>
      pool.$transaction((tx) => scheduleOrderInvoices(tx, orderId, { id: randomUUID(), type }));
    await Promise.all([
      fire("payment.confirmed"),
      fire("payment.confirmed"),
      fire("payment.confirmed"),
      fire("payment.confirmed"),
    ]);
    const rows = await pool.invoice.findMany({ where: { orderId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "invoice", docKey: "invoice", status: "queued" });
    const events = await pool.invoiceEvent.count({ where: { invoiceId: rows[0]!.id } });
    expect(events).toBe(1); // jurnalul «în coadă» se scrie o singură dată
  });
});

describe("mai mulți lucrători", () => {
  it("preluarea din coadă e exclusivă: niciun document nu e preluat de doi lucrători", async () => {
    await ensureProviderSetting();
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const orderId = await newOrder("card");
      await pool.$transaction((tx) =>
        scheduleOrderInvoices(tx, orderId, { id: randomUUID(), type: "payment.confirmed" }),
      );
      const row = await pool.invoice.findFirstOrThrow({ where: { orderId } });
      ids.push(row.id);
    }
    const source = { active: async () => "demo" as const, provider: async () => null };
    const workers = [0, 1, 2, 3].map(() => new InvoiceService({ db: pool, source }));
    const claimed = await Promise.all(workers.map((w) => w.claimDue(10)));
    const all = claimed.flat();
    expect(new Set(all).size).toBe(all.length); // fără dubluri
    const mine = all.filter((id) => ids.includes(id));
    expect(new Set(mine).size).toBe(mine.length);
    // înapoi în coadă, ca să nu rămână documente «în emitere» în baza comună
    await pool.invoice.updateMany({
      where: { id: { in: ids } },
      data: { status: "skipped", lockedAt: null },
    });
  });

  it("trei lucrători pe aceleași documente: fiecare document e dus la capăt O SINGURĂ DATĂ", async () => {
    const provider = new CountingProvider({ env });
    const source = {
      active: async () => "demo" as const,
      provider: async () => provider as InvoiceProvider,
    };
    const stornoIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const orderId = await newOrder("bank_transfer");
      const proforma = await pool.invoice.create({
        data: {
          orderId,
          kind: "proforma",
          docKey: "proforma",
          totalMinor: 10_000,
          taxMinor: 1_735,
          status: "issued",
          provider: "demo",
          simulated: true,
          series: "DEMO",
          number: `P${i}-${randomUUID().slice(0, 6)}`,
          providerRef: `demo-${i}`,
          issuedAt: new Date(),
        },
      });
      const storno = await pool.invoice.create({
        data: {
          orderId,
          kind: "storno",
          docKey: "storno:proforma",
          parentId: proforma.id,
          totalMinor: 10_000,
          taxMinor: 1_735,
        },
      });
      stornoIds.push(storno.id);
    }
    const workers = [0, 1, 2].map(() => new InvoiceService({ db: pool, source }));
    await Promise.all(
      workers.map(async (w) => {
        // fiecare lucrător ia cât găsește, în mai multe cicluri
        for (let round = 0; round < 4; round += 1) await w.processDue(2);
      }),
    );
    const rows = await pool.invoice.findMany({ where: { id: { in: stornoIds } } });
    expect(rows.every((r) => r.status === "issued")).toBe(true);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
    expect(provider.cancelled).toHaveLength(6); // exact câte documente, niciuna dublă
    expect(new Set(provider.cancelled.map((c) => c.number)).size).toBe(6);
  });
});

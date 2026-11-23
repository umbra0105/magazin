import { afterAll, describe, expect, it } from "vitest";
import { getDb, type PrismaClient } from "@ecom/db";
import { DemoInvoiceProvider } from "@ecom/integrations";
import {
  IntegrationError,
  vatFromGross,
  type DocumentRef,
  type EfacturaStatus,
  type InvoiceProvider,
  type InvoiceRequest,
  type IssuedDocument,
  type ReversalContext,
} from "@ecom/shared";
import { NOW, harness, q, type Harness } from "../test-utils/checkout-fixtures";
import { addOrderEvent, transitionOrder } from "../orders/order-service";
import { confirmManualRefund, requestRefund } from "../payments/refund-service";
import { InvoiceService, type InvoiceProviderSource } from "./invoice-service";

/**
 * Mini-faza `storno-total` (decizia 2026-11-23): stornoul «total» acoperă DOAR restul nestornat al facturii, pe Postgres real
 * (tranzacție anulată), prin furnizorul DEMO. Brutul tuturor stornourilor = totalul facturii EXACT; TVA-ul restului e extras din
 * brutul restului (deriva față de TVA-ul liniei: cel mult 1 ban pe linie atinsă de stornouri în bucăți). Aceleași scenarii din cele
 * trei căi (`payment.refunded`, rambursarea manuală din ecranul plăților, acțiunea manuală de storno) și din anulare / refuz de ramburs.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const env = { NODE_ENV: "development", ECOM_DEMO_PAYMENTS: "1" };

class Spy implements InvoiceProvider {
  readonly inner = new DemoInvoiceProvider({ env, now: () => NOW });
  readonly code = "demo" as const;
  readonly label = "spy";
  readonly simulated = true;
  readonly reportsEfactura = true;
  requests: InvoiceRequest[] = [];
  reversed: Array<{ ref: DocumentRef; context: ReversalContext | undefined }> = [];
  failures: Array<{ code: string; message: string }> = [];
  counter = 0;

  private maybeFail(): void {
    const f = this.failures.shift();
    if (f) throw new IntegrationError(f.code, f.message);
  }
  private number(): string {
    this.counter += 1;
    return String(2000 + this.counter);
  }
  async issueProforma(request: InvoiceRequest): Promise<IssuedDocument> {
    this.maybeFail();
    return { ...(await this.inner.issueProforma(request)), number: this.number() };
  }
  async issueInvoice(request: InvoiceRequest): Promise<IssuedDocument> {
    this.maybeFail();
    this.requests.push(request);
    return { ...(await this.inner.issueInvoice(request)), number: this.number() };
  }
  async reverseInvoice(
    invoice: DocumentRef,
    issueDate: Date,
    context?: ReversalContext,
  ): Promise<IssuedDocument> {
    this.maybeFail();
    this.reversed.push({ ref: invoice, context });
    return {
      ...(await this.inner.reverseInvoice(invoice, issueDate, context)),
      number: this.number(),
    };
  }
  async cancelProforma(): Promise<void> {
    this.maybeFail();
  }
  getInvoicePdf = (d: DocumentRef) => this.inner.getInvoicePdf(d);
  getProformaPdf = (d: DocumentRef) => this.inner.getProformaPdf(d);
  getEfacturaStatus = (): Promise<EfacturaStatus> => this.inner.getEfacturaStatus();
  testConnection = () => this.inner.testConnection();
}

interface Ctx {
  h: Harness;
  spy: Spy;
  service: InvoiceService;
}

async function withInvoicing<T>(fn: (c: Ctx) => Promise<T>): Promise<T> {
  return harness(
    async (h) => {
      await h.tx.setting.upsert({
        where: { key: "invoicing.provider" },
        create: { key: "invoicing.provider", group: "invoicing", value: "demo" },
        update: { value: "demo" },
      });
      const spy = new Spy();
      const source: InvoiceProviderSource = {
        active: async () => "demo",
        provider: async () => spy,
      };
      const clock = { now: new Date(NOW.getTime() + 60_000) };
      const service = new InvoiceService({
        db: h.tx as unknown as PrismaClient,
        source,
        now: () => clock.now,
      });
      return fn({ h, spy, service });
    },
    { settings: { cardProvider: { code: "demo", mode: "demo" } } },
  );
}

interface Placed {
  orderId: string;
  lineId: string;
  lineTotalMinor: number;
  unitMinor: number;
  invoiceTotalMinor: number;
  invoiceTaxMinor: number;
}

/**
 * O comandă cu un produs, facturată (emisă). `card` + ridicare = fără transport (scenariul de bază: 1000 lei, transport gratuit);
 * `cod` + curier = cu transport și taxă de ramburs.
 */
async function issued(
  h: Harness,
  service: InvoiceService,
  opts: {
    price?: number;
    quantity?: string;
    step?: string;
    method?: "card" | "cod";
    shipping?: boolean;
  } = {},
): Promise<Placed> {
  const method = opts.method ?? "card";
  const product = await h.product({
    price: opts.price ?? 20_000,
    ...(opts.step ? { step: opts.step, physical: "1000" } : {}),
  });
  const owner = await h.fill([{ variantId: product.variantId, quantity: q(opts.quantity ?? "5") }]);
  const { orderId } = await h.checkout.place(
    owner,
    await h.input(owner, {
      paymentMethod: method,
      ...(opts.shipping === false || (opts.shipping === undefined && method === "card")
        ? { shippingOfferCode: "pickup" }
        : {}),
    }),
  );
  if (method === "card") {
    await addOrderEvent(h.tx, orderId, { type: "payment.confirmed", message: "Plată confirmată" });
  }
  await service.processDue();
  const order = await h.tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { lines: true },
  });
  const invoice = await h.tx.invoice.findUniqueOrThrow({
    where: { orderId_docKey: { orderId, docKey: "invoice" } },
  });
  expect(invoice.status).toBe("issued");
  const line = order.lines[0]!;
  return {
    orderId,
    lineId: line.id,
    lineTotalMinor: line.lineTotalMinor,
    unitMinor: line.unitPriceMinor,
    invoiceTotalMinor: invoice.totalMinor,
    invoiceTaxMinor: invoice.taxMinor,
  };
}

const docs = (h: Harness, orderId: string) =>
  h.tx.invoice.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });

/** Stornourile facturii care nu sunt sărite (fără anularea proformei). */
async function stornos(h: Harness, orderId: string) {
  return (await docs(h, orderId)).filter(
    (d) => d.kind === "storno" && d.docKey !== "storno:proforma" && d.status !== "skipped",
  );
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

async function partial(
  service: InvoiceService,
  p: Placed,
  reference: string,
  quantityTicks: bigint,
): Promise<string | null> {
  return service.requestPartialStorno(
    p.orderId,
    reference,
    [{ orderLineId: p.lineId, quantityTicks }],
    "admin@test.ro",
  );
}

async function markRefundedAndFire(h: Harness, orderId: string) {
  await h.tx.order.update({ where: { id: orderId }, data: { paymentStatus: "refunded" } });
  await addOrderEvent(h.tx, orderId, { type: "payment.refunded", message: "Rambursat total" });
}

describe("scenariul de bază: 1000 lei, transport gratuit, două retururi (400 + 600)", () => {
  it("calea 1, `payment.refunded` total: restul e 600 și totalul stornat e 1000, nu 1400", async () => {
    await withInvoicing(async ({ h, spy, service }) => {
      const p = await issued(h, service);
      expect(p.invoiceTotalMinor).toBe(100_000);
      await partial(service, p, "ret-1", 20_000n); // 2 din 5 bucăți = 400 lei
      await service.processDue();
      expect(sum((await stornos(h, p.orderId)).map((s) => s.totalMinor))).toBe(40_000);

      await markRefundedAndFire(h, p.orderId);
      const all = await stornos(h, p.orderId);
      const total = all.find((s) => s.docKey === "storno:total");
      expect(total).toMatchObject({ status: "queued", totalMinor: 60_000 });
      await service.processDue();

      const done = await stornos(h, p.orderId);
      expect(done.every((s) => s.status === "issued")).toBe(true);
      expect(sum(done.map((s) => s.totalMinor))).toBe(p.invoiceTotalMinor);
      // restul se emite ca factură cu cantități NEGATIVE, nu prin /invoice/reverse (stornează tot documentul)
      expect(spy.reversed).toHaveLength(0);
      const sent = spy.requests.at(-1)!;
      expect(sent.lines.map((l) => l.quantityTicks)).toEqual([-30_000n]);
      expect(sent.lines.map((l) => l.lineTotalMinor)).toEqual([-60_000]);
      expect(sent.reversal).toEqual({ invoiceTotalMinor: 100_000, alreadyReversedMinor: 40_000 });
    });
  });

  it("calea 2, rambursarea manuală din ecranul plăților (Faza 10): 400 apoi 600 de lei", async () => {
    await withInvoicing(async ({ h, service }) => {
      const p = await issued(h, service);
      const payment = await h.tx.payment.findFirstOrThrow({ where: { orderId: p.orderId } });
      await h.tx.payment.update({
        where: { id: payment.id },
        data: {
          status: "paid",
          capturedAt: new Date(NOW.getTime() - 86_400_000),
          capturedAmountMinor: payment.amountMinor,
          capturedCurrency: "RON",
        },
      });
      await h.tx.order.update({ where: { id: p.orderId }, data: { paymentStatus: "paid" } });
      const deps = { db: h.tx, getProvider: async () => null, now: () => NOW };
      const refund = async (amountMinor: number, key: string) => {
        const r = await requestRefund(deps, {
          paymentId: payment.id,
          amountMinor,
          reason: "Retur",
          idempotencyKey: key,
          actorLabel: "admin@test.ro",
        });
        await confirmManualRefund(deps, {
          refundId: r.refundId,
          reference: `ext-${key}`,
          actorLabel: "admin@test.ro",
        });
      };
      await refund(40_000, "m1");
      expect((await stornos(h, p.orderId)).length).toBe(0); // rambursarea parțială nu stornează nimic
      await partial(service, p, "ret-1", 20_000n);
      await service.processDue();
      await refund(60_000, "m2"); // completează rambursarea totală: payment.refunded → storno
      await service.processDue();
      const done = await stornos(h, p.orderId);
      expect(done.map((s) => s.status)).toEqual(["issued", "issued"]);
      expect(sum(done.map((s) => s.totalMinor))).toBe(100_000);
      expect(done.find((s) => s.docKey === "storno:total")?.totalMinor).toBe(60_000);
    });
  });

  it("calea 3, acțiunea manuală de storno din admin (`requestReverse`)", async () => {
    await withInvoicing(async ({ h, service }) => {
      const p = await issued(h, service);
      await partial(service, p, "ret-1", 20_000n);
      await service.processDue();
      const id = await service.requestReverse(p.orderId, "admin@test.ro");
      expect(id).not.toBeNull();
      await service.processDue();
      const done = await stornos(h, p.orderId);
      expect(sum(done.map((s) => s.totalMinor))).toBe(100_000);
      expect(done.map((s) => s.status)).toEqual(["issued", "issued"]);
    });
  });

  it("anulare după retur parțial (`order.cancelled`): stornoul acoperă doar restul", async () => {
    await withInvoicing(async ({ h, service }) => {
      const p = await issued(h, service);
      await partial(service, p, "ret-1", 20_000n);
      await service.processDue();
      await transitionOrder(
        h.tx,
        p.orderId,
        { status: "cancelled" },
        { type: "order.cancelled", message: "Anulată" },
        NOW,
      );
      await service.processDue();
      const done = await stornos(h, p.orderId);
      expect(sum(done.map((s) => s.totalMinor))).toBe(100_000);
      expect(done.find((s) => s.docKey === "storno:total")?.totalMinor).toBe(60_000);
    });
  });

  it("refuz de ramburs după retur parțial (`order.returned_to_sender`), cu transport și taxă de ramburs", async () => {
    await withInvoicing(async ({ h, spy, service }) => {
      const p = await issued(h, service, { method: "cod" });
      const invoice = await h.tx.invoice.findUniqueOrThrow({
        where: { orderId_docKey: { orderId: p.orderId, docKey: "invoice" } },
        include: { lines: true },
      });
      expect(invoice.lines.map((l) => l.kind).sort()).toEqual(["cod_fee", "product", "shipping"]);
      await partial(service, p, "ret-1", 20_000n);
      await service.processDue();
      await addOrderEvent(h.tx, p.orderId, {
        type: "order.returned_to_sender",
        message: "Refuzat",
      });
      await service.processDue();
      const done = await stornos(h, p.orderId);
      expect(sum(done.map((s) => s.totalMinor))).toBe(p.invoiceTotalMinor);
      const sent = spy.requests.at(-1)!;
      expect(sent.lines.map((l) => l.kind).sort()).toEqual(["cod_fee", "product", "shipping"]);
      expect(sent.lines.every((l) => l.quantityTicks < 0n && l.lineTotalMinor < 0)).toBe(true);
      const shipping = invoice.lines.find((l) => l.kind === "shipping")!;
      expect(sent.lines.find((l) => l.kind === "shipping")?.lineTotalMinor).toBe(
        -shipping.lineTotalMinor,
      );
    });
  });
});

describe("fără stornouri parțiale: comportamentul de azi, neschimbat", () => {
  it("același document (`storno:total`), cheie, sume și apel `reverseInvoice` pe tot documentul", async () => {
    await withInvoicing(async ({ h, spy, service }) => {
      const p = await issued(h, service);
      const invoice = await h.tx.invoice.findUniqueOrThrow({
        where: { orderId_docKey: { orderId: p.orderId, docKey: "invoice" } },
      });
      await markRefundedAndFire(h, p.orderId);
      const total = (await docs(h, p.orderId)).find((d) => d.docKey === "storno:total")!;
      expect(total).toMatchObject({
        kind: "storno",
        parentId: invoice.id,
        status: "queued",
        totalMinor: invoice.totalMinor,
        taxMinor: invoice.taxMinor,
      });
      // liniile se copiază abia la emitere, ca până acum
      expect(await h.tx.invoiceLine.count({ where: { invoiceId: total.id } })).toBe(0);
      await service.processDue();
      expect(spy.reversed).toHaveLength(1);
      expect(spy.reversed[0]?.ref).toEqual({ series: "DEMO", number: invoice.number });
      expect(spy.reversed[0]?.context).toEqual({
        invoiceTotalMinor: invoice.totalMinor,
        alreadyReversedMinor: 0,
      });
      expect(await h.tx.invoiceLine.count({ where: { invoiceId: total.id } })).toBeGreaterThan(0);
    });
  });

  it("anularea proformei rămâne neschimbată", async () => {
    await withInvoicing(async ({ h, service }) => {
      const product = await h.product();
      const owner = await h.fill([{ variantId: product.variantId, quantity: q("3") }]);
      const { orderId } = await h.checkout.place(
        owner,
        await h.input(owner, { paymentMethod: "bank_transfer" }),
      );
      await service.processDue();
      await transitionOrder(
        h.tx,
        orderId,
        { status: "cancelled" },
        { type: "order.cancelled", message: "Anulată" },
        NOW,
      );
      await service.processDue();
      const storno = (await docs(h, orderId)).find((d) => d.kind === "storno");
      expect(storno).toMatchObject({ docKey: "storno:proforma", status: "issued" });
    });
  });
});

describe("idempotență", () => {
  it("două cereri consecutive nu creează două documente (restul: un singur `storno:total`)", async () => {
    await withInvoicing(async ({ h, service }) => {
      const p = await issued(h, service);
      await partial(service, p, "ret-1", 20_000n);
      await service.processDue();
      const first = await service.requestReverse(p.orderId, "admin@test.ro");
      const second = await service.requestReverse(p.orderId, "admin@test.ro");
      expect(first).not.toBeNull();
      expect(second).toBeNull();
      await markRefundedAndFire(h, p.orderId);
      expect((await stornos(h, p.orderId)).filter((s) => s.docKey === "storno:total")).toHaveLength(
        1,
      );
      expect(await h.tx.invoiceLine.count({ where: { invoice: { id: first! } } })).toBe(1);
    });
  });
});

describe("rest pe linii, cu stornouri multiple, cu transport și zecimale", () => {
  it("trei stornouri parțiale apoi restul: brutul total = factura exact", async () => {
    await withInvoicing(async ({ h, spy, service }) => {
      const p = await issued(h, service, { quantity: "6" });
      await partial(service, p, "ret-1", 10_000n);
      await partial(service, p, "ret-2", 10_000n);
      await partial(service, p, "ret-3", 10_000n);
      await service.processDue();
      await service.requestReverse(p.orderId, "admin@test.ro");
      await service.processDue();
      const done = await stornos(h, p.orderId);
      expect(done).toHaveLength(4);
      expect(sum(done.map((s) => s.totalMinor))).toBe(p.invoiceTotalMinor);
      expect(spy.requests.at(-1)?.lines[0]?.quantityTicks).toBe(-30_000n);
    });
  });

  it("transportul rămâne în rest: după returnarea tuturor produselor, restul e doar transportul", async () => {
    await withInvoicing(async ({ h, spy, service }) => {
      const p = await issued(h, service, { method: "cod", quantity: "2" });
      await partial(service, p, "ret-1", 20_000n);
      await service.processDue();
      await service.requestReverse(p.orderId, "admin@test.ro");
      await service.processDue();
      const done = await stornos(h, p.orderId);
      expect(sum(done.map((s) => s.totalMinor))).toBe(p.invoiceTotalMinor);
      const sent = spy.requests.at(-1)!;
      expect(sent.lines.map((l) => l.kind).sort()).toEqual(["cod_fee", "shipping"]);
    });
  });

  it("rest zero: nu se creează niciun document; un eveniment pe factură, o singură dată, fără eroare", async () => {
    await withInvoicing(async ({ h, service }) => {
      const p = await issued(h, service); // ridicare: fără transport
      await partial(service, p, "ret-1", 50_000n); // toate cele 5 bucăți
      await service.processDue();
      const before = (await docs(h, p.orderId)).length;
      expect(await service.requestReverse(p.orderId, "admin@test.ro")).toBeNull();
      await markRefundedAndFire(h, p.orderId);
      expect(await service.requestReverse(p.orderId, "admin@test.ro")).toBeNull();
      const all = await docs(h, p.orderId);
      expect(all).toHaveLength(before);
      expect(all.some((d) => d.docKey === "storno:total")).toBe(false);
      const invoice = all.find((d) => d.kind === "invoice")!;
      const events = await h.tx.invoiceEvent.findMany({
        where: { invoiceId: invoice.id, type: "reverse_not_needed" },
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.message).toMatch(/integral stornat/i);
      expect(sum((await stornos(h, p.orderId)).map((s) => s.totalMinor))).toBe(p.invoiceTotalMinor);
    });
  });

  it("linii zecimale: 6,09 mp × 123,45 = 751,81; retur parțial al cantității, apoi stornoul restului", async () => {
    await withInvoicing(async ({ h, spy, service }) => {
      const p = await issued(h, service, { price: 12_345, quantity: "6,09", step: "0,01" });
      expect(p.lineTotalMinor).toBe(75_181);
      await partial(service, p, "ret-1", 25_000n); // 2,50 mp
      await service.processDue();
      await service.requestReverse(p.orderId, "admin@test.ro");
      await service.processDue();
      const done = await stornos(h, p.orderId);
      expect(done.map((s) => s.status)).toEqual(["issued", "issued"]);
      expect(sum(done.map((s) => s.totalMinor))).toBe(p.invoiceTotalMinor);
      // restul de 3,59 mp costă 443,18 (brut exact), dar 3,59 × 123,45 = 443,19: furnizorul primește «1 × 443,18», negativ
      expect(spy.requests.at(-1)?.lines[0]).toMatchObject({
        quantityTicks: -10_000n,
        unitPriceMinor: 44_318,
        lineTotalMinor: -44_318,
      });
      const restDoc = done.find((s) => s.docKey === "storno:total")!;
      const restLines = await h.tx.invoiceLine.findMany({ where: { invoiceId: restDoc.id } });
      expect(restLines.map((l) => l.quantityTicks)).toEqual([35_900n]); // în baza noastră rămâne cantitatea reală
    });
  });

  it("TVA: fiecare storno are TVA extras din brutul lui; deriva față de factură ≤ 1 ban pe linie (4 × 123,45, retur 1 buc.)", async () => {
    await withInvoicing(async ({ h, service }) => {
      const p = await issued(h, service, { price: 12_345, quantity: "4" });
      await partial(service, p, "ret-1", 10_000n);
      await service.processDue();
      await service.requestReverse(p.orderId, "admin@test.ro");
      await service.processDue();
      const done = await stornos(h, p.orderId);
      expect(sum(done.map((s) => s.totalMinor))).toBe(49_380);
      for (const s of done) expect(s.taxMinor).toBe(vatFromGross(s.totalMinor, 2100));
      const drift = sum(done.map((s) => s.taxMinor)) - p.invoiceTaxMinor;
      expect(Math.abs(drift)).toBeLessThanOrEqual(1);
    });
  });
});

describe("se numără toate stornourile care nu sunt sărite, indiferent de stare", () => {
  it("un storno parțial încă în coadă (neemis) nu e dublat de cel total", async () => {
    await withInvoicing(async ({ h, service }) => {
      const p = await issued(h, service);
      await partial(service, p, "ret-1", 20_000n); // rămâne în coadă
      await service.requestReverse(p.orderId, "admin@test.ro");
      const queued = await stornos(h, p.orderId);
      expect(queued.map((s) => s.status)).toEqual(["queued", "queued"]);
      expect(sum(queued.map((s) => s.totalMinor))).toBe(p.invoiceTotalMinor);
      await service.processDue();
      expect(sum((await stornos(h, p.orderId)).map((s) => s.totalMinor))).toBe(p.invoiceTotalMinor);
    });
  });

  it("un storno parțial EȘUAT (rezultat nesigur, în așteptarea adminului) se numără și el", async () => {
    await withInvoicing(async ({ h, spy, service }) => {
      const p = await issued(h, service);
      await partial(service, p, "ret-1", 20_000n);
      spy.failures.push({ code: "INVOICE_PROVIDER_TIMEOUT", message: "timeout" });
      await service.processDue();
      expect((await stornos(h, p.orderId))[0]?.status).toBe("failed");
      await service.requestReverse(p.orderId, "admin@test.ro");
      const all = await stornos(h, p.orderId);
      expect(sum(all.map((s) => s.totalMinor))).toBe(p.invoiceTotalMinor);
      expect(all.find((s) => s.docKey === "storno:total")?.totalMinor).toBe(60_000);
    });
  });

  it("un storno parțial «în emitere» se numără și el", async () => {
    await withInvoicing(async ({ h, service }) => {
      const p = await issued(h, service);
      await partial(service, p, "ret-1", 20_000n);
      await h.tx.invoice.updateMany({
        where: { orderId: p.orderId, docKey: "storno:ret-1" },
        data: { status: "issuing", lockedAt: new Date() },
      });
      await service.requestReverse(p.orderId, "admin@test.ro");
      const all = await stornos(h, p.orderId);
      expect(sum(all.map((s) => s.totalMinor))).toBe(p.invoiceTotalMinor);
    });
  });
});

describe("apărarea în plus: refuzul unui storno care ar depăși totalul", () => {
  it("date incoerente (stornouri peste factură): nu se creează storno, comanda NU se blochează, alertă în admin", async () => {
    await withInvoicing(async ({ h, service }) => {
      const p = await issued(h, service);
      const invoice = await h.tx.invoice.findUniqueOrThrow({
        where: { orderId_docKey: { orderId: p.orderId, docKey: "invoice" } },
        include: { lines: true },
      });
      // un storno «moștenit» cu mai mult decât a fost facturat (date greșite, nu produse de cod)
      const forged = await h.tx.invoice.create({
        data: {
          orderId: p.orderId,
          kind: "storno",
          docKey: "storno:forged",
          parentId: invoice.id,
          totalMinor: 120_000,
          taxMinor: 20_826,
        },
      });
      const line = invoice.lines.find((l) => l.kind === "product")!;
      await h.tx.invoiceLine.create({
        data: {
          invoiceId: forged.id,
          position: 1,
          kind: "product",
          orderLineId: line.orderLineId,
          sku: line.sku,
          title: line.title,
          unitName: line.unitName,
          quantityTicks: 60_000n,
          unitPriceMinor: line.unitPriceMinor,
          lineTotalMinor: 120_000,
          netMinor: 99_174,
          taxMinor: 20_826,
          taxRateBps: 2100,
        },
      });
      await expect(
        transitionOrder(
          h.tx,
          p.orderId,
          { status: "cancelled" },
          { type: "order.cancelled", message: "Anulată" },
          NOW,
        ),
      ).resolves.not.toThrow();
      expect((await docs(h, p.orderId)).some((d) => d.docKey === "storno:total")).toBe(false);
      const refused = await h.tx.invoiceEvent.findMany({
        where: { invoiceId: invoice.id, type: "storno_refused" },
      });
      expect(refused).toHaveLength(1);
      const alerts = await h.tx.adminNotification.findMany({
        where: { dedupKey: `storno-refused:${invoice.id}` },
      });
      expect(alerts.length).toBeGreaterThan(0);
    });
  });

  it("la emitere: un storno total care ar depăși factura (alături de unul parțial) NU ajunge la furnizor, ci trece în «eșuat» cu alertă", async () => {
    await withInvoicing(async ({ h, spy, service }) => {
      const p = await issued(h, service);
      await partial(service, p, "ret-1", 20_000n);
      await service.processDue();
      const invoice = await h.tx.invoice.findUniqueOrThrow({
        where: { orderId_docKey: { orderId: p.orderId, docKey: "invoice" } },
      });
      // document total «vechi» pe tot totalul, creat înainte de corecție, alături de stornoul parțial emis
      await h.tx.invoice.create({
        data: {
          orderId: p.orderId,
          kind: "storno",
          docKey: "storno:total",
          parentId: invoice.id,
          totalMinor: invoice.totalMinor,
          taxMinor: invoice.taxMinor,
        },
      });
      const calls = spy.reversed.length + spy.requests.length;
      await service.processDue();
      const total = (await docs(h, p.orderId)).find((d) => d.docKey === "storno:total")!;
      expect(total).toMatchObject({
        status: "failed",
        lastErrorCode: "INVOICE_STORNO_EXCEEDS_TOTAL",
      });
      expect(spy.reversed.length + spy.requests.length).toBe(calls);
      expect(total.alertedAt).not.toBeNull();
    });
  });

  it("un storno parțial care ar depăși factura (cu un total deja în coadă) e refuzat înainte de coadă", async () => {
    await withInvoicing(async ({ h, service }) => {
      const p = await issued(h, service);
      await service.requestReverse(p.orderId, "admin@test.ro");
      await expect(partial(service, p, "ret-1", 10_000n)).rejects.toMatchObject({
        code: "INVOICE_STATE_INVALID",
      });
    });
  });
});

import { afterAll, describe, expect, it } from "vitest";
import { getDb, type PrismaClient } from "@ecom/db";
import { DemoInvoiceProvider } from "@ecom/integrations";
import {
  IntegrationError,
  netFromGross,
  type DocumentRef,
  type EfacturaStatus,
  type InvoiceProvider,
  type InvoiceRequest,
  type IssuedDocument,
} from "@ecom/shared";
import { NOW, harness, orderOf, q, type Harness } from "../test-utils/checkout-fixtures";
import { addOrderEvent, transitionOrder } from "../orders/order-service";
import { InvoiceService, type InvoiceProviderSource } from "./invoice-service";

/**
 * Facturarea pe Postgres real (tranzacție anulată): outbox-ul din evenimentele comenzii, emiterea prin furnizorul DEMO,
 * momentul emiterii după metoda de plată, storno total și parțial, reîncercări cu backoff, alerta după 3 eșecuri, rezultatul
 * nesigur, descărcarea de gestiune și `markInvoiced`. Niciun test nu emite o factură reală: totul trece prin furnizorul DEMO.
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
  proformas: InvoiceRequest[] = [];
  reversed: DocumentRef[] = [];
  cancelled: DocumentRef[] = [];
  /** Erori de aruncat la următoarele emiteri (câte una pe apel). */
  failures: Array<{ code: string; message: string }> = [];
  counter = 0;

  private maybeFail(): void {
    const f = this.failures.shift();
    if (f) throw new IntegrationError(f.code, f.message);
  }
  private number(): string {
    this.counter += 1;
    return String(1000 + this.counter);
  }
  async issueProforma(request: InvoiceRequest): Promise<IssuedDocument> {
    this.maybeFail();
    this.proformas.push(request);
    const doc = await this.inner.issueProforma(request);
    return { ...doc, number: this.number() };
  }
  async issueInvoice(request: InvoiceRequest): Promise<IssuedDocument> {
    this.maybeFail();
    this.requests.push(request);
    const doc = await this.inner.issueInvoice(request);
    return { ...doc, number: this.number() };
  }
  async reverseInvoice(invoice: DocumentRef, issueDate: Date): Promise<IssuedDocument> {
    this.maybeFail();
    this.reversed.push(invoice);
    const doc = await this.inner.reverseInvoice();
    void issueDate;
    return { ...doc, number: this.number() };
  }
  async cancelProforma(proforma: DocumentRef): Promise<void> {
    this.maybeFail();
    this.cancelled.push(proforma);
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
  clock: { now: Date };
}

async function withInvoicing<T>(
  fn: (c: Ctx) => Promise<T>,
  settings: Record<string, unknown> = {},
): Promise<T> {
  return harness(
    async (h) => {
      for (const [key, value] of Object.entries({ "invoicing.provider": "demo", ...settings })) {
        await h.tx.setting.upsert({
          where: { key },
          create: { key, group: key.split(".")[0] as string, value: value as never },
          update: { value: value as never },
        });
      }
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
      return fn({ h, spy, service, clock });
    },
    { settings: { cardProvider: { code: "demo", mode: "demo" } } },
  );
}

async function place(h: Harness, over: Record<string, unknown> = {}, productOver = {}) {
  const product = await h.product(productOver);
  const owner = await h.fill([{ variantId: product.variantId, quantity: q("3") }]);
  const { orderId } = await h.checkout.place(owner, await h.input(owner, over));
  return { orderId, product };
}

const docs = (h: Harness, orderId: string) =>
  h.tx.invoice.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });

describe("momentul emiterii, după metoda de plată", () => {
  it("ramburs: factura se pune în coadă la plasare și se emite cu totalul comenzii", async () => {
    await withInvoicing(async ({ h, spy, service }) => {
      const { orderId } = await place(h);
      const order = await orderOf(h.tx, orderId);
      const [queued] = await docs(h, orderId);
      expect(queued).toMatchObject({ kind: "invoice", docKey: "invoice", status: "queued" });
      expect(queued?.totalMinor).toBe(order.totalMinor);
      expect(queued?.taxMinor).toBe(order.taxMinor);

      const summary = await service.processDue();
      expect(summary).toMatchObject({ processed: 1, issued: 1, failed: 0 });
      const [issued] = await docs(h, orderId);
      expect(issued).toMatchObject({
        status: "issued",
        provider: "demo",
        simulated: true,
        series: "DEMO",
        efacturaStatus: "pending",
        attempts: 1,
      });
      expect(spy.requests).toHaveLength(1);
      expect(spy.requests[0]?.payment).toBeNull(); // rambursul nu e încasat încă
      const lines = await h.tx.invoiceLine.findMany({ where: { invoiceId: issued!.id } });
      const sum = lines.reduce((a, l) => a + l.lineTotalMinor, 0);
      const tax = lines.reduce((a, l) => a + l.taxMinor, 0);
      expect(sum).toBe(order.totalMinor);
      expect(tax).toBe(order.taxMinor);
      const events = await h.tx.orderEvent.findMany({
        where: { orderId, type: { startsWith: "invoice." } },
      });
      expect(events.map((e) => e.type)).toEqual(["invoice.invoice_issued"]);
    });
  });

  it("card: nimic la plasare; factura apare la plata confirmată, cu încasarea «Card online»", async () => {
    await withInvoicing(async ({ h, spy, service }) => {
      const { orderId } = await place(h, { paymentMethod: "card" });
      expect(await docs(h, orderId)).toHaveLength(0);
      await addOrderEvent(h.tx, orderId, {
        type: "payment.confirmed",
        message: "Plată confirmată",
      });
      const [queued] = await docs(h, orderId);
      expect(queued?.kind).toBe("invoice");
      await service.processDue();
      const order = await orderOf(h.tx, orderId);
      expect(spy.requests[0]?.payment).toEqual({
        type: "Card online",
        valueMinor: order.totalMinor,
      });
    });
  });

  it("transfer bancar: proformă la plasare, factura abia după plata confirmată, din proformă", async () => {
    await withInvoicing(async ({ h, spy, service }) => {
      const { orderId } = await place(h, { paymentMethod: "bank_transfer" });
      const [proforma] = await docs(h, orderId);
      expect(proforma).toMatchObject({ kind: "proforma", docKey: "proforma", status: "queued" });
      await service.processDue();
      expect(spy.proformas).toHaveLength(1);
      expect(spy.requests).toHaveLength(0);
      const afterProforma = await docs(h, orderId);
      expect(afterProforma[0]).toMatchObject({
        status: "issued",
        efacturaStatus: "not_applicable",
      });

      await addOrderEvent(h.tx, orderId, {
        type: "payment.confirmed",
        message: "Plată confirmată",
      });
      await service.processDue();
      expect(spy.requests).toHaveLength(1);
      expect(spy.requests[0]?.fromProforma).toEqual({
        series: "DEMO",
        number: afterProforma[0]?.number,
      });
      expect(spy.requests[0]?.payment?.type).toBe("Ordin plata");
    });
  });

  it("fără furnizor ales, nu se scrie nimic în outbox", async () => {
    await withInvoicing(
      async ({ h }) => {
        const { orderId } = await place(h);
        expect(await docs(h, orderId)).toHaveLength(0);
      },
      { "invoicing.provider": "" },
    );
  });

  it("același eveniment repetat nu dă un al doilea document", async () => {
    await withInvoicing(async ({ h }) => {
      const { orderId } = await place(h, { paymentMethod: "card" });
      await addOrderEvent(h.tx, orderId, { type: "payment.confirmed", message: "a" });
      await addOrderEvent(h.tx, orderId, { type: "payment.confirmed", message: "b" });
      expect(await docs(h, orderId)).toHaveLength(1);
    });
  });
});

describe("stoc: descărcarea de gestiune și markInvoiced", () => {
  it("produs cu stoc gestionat: factura cere descărcare și ora ei intră pe angajare", async () => {
    await withInvoicing(async ({ h, spy, service }) => {
      const { orderId } = await place(h);
      await service.processDue();
      expect(spy.requests[0]?.useStock).toBe(true);
      expect(
        spy.requests[0]?.lines.filter((l) => l.kind === "product").every((l) => l.dischargeStock),
      ).toBe(true);
      const commitments = await h.tx.stockCommitment.findMany({ where: { refId: orderId } });
      expect(commitments.length).toBeGreaterThan(0);
      expect(commitments.every((c) => c.invoicedAt !== null)).toBe(true);
    });
  });

  it("produs fără stoc gestionat: factura se emite FĂRĂ descărcare, iar angajările rămân neoglindite", async () => {
    await withInvoicing(async ({ h, spy, service }) => {
      const { orderId } = await place(h, {}, { manageStock: false, physical: null });
      await service.processDue();
      expect(spy.requests[0]?.useStock).toBe(false);
      const [doc] = await docs(h, orderId);
      expect(doc).toMatchObject({ status: "issued", useStock: false });
      const commitments = await h.tx.stockCommitment.findMany({ where: { refId: orderId } });
      expect(commitments.every((c) => c.invoicedAt === null)).toBe(true);
    });
  });
});

describe("storno", () => {
  it("anulare după emitere: stornoul total se emite și stornează factura", async () => {
    await withInvoicing(async ({ h, spy, service }) => {
      const { orderId } = await place(h);
      await service.processDue();
      const [invoice] = await docs(h, orderId);
      await transitionOrder(
        h.tx,
        orderId,
        { status: "cancelled" },
        { type: "order.cancelled", message: "Anulată" },
        NOW,
      );
      const all = await docs(h, orderId);
      const storno = all.find((d) => d.kind === "storno");
      expect(storno).toMatchObject({
        docKey: "storno:total",
        parentId: invoice?.id,
        status: "queued",
      });
      await service.processDue();
      expect(spy.reversed).toEqual([{ series: "DEMO", number: invoice?.number }]);
      const done = (await docs(h, orderId)).find((d) => d.kind === "storno");
      expect(done?.status).toBe("issued");
      // factura originală rămâne neschimbată
      expect((await docs(h, orderId)).find((d) => d.kind === "invoice")).toMatchObject({
        status: "issued",
        number: invoice?.number,
      });
    });
  });

  it("anulare înainte ca factura să fie emisă: documentul e sărit și nu se mai emite nimic", async () => {
    await withInvoicing(async ({ h, spy, service }) => {
      const { orderId } = await place(h);
      await transitionOrder(
        h.tx,
        orderId,
        { status: "cancelled" },
        { type: "order.cancelled", message: "Anulată" },
        NOW,
      );
      await service.processDue();
      const all = await docs(h, orderId);
      expect(all.map((d) => d.status)).toEqual(["skipped"]);
      expect(spy.requests).toHaveLength(0);
      expect(spy.reversed).toHaveLength(0);
    });
  });

  it("transfer anulat cu doar proforma emisă: proforma se anulează", async () => {
    await withInvoicing(async ({ h, spy, service }) => {
      const { orderId } = await place(h, { paymentMethod: "bank_transfer" });
      await service.processDue();
      await transitionOrder(
        h.tx,
        orderId,
        { status: "cancelled" },
        { type: "order.cancelled", message: "Anulată" },
        NOW,
      );
      await service.processDue();
      expect(spy.cancelled).toHaveLength(1);
      const storno = (await docs(h, orderId)).find((d) => d.kind === "storno");
      expect(storno).toMatchObject({ docKey: "storno:proforma", status: "issued" });
    });
  });

  it("refuz de ramburs (returnat expeditorului): stornoul total", async () => {
    await withInvoicing(async ({ h, service }) => {
      const { orderId } = await place(h);
      await service.processDue();
      await addOrderEvent(h.tx, orderId, { type: "order.returned_to_sender", message: "Refuzat" });
      expect((await docs(h, orderId)).some((d) => d.docKey === "storno:total")).toBe(true);
    });
  });

  it("rambursare TOTALĂ stornează; rambursare PARȚIALĂ nu", async () => {
    await withInvoicing(async ({ h, service }) => {
      const { orderId } = await place(h, { paymentMethod: "card" });
      await addOrderEvent(h.tx, orderId, { type: "payment.confirmed", message: "ok" });
      await service.processDue();
      await h.tx.order.update({
        where: { id: orderId },
        data: { paymentStatus: "partially_refunded" },
      });
      await addOrderEvent(h.tx, orderId, { type: "payment.refunded", message: "parțial" });
      expect((await docs(h, orderId)).some((d) => d.kind === "storno")).toBe(false);
      await h.tx.order.update({ where: { id: orderId }, data: { paymentStatus: "refunded" } });
      await addOrderEvent(h.tx, orderId, { type: "payment.refunded", message: "total" });
      expect((await docs(h, orderId)).some((d) => d.docKey === "storno:total")).toBe(true);
    });
  });

  it("anulare urmată de rambursare: un singur storno", async () => {
    await withInvoicing(async ({ h, service }) => {
      const { orderId } = await place(h, { paymentMethod: "card" });
      await addOrderEvent(h.tx, orderId, { type: "payment.confirmed", message: "ok" });
      await service.processDue();
      await addOrderEvent(h.tx, orderId, { type: "order.cancelled", message: "anulat" });
      await h.tx.order.update({ where: { id: orderId }, data: { paymentStatus: "refunded" } });
      await addOrderEvent(h.tx, orderId, { type: "payment.refunded", message: "total" });
      expect((await docs(h, orderId)).filter((d) => d.kind === "storno")).toHaveLength(1);
    });
  });
});

describe("storno parțial pe produse", () => {
  async function issuedWithTwoLines(h: Harness, service: InvoiceService) {
    const a = await h.product({ price: 12_345 });
    const b = await h.product({ price: 4_990 });
    const owner = await h.fill([
      { variantId: a.variantId, quantity: q("4") },
      { variantId: b.variantId, quantity: q("2") },
    ]);
    const { orderId } = await h.checkout.place(owner, await h.input(owner));
    await service.processDue();
    const order = await h.tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { lines: true },
    });
    return { orderId, lines: order.lines };
  }

  it("două returnări succesive; suma stornourilor unei linii = totalul liniei; transportul nu se stornează", async () => {
    await withInvoicing(async ({ h, spy, service }) => {
      const { orderId, lines } = await issuedWithTwoLines(h, service);
      const first = lines.find((l) => l.sku.length > 0 && l.unitPriceMinor === 12_345)!;
      await service.requestPartialStorno(
        orderId,
        "R1",
        [{ orderLineId: first.id, quantityTicks: 10_000n }],
        "admin@test.ro",
      );
      await service.requestPartialStorno(
        orderId,
        "R2",
        [{ orderLineId: first.id, quantityTicks: 30_000n }],
        "admin@test.ro",
      );
      await service.processDue();
      const stornos = (await docs(h, orderId)).filter((d) => d.kind === "storno");
      expect(stornos).toHaveLength(2);
      expect(stornos.every((s) => s.status === "issued")).toBe(true);
      expect(stornos.reduce((a, s) => a + s.totalMinor, 0)).toBe(first.lineTotalMinor);
      // TVA-ul fiecărui document = extras din brutul lui (cum îl calculează și furnizorul); suma pe bucăți poate diferi cu cel mult
      // un ban de TVA-ul liniei originale (S3 în FINISAJE, de confirmat cu contabilul)
      for (const s of stornos)
        expect(s.taxMinor).toBe(s.totalMinor - netFromGross(s.totalMinor, 2100));
      const drift = stornos.reduce((a, s) => a + s.taxMinor, 0) - first.taxMinor;
      expect(Math.abs(drift)).toBeLessThanOrEqual(1);
      // furnizorul a primit cantități NEGATIVE
      const sent = spy.requests.at(-1);
      expect(sent?.lines.every((l) => l.quantityTicks < 0n && l.lineTotalMinor < 0)).toBe(true);
      expect(sent?.lines.some((l) => l.kind === "shipping")).toBe(false);
    });
  });

  it("aceeași referință repetată: niciun document nou; peste cantitatea facturată: refuz", async () => {
    await withInvoicing(async ({ h, service }) => {
      const { orderId, lines } = await issuedWithTwoLines(h, service);
      const line = lines[0]!;
      const id = await service.requestPartialStorno(
        orderId,
        "R1",
        [{ orderLineId: line.id, quantityTicks: 10_000n }],
        "a",
      );
      expect(id).not.toBeNull();
      expect(
        await service.requestPartialStorno(
          orderId,
          "R1",
          [{ orderLineId: line.id, quantityTicks: 10_000n }],
          "a",
        ),
      ).toBeNull();
      await expect(
        service.requestPartialStorno(
          orderId,
          "R9",
          [{ orderLineId: line.id, quantityTicks: 999_000_000n }],
          "a",
        ),
      ).rejects.toMatchObject({ code: "INVOICE_RETURN_INVALID" });
    });
  });

  it("după stornoul total nu se mai poate cere unul parțial", async () => {
    await withInvoicing(async ({ h, service }) => {
      const { orderId, lines } = await issuedWithTwoLines(h, service);
      await service.requestReverse(orderId, "admin");
      await expect(
        service.requestPartialStorno(
          orderId,
          "R1",
          [{ orderLineId: lines[0]!.id, quantityTicks: 10_000n }],
          "a",
        ),
      ).rejects.toMatchObject({ code: "INVOICE_STATE_INVALID" });
    });
  });
});

describe("eșecuri: reîncercări, alertă, dead-letter, rezultat nesigur", () => {
  it("eșec sigur de reîncercat: backoff din setări; la a 3-a încercare eșuată apare O alertă; a doua rulare nu o dublează", async () => {
    await withInvoicing(async ({ h, spy, service, clock }) => {
      const { orderId } = await place(h);
      spy.failures = [
        { code: "INVOICE_REJECTED", message: "Seria nu a fost gasita" },
        { code: "INVOICE_REJECTED", message: "Seria nu a fost gasita" },
        { code: "INVOICE_REJECTED", message: "Seria nu a fost gasita" },
      ];
      const alerts = () => h.tx.adminNotification.count({ where: { kind: "invoice_failed" } });

      await service.processDue();
      let [doc] = await docs(h, orderId);
      expect(doc).toMatchObject({
        status: "queued",
        attempts: 1,
        lastErrorCode: "INVOICE_REJECTED",
      });
      expect(doc?.nextAttemptAt?.getTime()).toBe(clock.now.getTime() + 60_000); // 1 minut
      expect(await alerts()).toBe(0);

      // înainte de scadență nu se preia
      expect((await service.processDue()).processed).toBe(0);

      clock.now = new Date(clock.now.getTime() + 61_000);
      await service.processDue();
      [doc] = await docs(h, orderId);
      expect(doc).toMatchObject({ status: "queued", attempts: 2 });
      expect(doc?.nextAttemptAt?.getTime()).toBe(clock.now.getTime() + 5 * 60_000);
      expect(await alerts()).toBe(0);

      clock.now = new Date(clock.now.getTime() + 5 * 60_000 + 1000);
      await service.processDue();
      [doc] = await docs(h, orderId);
      expect(doc).toMatchObject({ status: "queued", attempts: 3 });
      expect(doc?.alertedAt).not.toBeNull();
      expect(await alerts()).toBe(1);
      const notification = await h.tx.adminNotification.findFirstOrThrow({
        where: { kind: "invoice_failed" },
      });
      expect(notification.permission).toBe("invoices.read");
      expect(JSON.stringify(notification)).not.toContain("Ion Popescu");
      expect(JSON.stringify(notification)).not.toContain("client@exemplu");

      // al patrulea eșec: tot o alertă (cheia e pe document)
      spy.failures = [{ code: "INVOICE_REJECTED", message: "x" }];
      clock.now = new Date(clock.now.getTime() + 20 * 60_000);
      await service.processDue();
      expect(await alerts()).toBe(1);
    });
  });

  it("după maxAttempts documentul trece în «eșuat» (dead-letter); «Reîncearcă» îl pune în coadă și se emite", async () => {
    await withInvoicing(
      async ({ h, spy, service, clock }) => {
        const { orderId } = await place(h);
        spy.failures = [
          { code: "INVOICE_RATE_LIMITED", message: "prea multe apeluri" },
          { code: "INVOICE_RATE_LIMITED", message: "prea multe apeluri" },
        ];
        await service.processDue();
        clock.now = new Date(clock.now.getTime() + 3_600_000);
        await service.processDue();
        let [doc] = await docs(h, orderId);
        expect(doc).toMatchObject({ status: "failed", attempts: 2 });
        // «Reîncearcă» (eroare sigură: nu cere confirmare)
        await service.retry(doc!.id, "admin@test.ro", false);
        [doc] = await docs(h, orderId);
        expect(doc).toMatchObject({ status: "queued", attempts: 0 });
        await service.processDue();
        [doc] = await docs(h, orderId);
        expect(doc?.status).toBe("issued");
        const events = await h.tx.invoiceEvent.findMany({ where: { invoiceId: doc!.id } });
        expect(events.map((e) => e.type)).toContain("retry_requested");
      },
      { "invoicing.maxAttempts": 2, "invoicing.alertAfterFailures": 2 },
    );
  });

  it("timp depășit la emitere = rezultat NESIGUR: nu se reîncearcă singur, alertă imediată, retrimiterea cere confirmare", async () => {
    await withInvoicing(async ({ h, spy, service, clock }) => {
      const { orderId } = await place(h);
      spy.failures = [
        { code: "INVOICE_PROVIDER_TIMEOUT", message: "Furnizorul nu a răspuns la timp" },
      ];
      await service.processDue();
      let [doc] = await docs(h, orderId);
      expect(doc).toMatchObject({ status: "failed", lastErrorCode: "INVOICE_PROVIDER_TIMEOUT" });
      expect(doc?.lastError).toContain("Rezultat nesigur");
      expect(await h.tx.adminNotification.count({ where: { kind: "invoice_failed" } })).toBe(1);
      clock.now = new Date(clock.now.getTime() + 86_400_000);
      expect((await service.processDue()).processed).toBe(0); // niciun apel automat
      expect(spy.requests).toHaveLength(0);
      await expect(service.retry(doc!.id, "admin", false)).rejects.toMatchObject({
        code: "INVOICE_OUTCOME_UNKNOWN",
      });
      await service.retry(doc!.id, "admin", true);
      await service.processDue();
      [doc] = await docs(h, orderId);
      expect(doc?.status).toBe("issued");
    });
  });

  it("proces căzut în timpul emiterii (lease expirat): «eșuat» cu rezultat nesigur, fără reîncercare automată", async () => {
    await withInvoicing(async ({ h, service, clock }) => {
      const { orderId } = await place(h);
      const [claimed] = await service.claimDue();
      expect(claimed).toBeDefined();
      clock.now = new Date(clock.now.getTime() + 11 * 60_000); // peste leaseMinutes (10)
      expect(await service.recoverStale()).toBe(1);
      const [doc] = await docs(h, orderId);
      expect(doc).toMatchObject({ status: "failed", lastErrorCode: "INVOICE_OUTCOME_UNKNOWN" });
      expect(await service.claimDue()).toEqual([]);
    });
  });

  it("un eșec nu blochează comanda: statusurile ei rămân neschimbate", async () => {
    await withInvoicing(async ({ h, spy, service }) => {
      const { orderId } = await place(h);
      const before = await orderOf(h.tx, orderId);
      spy.failures = [{ code: "INVOICE_REJECTED", message: "x" }];
      await service.processDue();
      const after = await orderOf(h.tx, orderId);
      expect([after.status, after.paymentStatus, after.fulfillmentStatus]).toEqual([
        before.status,
        before.paymentStatus,
        before.fulfillmentStatus,
      ]);
    });
  });

  it("furnizor neconfigurat: documentul așteaptă, fără încercări numărate și fără alertă", async () => {
    await withInvoicing(async ({ h, service, clock }) => {
      const noProvider = new InvoiceService({
        db: h.tx as unknown as PrismaClient,
        source: { active: async () => "demo", provider: async () => null },
        now: () => clock.now,
      });
      const { orderId } = await place(h);
      await noProvider.processDue();
      const [doc] = await docs(h, orderId);
      expect(doc).toMatchObject({
        status: "queued",
        attempts: 0,
        lastErrorCode: "INVOICE_NOT_CONFIGURED",
      });
      expect(await h.tx.adminNotification.count({ where: { kind: "invoice_failed" } })).toBe(0);
      expect(service).toBeDefined();
    });
  });
});

describe("e-Factura și PDF", () => {
  it("starea e-Factura se poate marca manual doar pe o factură emisă; PDF-ul vine de la furnizor, marcat SIMULAT", async () => {
    await withInvoicing(async ({ h, service }) => {
      const { orderId } = await place(h);
      await service.processDue();
      const [doc] = await docs(h, orderId);
      await service.setEfacturaStatus(doc!.id, "validated", "admin@test.ro");
      expect((await docs(h, orderId))[0]?.efacturaStatus).toBe("validated");
      const { pdf, fileName } = await service.pdf(doc!.id);
      expect(fileName).toBe(`factura-DEMO${doc?.number}.pdf`);
      expect(new TextDecoder("latin1").decode(pdf.bytes)).toContain("SIMULAT");
      await expect(service.setEfacturaStatus("nu-exista", "sent", "a")).rejects.toMatchObject({
        code: "INVOICE_STATE_INVALID",
      });
    });
  });

  it("DEMO raportează e-Factura: «pending» devine «validated» la reîmprospătare", async () => {
    await withInvoicing(async ({ h, service }) => {
      const { orderId } = await place(h);
      await service.processDue();
      expect((await docs(h, orderId))[0]?.efacturaStatus).toBe("pending");
      expect(await service.refreshEfactura()).toBeGreaterThanOrEqual(1);
      expect((await docs(h, orderId))[0]?.efacturaStatus).toBe("validated");
    });
  });
});

describe("alerta pe email «factura nu s-a putut emite»", () => {
  const TEMPLATE = "internal.invoice_failed";
  let seq = 0;
  async function user(h: Harness, roles: string[], verified = true) {
    seq += 1;
    const created = await h.tx.user.create({
      data: {
        id: `u-fact-${seq}-${NOW.getTime()}`,
        name: "Utilizator facturare",
        email: `fact-${seq}-${NOW.getTime()}@exemplu.test`,
        emailVerified: verified,
      },
    });
    for (const key of roles) {
      const role = await h.tx.role.findUniqueOrThrow({ where: { key } });
      await h.tx.userRole.create({ data: { userId: created.id, roleId: role.id } });
    }
    return created;
  }

  it("pleacă doar către utilizatori verificați cu invoices.write, o singură dată pe document, fără date ale clientului", async () => {
    await withInvoicing(async ({ h, spy, service, clock }) => {
      const manager = await user(h, ["manager"]);
      const owner = await user(h, ["owner"]);
      const unverified = await user(h, ["manager"], false);
      const accountant = await user(h, ["accountant"]); // invoices.read, fără invoices.write
      const support = await user(h, ["support"]);
      const { orderId } = await place(h);
      spy.failures = [
        { code: "INVOICE_PROVIDER_TIMEOUT", message: "Furnizorul nu a răspuns la timp" },
      ];
      await service.processDue();
      const mails = await h.tx.emailDispatch.findMany({ where: { template: TEMPLATE, orderId } });
      const to = mails.map((m) => m.recipient);
      expect(to).toContain(manager.email.toLowerCase());
      expect(to).toContain(owner.email.toLowerCase());
      for (const other of [unverified, accountant, support]) {
        expect(to).not.toContain(other.email.toLowerCase());
      }
      expect(JSON.stringify(mails.map((m) => m.data))).not.toContain("Ion Popescu");
      // al doilea eșec pe același document (după «Reîncearcă») nu mai trimite a doua oară
      const [doc] = await docs(h, orderId);
      await service.retry(doc!.id, "admin", true);
      spy.failures = [{ code: "INVOICE_PROVIDER_TIMEOUT", message: "x" }];
      clock.now = new Date(clock.now.getTime() + 1000);
      await service.processDue();
      const again = await h.tx.emailDispatch.count({ where: { template: TEMPLATE, orderId } });
      expect(again).toBe(mails.length);
    });
  });
});

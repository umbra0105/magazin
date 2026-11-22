import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";

/**
 * Faza 13, schema facturilor (`invoice`, `invoice_line`, `invoice_event`). Fiecare constrângere are un test care o încalcă, iar
 * CHECK-urile compuse au și cazul «una setată, una nulă» (un CHECK cu rezultat NULL TRECE). Testele nu presupun date de seed:
 * își creează singure canalul și comanda, într-o tranzacție anulată. Niciun test nu emite o factură reală.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);

async function order(tx: TestTx) {
  const channel = await tx.salesChannel.create({ data: { code: `t_${uid()}`, name: "Canal" } });
  return tx.order.create({
    data: {
      number: `T-${uid()}`,
      channelId: channel.id,
      email: "client@exemplu.ro",
      phone: "0722000000",
      subtotalMinor: 10_000,
      shippingMinor: 0,
      taxMinor: 1_735,
      totalMinor: 10_000,
      taxRateBps: 2100,
      shippingMethodCode: "pickup",
      shippingSnapshot: { kind: "pickup" },
      paymentMethod: "cod",
      termsAcceptedAt: new Date(),
      termsConsentText: "Sunt de acord",
      termsConsentVersion: "t",
      idempotencyKey: randomUUID(),
    },
  });
}

const invoiceData = (orderId: string, over: Record<string, unknown> = {}) => ({
  orderId,
  kind: "invoice",
  docKey: "invoice",
  totalMinor: 10_000,
  taxMinor: 1_735,
  ...over,
});

const issuedFields = {
  status: "issued",
  provider: "smartbill",
  series: "FCT",
  number: "0001",
  providerRef: "123",
  issuedAt: new Date(),
};

async function attempt(act: (tx: TestTx, orderId: string) => Promise<unknown>) {
  return inRolledBackTransaction(db, async (tx) => {
    const o = await order(tx);
    try {
      await act(tx, o.id);
      return null;
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  });
}

async function rejects(act: (tx: TestTx, orderId: string) => Promise<unknown>, expected: string) {
  const error = await attempt(act);
  expect(error, `baza trebuia să respingă scrierea (${expected})`).not.toBeNull();
  expect(JSON.stringify(error) + String(error?.message)).toContain(expected);
}

async function accepts(act: (tx: TestTx, orderId: string) => Promise<unknown>) {
  const error = await attempt(act);
  expect(error, error?.message).toBeNull();
}

describe("factură: valori permise", () => {
  it("o factură în coadă se scrie, cu valorile implicite", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const o = await order(tx);
      const inv = await tx.invoice.create({ data: invoiceData(o.id) });
      expect(inv.status).toBe("queued");
      expect(inv.efacturaStatus).toBe("not_applicable");
      expect(inv.attempts).toBe(0);
      expect(inv.simulated).toBe(false);
      expect(inv.currency).toBe("RON");
    });
  });

  it("o factură emisă (toate câmpurile documentului setate) se scrie", async () => {
    await accepts((tx, orderId) => tx.invoice.create({ data: invoiceData(orderId, issuedFields) }));
  });

  it("proforma, factura și stornoul aceleiași comenzi coexistă; stornoul are părinte", async () => {
    await accepts(async (tx, orderId) => {
      await tx.invoice.create({
        data: invoiceData(orderId, { kind: "proforma", docKey: "proforma" }),
      });
      const inv = await tx.invoice.create({ data: invoiceData(orderId, issuedFields) });
      await tx.invoice.create({
        data: invoiceData(orderId, {
          kind: "storno",
          docKey: "storno:total",
          parentId: inv.id,
        }),
      });
    });
  });
});

describe("factură: unicitate pe comandă și tip de document (outbox)", () => {
  it("două facturi cu aceeași cheie pe aceeași comandă sunt respinse", async () => {
    await rejects(async (tx, orderId) => {
      await tx.invoice.create({ data: invoiceData(orderId) });
      await tx.invoice.create({ data: invoiceData(orderId) });
    }, "invoice_orderId_docKey_key");
  });
});

describe("factură: tip, stare, cheie", () => {
  it("tip necunoscut (respins; Postgres numește prima constrângere încălcată, deci nu doar `invoice_kind_check`)", async () => {
    await rejects(
      (tx, orderId) => tx.invoice.create({ data: invoiceData(orderId, { kind: "chitanta" }) }),
      "violates check constraint",
    );
  });
  it("stare necunoscută", async () => {
    await rejects(
      (tx, orderId) => tx.invoice.create({ data: invoiceData(orderId, { status: "gata" }) }),
      "invoice_status_check",
    );
  });
  it("stare e-Factura necunoscută", async () => {
    await rejects(
      (tx, orderId) => tx.invoice.create({ data: invoiceData(orderId, { efacturaStatus: "ok" }) }),
      "invoice_efactura_check",
    );
  });
  it("cheia nu se potrivește cu tipul (factură cu cheia «proforma»)", async () => {
    await rejects(
      (tx, orderId) => tx.invoice.create({ data: invoiceData(orderId, { docKey: "proforma" }) }),
      "invoice_dockey_check",
    );
  });
  it("storno fără cheia «storno:…»", async () => {
    await rejects(async (tx, orderId) => {
      const inv = await tx.invoice.create({ data: invoiceData(orderId, issuedFields) });
      await tx.invoice.create({
        data: invoiceData(orderId, { kind: "storno", docKey: "invoice2", parentId: inv.id }),
      });
    }, "invoice_dockey_check");
  });
});

describe("factură: părintele (CHECK compus, cazul «una setată, una nulă»)", () => {
  it("storno fără părinte e respins", async () => {
    await rejects(
      (tx, orderId) =>
        tx.invoice.create({
          data: invoiceData(orderId, { kind: "storno", docKey: "storno:total" }),
        }),
      "invoice_parent_check",
    );
  });
  it("factură cu părinte e respinsă", async () => {
    await rejects(async (tx, orderId) => {
      const first = await tx.invoice.create({ data: invoiceData(orderId, issuedFields) });
      await tx.invoice.create({
        data: invoiceData(orderId, { kind: "proforma", docKey: "proforma", parentId: first.id }),
      });
    }, "invoice_parent_check");
  });
});

describe("factură: documentul emis ⇔ câmpurile lui (CHECK compus)", () => {
  for (const missing of ["provider", "series", "number", "providerRef", "issuedAt"] as const) {
    it(`emisă dar fără «${missing}»: respinsă`, async () => {
      await rejects(
        (tx, orderId) =>
          tx.invoice.create({
            data: invoiceData(orderId, { ...issuedFields, [missing]: null }),
          }),
        "invoice_issued_check",
      );
    });
  }
  for (const present of [
    ["number", "0001"],
    ["series", "FCT"],
    ["providerRef", "9"],
    ["issuedAt", new Date()],
  ] as const) {
    it(`în coadă dar cu «${present[0]}» setat: respinsă`, async () => {
      await rejects(
        (tx, orderId) =>
          tx.invoice.create({ data: invoiceData(orderId, { [present[0]]: present[1] }) }),
        "invoice_issued_check",
      );
    });
  }
  it("furnizor necunoscut", async () => {
    await rejects(
      (tx, orderId) =>
        tx.invoice.create({ data: invoiceData(orderId, { ...issuedFields, provider: "oblio" }) }),
      "invoice_provider_check",
    );
  });
});

describe("factură: sume și încercări", () => {
  it("total negativ", async () => {
    await rejects(
      (tx, orderId) => tx.invoice.create({ data: invoiceData(orderId, { totalMinor: -1 }) }),
      "invoice_amounts_check",
    );
  });
  it("TVA mai mare decât totalul", async () => {
    await rejects(
      (tx, orderId) => tx.invoice.create({ data: invoiceData(orderId, { taxMinor: 10_001 }) }),
      "invoice_amounts_check",
    );
  });
  it("încercări negative", async () => {
    await rejects(
      (tx, orderId) => tx.invoice.create({ data: invoiceData(orderId, { attempts: -1 }) }),
      "invoice_amounts_check",
    );
  });
});

const lineData = (invoiceId: string, over: Record<string, unknown> = {}) => ({
  invoiceId,
  position: 1,
  kind: "shipping",
  title: "Transport",
  unitName: "buc",
  quantityTicks: 10_000n,
  unitPriceMinor: 1_210,
  lineTotalMinor: 1_210,
  netMinor: 1_000,
  taxMinor: 210,
  taxRateBps: 2100,
  ...over,
});

async function withInvoice(
  act: (tx: TestTx, invoiceId: string, orderId: string) => Promise<unknown>,
) {
  return attempt(async (tx, orderId) => {
    const inv = await tx.invoice.create({ data: invoiceData(orderId) });
    await act(tx, inv.id, orderId);
  });
}

describe("linie de factură", () => {
  it("o linie de transport valabilă (fără linie de comandă, fără SKU) se scrie", async () => {
    expect(
      (await withInvoice((tx, id) => tx.invoiceLine.create({ data: lineData(id) })))?.message,
    ).toBeUndefined();
  });

  it("net + TVA trebuie să dea totalul liniei", async () => {
    const error = await withInvoice((tx, id) =>
      tx.invoiceLine.create({ data: lineData(id, { netMinor: 999 }) }),
    );
    expect(String(error?.message)).toContain("invoice_line_amounts_check");
  });

  it("cantitate zero", async () => {
    const error = await withInvoice((tx, id) =>
      tx.invoiceLine.create({ data: lineData(id, { quantityTicks: 0n }) }),
    );
    expect(String(error?.message)).toContain("invoice_line_amounts_check");
  });

  it("cantitate cu mai mult de 2 zecimale (SmartBill: cel mult 2)", async () => {
    const error = await withInvoice((tx, id) =>
      tx.invoiceLine.create({ data: lineData(id, { quantityTicks: 10_001n }) }),
    );
    expect(String(error?.message)).toContain("invoice_line_quantity_check");
  });

  it("tip de linie necunoscut", async () => {
    const error = await withInvoice((tx, id) =>
      tx.invoiceLine.create({ data: lineData(id, { kind: "bonus" }) }),
    );
    expect(String(error?.message)).toContain("invoice_line_kind_check");
  });

  it("linie de produs fără linie de comandă (una setată, una nulă)", async () => {
    const error = await withInvoice((tx, id) =>
      tx.invoiceLine.create({ data: lineData(id, { kind: "product", sku: "SKU-1" }) }),
    );
    expect(String(error?.message)).toContain("invoice_line_source_check");
  });

  it("linie de transport cu SKU (una setată, una nulă)", async () => {
    const error = await withInvoice((tx, id) =>
      tx.invoiceLine.create({ data: lineData(id, { sku: "SKU-1" }) }),
    );
    expect(String(error?.message)).toContain("invoice_line_source_check");
  });

  it("două linii pe aceeași poziție", async () => {
    const error = await withInvoice(async (tx, id) => {
      await tx.invoiceLine.create({ data: lineData(id) });
      await tx.invoiceLine.create({ data: lineData(id, { kind: "cod_fee" }) });
    });
    expect(String(error?.message)).toContain("invoice_line_invoiceId_position_key");
  });
});

describe("eveniment de factură: jurnal care doar se adaugă", () => {
  it("un eveniment nu se poate modifica", async () => {
    const error = await withInvoice(async (tx, id) => {
      const ev = await tx.invoiceEvent.create({
        data: { invoiceId: id, type: "queued", message: "x" },
      });
      await tx.invoiceEvent.update({ where: { id: ev.id }, data: { message: "y" } });
    });
    expect(String(error?.message)).toContain("invoice_event");
  });
  it("un eveniment nu se poate șterge direct", async () => {
    const error = await withInvoice(async (tx, id) => {
      const ev = await tx.invoiceEvent.create({
        data: { invoiceId: id, type: "queued", message: "x" },
      });
      await tx.invoiceEvent.delete({ where: { id: ev.id } });
    });
    expect(String(error?.message)).toContain("invoice_event");
  });
});

describe("factură: câmpurile fiscale ale unui document emis nu se mai schimbă", () => {
  it("seria și numărul unei facturi emise nu se pot schimba", async () => {
    await rejects(async (tx, orderId) => {
      const inv = await tx.invoice.create({ data: invoiceData(orderId, issuedFields) });
      await tx.invoice.update({ where: { id: inv.id }, data: { number: "9999" } });
    }, "invoice_issued_immutable");
  });
  it("sumele unei facturi emise nu se pot schimba", async () => {
    await rejects(async (tx, orderId) => {
      const inv = await tx.invoice.create({ data: invoiceData(orderId, issuedFields) });
      await tx.invoice.update({ where: { id: inv.id }, data: { totalMinor: 1 } });
    }, "invoice_issued_immutable");
  });
  it("starea e-Factura și linkul PDF se pot actualiza după emitere", async () => {
    await accepts(async (tx, orderId) => {
      const inv = await tx.invoice.create({ data: invoiceData(orderId, issuedFields) });
      await tx.invoice.update({
        where: { id: inv.id },
        data: { efacturaStatus: "sent", pdfUrl: "https://exemplu.invalid/x" },
      });
    });
  });
});

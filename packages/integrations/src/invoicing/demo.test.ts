import { describe, expect, it } from "vitest";
import { IntegrationError, type InvoiceDocLine, type InvoiceRequest } from "@ecom/shared";
import { DEMO_SIMULATED_NOTICE, DemoInvoiceProvider, demoComputeTotals } from "./demo";
import { buildInvoiceProvider } from "./registry";

const env = { NODE_ENV: "development", ECOM_DEMO_PAYMENTS: "1" };

const line = (over: Partial<InvoiceDocLine> = {}): InvoiceDocLine => ({
  kind: "product",
  name: "Mozaic",
  code: "MZ",
  unitName: "mp",
  quantityTicks: 60_900n,
  unitPriceMinor: 12_345,
  lineTotalMinor: 75_181,
  taxMinor: 13_048,
  taxRateBps: 2100,
  dischargeStock: false,
  ...over,
});

const request = (lines: InvoiceDocLine[]): InvoiceRequest => ({
  orderNumber: "WEB-1",
  client: {
    name: "Test",
    vatCode: null,
    isTaxPayer: false,
    regCom: null,
    address: "x",
    city: "x",
    county: "x",
    country: "Romania",
    email: null,
    phone: null,
  },
  lines,
  currency: "RON",
  issueDate: new Date(),
  useStock: false,
  payment: null,
  fromProforma: null,
  sendEmail: false,
});

describe("furnizorul DEMO de facturare: garda", () => {
  it("nu se poate construi într-o instalare de producție", () => {
    expect(() => new DemoInvoiceProvider({ env: { NODE_ENV: "production" } })).toThrowError(/DEMO/);
    expect(() =>
      buildInvoiceProvider({ code: "demo", credentials: {}, env: { NODE_ENV: "production" } }),
    ).toThrowError(/DEMO/);
  });
  it("se construiește în dezvoltare, cu flag", () => {
    expect(new DemoInvoiceProvider({ env }).simulated).toBe(true);
  });
});

describe("furnizorul DEMO: documente simulate", () => {
  it("emite cu seria DEMO, marcat simulat, cu totalul și TVA-ul pe linii", async () => {
    const provider = new DemoInvoiceProvider({ env });
    const doc = await provider.issueInvoice(request([line()]));
    expect(doc).toMatchObject({
      series: "DEMO",
      simulated: true,
      totalMinor: 75_181,
      taxMinor: 13_048,
    });
    expect(doc.number).toMatch(/^\d{13}$/);
  });

  it("PDF-ul poartă marcajul «SIMULAT, nu este document fiscal»", async () => {
    const provider = new DemoInvoiceProvider({ env });
    const pdf = await provider.getInvoicePdf({ series: "DEMO", number: "1" });
    const text = new TextDecoder("latin1").decode(pdf.bytes);
    expect(text.startsWith("%PDF")).toBe(true);
    expect(text).toContain(DEMO_SIMULATED_NOTICE.replace(/[^\x20-\x7e]/g, "?"));
    const pro = await provider.getProformaPdf({ series: "DEMO", number: "1" });
    expect(new TextDecoder("latin1").decode(pro.bytes)).toContain("SIMULAT");
  });
});

describe("furnizorul DEMO respinge orice diferență de bani", () => {
  it("totalul unei linii diferit cu 1 ban", () => {
    expect(() => demoComputeTotals(request([line({ lineTotalMinor: 75_182 })]))).toThrowError(
      /Linia 1/,
    );
    expect(() => demoComputeTotals(request([line({ lineTotalMinor: 75_180 })]))).toThrowError(
      IntegrationError,
    );
  });
  it("TVA-ul unei linii diferit cu 1 ban", () => {
    expect(() => demoComputeTotals(request([line({ taxMinor: 13_049 })]))).toThrowError(/TVA/);
  });
  it("cantitate cu mai mult de 2 zecimale", () => {
    expect(() => demoComputeTotals(request([line({ quantityTicks: 60_901n })]))).toThrowError(
      /2 zecimale/,
    );
  });
  it("totalul = suma liniilor, TVA = suma TVA-urilor pe linii (nu extras din total)", () => {
    const a = line({
      quantityTicks: 10_000n,
      unitPriceMinor: 1_999,
      lineTotalMinor: 1_999,
      taxMinor: 347,
    });
    const b = line({
      quantityTicks: 10_000n,
      unitPriceMinor: 1_999,
      lineTotalMinor: 1_999,
      taxMinor: 347,
    });
    const totals = demoComputeTotals(request([a, b]));
    expect(totals).toEqual({ totalMinor: 3_998, taxMinor: 694 });
  });
  it("storno parțial cu cantitate negativă", () => {
    const neg = line({
      quantityTicks: -10_000n,
      unitPriceMinor: 12_345,
      lineTotalMinor: -12_345,
      taxMinor: -2_143,
    });
    expect(demoComputeTotals(request([neg]))).toEqual({ totalMinor: -12_345, taxMinor: -2_143 });
  });
  it("emiterea cere o eroare configurată (pentru alerta de după 3 eșecuri)", async () => {
    const provider = new DemoInvoiceProvider({
      env,
      failWith: { code: "INVOICE_REJECTED", message: "Seria nu există (simulat)" },
    });
    const error = await provider.issueInvoice(request([line()])).catch((e: unknown) => e);
    expect((error as IntegrationError).code).toBe("INVOICE_REJECTED");
  });
});

describe("furnizorul DEMO spune dacă a descărcat gestiunea", () => {
  it("factura cu useStock descarcă; proforma și stornoul nu", async () => {
    const provider = new DemoInvoiceProvider({ env });
    const withStock = { ...request([line()]), useStock: true };
    expect((await provider.issueInvoice(withStock)).stockDischarged).toBe(true);
    expect((await provider.issueInvoice(request([line()]))).stockDischarged).toBe(false);
    expect((await provider.issueProforma(withStock)).stockDischarged).toBe(false);
    expect((await provider.reverseInvoice()).stockDischarged).toBe(false);
  });
});

describe("furnizorul DEMO: refuză orice storno care ar duce suma cumulată peste totalul facturii", () => {
  const negative = (totalMinor: number): InvoiceDocLine =>
    line({
      quantityTicks: -10_000n,
      unitPriceMinor: -totalMinor === 0 ? 0 : Math.abs(totalMinor),
      lineTotalMinor: totalMinor,
      taxMinor: -Math.round((Math.abs(totalMinor) * 2100) / 12100),
    });

  it("un storno parțial care încape sub total e acceptat, unul care îl depășește e refuzat cu cod stabil", async () => {
    const provider = new DemoInvoiceProvider({ env });
    const ok = {
      ...request([negative(-10_000)]),
      reversal: { invoiceTotalMinor: 100_000, alreadyReversedMinor: 90_000 },
    };
    await expect(provider.issueInvoice(ok)).resolves.toMatchObject({ totalMinor: -10_000 });
    const over = {
      ...request([negative(-10_000)]),
      reversal: { invoiceTotalMinor: 100_000, alreadyReversedMinor: 90_001 },
    };
    await expect(provider.issueInvoice(over)).rejects.toMatchObject({
      code: "INVOICE_STORNO_EXCEEDS_TOTAL",
    });
    await expect(provider.issueInvoice(over)).rejects.toBeInstanceOf(IntegrationError);
  });

  it("stornoul total (reverseInvoice) cu ceva deja stornat e refuzat; fără nimic stornat, trece", async () => {
    const provider = new DemoInvoiceProvider({ env });
    const ref = { series: "DEMO", number: "1" };
    await expect(
      provider.reverseInvoice(ref, new Date(), {
        invoiceTotalMinor: 100_000,
        alreadyReversedMinor: 40_000,
      }),
    ).rejects.toMatchObject({ code: "INVOICE_STORNO_EXCEEDS_TOTAL" });
    await expect(
      provider.reverseInvoice(ref, new Date(), {
        invoiceTotalMinor: 100_000,
        alreadyReversedMinor: 0,
      }),
    ).resolves.toMatchObject({ simulated: true });
    // apelul vechi, fără context, rămâne valid
    await expect(provider.reverseInvoice()).resolves.toMatchObject({ simulated: true });
  });
});

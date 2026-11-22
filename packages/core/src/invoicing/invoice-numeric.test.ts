import { describe, expect, it } from "vitest";
import { DemoInvoiceProvider } from "@ecom/integrations";
import { parseQuantity, quantityFromTicks, type InvoiceRequest, type Quantity } from "@ecom/shared";
import { computeOrderTotals } from "../orders/order-totals";
import { priceLines, type PriceGroup, type PricingCoupon, type PricingLineInput } from "../pricing";
import {
  InvoiceDraftError,
  buildInvoiceDraft,
  buildPartialStorno,
  isInvoiceQuantity,
  negateLines,
  toDocLines,
  type DraftOrder,
  type StornoReturned,
  type StornoSourceLine,
} from "./invoice-draft";

/**
 * Cele 20 de cazuri numerice ale Fazei 13 (docs/06): total încasat = total factură, la 1 ban; TVA factură = suma TVA-urilor pe
 * linii. Cazurile trec prin MOTORUL DE PREȚURI real și prin `computeOrderTotals` (aceleași funcții ca la checkout), apoi prin
 * construirea facturii și prin furnizorul DEMO, care respinge orice diferență. Rezultatul nu spune nimic despre SmartBill real:
 * verificarea în contul lor e pasul separat al utilizatorului (`scripts/facturare/verifica-rotunjirea.mjs`).
 */
const NOW = new Date("2026-06-01T10:00:00.000Z");
const RATE = 2100;
const provider = new DemoInvoiceProvider({
  env: { NODE_ENV: "development", ECOM_DEMO_PAYMENTS: "1" },
});

const qty = (text: string): Quantity => parseQuantity(text, { maxDecimals: 4 });
const ONE = quantityFromTicks(10_000n);

interface Item {
  sku: string;
  priceMinor: number;
  quantity: string;
  salePriceMinor?: number;
  symbol?: string;
}

interface Scenario {
  items: Item[];
  shippingMinor?: number;
  codFeeMinor?: number;
  group?: PriceGroup;
  coupon?: PricingCoupon;
}

function orderOf(s: Scenario): { order: DraftOrder; lineTotals: number[] } {
  const inputs: PricingLineInput[] = s.items.map((item) => ({
    key: item.sku,
    productId: `p-${item.sku}`,
    categoryIds: [],
    basis: "unit",
    priceMinor: item.priceMinor,
    salePriceMinor: item.salePriceMinor ?? null,
    quantity: qty(item.quantity),
    step: ONE,
    taxRateBps: RATE,
    excludeFromGroupDiscount: false,
    costNetMinor: null,
  }));
  const priced = priceLines(inputs, {
    applySale: true,
    group: s.group ?? { pricingType: "none" },
    coupon: s.coupon ?? null,
    now: NOW,
    maxLineMinor: 1_000_000_000,
  });
  const totals = computeOrderTotals({
    cart: { totalMinor: priced.totals.totalMinor, vatMinor: priced.totals.vatMinor },
    shippingMinor: s.shippingMinor ?? 0,
    codFeeMinor: s.codFeeMinor ?? 0,
    paymentMethod: (s.codFeeMinor ?? 0) > 0 ? "cod" : "card",
    taxRateBps: RATE,
  });
  const order: DraftOrder = {
    lines: priced.lines.map((line, index) => {
      const item = s.items[index] as Item;
      return {
        id: `ol-${item.sku}`,
        sku: item.sku,
        title: `Produs ${item.sku}`,
        variantTitle: null,
        quantityTicks: qty(item.quantity),
        unitSymbol: item.symbol ?? "buc",
        unitPriceMinor: line.unitPriceMinor,
        lineTotalMinor: line.totalMinor,
        netMinor: line.netMinor,
        taxMinor: line.vatMinor,
        taxRateBps: RATE,
        dischargeable: true,
      };
    }),
    discountMinor: 0,
    shippingMinor: totals.shippingMinor,
    shippingTaxMinor: totals.shippingTaxMinor,
    codFeeMinor: totals.codFeeMinor,
    codFeeTaxMinor: totals.codFeeTaxMinor,
    taxMinor: totals.taxMinor,
    totalMinor: totals.totalMinor,
    taxRateBps: RATE,
  };
  return { order, lineTotals: priced.lines.map((l) => l.totalMinor) };
}

const options = {
  unitName: (symbol: string) => symbol,
  labels: { shipping: "Transport", codFee: "Taxă ramburs", serviceUnit: "buc" },
};

async function emit(s: Scenario) {
  const { order, lineTotals } = orderOf(s);
  const draft = buildInvoiceDraft(order, options);
  const request: InvoiceRequest = {
    orderNumber: "WEB-TEST",
    client: {
      name: "Client Test",
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
    lines: toDocLines(draft.lines),
    currency: "RON",
    issueDate: NOW,
    useStock: draft.useStock,
    payment: null,
    fromProforma: null,
    sendEmail: false,
  };
  const issued = await provider.issueInvoice(request);
  return { order, draft, issued, lineTotals };
}

/** Invariantele cerute de decizia utilizatorului, verificate la fiecare caz. */
async function expectExact(s: Scenario) {
  const out = await emit(s);
  const { order, draft, issued } = out;
  expect(draft.totalMinor).toBe(order.totalMinor); // total factură = total încasat
  expect(issued.totalMinor).toBe(order.totalMinor); // furnizorul calculează același total
  expect(draft.taxMinor).toBe(order.taxMinor); // TVA factură = TVA magazin
  expect(issued.taxMinor).toBe(order.taxMinor);
  expect(draft.lines.reduce((a, l) => a + l.taxMinor, 0)).toBe(draft.taxMinor); // = suma TVA-urilor pe linii
  for (const line of draft.lines) expect(line.netMinor + line.taxMinor).toBe(line.lineTotalMinor);
  return out;
}

describe("20 de cazuri numerice: total încasat = total factură, TVA = suma pe linii", () => {
  it("01 · 3 cutii de mozaic = 6,09 mp × 123,45 = 751,81", async () => {
    const { draft } = await expectExact({
      items: [{ sku: "MZ", priceMinor: 12_345, quantity: "6,09", symbol: "mp" }],
    });
    expect(draft.lines[0]).toMatchObject({
      lineTotalMinor: 75_181,
      taxMinor: 13_048,
      unitName: "mp",
    });
  });

  it("02 · liner 41,25 mp × 89,90 = 3.708,375 → 3.708,38 (half-up)", async () => {
    const { draft } = await expectExact({
      items: [{ sku: "LN", priceMinor: 8_990, quantity: "41,25", symbol: "mp" }],
    });
    expect(draft.lines[0]?.lineTotalMinor).toBe(370_838);
  });

  it("03 · bisulfat 2 saci × 120,00 = 240,00", async () => {
    const { draft } = await expectExact({
      items: [{ sku: "BS", priceMinor: 12_000, quantity: "2", symbol: "sac" }],
    });
    expect(draft.lines[0]).toMatchObject({ lineTotalMinor: 24_000, taxMinor: 4_165 });
  });

  it("04 · coșul din docs/09: 751,81 + 240,00 + 9.490,00 = 10.481,81; TVA pe linii 1.819,15 (nu 1.819,16)", async () => {
    const { draft } = await expectExact({
      items: [
        { sku: "MZ", priceMinor: 12_345, quantity: "6,09", symbol: "mp" },
        { sku: "BS", priceMinor: 12_000, quantity: "2", symbol: "sac" },
        { sku: "PP", priceMinor: 949_000, quantity: "1" },
      ],
    });
    expect(draft.totalMinor).toBe(1_048_181);
    expect(draft.taxMinor).toBe(181_915);
    expect(draft.lines.map((l) => l.taxMinor)).toEqual([13_048, 4_165, 164_702]);
  });

  it("05 · coșul din docs/09 + transport 35,00 ca linie separată", async () => {
    const { draft } = await expectExact({
      items: [
        { sku: "MZ", priceMinor: 12_345, quantity: "6,09", symbol: "mp" },
        { sku: "BS", priceMinor: 12_000, quantity: "2", symbol: "sac" },
        { sku: "PP", priceMinor: 949_000, quantity: "1" },
      ],
      shippingMinor: 3_500,
    });
    expect(draft.totalMinor).toBe(1_051_681);
    expect(draft.lines.at(-1)).toMatchObject({ kind: "shipping", lineTotalMinor: 3_500 });
  });

  it("06 · produs + transport + taxă de ramburs, fiecare linie separată", async () => {
    const { draft } = await expectExact({
      items: [{ sku: "A", priceMinor: 4_999, quantity: "3" }],
      shippingMinor: 2_499,
      codFeeMinor: 1_500,
    });
    expect(draft.lines.map((l) => l.kind)).toEqual(["product", "shipping", "cod_fee"]);
  });

  it("07 · transport paletizat 350,00 lei (TVA inclus) ca orice transport", async () => {
    const { draft } = await expectExact({
      items: [{ sku: "PC", priceMinor: 1_850_000, quantity: "1" }],
      shippingMinor: 35_000,
    });
    expect(draft.lines[1]).toMatchObject({
      kind: "shipping",
      lineTotalMinor: 35_000,
      taxMinor: 6_074,
    });
  });

  it("08 · 0,5 × 33,33 = 16,665 → 16,67 (half-up)", async () => {
    const { draft } = await expectExact({
      items: [{ sku: "H", priceMinor: 3_333, quantity: "0,5" }],
    });
    expect(draft.lines[0]?.lineTotalMinor).toBe(1_667);
  });

  it("09 · 0,01 × 0,99 = 0,0099 → 0,01", async () => {
    const { draft } = await expectExact({
      items: [{ sku: "T", priceMinor: 99, quantity: "0,01" }],
    });
    expect(draft.lines[0]?.lineTotalMinor).toBe(1);
  });

  it("10 · 99,99 × 1,01 = 100,9899 → 100,99", async () => {
    const { draft } = await expectExact({
      items: [{ sku: "L", priceMinor: 101, quantity: "99,99" }],
    });
    expect(draft.lines[0]?.lineTotalMinor).toBe(10_099);
  });

  it("11 · 0,10 × 0,05 = 0,005 → 0,01 (jumătate rotunjită în sus)", async () => {
    const { draft } = await expectExact({ items: [{ sku: "J", priceMinor: 5, quantity: "0,1" }] });
    expect(draft.lines[0]?.lineTotalMinor).toBe(1);
  });

  it("12 · cantitate mare: 1.250,75 mp × 49,99", async () => {
    await expectExact({
      items: [{ sku: "G", priceMinor: 4_999, quantity: "1250,75", symbol: "mp" }],
    });
  });

  it("13 · zece linii de 199,99: TVA = suma TVA-urilor pe linii", async () => {
    const items: Item[] = Array.from({ length: 10 }, (_, i) => ({
      sku: `S${i}`,
      priceMinor: 19_999,
      quantity: "1",
    }));
    const { draft } = await expectExact({ items });
    expect(draft.lines).toHaveLength(10);
  });

  it("14 · transport gratuit: nu apare nicio linie de transport", async () => {
    const { draft } = await expectExact({
      items: [{ sku: "F", priceMinor: 50_000, quantity: "1" }],
      shippingMinor: 0,
    });
    expect(draft.lines.every((l) => l.kind === "product")).toBe(true);
  });

  it("15 · transport de 1 ban (TVA 0)", async () => {
    await expectExact({
      items: [{ sku: "K", priceMinor: 1_000, quantity: "1" }],
      shippingMinor: 1,
    });
  });

  it("16 · preț promoțional activ", async () => {
    const { draft } = await expectExact({
      items: [{ sku: "P", priceMinor: 25_000, salePriceMinor: 19_900, quantity: "2" }],
    });
    expect(draft.lines[0]?.unitPriceMinor).toBe(19_900);
  });

  it("17 · discount de grup 5% fracționar: linia iese cantitatea 1, cu totalul EXACT încasat", async () => {
    const { draft, order } = await expectExact({
      items: [{ sku: "GR", priceMinor: 12_345, quantity: "6,09", symbol: "mp" }],
      group: { pricingType: "discount", discountBps: 500, stacksWithSalePrice: false },
    });
    expect(order.lines[0]?.lineTotalMinor).toBe(71_422); // 117,2775 × 6,09 = 714,2... → o singură rotunjire
    expect(draft.collapsedPositions).toEqual([1]);
    expect(draft.lines[0]).toMatchObject({ quantityTicks: 10_000n, lineTotalMinor: 71_422 });
    expect(draft.useStock).toBe(false); // linia comprimată nu se descarcă din gestiune
  });

  it("18 · cupon de 10% pe o linie de 3 bucăți", async () => {
    await expectExact({
      items: [{ sku: "CP", priceMinor: 1_999, quantity: "3" }],
      coupon: {
        code: "TEST10",
        discount: { type: "percent", bps: 1000 },
        notForDiscountedGroups: false,
        excludedProductIds: [],
        excludedCategoryIds: [],
        minSubtotalMinor: null,
        startsAt: null,
        endsAt: null,
      },
    });
  });

  it("19 · cupon fix repartizat pe două linii", async () => {
    await expectExact({
      items: [
        { sku: "C1", priceMinor: 3_333, quantity: "2" },
        { sku: "C2", priceMinor: 12_345, quantity: "1,5", symbol: "mp" },
      ],
      shippingMinor: 1_999,
      coupon: {
        code: "FIX50",
        discount: { type: "fixed", amountMinor: 5_000 },
        notForDiscountedGroups: false,
        excludedProductIds: [],
        excludedCategoryIds: [],
        minSubtotalMinor: null,
        startsAt: null,
        endsAt: null,
      },
    });
  });

  it("20 · cantitate cu 3 zecimale (0,333): factura o REFUZĂ, nu o rotunjește în tăcere", () => {
    const { order } = orderOf({
      items: [{ sku: "Z", priceMinor: 3_333, quantity: "0,333", symbol: "mp" }],
    });
    expect(() => buildInvoiceDraft(order, options)).toThrowError(InvoiceDraftError);
    try {
      buildInvoiceDraft(order, options);
    } catch (error) {
      expect((error as InvoiceDraftError).code).toBe("INVOICE_QUANTITY_PRECISION");
    }
    expect(isInvoiceQuantity(3_330n)).toBe(false);
    expect(isInvoiceQuantity(3_300n)).toBe(true);
  });
});

describe("garda: factura nu se emite cu alt număr decât cel încasat", () => {
  const base = () =>
    orderOf({
      items: [{ sku: "G", priceMinor: 12_345, quantity: "6,09", symbol: "mp" }],
      shippingMinor: 3_500,
    }).order;

  it("totalul comenzii diferă cu 1 ban de suma liniilor", () => {
    const order = { ...base(), totalMinor: base().totalMinor + 1 };
    expect(() => buildInvoiceDraft(order, options)).toThrowError(/nu coincid/);
  });
  it("TVA-ul comenzii diferă cu 1 ban de suma TVA-urilor pe linii", () => {
    const order = { ...base(), taxMinor: base().taxMinor - 1 };
    expect(() => buildInvoiceDraft(order, options)).toThrowError(/nu coincid/);
  });
  it("o reducere la nivel de comandă (neprevăzută încă) se refuză", () => {
    const order = { ...base(), discountMinor: 100 };
    expect(() => buildInvoiceDraft(order, options)).toThrowError(/reducere/);
  });
  it("TVA extras din total (1.819,16) ar fi fost respins de furnizorul simulat", async () => {
    const { order } = orderOf({
      items: [
        { sku: "MZ", priceMinor: 12_345, quantity: "6,09", symbol: "mp" },
        { sku: "BS", priceMinor: 12_000, quantity: "2", symbol: "sac" },
        { sku: "PP", priceMinor: 949_000, quantity: "1" },
      ],
    });
    const draft = buildInvoiceDraft(order, options);
    const wrong = draft.lines.map((l, i) => (i === 0 ? { ...l, taxMinor: l.taxMinor + 1 } : l));
    await expect(
      provider.issueInvoice({
        orderNumber: "X",
        client: {
          name: "x",
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
        lines: toDocLines(wrong),
        currency: "RON",
        issueDate: NOW,
        useStock: false,
        payment: null,
        fromProforma: null,
        sendEmail: false,
      }),
    ).rejects.toMatchObject({ code: "INVOICE_TOTAL_MISMATCH" });
  });
});

describe("storno parțial: suma stornourilor unei linii = totalul liniei, la 1 ban", () => {
  const source: StornoSourceLine = {
    orderLineId: "ol-1",
    sku: "MZ",
    title: "Mozaic",
    unitName: "mp",
    quantityTicks: 60_900n, // 6,09
    unitPriceMinor: 12_345,
    lineTotalMinor: 75_181,
    taxMinor: 13_048,
    taxRateBps: RATE,
  };
  const ZERO: StornoReturned = { quantityTicks: 0n, lineTotalMinor: 0, taxMinor: 0 };

  it("returnează 1 mp dintr-un singur pas: round(123,45 × 1) = 123,45", () => {
    const out = buildPartialStorno([source], new Map(), [
      { orderLineId: "ol-1", quantityTicks: 10_000n },
    ]);
    expect(out.lines[0]).toMatchObject({
      lineTotalMinor: 12_345,
      taxMinor: 2_143,
      quantityTicks: 10_000n,
    });
    expect(out.totalMinor).toBe(12_345);
  });

  it("trei returnări (2,00 + 1,50 + restul 2,59): suma e EXACT 751,81 și TVA 130,48", () => {
    const steps = [20_000n, 15_000n, 25_900n];
    let done: StornoReturned = ZERO;
    let total = 0;
    let tax = 0;
    for (const ticks of steps) {
      const out = buildPartialStorno([source], new Map([["ol-1", done]]), [
        { orderLineId: "ol-1", quantityTicks: ticks },
      ]);
      const line = out.lines[0];
      if (!line) throw new Error("fără linie");
      total += line.lineTotalMinor;
      tax += line.taxMinor;
      done = {
        quantityTicks: done.quantityTicks + ticks,
        lineTotalMinor: done.lineTotalMinor + line.lineTotalMinor,
        taxMinor: done.taxMinor + line.taxMinor,
      };
    }
    expect(total).toBe(75_181);
    expect(tax).toBe(13_048);
  });

  it("refuză: peste cantitatea rămasă, zero, 3 zecimale, linie străină, duplicat, listă goală", () => {
    const run =
      (qtyTicks: bigint, id = "ol-1") =>
      () =>
        buildPartialStorno([source], new Map(), [{ orderLineId: id, quantityTicks: qtyTicks }]);
    expect(run(70_000n)).toThrowError(/mai mult/);
    expect(run(0n)).toThrowError(/pozitivă/);
    expect(run(10_050n)).toThrowError(/2 zecimale/);
    expect(run(10_000n, "alta")).toThrowError(/nu face parte/);
    expect(() =>
      buildPartialStorno([source], new Map(), [
        { orderLineId: "ol-1", quantityTicks: 10_000n },
        { orderLineId: "ol-1", quantityTicks: 10_000n },
      ]),
    ).toThrowError(/de două ori/);
    expect(() => buildPartialStorno([source], new Map(), [])).toThrowError(/nicio linie/);
  });

  it("spre furnizor liniile se trimit cu semn schimbat, iar furnizorul simulat acceptă totalul negativ", async () => {
    const out = buildPartialStorno([source], new Map(), [
      { orderLineId: "ol-1", quantityTicks: 20_000n },
    ]);
    const negated = negateLines(out.lines);
    const issued = await provider.issueInvoice({
      orderNumber: "X",
      client: {
        name: "x",
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
      lines: toDocLines(negated),
      currency: "RON",
      issueDate: NOW,
      useStock: false,
      payment: null,
      fromProforma: null,
      sendEmail: false,
    });
    expect(issued.totalMinor).toBe(-24_690);
    expect(issued.taxMinor).toBe(-4_285);
  });
});

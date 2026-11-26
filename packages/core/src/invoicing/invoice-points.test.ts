import { describe, expect, it } from "vitest";
import { vatFromGross, type InvoiceRequest } from "@ecom/shared";
import { demoComputeTotals } from "@ecom/integrations";
import { discountShareForReturn } from "../pricing/points";
import {
  InvoiceDraftError,
  buildInvoiceDraft,
  buildPartialStorno,
  buildRemainderStorno,
  collapseInexactLines,
  negateLines,
  toDocLines,
  type DraftLine,
  type DraftOrder,
  type DraftOrderLine,
  type StornoEarlierLine,
  type StornoParentLine,
  type StornoReturned,
  type StornoSourceLine,
} from "./invoice-draft";

/**
 * Factura și stornourile unei comenzi cu puncte, `base_reduced` (Faza 15b): fiecare linie cu reducere are un rând de reducere
 * separat, cu TVA-ul extras din brutul LUI (decizia 2026-11-26). Cifrele sunt calculate de mână, în bani:
 * linia A: 2 × 50,00 lei, reducere din puncte 33,33 (TVA 5,78); linia B: 50,00 lei plătită integral cu puncte (TVA 8,68);
 * transport 20,00. De plată: 100 + 50 − 83,33 + 20 = 86,67 lei; TVA = 17,36 + 8,68 − 5,78 − 8,68 + 3,47 = 15,05 lei.
 */
const vat = (gross: number): number => vatFromGross(gross, 2100);
const labels = {
  shipping: "Transport",
  codFee: "Taxă de ramburs",
  serviceUnit: "buc",
  pointsDiscount: "Reducere din puncte de loialitate",
};
const options = { unitName: (s: string) => s, labels };

const orderLine = (
  id: string,
  units: number,
  unitPrice: number,
  discount: number,
): DraftOrderLine => ({
  id,
  sku: `SKU-${id}`,
  title: `Produs ${id}`,
  variantTitle: null,
  quantityTicks: BigInt(units) * 10_000n,
  unitSymbol: "buc",
  unitPriceMinor: unitPrice,
  lineTotalMinor: units * unitPrice,
  netMinor: units * unitPrice - vat(units * unitPrice),
  taxMinor: vat(units * unitPrice),
  taxRateBps: 2100,
  dischargeable: true,
  ...(discount > 0
    ? { loyaltyDiscountMinor: discount, loyaltyDiscountTaxMinor: vat(discount) }
    : {}),
});

function orderOf(lines: DraftOrderLine[], shipping = 2_000): DraftOrder {
  const discount = lines.reduce((s, l) => s + (l.loyaltyDiscountMinor ?? 0), 0);
  const discountTax = lines.reduce((s, l) => s + (l.loyaltyDiscountTaxMinor ?? 0), 0);
  return {
    lines,
    discountMinor: discount,
    shippingMinor: shipping,
    shippingTaxMinor: vat(shipping),
    codFeeMinor: 0,
    codFeeTaxMinor: 0,
    taxMinor: lines.reduce((s, l) => s + l.taxMinor, 0) - discountTax + vat(shipping),
    totalMinor: lines.reduce((s, l) => s + l.lineTotalMinor, 0) - discount + shipping,
    taxRateBps: 2100,
  };
}

const EXAMPLE = () => orderOf([orderLine("A", 2, 5_000, 3_333), orderLine("B", 1, 5_000, 5_000)]);

const brief = (lines: readonly DraftLine[]) =>
  lines.map((l) => [l.kind, l.orderLineId, l.lineTotalMinor, l.taxMinor]);

const signed = (lines: ReadonlyArray<{ kind: string; lineTotalMinor: number }>) =>
  lines.reduce((s, l) => s + (l.kind === "discount" ? -l.lineTotalMinor : l.lineTotalMinor), 0);

describe("factura cu puncte (base_reduced)", () => {
  it("produsele la prețul întreg, fiecare cu rândul lui de reducere; totalul și TVA-ul sunt ale comenzii", () => {
    const order = EXAMPLE();
    expect([order.totalMinor, order.taxMinor]).toEqual([8_667, 1_505]);
    const draft = buildInvoiceDraft(order, options);
    expect(brief(draft.lines)).toEqual([
      ["product", "A", 10_000, 1_736],
      ["discount", "A", 3_333, 578],
      ["product", "B", 5_000, 868],
      ["discount", "B", 5_000, 868],
      ["shipping", null, 2_000, 347],
    ]);
    expect([draft.totalMinor, draft.taxMinor]).toEqual([8_667, 1_505]);
    expect(draft.lines[1]).toMatchObject({
      sku: null,
      title: "Reducere din puncte de loialitate: Produs A",
      quantityTicks: 10_000n,
      unitPriceMinor: 3_333,
      netMinor: 3_333 - 578,
      dischargeStock: false,
    });
    // reducerea nu are stoc: bifa de descărcare rămâne a produselor
    expect(draft.useStock).toBe(true);
  });

  it("spre furnizor reducerea pleacă cu minus, iar simulatorul calculează exact aceleași sume pe fiecare rând", () => {
    const draft = buildInvoiceDraft(EXAMPLE(), options);
    const doc = toDocLines(draft.lines);
    expect(doc[1]).toMatchObject({
      kind: "discount",
      quantityTicks: -10_000n,
      unitPriceMinor: 3_333,
      lineTotalMinor: -3_333,
      taxMinor: -578,
    });
    expect(demoComputeTotals({ lines: doc } as unknown as InvoiceRequest)).toEqual({
      totalMinor: 8_667,
      taxMinor: 1_505,
    });
  });

  it("fără puncte factura e neschimbată (niciun rând de reducere)", () => {
    const draft = buildInvoiceDraft(orderOf([orderLine("A", 2, 5_000, 0)]), options);
    expect(brief(draft.lines)).toEqual([
      ["product", "A", 10_000, 1_736],
      ["shipping", null, 2_000, 347],
    ]);
  });

  it("o reducere la nivel de comandă care nu e a liniilor (alt fel de reducere) rămâne refuzată", () => {
    const order = { ...EXAMPLE(), discountMinor: 9_000 };
    expect(() => buildInvoiceDraft(order, options)).toThrow(InvoiceDraftError);
  });

  it("dacă liniile nu dau totalul comenzii, factura nu se construiește", () => {
    const order = { ...EXAMPLE(), taxMinor: 1_506 };
    expect(() => buildInvoiceDraft(order, options)).toThrow(/nu coincid cu comanda/);
  });
});

const sourceOf = (order: DraftOrder): StornoSourceLine[] =>
  order.lines.map((l) => ({
    orderLineId: l.id,
    sku: l.sku,
    title: l.title,
    unitName: l.unitSymbol,
    quantityTicks: l.quantityTicks,
    unitPriceMinor: l.unitPriceMinor,
    lineTotalMinor: l.lineTotalMinor,
    taxMinor: l.taxMinor,
    taxRateBps: l.taxRateBps,
    ...(l.loyaltyDiscountMinor ? { discountMinor: l.loyaltyDiscountMinor } : {}),
  }));

/** Ce s-a stornat deja din liniile de produs ale documentelor date (ca în `queuePartialStorno`). */
function returnedFrom(docs: ReadonlyArray<readonly DraftLine[]>): Map<string, StornoReturned> {
  const map = new Map<string, StornoReturned>();
  for (const line of docs.flat()) {
    if (line.kind !== "product" || !line.orderLineId) continue;
    const prev = map.get(line.orderLineId) ?? { quantityTicks: 0n, lineTotalMinor: 0, taxMinor: 0 };
    map.set(line.orderLineId, {
      quantityTicks: prev.quantityTicks + line.quantityTicks,
      lineTotalMinor: prev.lineTotalMinor + line.lineTotalMinor,
      taxMinor: prev.taxMinor + line.taxMinor,
    });
  }
  return map;
}

const parentOf = (lines: readonly DraftLine[]): StornoParentLine[] => lines.map((l) => ({ ...l }));
const earlierOf = (docs: ReadonlyArray<readonly DraftLine[]>): StornoEarlierLine[] =>
  docs.flat().map((l) => ({ ...l }));

describe("stornoul parțial și al restului pe o comandă cu puncte", () => {
  it("o bucată din linia A: produsul 50,00 minus partea lui de reducere 16,66 = 33,34 lei", () => {
    const order = EXAMPLE();
    const storno = buildPartialStorno(sourceOf(order), new Map(), [
      { orderLineId: "A", quantityTicks: 10_000n },
    ]);
    // 3333 × 5000 / 10000 = 1666,5 → 1666; TVA: 868 − 289 = 579
    expect(brief(storno.lines)).toEqual([
      ["product", "A", 5_000, 868],
      ["discount", "A", 1_666, 289],
    ]);
    expect([storno.totalMinor, storno.taxMinor]).toEqual([3_334, 579]);
  });

  it("linia plătită integral cu puncte: storno de 0 lei, cu ambele rânduri", () => {
    const storno = buildPartialStorno(sourceOf(EXAMPLE()), new Map(), [
      { orderLineId: "B", quantityTicks: 10_000n },
    ]);
    expect(brief(storno.lines)).toEqual([
      ["product", "B", 5_000, 868],
      ["discount", "B", 5_000, 868],
    ]);
    expect([storno.totalMinor, storno.taxMinor]).toEqual([0, 0]);
  });

  it("parțial, parțial, apoi restul: suma stornourilor = totalul facturii, la ban", () => {
    const order = EXAMPLE();
    const invoice = buildInvoiceDraft(order, options);
    const first = buildPartialStorno(sourceOf(order), new Map(), [
      { orderLineId: "A", quantityTicks: 10_000n },
    ]);
    const second = buildPartialStorno(sourceOf(order), returnedFrom([first.lines]), [
      { orderLineId: "B", quantityTicks: 10_000n },
    ]);
    const rest = buildRemainderStorno(
      parentOf(invoice.lines),
      earlierOf([first.lines, second.lines]),
    );
    expect(brief(rest.lines)).toEqual([
      ["product", "A", 5_000, 868],
      ["discount", "A", 1_667, 289],
      ["shipping", null, 2_000, 347],
    ]);
    expect(first.totalMinor + second.totalMinor + rest.totalMinor).toBe(invoice.totalMinor);
    expect(rest.totalMinor).toBe(5_333);
  });

  it("totalul fără stornouri parțiale: restul e factura întreagă", () => {
    const invoice = buildInvoiceDraft(EXAMPLE(), options);
    const rest = buildRemainderStorno(parentOf(invoice.lines), []);
    expect(brief(rest.lines)).toEqual(brief(invoice.lines));
    expect([rest.totalMinor, rest.taxMinor]).toEqual([invoice.totalMinor, invoice.taxMinor]);
  });

  it("toate liniile stornate în bucăți: restul e doar transportul", () => {
    const order = EXAMPLE();
    const invoice = buildInvoiceDraft(order, options);
    const all = buildPartialStorno(sourceOf(order), new Map(), [
      { orderLineId: "A", quantityTicks: 20_000n },
      { orderLineId: "B", quantityTicks: 10_000n },
    ]);
    const rest = buildRemainderStorno(parentOf(invoice.lines), earlierOf([all.lines]));
    expect(brief(rest.lines)).toEqual([["shipping", null, 2_000, 347]]);
    expect(all.totalMinor + rest.totalMinor).toBe(invoice.totalMinor);
  });

  it("restul trimis furnizorului: reducerea schimbă semnul de două ori și rămâne scăzută din storno", () => {
    const order = EXAMPLE();
    const invoice = buildInvoiceDraft(order, options);
    const rest = buildRemainderStorno(parentOf(invoice.lines), []);
    const doc = toDocLines(negateLines(collapseInexactLines(rest.lines, "buc")));
    expect(doc.map((l) => l.lineTotalMinor)).toEqual([-10_000, 3_333, -5_000, 5_000, -2_000]);
    expect(demoComputeTotals({ lines: doc } as unknown as InvoiceRequest).totalMinor).toBe(
      -invoice.totalMinor,
    );
  });

  it("aceeași parte de reducere ca la rambursare (o singură regulă)", () => {
    const storno = buildPartialStorno(sourceOf(EXAMPLE()), new Map(), [
      { orderLineId: "A", quantityTicks: 10_000n },
    ]);
    expect(storno.lines[1]!.lineTotalMinor).toBe(
      discountShareForReturn({
        lineDiscountMinor: 3_333,
        lineGrossMinor: 10_000,
        grossBeforeMinor: 0,
        grossNowMinor: 5_000,
      }),
    );
  });

  it("pe multe comenzi și ordini de returnare, suma stornourilor = totalul facturii și niciun document nu e negativ", () => {
    let seed = 7;
    const next = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_647;
      return seed % max;
    };
    for (let round = 0; round < 300; round += 1) {
      const lines = Array.from({ length: 1 + next(4) }, (_, index) => {
        const units = 1 + next(5);
        const price = 1 + next(20_000);
        const total = units * price;
        const discount = next(3) === 0 ? total : next(total + 1);
        return orderLine(`L${index}`, units, price, discount);
      });
      const order = orderOf(lines, next(3) === 0 ? 0 : 1 + next(5_000));
      const invoice = buildInvoiceDraft(order, options);
      const docs: DraftLine[][] = [];
      let reversed = 0;
      const left = new Map(lines.map((l) => [l.id, Number(l.quantityTicks / 10_000n)]));
      for (let step = 0; step < 6; step += 1) {
        const open = [...left].filter(([, units]) => units > 0);
        if (open.length === 0 || next(4) === 0) break;
        const [id, units] = open[next(open.length)]!;
        const take = 1 + next(units);
        const storno = buildPartialStorno(sourceOf(order), returnedFrom(docs), [
          { orderLineId: id, quantityTicks: BigInt(take) * 10_000n },
        ]);
        expect(storno.totalMinor).toBeGreaterThanOrEqual(0);
        expect(storno.taxMinor).toBeGreaterThanOrEqual(0);
        expect(storno.taxMinor).toBeLessThanOrEqual(storno.totalMinor);
        expect(signed(storno.lines)).toBe(storno.totalMinor);
        reversed += storno.totalMinor;
        left.set(id, units - take);
        docs.push(storno.lines);
      }
      const rest = buildRemainderStorno(parentOf(invoice.lines), earlierOf(docs));
      expect(rest.totalMinor).toBeGreaterThanOrEqual(0);
      expect(rest.taxMinor).toBeLessThanOrEqual(rest.totalMinor);
      expect(reversed + rest.totalMinor).toBe(invoice.totalMinor);
    }
  });

  it("un rând de reducere stornat peste valoarea lui e refuzat", () => {
    const invoice = buildInvoiceDraft(EXAMPLE(), options);
    const forged: StornoEarlierLine[] = [
      {
        kind: "discount",
        orderLineId: "A",
        quantityTicks: 10_000n,
        lineTotalMinor: 3_334,
        taxMinor: 578,
      },
    ];
    expect(() => buildRemainderStorno(parentOf(invoice.lines), forged)).toThrow(InvoiceDraftError);
  });
});

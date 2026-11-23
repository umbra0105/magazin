import { describe, expect, it } from "vitest";
import { buildInvoiceDraft, type DraftOrder, type DraftOrderLine } from "./invoice-draft";

/**
 * Faza 14b, D8: o linie digitală intră pe factură ca orice linie (cu TVA-ul ei, în total), dar fără descărcare de gestiune și fără
 * stoc. SmartBill are O SINGURĂ bifă `useStock` pe factură: liniile digitale NU o opresc pentru produsele fizice din aceeași
 * comandă (altfel un curs în coș ar anula descărcarea șurubelniței), iar o comandă DOAR digitală nu cere descărcare deloc.
 */
const RATE = 2100;

function line(patch: Partial<DraftOrderLine> & { id: string }): DraftOrderLine {
  return {
    sku: patch.id,
    title: patch.id,
    variantTitle: null,
    quantityTicks: 10_000n,
    unitSymbol: "buc",
    unitPriceMinor: 10_000,
    lineTotalMinor: 10_000,
    netMinor: 8_264,
    taxMinor: 1_736,
    taxRateBps: RATE,
    dischargeable: false,
    ...patch,
  };
}

function order(lines: DraftOrderLine[], shippingMinor = 0): DraftOrder {
  const sum = (pick: (l: DraftOrderLine) => number) => lines.reduce((acc, l) => acc + pick(l), 0);
  const shippingTax = shippingMinor === 0 ? 0 : 365;
  return {
    lines,
    discountMinor: 0,
    shippingMinor,
    shippingTaxMinor: shippingTax,
    codFeeMinor: 0,
    codFeeTaxMinor: 0,
    taxMinor: sum((l) => l.taxMinor) + shippingTax,
    totalMinor: sum((l) => l.lineTotalMinor) + shippingMinor,
    taxRateBps: RATE,
  };
}

const options = {
  unitName: (symbol: string) => symbol,
  labels: { shipping: "Transport", codFee: "Taxă de ramburs", serviceUnit: "buc" },
};

describe("liniile digitale pe factură (D8)", () => {
  it("comandă mixtă: produsul fizic gestionat se descarcă, cursul digital nu o împiedică", () => {
    const draft = buildInvoiceDraft(
      order([
        line({ id: "fizic", dischargeable: true }),
        line({ id: "curs", digital: true, dischargeable: false }),
      ]),
      options,
    );
    expect(draft.useStock).toBe(true);
    const byId = new Map(draft.lines.map((l) => [l.orderLineId, l]));
    expect(byId.get("fizic")?.dischargeStock).toBe(true);
    expect(byId.get("curs")?.dischargeStock).toBe(false);
    expect(draft.totalMinor).toBe(20_000);
    expect(draft.taxMinor).toBe(3_472);
  });

  it("comandă mixtă cu un produs fizic negestionat: tot fără descărcare (regula Fazei 13 rămâne)", () => {
    const draft = buildInvoiceDraft(
      order([line({ id: "fizic", dischargeable: false }), line({ id: "curs", digital: true })]),
      options,
    );
    expect(draft.useStock).toBe(false);
  });

  it("comandă doar digitală: fără descărcare de gestiune și fără transport pe factură", () => {
    const draft = buildInvoiceDraft(
      order([line({ id: "curs-1", digital: true }), line({ id: "curs-2", digital: true })]),
      options,
    );
    expect(draft.useStock).toBe(false);
    expect(draft.lines.every((l) => l.kind === "product" && !l.dischargeStock)).toBe(true);
    expect(draft.lines.some((l) => l.kind === "shipping")).toBe(false);
    expect(draft.totalMinor).toBe(20_000);
  });

  it("comandă mixtă cu transport: transportul rămâne pe linia lui, totalul și TVA-ul se închid la ban", () => {
    const draft = buildInvoiceDraft(
      order(
        [line({ id: "fizic", dischargeable: true }), line({ id: "curs", digital: true })],
        2_500,
      ),
      options,
    );
    expect(draft.useStock).toBe(true);
    expect(draft.lines.filter((l) => l.kind === "shipping")).toHaveLength(1);
    expect(draft.totalMinor).toBe(22_500);
  });

  it("o linie digitală NU se poate descărca din gestiune nici dacă i s-ar fi angajat stoc din greșeală", () => {
    const draft = buildInvoiceDraft(
      order([line({ id: "curs", digital: true, dischargeable: true })]),
      options,
    );
    const curs = draft.lines.find((l) => l.orderLineId === "curs");
    expect(curs?.dischargeStock).toBe(false);
    expect(draft.useStock).toBe(false);
  });
});

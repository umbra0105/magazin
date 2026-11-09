import { countLowStock, type LowStockCounts, type StockOverviewRow } from "@ecom/core";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/messages";
import { stockHealthView } from "./stock-health";

/**
 * Bara de stoc segmentată (Panou și Stoc): din numărătorile «Stoc mic» și numărul de variante gestionate. Patru segmente cu
 * EXACT cuvintele și cifrele cardurilor din vederea «Stoc mic»: În stoc, Sub prag, Doar rest nevandabil, Epuizat.
 */

const counts = (over: Partial<Parameters<typeof stockHealthView>[0]> = {}) => ({
  outOfStock: 3,
  remainderOnly: 1,
  belowThreshold: 2,
  ...over,
});
const none = { outOfStock: 0, remainderOnly: 0, belowThreshold: 0 };
const value = (view: ReturnType<typeof stockHealthView>, key: string) =>
  view?.segments.find((segment) => segment.key === key)?.value;

describe("stockHealthView", () => {
  it("patru segmente: în stoc = gestionate − la stoc mic; sub prag, doar rest nevandabil și epuizat, fiecare cu cifra lui", () => {
    const view = stockHealthView(counts(), 20);
    expect(view?.segments).toEqual([
      { key: "in-stock", label: "În stoc", value: 14, tone: "ok" },
      { key: "below_threshold", label: "Sub prag", value: 2, tone: "low" },
      { key: "remainder_only", label: "Doar rest nevandabil", value: 1, tone: "neutral" },
      { key: "out_of_stock", label: "Epuizat", value: 3, tone: "out" },
    ]);
    expect(view?.label).toBe("Starea stocului");
  });

  it("legenda nu mai conține eticheta «Stoc mic» (e numele tab-ului și al cardului din Panou, nu al unui segment)", () => {
    const labels = stockHealthView(counts(), 20)?.segments.map((segment) => segment.label) ?? [];
    expect(labels).not.toContain("Stoc mic");
    expect(labels).toHaveLength(4);
  });

  it("aceleași cuvinte ca cele trei carduri din vederea «Stoc mic» (o singură sursă de texte)", () => {
    const cards = getMessages().admin.inventory.lowStock.summary;
    const labels = Object.fromEntries(
      (stockHealthView(counts(), 20)?.segments ?? []).map((segment) => [
        segment.key,
        segment.label,
      ]),
    );
    expect(labels["out_of_stock"]).toBe(cards.out_of_stock);
    expect(labels["remainder_only"]).toBe(cards.remainder_only);
    expect(labels["below_threshold"]).toBe(cards.below_threshold);
  });

  it("„doar rest nevandabil” are ton neutru (din tokenii existenți), diferit de cel al celorlalte stări", () => {
    const tones = stockHealthView(counts(), 20)?.segments.map((segment) => segment.tone) ?? [];
    expect(tones).toEqual(["ok", "low", "neutral", "out"]);
    expect(new Set(tones).size).toBe(4);
  });

  it("invariant: cele patru segmente însumează exact variantele gestionate (nimic numărat de două ori sau pierdut)", () => {
    for (const [c, managed] of [
      [counts(), 20],
      [counts(none), 5],
      [counts({ outOfStock: 3, remainderOnly: 0, belowThreshold: 0 }), 3],
      [counts({ outOfStock: 0, remainderOnly: 4, belowThreshold: 0 }), 4],
    ] as const) {
      const view = stockHealthView(c, managed);
      expect(
        view?.segments.reduce((sum, seg) => sum + seg.value, 0),
        JSON.stringify(c),
      ).toBe(managed);
    }
  });

  it("invariant: sub prag + doar rest nevandabil + epuizat = numărul din tab-ul «Stoc mic (N)» și din cardul Panoului", () => {
    const c: LowStockCounts = { total: 6, outOfStock: 3, remainderOnly: 1, belowThreshold: 2 };
    const view = stockHealthView(c, 20);
    const lowStockSegments =
      (value(view, "below_threshold") ?? 0) +
      (value(view, "remainder_only") ?? 0) +
      (value(view, "out_of_stock") ?? 0);
    expect(lowStockSegments).toBe(c.total);
    // și «în stoc» e restul față de același total
    expect(value(view, "in-stock")).toBe(20 - c.total);
  });

  it("numerele vin din rândurile reale: countLowStock → bară, cu aceeași grupare ca tab-ul (fiecare variantă într-un singur segment)", () => {
    const row = (reason: StockOverviewRow["lowStockReason"]) =>
      ({ kind: "managed", lowStockReason: reason }) as StockOverviewRow;
    const rows = [
      row("out_of_stock"),
      row("out_of_stock"),
      row("remainder_only"),
      row("below_threshold"),
      row("below_threshold"),
      row("below_threshold"),
      row(null),
      row(null),
    ];
    const lowStock = countLowStock(rows);
    const view = stockHealthView(lowStock, rows.length);
    expect(value(view, "out_of_stock")).toBe(2);
    expect(value(view, "remainder_only")).toBe(1);
    expect(value(view, "below_threshold")).toBe(3);
    expect(value(view, "in-stock")).toBe(2);
    expect(lowStock.total).toBe(6);
  });

  it("legenda spune pe câte variante gestionate se bazează, cu plural românesc", () => {
    const caption = (n: number) => stockHealthView(counts(none), n)?.caption;
    expect(caption(1)).toBe("1 variantă gestionată");
    expect(caption(2)).toBe("2 variante gestionate");
    expect(caption(19)).toBe("19 variante gestionate");
    expect(caption(20)).toBe("20 de variante gestionate");
    expect(caption(1234)).toBe("1.234 de variante gestionate");
  });

  it("fără variante gestionate nu există bară (nimic de arătat, nu o bară goală)", () => {
    expect(stockHealthView(counts(none), 0)).toBeNull();
  });

  it("numere incoerente (mai multe la stoc mic decât gestionate) nu dau «în stoc» negativ", () => {
    expect(stockHealthView(counts(), 4)?.segments[0]?.value).toBe(0);
  });
});

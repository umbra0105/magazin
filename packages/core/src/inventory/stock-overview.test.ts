import { describe, expect, it } from "vitest";
import { formatQuantity, parseQuantity, saleStepToInt, type Quantity } from "@ecom/shared";
import {
  buildStockOverviewRow,
  groupStockRows,
  type StockOverviewSource,
  type StockOverviewSettings,
} from "./stock-overview";

/**
 * Faza 5, punctul 8: modelul de afișare al ecranului de stoc (funcții PURE). Cele 6 produse-model din plan sunt cazurile
 * principale; verificăm cantitățile, pașii, restul nevandabil și starea fiecărei ramuri (gestionat, negestionat, digital).
 */

const q = (text: string): Quantity => parseQuantity(text);
const settings: StockOverviewSettings = { defaultLowStockSteps: 2, defaultLeadTimeDays: 14 };

function source(
  overrides: Partial<StockOverviewSource> & { step?: string; physical?: string | null },
): StockOverviewSource {
  const { step, physical, ...rest } = overrides;
  return {
    variantId: "v1",
    sku: "SKU-1",
    variantLabel: null,
    productId: "p1",
    productTitle: "Produs",
    productSlug: "produs",
    productType: "physical",
    manageStock: true,
    stockStatus: "instock",
    allowBackorder: false,
    unit: { code: "mp", symbol: "mp", decimals: 2 },
    saleStep: saleStepToInt(q(step ?? "1")),
    minSteps: null,
    item:
      physical === null
        ? null
        : {
            physical: q(physical ?? "0"),
            physicalAsOf: null,
            committed: 0n as Quantity,
            reserved: 0n as Quantity,
            safetyBuffer: 0n as Quantity,
            lowStockSteps: null,
          },
    leadTime: { productDays: null, brandDays: null },
    ...rest,
  };
}

const show = (value: Quantity | null): string | null =>
  value === null ? null : formatQuantity(value);

describe("cele 6 produse-model (disponibil în pași și rest nevandabil)", () => {
  const cases: Array<{
    name: string;
    step: string;
    unit: { code: string; symbol: string; decimals: number };
    physical: string;
    steps: string;
    remainder: string;
    /** Implicit «În stoc»; 2 pași sunt exact la pragul «Stoc limitat» */
    state?: "limited";
  }> = [
    {
      name: "Țeavă PVC-U 100 ml, pas 2,5",
      step: "2,5",
      unit: { code: "ml", symbol: "ml", decimals: 1 },
      physical: "100",
      steps: "40",
      remainder: "0",
    },
    {
      name: "Liner 100 mp, rola de 41,25",
      step: "41,25",
      unit: { code: "mp", symbol: "mp", decimals: 2 },
      physical: "100",
      steps: "2",
      remainder: "17,5",
      state: "limited",
    },
    {
      name: "Bisulfat 80 kg, sacul de 25",
      step: "25",
      unit: { code: "kg", symbol: "kg", decimals: 0 },
      physical: "80",
      steps: "3",
      remainder: "5",
    },
    {
      name: "Furtun 300 ml, pas 1",
      step: "1",
      unit: { code: "ml", symbol: "ml", decimals: 0 },
      physical: "300",
      steps: "300",
      remainder: "0",
    },
    {
      name: "Mozaic 10 mp, cutia de 2,03",
      step: "2,03",
      unit: { code: "mp", symbol: "mp", decimals: 2 },
      physical: "10",
      steps: "4",
      remainder: "1,88",
    },
    {
      name: "Abachi 1,5 ml, 10 ml → 6 pași",
      step: "1,5",
      unit: { code: "ml", symbol: "ml", decimals: 1 },
      physical: "10",
      steps: "6",
      remainder: "1",
    },
    {
      name: "Abachi 1,8 ml, 10 ml → 5 pași",
      step: "1,8",
      unit: { code: "ml", symbol: "ml", decimals: 1 },
      physical: "10",
      steps: "5",
      remainder: "1",
    },
    {
      name: "Abachi 2,1 ml, 10 ml → 4 pași",
      step: "2,1",
      unit: { code: "ml", symbol: "ml", decimals: 1 },
      physical: "10",
      steps: "4",
      remainder: "1,6",
    },
    {
      name: "Abachi 2,6 ml, 10 ml → 3 pași",
      step: "2,6",
      unit: { code: "ml", symbol: "ml", decimals: 1 },
      physical: "10",
      steps: "3",
      remainder: "2,2",
    },
  ];
  it.each(cases)("$name", ({ step, unit, physical, steps, remainder, state }) => {
    const row = buildStockOverviewRow(source({ step, unit, physical }), settings);
    expect(row.kind).toBe("managed");
    expect(show(row.physical)).toBe(physical);
    expect(show(row.available)).toBe(physical);
    expect(row.availableSteps?.toString()).toBe(steps);
    expect(show(row.remainder)).toBe(remainder);
    expect(row.state).toBe(state ?? "in_stock");
  });

  it("angajatul și rezervatul scad din disponibil; pașii și restul se calculează din ce rămâne", () => {
    const base = source({ step: "41,25", physical: "200" });
    const row = buildStockOverviewRow(
      {
        ...base,
        item: { ...base.item!, committed: q("41,25"), reserved: q("20") },
      },
      settings,
    );
    expect(show(row.physical)).toBe("200");
    expect(show(row.committed)).toBe("41,25");
    expect(show(row.reserved)).toBe("20");
    expect(show(row.available)).toBe("138,75");
    expect(row.availableSteps?.toString()).toBe("3");
    expect(show(row.remainder)).toBe("15");
  });

  it("tamponul de siguranță scade din vandabil, nu din disponibil", () => {
    const base = source({
      step: "1",
      physical: "10",
      unit: { code: "buc", symbol: "buc", decimals: 0 },
    });
    const row = buildStockOverviewRow(
      { ...base, item: { ...base.item!, safetyBuffer: q("3") } },
      settings,
    );
    expect(show(row.available)).toBe("10");
    expect(show(row.sellable)).toBe("7");
    expect(row.availableSteps?.toString()).toBe("7");
    expect(show(row.safetyBuffer)).toBe("3");
  });
});

describe("stări vizibile și semnale", () => {
  const unit = { code: "buc", symbol: "buc", decimals: 0 };

  it("În stoc / Stoc limitat (≤ 2 pași) / Indisponibil (0)", () => {
    expect(buildStockOverviewRow(source({ unit, physical: "10" }), settings).state).toBe(
      "in_stock",
    );
    const limited = buildStockOverviewRow(source({ unit, physical: "2" }), settings);
    expect(limited.state).toBe("limited");
    expect(limited.lowStock).toBe(true);
    const out = buildStockOverviewRow(source({ unit, physical: "0" }), settings);
    expect(out.state).toBe("unavailable");
    expect(out.lowStock).toBe(true);
  });

  it("pragul variantei bate pragul global", () => {
    const base = source({ unit, physical: "5" });
    const row = buildStockOverviewRow(
      { ...base, item: { ...base.item!, lowStockSteps: 5 } },
      settings,
    );
    expect(row.state).toBe("limited");
  });

  it("a rămas doar un rest nevandabil (sub un pas): indisponibil, dar semnalat", () => {
    const row = buildStockOverviewRow(source({ step: "41,25", physical: "17,5" }), settings);
    expect(row.state).toBe("unavailable");
    expect(row.remainderOnly).toBe(true);
    expect(show(row.remainder)).toBe("17,5");
  });

  it("hibrid epuizat devine «La comandă», cu termenul produs → brand → global", () => {
    const hybrid = source({ unit, physical: "0", allowBackorder: true });
    expect(buildStockOverviewRow(hybrid, settings)).toMatchObject({
      state: "on_order",
      leadTimeDays: 14,
    });
    expect(
      buildStockOverviewRow({ ...hybrid, leadTime: { productDays: null, brandDays: 7 } }, settings)
        .leadTimeDays,
    ).toBe(7);
    expect(
      buildStockOverviewRow({ ...hybrid, leadTime: { productDays: 3, brandDays: 7 } }, settings)
        .leadTimeDays,
    ).toBe(3);
    expect(
      buildStockOverviewRow({ ...hybrid, leadTime: { productDays: 0, brandDays: 7 } }, settings)
        .leadTimeDays,
    ).toBe(0);
  });

  it("gestionat fără rând de stoc: «neinventariat», cantități zero, indisponibil", () => {
    const row = buildStockOverviewRow(source({ unit, physical: null }), settings);
    expect(row).toMatchObject({ kind: "managed", inventoried: false, state: "unavailable" });
    expect(show(row.physical)).toBe("0");
    expect(show(row.available)).toBe("0");
    expect(row.physicalAsOf).toBeNull();
  });

  it("«valabilă la» vine de la rândul de stoc", () => {
    const base = source({ unit, physical: "4" });
    const at = new Date("2026-10-23T08:00:00Z");
    const row = buildStockOverviewRow(
      { ...base, item: { ...base.item!, physicalAsOf: at } },
      settings,
    );
    expect(row.physicalAsOf).toEqual(at);
    expect(row.inventoried).toBe(true);
  });
});

describe("negestionat și digital: fără cantități", () => {
  const unit = { code: "buc", symbol: "buc", decimals: 0 };

  it("negestionat: doar starea din dropdown, orice rând de stoc rămas se ignoră", () => {
    for (const [status, state] of [
      ["instock", "in_stock"],
      ["outofstock", "unavailable"],
      ["onbackorder", "on_order"],
    ] as const) {
      const row = buildStockOverviewRow(
        source({ unit, manageStock: false, stockStatus: status, physical: "50" }),
        settings,
      );
      expect(row).toMatchObject({ kind: "unmanaged", state, stockStatus: status });
      expect(row.physical).toBeNull();
      expect(row.available).toBeNull();
      expect(row.availableSteps).toBeNull();
      expect(row.remainder).toBeNull();
      expect(row.lowStock).toBe(false);
    }
  });

  it("«La comandă» la negestionat arată termenul", () => {
    const row = buildStockOverviewRow(
      source({
        unit,
        manageStock: false,
        stockStatus: "onbackorder",
        physical: null,
        leadTime: { productDays: 10, brandDays: null },
      }),
      settings,
    );
    expect(row.leadTimeDays).toBe(10);
  });

  it("digital: mereu în stoc, fără cantități, indiferent de bifa de gestiune", () => {
    const row = buildStockOverviewRow(
      source({ unit, productType: "digital", manageStock: true, physical: "0" }),
      settings,
    );
    expect(row).toMatchObject({ kind: "digital", state: "in_stock" });
    expect(row.physical).toBeNull();
    expect(row.available).toBeNull();
  });
});

describe("suma pe produs (D9): doar dacă variantele gestionate au aceeași unitate", () => {
  const mp = { code: "mp", symbol: "mp", decimals: 2 };
  const ml = { code: "ml", symbol: "ml", decimals: 1 };
  const variant = (
    id: string,
    physical: string | null,
    unit = mp,
    extra: Partial<StockOverviewSource> = {},
  ) =>
    buildStockOverviewRow(
      source({
        variantId: id,
        sku: id,
        productId: "p-liner",
        productTitle: "Liner",
        unit,
        physical,
        ...extra,
      }),
      settings,
    );

  it("aceeași unitate → sumă pe fizic, angajat, rezervat, disponibil", () => {
    const groups = groupStockRows([variant("a", "100"), variant("b", "50,5")]);
    expect(groups).toHaveLength(1);
    const total = groups[0]?.total;
    expect(total).toMatchObject({ unit: { code: "mp" } });
    expect(show(total?.physical ?? null)).toBe("150,5");
    expect(show(total?.available ?? null)).toBe("150,5");
    expect(groups[0]?.totalProblem).toBeNull();
  });

  it("unități diferite → nu se însumează", () => {
    const groups = groupStockRows([variant("a", "100"), variant("b", "50", ml)]);
    expect(groups[0]?.total).toBeNull();
    expect(groups[0]?.totalProblem).toBe("different_units");
  });

  it("variantele negestionate sau digitale nu intră în sumă; fără gestionate nu există sumă", () => {
    const unmanaged = variant("n", null, mp, { manageStock: false });
    const withUnmanaged = groupStockRows([variant("a", "10"), variant("b", "5"), unmanaged]);
    expect(show(withUnmanaged[0]?.total?.physical ?? null)).toBe("15");
    const none = groupStockRows([unmanaged, variant("d", null, mp, { productType: "digital" })]);
    expect(none[0]?.total).toBeNull();
    expect(none[0]?.totalProblem).toBe("no_managed");
  });

  it("un produs cu o singură variantă nu are rând de total", () => {
    const groups = groupStockRows([variant("a", "100")]);
    expect(groups[0]?.total).toBeNull();
    expect(groups[0]?.totalProblem).toBeNull();
  });

  it("grupează pe produs în ordinea primei apariții și păstrează ordinea variantelor", () => {
    const other = buildStockOverviewRow(
      source({ variantId: "z", productId: "p-alt", productTitle: "Alt produs", physical: "1" }),
      settings,
    );
    const groups = groupStockRows([variant("a", "1"), other, variant("b", "2")]);
    expect(groups.map((g) => g.productId)).toEqual(["p-liner", "p-alt"]);
    expect(groups[0]?.rows.map((r) => r.variantId)).toEqual(["a", "b"]);
  });

  it("o variantă neinventariată intră în sumă ca zero", () => {
    const groups = groupStockRows([variant("a", "10"), variant("b", null)]);
    expect(show(groups[0]?.total?.physical ?? null)).toBe("10");
  });
});

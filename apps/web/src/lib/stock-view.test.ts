import { describe, expect, it } from "vitest";
import { parseQuantity, parseSignedDelta, saleStepToInt, type Quantity } from "@ecom/shared";
import {
  buildStockOverviewRow,
  summarizeProductRows,
  type StockOverviewSource,
  type WarehouseFreshness,
} from "@ecom/core";
import {
  availabilityView,
  daysText,
  deltaText,
  kindLabel,
  quantityText,
  snapshotView,
  stateView,
  lowStockReasonView,
  stepsText,
  summaryView,
  thresholdTarget,
  thresholdView,
  warningText,
} from "./stock-view";

/** Textele ecranului de stoc (română): plural, cantități cu unitate, stare, banner-ul «stoc verificat la …», avertismente. */

const q = (text: string): Quantity => parseQuantity(text);
const settings = { defaultLowStockSteps: 2, defaultLeadTimeDays: 14 };
const TZ = "Europe/Bucharest";

function row(
  over: Partial<StockOverviewSource> & { step?: string; physical?: string | null } = {},
) {
  const { step, physical, ...rest } = over;
  const base: StockOverviewSource = {
    variantId: "v",
    sku: "S",
    variantLabel: null,
    productId: "p",
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
  return buildStockOverviewRow(base, settings);
}

describe("pașii la plural românesc", () => {
  it.each([
    [0n, "0 pași"],
    [1n, "1 pas"],
    [2n, "2 pași"],
    [19n, "19 pași"],
    [20n, "20 de pași"],
    [21n, "21 de pași"],
    [100n, "100 de pași"],
    [101n, "101 pași"],
    [119n, "119 pași"],
    [120n, "120 de pași"],
    [300n, "300 de pași"],
    [1000n, "1000 de pași"],
  ])("%s → %s", (steps, text) => {
    expect(stepsText(steps)).toBe(text);
  });
});

describe("zilele la plural românesc", () => {
  it.each([
    [0, "0 zile"],
    [1, "1 zi"],
    [2, "2 zile"],
    [14, "14 zile"],
    [19, "19 zile"],
    [20, "20 de zile"],
    [365, "365 de zile"],
  ])("%s → %s", (days, text) => {
    expect(daysText(days)).toBe(text);
  });
});

describe("cantități cu unitate", () => {
  it("virgulă zecimală, zerourile de la coadă tăiate, simbolul unității după", () => {
    expect(quantityText(q("100"), { symbol: "mp" })).toBe("100 mp");
    expect(quantityText(q("17,5"), { symbol: "mp" })).toBe("17,5 mp");
    expect(quantityText(q("2,0300"), { symbol: "mp" })).toBe("2,03 mp");
    expect(quantityText(q("0"), { symbol: "buc" })).toBe("0 buc");
  });

  it("variația cu semn", () => {
    expect(deltaText(parseSignedDelta("2"), { symbol: "buc" })).toBe("+2 buc");
    expect(deltaText(parseSignedDelta("-2,5"), { symbol: "ml" })).toBe("-2,5 ml");
    expect(deltaText(parseSignedDelta("0"), { symbol: "ml" })).toBe("0 ml");
  });
});

describe("disponibilul în unitate și în pași, cu restul nevandabil", () => {
  it("liner 100 mp = 2 pași · rest 17,5 mp", () => {
    const view = availabilityView(row({ step: "41,25", physical: "100" }));
    expect(view).toEqual({ quantity: "100 mp", steps: "2 pași", remainder: "17,5 mp" });
  });

  it("bisulfat 80 kg = 3 pași · rest 5 kg; mozaic 10 mp = 4 pași · rest 1,88 mp", () => {
    expect(
      availabilityView(
        row({ step: "25", physical: "80", unit: { code: "kg", symbol: "kg", decimals: 0 } }),
      ),
    ).toEqual({ quantity: "80 kg", steps: "3 pași", remainder: "5 kg" });
    expect(availabilityView(row({ step: "2,03", physical: "10" }))).toEqual({
      quantity: "10 mp",
      steps: "4 pași",
      remainder: "1,88 mp",
    });
  });

  it("fără rest nevandabil → remainder null", () => {
    expect(
      availabilityView(
        row({ step: "2,5", physical: "100", unit: { code: "ml", symbol: "ml", decimals: 1 } }),
      ),
    ).toEqual({
      quantity: "100 ml",
      steps: "40 de pași",
      remainder: null,
    });
  });

  it("negestionat și digital nu au disponibil", () => {
    expect(availabilityView(row({ manageStock: false, physical: null }))).toBeNull();
    expect(availabilityView(row({ productType: "digital", physical: null }))).toBeNull();
  });
});

describe("starea vizibilă și tipul", () => {
  it("În stoc / Stoc limitat (cu «mai sunt N») / Indisponibil", () => {
    expect(stateView(row({ physical: "50" }))).toMatchObject({ label: "În stoc", tone: "ok" });
    expect(stateView(row({ physical: "2" }))).toMatchObject({
      label: "Stoc limitat",
      tone: "warn",
      detail: "mai sunt 2 pași",
    });
    expect(stateView(row({ physical: "0" }))).toMatchObject({
      label: "Indisponibil",
      tone: "danger",
    });
  });

  it("«La comandă» cu termenul", () => {
    expect(stateView(row({ physical: "0", allowBackorder: true }))).toMatchObject({
      label: "La comandă",
      tone: "info",
      detail: "termen 14 zile",
    });
  });

  it("a rămas doar un rest nevandabil: indisponibil, cu explicație", () => {
    expect(stateView(row({ step: "41,25", physical: "17,5" }))).toMatchObject({
      label: "Indisponibil",
      detail: "a rămas doar un rest nevandabil",
    });
  });

  it("negestionat arată starea din dropdown; digital «În stoc»", () => {
    expect(
      stateView(row({ manageStock: false, stockStatus: "outofstock", physical: null })),
    ).toMatchObject({ label: "Stoc epuizat", tone: "danger" });
    expect(
      stateView(row({ manageStock: false, stockStatus: "instock", physical: null })),
    ).toMatchObject({ label: "În stoc", tone: "ok" });
    expect(
      stateView(row({ manageStock: false, stockStatus: "onbackorder", physical: null })),
    ).toMatchObject({ label: "La comandă", tone: "info" });
    expect(stateView(row({ productType: "digital", physical: null }))).toMatchObject({
      label: "În stoc",
      tone: "ok",
    });
  });

  it("eticheta tipului", () => {
    expect(kindLabel(row({ physical: "5" }))).toBe("Gestionat");
    expect(kindLabel(row({ physical: null }))).toBe("Neinventariat");
    expect(kindLabel(row({ manageStock: false, physical: null }))).toBe(
      "Negestionat până la inventar",
    );
    expect(kindLabel(row({ productType: "digital", physical: null }))).toBe("Digital, fără stoc");
  });
});

describe("banner-ul «Sincronizare SmartBill»", () => {
  const at = new Date("2026-10-23T07:00:00Z"); // 10:00 la București
  const base: WarehouseFreshness = {
    warehouseId: "w",
    name: "Depozit principal",
    status: "fresh",
    takenAt: at,
    ageHours: 3,
  };

  it("la zi: «Actualizat acum …», ton liniștit", () => {
    expect(snapshotView(base)).toEqual({ tone: "ok", text: "Actualizat acum 3 ore." });
  });

  it("neactualizat: roșu, cu vârsta și avertismentul", () => {
    const view = snapshotView({ ...base, status: "stale", ageHours: 54 });
    expect(view.tone).toBe("danger");
    expect(view.text).toBe("Ultima actualizare: acum 2 zile. Cantitățile pot fi depășite.");
  });

  it("neimportat: roșu", () => {
    const view = snapshotView({ ...base, status: "never", takenAt: null, ageHours: null });
    expect(view).toEqual({
      tone: "danger",
      text: "Stocul nu a fost încă importat din SmartBill. Cantitățile afișate sunt cele introduse manual.",
    });
  });

  it("depozit fără stoc gestionat: doar o informare", () => {
    expect(snapshotView(null)).toEqual({
      tone: "info",
      text: "Nu există încă stoc gestionat în acest depozit.",
    });
  });

  it("vârsta: sub o oră, ore până la 48 h, apoi zile, cu plural românesc", () => {
    const age = (hours: number) => snapshotView({ ...base, ageHours: hours }).text;
    expect(age(0.4)).toBe("Actualizat acum mai puțin de o oră.");
    expect(age(1)).toBe("Actualizat acum 1 oră.");
    expect(age(2)).toBe("Actualizat acum 2 ore.");
    expect(age(19)).toBe("Actualizat acum 19 ore.");
    expect(age(20)).toBe("Actualizat acum 20 de ore.");
    expect(age(30)).toBe("Actualizat acum 30 de ore.");
    expect(age(47.6)).toBe("Actualizat acum 48 de ore.");
    expect(age(72)).toBe("Actualizat acum 3 zile.");
    expect(age(24 * 25)).toBe("Actualizat acum 25 de zile.");
  });
});

describe("avertismentele ajustării", () => {
  const asOf = new Date("2026-10-23T07:00:00Z");
  it("ora efectivă dinaintea ultimei actualizări, cu data ei", () => {
    expect(warningText("effective_before_snapshot", { asOf, timeZone: TZ })).toBe(
      "Ora efectivă este dinaintea ultimei actualizări din SmartBill (23.10.2026, 10:00). Dacă evenimentul era deja în SmartBill la acea actualizare, va fi scăzut de două ori până la actualizarea următoare.",
    );
  });
  it("fără data actualizării (nu ar trebui să se întâmple) mesajul rămâne corect", () => {
    expect(warningText("effective_before_snapshot", { asOf: null, timeZone: TZ })).toContain(
      "dinaintea ultimei actualizări din SmartBill",
    );
  });
  it("sub angajat și rezervat", () => {
    expect(warningText("below_commitments", { asOf: null, timeZone: TZ })).toBe(
      "Stocul fizic a coborât sub cantitatea angajată și rezervată: disponibilul este acum 0.",
    );
  });
});

describe("summaryView: coloana «Stoc» din lista de produse", () => {
  const summary = (rows: ReturnType<typeof row>[], withQuantities = true) =>
    summaryView(summarizeProductRows(rows, { withQuantities }));

  it("gestionat, o variantă: starea și cantitatea disponibilă cu unitate", () => {
    const view = summary([row({ physical: "100" })]);
    expect(view).toMatchObject({ label: "În stoc", tone: "ok", quantity: "Disponibil 100 mp" });
  });

  it("gestionat, mai multe variante: numărul de variante și suma, în aceeași unitate", () => {
    const view = summary([
      row({ variantId: "a", physical: "40" }),
      row({ variantId: "b", physical: "60" }),
    ]);
    expect(view.quantity).toBe("2 variante · Disponibil 100 mp");
  });

  it("unități diferite: fără sumă, cu mențiune", () => {
    const view = summary([
      row({ variantId: "a", physical: "40" }),
      row({ variantId: "b", physical: "6", unit: { code: "ml", symbol: "ml", decimals: 1 } }),
    ]);
    expect(view.quantity).toBe("2 variante, unități diferite");
  });

  it("Stoc limitat: ton de avertizare; La comandă: termenul; Indisponibil: ton de pericol", () => {
    expect(summary([row({ physical: "2" })])).toMatchObject({
      label: "Stoc limitat",
      tone: "warn",
    });
    const onOrder = summary([
      row({
        manageStock: false,
        stockStatus: "onbackorder",
        leadTime: { productDays: 9, brandDays: null },
      }),
    ]);
    expect(onOrder).toMatchObject({ label: "La comandă", tone: "info", detail: "termen 9 zile" });
    expect(summary([row({ physical: "0" })])).toMatchObject({
      label: "Indisponibil",
      tone: "danger",
    });
  });

  it("negestionat și digital: fără cantitate, cu mențiune scurtă", () => {
    expect(summary([row({ manageStock: false, stockStatus: "outofstock" })])).toMatchObject({
      label: "Indisponibil",
      quantity: "Negestionat",
    });
    expect(summary([row({ productType: "digital" })])).toMatchObject({
      label: "În stoc",
      quantity: "Digital",
    });
  });

  it("fără drept de cantități: doar starea, fără nicio cantitate", () => {
    const view = summary([row({ physical: "100" })], false);
    expect(view.label).toBe("În stoc");
    expect(view.quantity).toBeNull();
  });

  it("gestionat neinventariat: semnalat", () => {
    expect(summary([row({ physical: null })]).quantity).toBe("Neinventariat");
  });
});

describe("lista «Stoc mic»: prag și motiv", () => {
  const unit = { code: "buc", symbol: "buc", decimals: 0 };
  const own = (physical: string, lowStockSteps: number | null) => {
    const r = row({ unit, physical });
    return {
      ...r,
      thresholdSteps: lowStockSteps ?? 2,
      ownThresholdSteps: lowStockSteps,
    } as typeof r;
  };

  it("pragul: valoarea efectivă în pași și de unde vine (propriu sau setarea globală)", () => {
    expect(thresholdView(own("10", null))).toEqual({
      steps: "2 pași",
      origin: "global",
      originLabel: "setarea globală",
    });
    expect(thresholdView(own("10", 5))).toEqual({
      steps: "5 pași",
      origin: "own",
      originLabel: "propriu",
    });
    expect(thresholdView(own("10", 0))?.steps).toBe("0 pași");
    expect(thresholdView(own("10", 1))?.steps).toBe("1 pas");
    expect(thresholdView(own("10", 20))?.steps).toBe("20 de pași");
  });

  it("negestionat și digital nu au prag", () => {
    expect(thresholdView(row({ manageStock: false }))).toBeNull();
    expect(thresholdView(row({ productType: "digital" }))).toBeNull();
  });

  it("motivul: etichetă și ton; nimic pentru ce nu e în listă", () => {
    expect(lowStockReasonView(row({ unit, physical: "0" }))).toEqual({
      label: "Epuizat",
      tone: "danger",
      reason: "out_of_stock",
    });
    expect(lowStockReasonView(row({ step: "41,25", physical: "17,5" }))).toEqual({
      label: "Doar rest nevandabil",
      tone: "warn",
      reason: "remainder_only",
    });
    expect(lowStockReasonView(row({ unit, physical: "2" }))).toEqual({
      label: "Sub prag",
      tone: "warn",
      reason: "below_threshold",
    });
    expect(lowStockReasonView(row({ unit, physical: "50" }))).toBeNull();
    expect(lowStockReasonView(row({ manageStock: false, physical: "0" }))).toBeNull();
  });
});

describe("ținta dialogului «Prag»", () => {
  const unit = { code: "buc", symbol: "buc", decimals: 0 };
  const withOwn = (own: number | null) => {
    const r = row({ unit, physical: "10" });
    return { ...r, thresholdSteps: own ?? 2, ownThresholdSteps: own } as typeof r;
  };

  it("cu prag propriu: valoarea propriu-zisă, efectivul formatat, originea și setarea globală formatată", () => {
    expect(
      thresholdTarget(withOwn(5), { warehouseId: "w1", name: "Pompă (L)", globalSteps: 2 }),
    ).toEqual({
      variantId: "v",
      warehouseId: "w1",
      name: "Pompă (L)",
      ownSteps: 5,
      effectiveText: "5 pași",
      originLabel: "propriu",
      globalText: "2 pași",
    });
  });

  it("fără prag propriu: ownSteps nul, efectiv = setarea globală; globala de 1 e «1 pas»", () => {
    expect(
      thresholdTarget(withOwn(null), { warehouseId: "w1", name: "P", globalSteps: 1 }),
    ).toMatchObject({
      ownSteps: null,
      effectiveText: "2 pași",
      originLabel: "setarea globală",
      globalText: "1 pas",
    });
  });

  it("negestionat: nu are țintă (nu se poate seta prag)", () => {
    expect(
      thresholdTarget(row({ manageStock: false }), {
        warehouseId: "w1",
        name: "P",
        globalSteps: 2,
      }),
    ).toBeNull();
  });
});

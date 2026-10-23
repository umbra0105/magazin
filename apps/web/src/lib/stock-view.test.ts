import { describe, expect, it } from "vitest";
import { parseQuantity, parseSignedDelta, saleStepToInt, type Quantity } from "@ecom/shared";
import {
  buildStockOverviewRow,
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
  stepsText,
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

describe("banner-ul «stoc verificat la …»", () => {
  const at = new Date("2026-10-23T07:00:00Z"); // 10:00 la București
  const base: WarehouseFreshness = {
    warehouseId: "w",
    name: "Depozit principal",
    status: "fresh",
    takenAt: at,
    ageHours: 3,
  };

  it("proaspăt: data și vârsta, ton liniștit", () => {
    expect(snapshotView(base, TZ, 24)).toEqual({
      tone: "ok",
      text: "Stoc verificat la 23.10.2026, 10:00 (acum 3 h).",
    });
  });

  it("vechi: roșu, cu pragul și consecința", () => {
    const view = snapshotView({ ...base, status: "stale", ageHours: 54 }, TZ, 24);
    expect(view.tone).toBe("danger");
    expect(view.text).toBe(
      "Poza SmartBill e veche: stoc verificat la 23.10.2026, 10:00 (acum 2 zile). Pragul este de 24 h; vânzările din magazin de după poză nu sunt cunoscute până la poza următoare.",
    );
  });

  it("fără nicio poză: roșu", () => {
    const view = snapshotView({ ...base, status: "never", takenAt: null, ageHours: null }, TZ, 24);
    expect(view).toEqual({
      tone: "danger",
      text: "Nu există nicio poză SmartBill pentru acest depozit: cantitățile afișate sunt cele introduse manual.",
    });
  });

  it("depozit fără stoc gestionat: doar o informare", () => {
    expect(snapshotView(null, TZ, 24)).toEqual({
      tone: "info",
      text: "Nu există încă stoc gestionat în acest depozit.",
    });
  });

  it("vârsta: sub o oră, ore până la 48 h, apoi zile", () => {
    const age = (hours: number) => snapshotView({ ...base, ageHours: hours }, TZ, 24).text;
    expect(age(0.4)).toContain("acum mai puțin de o oră");
    expect(age(1)).toContain("acum 1 h");
    expect(age(30)).toContain("acum 30 h");
    expect(age(47.6)).toContain("acum 48 h");
    expect(age(72)).toContain("acum 3 zile");
  });
});

describe("avertismentele ajustării", () => {
  const asOf = new Date("2026-10-23T07:00:00Z");
  it("ora efectivă dinaintea pozei, cu data pozei", () => {
    expect(warningText("effective_before_snapshot", { asOf, timeZone: TZ })).toBe(
      "Ora efectivă este dinaintea pozei SmartBill din 23.10.2026, 10:00. Dacă evenimentul era deja în SmartBill la acea poză, va fi scăzut de două ori până la poza următoare.",
    );
  });
  it("fără data pozei (nu ar trebui să se întâmple) mesajul rămâne corect", () => {
    expect(warningText("effective_before_snapshot", { asOf: null, timeZone: TZ })).toContain(
      "dinaintea ultimei poze SmartBill",
    );
  });
  it("sub angajat și rezervat", () => {
    expect(warningText("below_commitments", { asOf: null, timeZone: TZ })).toBe(
      "Stocul fizic a coborât sub cantitatea angajată și rezervată: disponibilul este acum 0.",
    );
  });
});

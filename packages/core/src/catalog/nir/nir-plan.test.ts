import { describe, expect, it } from "vitest";
import {
  planNirImport,
  unitMatches,
  type NirCatalog,
  type NirPlan,
  type NirVariant,
} from "./nir-plan";
import type { NirRawRow } from "./nir-parse";

/** Date SINTETICE: coduri, produse și costuri inventate. Ceasul e injectat; datele sunt relative la el, nu la ceasul real. */
const NOW = new Date("2030-06-15T12:00:00.000Z");

const variant = (sku: string, over: Partial<NirVariant> = {}): NirVariant => ({
  variantId: `v-${sku}`,
  sku,
  currentDate: null,
  smartbillMode: "same_unit",
  priceBasis: "unit",
  expectedUnit: "buc",
  ...over,
});

function catalogOf(variants: readonly NirVariant[]): NirCatalog {
  return {
    exact: (code) => variants.find((v) => v.sku === code),
    caseInsensitive: (code) => variants.filter((v) => v.sku.toLowerCase() === code.toLowerCase()),
  };
}

let row = 10;
const entry = (
  code: string | null,
  over: Partial<Record<string, string | null>> = {},
): NirRawRow => ({
  rowNumber: row++,
  warehouse: "Depozit",
  product: "Produs inventat",
  code,
  date: { text: over["date"] === undefined ? "10/05/2030" : over["date"], date: null },
  docType: over["type"] === undefined ? "Receptie" : over["type"],
  unit: over["unit"] === undefined ? "buc" : over["unit"],
  qtyIn: over["in"] === undefined ? "5" : over["in"],
  unitCost: over["cost"] === undefined ? "10.0000" : over["cost"],
});

function plan(rows: NirRawRow[], variants: NirVariant[]): NirPlan {
  return planNirImport({
    rows,
    counters: { blankRows: 0, totalRows: 0 },
    catalog: catalogOf(variants),
    now: NOW,
  });
}

describe("ce rând contează: doar intrările", () => {
  it("cantitatea zero, negativă sau lipsă se ignoră și se numără (nu sunt intrări)", () => {
    const out = plan(
      [
        entry("A", { in: "0" }),
        entry("A", { in: "-3" }),
        entry("A", { in: null }),
        entry("A", { in: "-0.5" }),
        entry("A", { in: "4" }),
      ],
      [variant("A")],
    );
    expect(out.report.counters.ignored).toBe(4);
    expect(out.report.counters.updated).toBe(1);
    expect(out.report.counters.invalid).toBe(0);
  });

  it("un storno cu cost ciudat NU strică nimic: rândul negativ nu e validat deloc", () => {
    const out = plan(
      [entry("A", { in: "-2", cost: "abc", date: "xx" }), entry("A")],
      [variant("A")],
    );
    expect(out.report.counters.invalid).toBe(0);
    expect(out.report.counters.ignored).toBe(1);
    expect(out.items).toHaveLength(1);
  });

  it("cantitate nenumerică: rând invalid", () => {
    const out = plan([entry("A", { in: "mult" })], [variant("A")]);
    expect(out.report.invalid).toEqual([
      { row: expect.any(Number), code: "A", reason: "cantitatea intrată nu e un număr" },
    ]);
    expect(out.items).toEqual([]);
  });

  it("alte tipuri de document decât «recepție» se folosesc la fel și se listează ca informație", () => {
    const out = plan(
      [
        entry("A", { type: "Receptie", date: "01/05/2030" }),
        entry("B", { type: "Transfer intrare" }),
        entry("B", { type: "Transfer intrare", date: "11/05/2030" }),
        entry("C", { type: "Recepție" }),
      ],
      [variant("A"), variant("B"), variant("C")],
    );
    expect(out.report.otherDocTypes).toEqual([{ type: "Transfer intrare", count: 2 }]);
    expect(out.items.map((i) => i.code)).toEqual(["A", "B", "C"]);
  });
});

describe("rândurile invalide", () => {
  it.each([
    ["fără cod", { code: null }, "lipsește codul"],
    ["dată text greșită", { date: "10-05-2030" }, "data nu e validă"],
    ["dată inexistentă", { date: "31/04/2030" }, "data nu e validă"],
    ["dată lipsă", { date: null }, "data nu e validă"],
    ["dată în viitor (peste ziua de mâine)", { date: "20/06/2030" }, "data intrării e în viitor"],
    ["cost lipsă", { cost: null }, "costul unitar lipsește"],
    ["cost nenumeric", { cost: "n/a" }, "costul unitar lipsește"],
    ["cost zero", { cost: "0" }, "preț prea mic"],
    ["cost sub 0,5 bani", { cost: "0.0049" }, "preț prea mic"],
    ["cost negativ", { cost: "-4" }, "preț prea mic"],
    ["cost peste plafon", { cost: "99999999999" }, "preț prea mic"],
  ])("%s", (_label, over, reason) => {
    const { code, ...rest } = over as { code?: string | null } & Record<string, string | null>;
    const out = plan([entry(code === undefined ? "A" : code, rest)], [variant("A")]);
    expect(out.report.counters.invalid).toBe(1);
    expect(out.report.invalid[0]?.reason).toContain(reason);
    expect(out.items).toEqual([]);
    expect(out.report.counters.updated).toBe(0);
  });

  it("motivele nu repetă valori din fișier", () => {
    const out = plan(
      [entry("COD-SECRET", { cost: "1234.5678x" }), entry("COD-SECRET", { date: "99/99/9999" })],
      [variant("COD-SECRET")],
    );
    for (const issue of out.report.invalid) {
      expect(issue.reason).not.toMatch(/1234|9999|5678/);
    }
  });

  it("ziua de mâine încă se acceptă (toleranță de 24 de ore pentru ceasuri nesincronizate)", () => {
    expect(plan([entry("A", { date: "16/06/2030" })], [variant("A")]).items).toHaveLength(1);
  });
});

describe("potrivirea codului", () => {
  it("exactă după trim", () => {
    const out = plan([entry("  A-1  ")], [variant("A-1")]);
    expect(out.items[0]).toMatchObject({ code: "A-1", variantId: "v-A-1" });
  });

  it("fără diferență de majuscule doar când duce la o singură variantă", () => {
    const out = plan([entry("abc-1")], [variant("ABC-1")]);
    expect(out.items[0]?.code).toBe("ABC-1");
    const ambiguous = plan([entry("abc")], [variant("ABC"), variant("Abc")]);
    expect(ambiguous.items).toEqual([]);
    expect(ambiguous.report.unknown[0]?.reason).toContain("ambiguu");
  });

  it("exactul bate varianta fără diferență de majuscule", () => {
    const out = plan([entry("Abc")], [variant("ABC"), variant("Abc")]);
    expect(out.items[0]?.variantId).toBe("v-Abc");
  });

  it("cod necunoscut (inclusiv nume de produs în loc de cod): raportat, nu ghicit", () => {
    const out = plan([entry("Pompă de căldură 12 kW")], [variant("PC-12")]);
    expect(out.report.unknown).toEqual([
      { row: expect.any(Number), code: "Pompă de căldură 12 kW", reason: "cod necunoscut" },
    ]);
    expect(out.items).toEqual([]);
  });
});

describe("mai multe intrări pe același cod", () => {
  it("câștigă data cea mai recentă, indiferent de ordinea rândurilor; costul e al câștigătorului", () => {
    const out = plan(
      [
        entry("A", { date: "01/05/2030", cost: "10" }),
        entry("A", { date: "20/05/2030", cost: "30" }),
        entry("A", { date: "10/05/2030", cost: "20" }),
      ],
      [variant("A")],
    );
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ date: "2030-05-20", costMinor: 3000 });
    expect(out.report.counters.matchedCodes).toBe(1);
  });

  it("prețul scade față de intrarea anterioară → câștigă cea mai recentă, nu minimul sau maximul", () => {
    const out = plan(
      [
        entry("A", { date: "01/05/2030", cost: "50" }),
        entry("A", { date: "02/05/2030", cost: "40" }),
      ],
      [variant("A")],
    );
    expect(out.items[0]?.costMinor).toBe(4000);
  });

  it("la aceeași dată câștigă ULTIMUL rând din fișier, iar intrările multiple din aceeași zi se raportează ca informație", () => {
    const first = entry("A", { date: "07/05/2030", cost: "10" });
    const second = entry("A", { date: "07/05/2030", cost: "11" });
    const third = entry("A", { date: "07/05/2030", cost: "12" });
    const out = plan([first, second, third], [variant("A")]);
    expect(out.items[0]).toMatchObject({ costMinor: 1200, row: third.rowNumber });
    expect(out.report.multiSameDay).toEqual([
      { code: "A", date: "2030-05-07", rows: [first.rowNumber, second.rowNumber, third.rowNumber] },
    ]);
    expect(out.report.counters.multiSameDay).toBe(1);
  });

  it("intrări în zile diferite nu sunt «multiple în aceeași zi»", () => {
    const out = plan(
      [entry("A", { date: "01/05/2030" }), entry("A", { date: "02/05/2030" })],
      [variant("A")],
    );
    expect(out.report.multiSameDay).toEqual([]);
  });
});

describe("data strict mai nouă decât cea curentă", () => {
  const withDate = (currentDate: string | null) => [variant("A", { currentDate })];

  it("fără preț NIR: se actualizează", () => {
    expect(plan([entry("A")], withDate(null)).report.counters).toMatchObject({
      updated: 1,
      unchanged: 0,
    });
  });

  it("data din fișier mai nouă: se actualizează", () => {
    expect(plan([entry("A", { date: "10/05/2030" })], withDate("2030-05-09")).items).toHaveLength(
      1,
    );
  });

  it("aceeași dată: neschimbat, chiar dacă valoarea diferă", () => {
    const out = plan([entry("A", { date: "10/05/2030", cost: "999" })], withDate("2030-05-10"));
    expect(out.items).toEqual([]);
    expect(out.report.counters).toMatchObject({ updated: 0, unchanged: 1 });
    expect(out.report.unchanged[0]).toMatchObject({ code: "A", date: "2030-05-10" });
  });

  it("data mai veche: neschimbat", () => {
    const out = plan([entry("A", { date: "01/05/2030" })], withDate("2030-05-10"));
    expect(out.items).toEqual([]);
    expect(out.report.counters.unchanged).toBe(1);
  });
});

describe("unitatea: nicio conversie ghicită", () => {
  it.each([
    ["varianta ținută pe pași", { smartbillMode: "steps" as const }, "buc"],
    ["varianta ținută cu raport", { smartbillMode: "ratio" as const }, "buc"],
    ["prețul variantei pe pas", { priceBasis: "step" as const }, "buc"],
    ["unitate diferită", {}, "kg"],
    ["unitate lipsă", {}, null],
  ])("%s: rândul se sare și apare la «unitate diferită»", (_label, over, unit) => {
    const out = plan([entry("A", { unit })], [variant("A", over)]);
    expect(out.items).toEqual([]);
    expect(out.report.counters.unitDifferent).toBe(1);
    expect(out.report.unitDifferent[0]).toMatchObject({ code: "A", fileUnit: unit });
  });

  it("unitatea scrisă altfel în SmartBill (BUC, bucată, M2 = mp) se potrivește prin tabel", () => {
    expect(unitMatches("BUC", "buc")).toBe(true);
    expect(unitMatches("Bucata", "buc")).toBe(true);
    expect(unitMatches("M2", "mp")).toBe(true);
    expect(unitMatches("kg", "buc")).toBe(false);
    expect(unitMatches("pachet", "pachet")).toBe(true);
    expect(unitMatches("pachet", "set")).toBe(false);
  });

  it("alte rânduri ale aceluiași cod, cu unitatea potrivită, se folosesc", () => {
    const out = plan(
      [
        entry("A", { unit: "kg", date: "12/05/2030" }),
        entry("A", { unit: "buc", date: "05/05/2030" }),
      ],
      [variant("A")],
    );
    expect(out.items[0]).toMatchObject({ date: "2030-05-05" });
    expect(out.report.counters.unitDifferent).toBe(1);
  });
});

describe("rotunjirea la bani, o singură dată, half-up (limite)", () => {
  const cost = (text: string) =>
    plan([entry("A", { cost: text })], [variant("A")]).items[0]?.costMinor;
  it("4 zecimale în fișier → bani întregi", () => {
    expect(cost("123.4549")).toBe(12345);
    expect(cost("123.4550")).toBe(12346);
    expect(cost("123.4551")).toBe(12346);
    expect(cost("0.0050")).toBe(1);
    expect(cost("19.9950")).toBe(2000);
    expect(cost("19.9949")).toBe(1999);
  });
});

describe("idempotență și structură", () => {
  it("același fișier, același catalog → același plan (nicio dependență de ordine sau de ceas)", () => {
    const rows = [
      entry("B", { date: "03/05/2030" }),
      entry("A", { date: "01/05/2030", cost: "7.5" }),
      entry("A", { date: "02/05/2030", cost: "8.25" }),
    ];
    const catalog = [variant("A"), variant("B")];
    expect(plan(rows, catalog)).toEqual(plan(rows, catalog));
    expect(plan(rows, catalog).items.map((i) => i.code)).toEqual(["B", "A"]);
  });

  it("contoarele se adună: rândurile din fișier = ignorate + invalide + necunoscute + unitate + intrări folosite", () => {
    const rows = [
      entry("A"),
      entry("A", { in: "-1" }),
      entry("ZZZ"),
      entry("A", { cost: "0" }),
      entry("B", { unit: "kg" }),
      entry("A", { date: "01/05/2030" }),
    ];
    const out = plan(rows, [variant("A"), variant("B")]);
    const c = out.report.counters;
    expect(c.fileRows).toBe(rows.length);
    expect(
      c.ignored + c.invalid + c.unknownCodes + c.unitDifferent + 2 /* două intrări bune pe A */,
    ).toBe(rows.length);
  });
});

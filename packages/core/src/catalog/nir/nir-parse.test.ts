import { describe, expect, it } from "vitest";
import type { NirFileError } from "./nir-parse";
import {
  costToMinor,
  headerKey,
  parseDecimalText,
  parseNirDate,
  parseNirTable,
  type NirGridRow,
} from "./nir-parse";

/** Fișiere SINTETICE: coduri, produse și valori inventate (fișierul real SmartBill nu intră în teste). */
const HEADER = [
  "Gestiune",
  "Produs",
  "Cod",
  "Data",
  "Tip document",
  "Document",
  "U.M.",
  "Intrari",
  "Iesiri",
  "Cost unitar",
  "Intrari (valoare)",
  "Iesiri (valoare)",
];

const cell = (text: string | null) => ({ text, display: text, date: null });
const row = (rowNumber: number, texts: ReadonlyArray<string | null>): NirGridRow => ({
  rowNumber,
  cells: texts.map(cell),
});

function grid(body: ReadonlyArray<ReadonlyArray<string | null>>, titleRows = 3): NirGridRow[] {
  const rows: NirGridRow[] = [];
  for (let i = 0; i < titleRows; i += 1) rows.push(row(rows.length + 1, [`Titlu ${i}`]));
  rows.push(row(rows.length + 1, HEADER));
  for (const texts of body) rows.push(row(rows.length + 1, texts));
  return rows;
}

const data = (code: string | null, extra: Partial<Record<string, string>> = {}) => [
  "Depozit",
  "Produs inventat",
  code,
  extra["date"] ?? "05/11/2026",
  extra["type"] ?? "Receptie",
  "NIR 1",
  extra["unit"] ?? "buc",
  extra["in"] ?? "10",
  "0",
  extra["cost"] ?? "12.3456",
  "123.45",
  "0",
];

describe("antetul se caută după nume, nu după poziție", () => {
  it("găsește antetul sub oricâte rânduri de titlu (până la 60) și citește rândurile de date", () => {
    const table = parseNirTable(grid([data("A-1"), data("A-2")], 7));
    expect(table.headerRow).toBe(8);
    expect(table.rows.map((r) => r.code)).toEqual(["A-1", "A-2"]);
    expect(table.rows[0]).toMatchObject({
      rowNumber: 9,
      unit: "buc",
      qtyIn: "10",
      unitCost: "12.3456",
      docType: "Receptie",
    });
  });

  it("coloanele pot fi în altă ordine și cu diacritice/majuscule diferite", () => {
    const rows: NirGridRow[] = [
      row(1, ["COST UNITAR", "Cod", "DATA", "Gestiune", "Produs", "u.m.", "INTRĂRI"]),
      row(2, ["9.5000", "X-1", "01/02/2026", "D", "P", "BUC", "3"]),
    ];
    const table = parseNirTable(rows);
    expect(table.rows[0]).toMatchObject({
      code: "X-1",
      unitCost: "9.5000",
      unit: "BUC",
      qtyIn: "3",
    });
  });

  it("«Intrari (valoare)» nu e «Intrari»", () => {
    const rows: NirGridRow[] = [
      row(1, [
        "Gestiune",
        "Produs",
        "Cod",
        "Data",
        "U.M.",
        "Intrari (valoare)",
        "Intrari",
        "Cost unitar",
      ]),
      row(2, ["D", "P", "C", "01/02/2026", "buc", "999.99", "4", "1.0000"]),
    ];
    expect(parseNirTable(rows).rows[0]?.qtyIn).toBe("4");
  });

  it("rândurile goale și rândul «Total» se sar, cu contor", () => {
    const table = parseNirTable(
      grid([
        data("A-1"),
        [null, null, null, null, null, null, null, null, null, null],
        ["Total", null, null, null, null, null, null, "10", "0", null, "123", "0"],
      ]),
    );
    expect(table.rows).toHaveLength(1);
    expect(table.counters).toEqual({ dataRows: 1, blankRows: 1, totalRows: 1 });
  });

  it("fără antet: eroare clară, fără valori din fișier", () => {
    const err = (() => {
      try {
        parseNirTable([row(1, ["Altceva"]), row(2, ["valoare-secreta-12.34"])]);
      } catch (e) {
        return e as NirFileError;
      }
      return null;
    })();
    expect(err?.code).toBe("NIR_FILE_HEADER_NOT_FOUND");
    expect(err?.message).not.toContain("valoare-secreta");
  });

  it("antet găsit, dar fără coloana de cost: se spune ce lipsește", () => {
    const rows = [row(1, ["Gestiune", "Produs", "Cod", "Data", "U.M.", "Intrari"])];
    expect(() => parseNirTable(rows)).toThrowError(
      expect.objectContaining({ code: "NIR_FILE_COLUMNS_MISSING" }),
    );
  });

  it("coloană repetată: ambiguu, nu se ghicește", () => {
    const rows = [
      row(1, ["Gestiune", "Produs", "Cod", "Cod", "Data", "U.M.", "Intrari", "Cost unitar"]),
    ];
    expect(() => parseNirTable(rows)).toThrowError(
      expect.objectContaining({ code: "NIR_FILE_COLUMNS_AMBIGUOUS" }),
    );
  });

  it("headerKey ignoră diacriticele, majusculele și punctele", () => {
    expect(headerKey("  U.M. ")).toBe("um");
    expect(headerKey("Introduceri Șurub")).toBe("introduceri surub");
  });
});

describe("data intrării: text zz/ll/aaaa strict", () => {
  const text = (value: string | null) => parseNirDate({ text: value, date: null });

  it("acceptă datele valide", () => {
    expect(text("05/11/2026")).toMatchObject({ year: 2026, month: 11, day: 5, iso: "2026-11-05" });
    expect(text("29/02/2028")?.iso).toBe("2028-02-29");
    expect(text("31/12/2025")?.iso).toBe("2025-12-31");
  });

  it.each([
    "5/11/2026",
    "05/1/2026",
    "05-11-2026",
    "05.11.2026",
    "2026/11/05",
    "11/05/26",
    "29/02/2026",
    "31/04/2026",
    "00/01/2026",
    "01/13/2026",
    "32/01/2026",
    "05/11/1800",
    "",
    "azi",
    " 05/11/2026 x",
  ])("«%s» e invalidă", (value) => {
    expect(text(value)).toBeNull();
  });

  it("text lipsă e invalid; o dată calendaristică reală din celulă se acceptă", () => {
    expect(text(null)).toBeNull();
    expect(parseNirDate({ text: null, date: { year: 2026, month: 3, day: 9 } })?.iso).toBe(
      "2026-03-09",
    );
    expect(parseNirDate({ text: null, date: { year: 2026, month: 2, day: 30 } })).toBeNull();
  });
});

describe("numere zecimale ca text", () => {
  it.each([
    ["12", 12n, 0],
    ["12.3456", 123456n, 4],
    ["12,3456", 123456n, 4],
    ["0.0050", 50n, 4],
    ["007", 7n, 0],
    [" 5.5 ", 55n, 1],
  ])("«%s»", (text, digits, scale) => {
    expect(parseDecimalText(text)).toMatchObject({ negative: false, digits, scale });
  });

  it("negativul se recunoaște", () => {
    expect(parseDecimalText("-3.5")).toMatchObject({ negative: true, digits: 35n, scale: 1 });
  });

  it.each([
    "",
    "abc",
    "1e-3",
    "1E5",
    "1.234,56",
    "1 234",
    "1.2.3",
    "--1",
    "12.",
    ".5",
    "0x10",
    "NaN",
    "Infinity",
  ])("«%s» nu e număr (nu se ghicește)", (text) => {
    expect(parseDecimalText(text)).toBeNull();
  });

  it("null → null", () => expect(parseDecimalText(null)).toBeNull());
});

describe("costul în bani: o singură rotunjire half-up, exact", () => {
  const minor = (text: string) => {
    const value = parseDecimalText(text);
    return value ? costToMinor(value) : "nenumeric";
  };

  it("exemple de mână cu 4 zecimale", () => {
    expect(minor("12.3456")).toBe(1235); // 1234,56 bani → 1235
    expect(minor("123.4549")).toBe(12345); // 12345,49 → 12345
    expect(minor("123.4550")).toBe(12346); // 12345,50 → 12346 (half-up)
    expect(minor("123.4551")).toBe(12346);
    expect(minor("100")).toBe(10000);
    expect(minor("100.0000")).toBe(10000);
    expect(minor("0.0050")).toBe(1); // 0,5 bani → 1
    expect(minor("0.0049")).toBe(null); // 0,49 bani → 0 → prea mic
    expect(minor("0.0150")).toBe(2); // 1,5 → 2
    expect(minor("0.0250")).toBe(3); // 2,5 → 3 (half-up, nu «banker's»)
    expect(minor("99.9999")).toBe(10000); // 9999,99 → 10000
  });

  it("zero, negativ și peste plafon: invalid", () => {
    expect(minor("0")).toBe(null);
    expect(minor("0.0000")).toBe(null);
    expect(minor("-5")).toBe(null);
    expect(minor("999999999999")).toBe(null);
  });

  it("nu depinde de float: 1.005 lei = 100,5 bani exact → 101", () => {
    expect(minor("1.005")).toBe(101);
    expect(minor("1.0049999")).toBe(100);
    expect(minor("0.285")).toBe(29); // 28,5 → 29
  });
});

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  STOCK_REPORT_MAX_BYTES,
  STOCK_REPORT_MAX_SHEET_ROWS,
  readStockReportFile,
} from "./stock-report-reader";
import {
  SMARTBILL_HEADER,
  XLSX,
  buildReport,
  reportAoa,
  setCell,
  workbookBuffer,
  type FabricatedRow,
  type ReportFormat,
} from "./test-utils/report-workbook";

const FORMATS: ReportFormat[] = ["xls", "xlsx"];

const row = (overrides: Partial<FabricatedRow> = {}): FabricatedRow => ({
  warehouse: "Depozit Test",
  code: "00123",
  unit: "BUC",
  quantity: 12,
  ...overrides,
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? "FĂRĂ COD";
  }
  return "NU A ARUNCAT";
}

/** Adresa unei celule din coloana `column` (A = 0) a rândului de date `index` (primul rând de date = rândul 11). */
const at = (column: number, index: number): string =>
  `${String.fromCharCode(65 + column)}${11 + index}`;

describe("readStockReportFile: structura raportului SmartBill", () => {
  it.each(FORMATS)("citește rândurile, data și contoarele (%s)", async (format) => {
    const file = buildReport({
      format,
      rows: [
        row(),
        row({ code: "A-9", unit: "KG", quantity: 2.348 }),
        row({ warehouse: "Alt depozit", unit: "MP", quantity: 5 }),
      ],
    });
    const result = await readStockReportFile(file);
    expect(result.format).toBe(format);
    expect(result.headerRow).toBe(10);
    expect(result.fileDate).toEqual({ year: 2026, month: 10, day: 28 });
    expect(result.counters).toEqual({ dataRows: 3, blankRows: 0, totalRows: 1 });
    expect(result.rows).toEqual([
      { rowNumber: 11, warehouse: "Depozit Test", code: "00123", unit: "BUC", quantity: "12" },
      { rowNumber: 12, warehouse: "Depozit Test", code: "A-9", unit: "KG", quantity: "2.348" },
      { rowNumber: 13, warehouse: "Alt depozit", code: "00123", unit: "MP", quantity: "5" },
    ]);
  });

  it.each(FORMATS)("sare peste rândul «Total» și peste rândurile goale (%s)", async (format) => {
    const file = buildReport({
      format,
      rows: [row(), row({ code: "B-2" })],
      blankRowsBeforeTotal: 2,
    });
    const result = await readStockReportFile(file);
    expect(result.rows.map((r) => r.code)).toEqual(["00123", "B-2"]);
    expect(result.counters).toEqual({ dataRows: 2, blankRows: 2, totalRows: 1 });
  });

  it("«Total» se recunoaște după litere (mari/mici, spații), dar un rând cu cod rămâne rând de date", async () => {
    const aoa = reportAoa({
      rows: [row(), row({ warehouse: "Total", code: "T-1" })],
      total: false,
    });
    aoa.push(["  TOTAL ", null, null, null, 7, 1, 1]);
    const result = await readStockReportFile(workbookBuffer([aoa]));
    expect(result.rows.map((r) => r.code)).toEqual(["00123", "T-1"]);
    expect(result.counters.totalRows).toBe(1);
  });

  it("numerotează rândurile ca în Excel (de la 1), oricâte rânduri de titlu ar fi", async () => {
    const file = buildReport({ rows: [row(), row({ code: "B-2" })], extraTitleRows: 3 });
    const result = await readStockReportFile(file);
    expect(result.headerRow).toBe(13);
    expect(result.rows.map((r) => r.rowNumber)).toEqual([14, 15]);
  });

  it("găsește antetul după numele coloanelor, nu după poziție: ordine schimbată, coloane în plus", async () => {
    const aoa: unknown[][] = [
      ["Titlu"],
      ["Altceva", "Cod", "GESTIUNE", "stoc  final", "Sold final", "U.M"],
      ["x", "00123", "Depozit Test", 12, 55, "BUC"],
      ["y", "A-9", "Depozit Test", 2.5, 55, "KG"],
    ];
    const result = await readStockReportFile(workbookBuffer([aoa], "xls"));
    expect(result.headerRow).toBe(2);
    expect(result.rows).toEqual([
      { rowNumber: 3, warehouse: "Depozit Test", code: "00123", unit: "BUC", quantity: "12" },
      { rowNumber: 4, warehouse: "Depozit Test", code: "A-9", unit: "KG", quantity: "2.5" },
    ]);
  });

  it("recunoaște antetul fără diacritice, cu litere mici/mari și cu variante de scriere", async () => {
    const aoa: unknown[][] = [
      ["gestiune", "cod produs", "unitate de măsură", "STOC FINAL"],
      ["Depozit Test", "00123", "BUC", 3],
    ];
    const result = await readStockReportFile(workbookBuffer([aoa]));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.unit).toBe("BUC");
  });

  it("antetul poate fi pe rândul 60, dar nu pe rândul 61", async () => {
    const ok = await readStockReportFile(buildReport({ rows: [row()], extraTitleRows: 50 }));
    expect(ok.headerRow).toBe(60);
    expect(
      await codeOf(readStockReportFile(buildReport({ rows: [row()], extraTitleRows: 51 }))),
    ).toBe("STOCK_REPORT_FILE_HEADER_NOT_FOUND");
  });

  it.each(FORMATS)("păstrează diacriticele din text (%s)", async (format) => {
    const file = buildReport({
      format,
      rows: [row({ warehouse: "Depozit Țăndărei Ștefan", unit: "bucată", code: "Ă-î-â" })],
    });
    const result = await readStockReportFile(file);
    expect(result.rows[0]).toMatchObject({
      warehouse: "Depozit Țăndărei Ștefan",
      unit: "bucată",
      code: "Ă-î-â",
    });
  });

  it.each(FORMATS)("«Sold final» se ignoră: nu apare nicăieri în rezultat (%s)", async (format) => {
    const file = buildReport({
      format,
      rows: [row({ soldFinal: 987654.321 }), row({ code: "B-2", soldFinal: "SOLD-SECRET" })],
    });
    const result = await readStockReportFile(file);
    expect(JSON.stringify(result)).not.toContain("987654");
    expect(JSON.stringify(result)).not.toContain("SOLD-SECRET");
    for (const r of result.rows) {
      expect(Object.keys(r).sort()).toEqual(["code", "quantity", "rowNumber", "unit", "warehouse"]);
    }
  });

  it("«Sold final» nu e acceptat ca stoc: lipsa «Stoc final» e eroare, cu coloana numită", async () => {
    const aoa: unknown[][] = [
      ["Gestiune", "Cod", "U.M.", "Sold final"],
      ["Depozit Test", "00123", "BUC", 100],
    ];
    const error = await readStockReportFile(workbookBuffer([aoa])).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "STOCK_REPORT_FILE_COLUMNS_MISSING",
      details: { missing: ["Stoc final"] },
    });
  });

  it("citește doar prima foaie", async () => {
    const first = reportAoa({ rows: [row()] });
    const second = reportAoa({ rows: [row({ code: "DIN-A-DOUA-FOAIE" })] });
    const result = await readStockReportFile(workbookBuffer([first, second]));
    expect(result.rows.map((r) => r.code)).toEqual(["00123"]);
  });

  it.each(FORMATS)(
    "prima foaie goală și a doua cu date: eroare, nu trece pe a doua foaie (%s)",
    async (format) => {
      const file = workbookBuffer([[], reportAoa({ rows: [row()] })], format);
      expect(await codeOf(readStockReportFile(file))).toBe("STOCK_REPORT_FILE_EMPTY");
    },
  );

  it("antet fără rânduri de date: rezultat gol (planul hotărăște), nu eroare de citire", async () => {
    const result = await readStockReportFile(buildReport({ rows: [], total: false }));
    expect(result.rows).toEqual([]);
    expect(result.counters).toEqual({ dataRows: 0, blankRows: 0, totalRows: 0 });
  });

  it("calculează amprenta SHA-256 a fișierului și nu modifică octeții primiți", async () => {
    const file = buildReport({ rows: [row()] });
    const before = Buffer.from(file);
    const result = await readStockReportFile(file);
    expect(result.fileHash).toBe(createHash("sha256").update(before).digest("hex"));
    expect(result.byteLength).toBe(before.length);
    expect(file.equals(before)).toBe(true);
  });

  it("acceptă și un ArrayBuffer", async () => {
    const file = buildReport({ rows: [row()] });
    const copy = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
    const result = await readStockReportFile(copy as ArrayBuffer);
    expect(result.rows).toHaveLength(1);
  });
});

describe("readStockReportFile: data din antetul raportului", () => {
  const dateOf = async (cells: unknown[] | null, format: ReportFormat = "xlsx") => {
    const aoa = reportAoa({ rows: [row()], dateText: null });
    if (cells) aoa[4] = cells;
    return (await readStockReportFile(workbookBuffer([aoa], format))).fileDate;
  };

  it.each(["Data: 28.10.2026", "Data:28.10.2026", "DATA : 28.10.2026", "Data 28.10.2026"])(
    "citește «%s»",
    async (text) => {
      expect(await dateOf([text])).toEqual({ year: 2026, month: 10, day: 28 });
    },
  );

  it("citește și separatorii / și -, cu zi și lună fără zero în față", async () => {
    expect(await dateOf(["Data: 5/3/2026"])).toEqual({ year: 2026, month: 3, day: 5 });
    expect(await dateOf(["Data: 05-03-2026"])).toEqual({ year: 2026, month: 3, day: 5 });
  });

  it("etichetă și dată în celule alăturate (text sau dată Excel)", async () => {
    expect(await dateOf(["Data:", "28.10.2026"])).toEqual({ year: 2026, month: 10, day: 28 });
    const serial = (Date.UTC(2026, 9, 28) - Date.UTC(1899, 11, 30)) / 86_400_000;
    const aoa = reportAoa({ rows: [row()], dateText: null });
    aoa[4] = ["Data:", serial];
    const file = workbookBuffer([aoa], "xlsx", (sheet) => {
      setCell(sheet, "B5", { t: "n", v: serial, z: "dd.mm.yyyy" });
    });
    expect((await readStockReportFile(file)).fileDate).toEqual({ year: 2026, month: 10, day: 28 });
  });

  it("funcționează la fel în .xls", async () => {
    expect(await dateOf(["Data: 28.10.2026"], "xls")).toEqual({ year: 2026, month: 10, day: 28 });
  });

  it("fără rând «Data»: nu se ghicește din alte date din titlu (data tipăririi)", async () => {
    expect(await dateOf(null)).toBeNull();
    expect(await dateOf(["Perioada 01.10.2026"])).toBeNull();
  });

  it("dată care nu există în calendar sau cu anul pe 2 cifre: ignorată", async () => {
    expect(await dateOf(["Data: 31.02.2026"])).toBeNull();
    expect(await dateOf(["Data: 28.10.26"])).toBeNull();
    expect(await dateOf(["Data: 00.10.2026"])).toBeNull();
  });

  it("an în afara intervalului 1900–2200: dată ignorată", async () => {
    expect(await dateOf(["Data: 01.01.1850"])).toBeNull();
    expect(await dateOf(["Data: 01.01.2250"])).toBeNull();
  });

  it("două date diferite cu eticheta «Data»: ambiguu, deci nicio dată", async () => {
    const aoa = reportAoa({ rows: [row()], dateText: "Data: 28.10.2026" });
    aoa[2] = ["Data: 27.10.2026"];
    const file = workbookBuffer([aoa]);
    expect((await readStockReportFile(file)).fileDate).toBeNull();
  });

  it("aceeași dată scrisă de două ori: rămâne data", async () => {
    const aoa = reportAoa({ rows: [row()], dateText: "Data: 28.10.2026" });
    aoa[2] = ["Data: 28.10.2026"];
    expect((await readStockReportFile(workbookBuffer([aoa]))).fileDate).toEqual({
      year: 2026,
      month: 10,
      day: 28,
    });
  });

  it("o «Data» scrisă sub antet (în datele raportului) nu contează", async () => {
    const aoa = reportAoa({ rows: [row()], dateText: null });
    aoa.push(["Data: 28.10.2026"]);
    expect((await readStockReportFile(workbookBuffer([aoa]))).fileDate).toBeNull();
  });
});

describe("readStockReportFile: celule ciudate (cod, cantitate)", () => {
  /** Citește un fișier cu UN rând de date, cu celula din coloana `column` înlocuită de `cell`. */
  const readWith = async (
    format: ReportFormat,
    column: number,
    cell: Parameters<typeof setCell>[2] | null,
    base: Partial<FabricatedRow> = {},
  ) => {
    const file = buildReport({ format, rows: [row(base)] }, (sheet) => {
      if (cell) setCell(sheet, at(column, 0), cell);
    });
    return (await readStockReportFile(file)).rows[0];
  };

  it.each(FORMATS)(
    "cantitatea vine din valoarea exactă, nu din formatul afișat (%s)",
    async (format) => {
      const out = await readWith(format, 4, { t: "n", v: 2.348, z: "0.00" });
      expect(out?.quantity).toBe("2.348");
    },
  );

  it.each(FORMATS)("numere: întregi, zecimale, negative, zero (%s)", async (format) => {
    for (const [value, text] of [
      [12, "12"],
      [0.5, "0.5"],
      [-3, "-3"],
      [0, "0"],
      [1234567.0625, "1234567.0625"],
    ] as const) {
      expect((await readWith(format, 4, { t: "n", v: value }))?.quantity).toBe(text);
    }
  });

  it("un număr cu zeci de zecimale (zgomot de virgulă mobilă) rămâne text exact, nerotunjit", async () => {
    const out = await readWith("xlsx", 4, { t: "n", v: 0.1 + 0.2 });
    expect(out?.quantity).toBe("0.30000000000000004");
  });

  it("un număr uriaș rămâne în forma lui științifică, pe care planul o respinge", async () => {
    const out = await readWith("xlsx", 4, { t: "n", v: 1e21 });
    expect(out?.quantity).toBe("1e+21");
  });

  it.each(FORMATS)("cantitate scrisă ca TEXT: trecută mai departe, tăiată (%s)", async (format) => {
    expect((await readWith(format, 4, { t: "s", v: " 12,5 " }))?.quantity).toBe("12,5");
    expect((await readWith(format, 4, { t: "s", v: "7.250" }))?.quantity).toBe("7.250");
    expect((await readWith(format, 4, { t: "s", v: "douăsprezece" }))?.quantity).toBe(
      "douăsprezece",
    );
  });

  it.each(FORMATS)("cantitate goală sau doar spații: null (%s)", async (format) => {
    expect((await readWith(format, 4, null, { quantity: null }))?.quantity).toBeNull();
    expect((await readWith(format, 4, { t: "s", v: "   " }))?.quantity).toBeNull();
  });

  it.each(FORMATS)(
    "cantitate booleană sau eroare de celulă: text, nu număr (%s)",
    async (format) => {
      expect((await readWith(format, 4, { t: "b", v: true }))?.quantity).toBe("TRUE");
      expect((await readWith(format, 4, { t: "e", v: 42 }))?.quantity).toBe("#N/A");
    },
  );

  it.each(FORMATS)("cantitate cu format de dată: text, nu numărul serial (%s)", async (format) => {
    const out = await readWith(format, 4, { t: "n", v: 46323, z: "dd.mm.yyyy" });
    expect(out?.quantity).toMatch(/\D/);
    expect(out?.quantity).not.toBe("46323");
  });

  it.each(FORMATS)(
    "codul numeric își păstrează zerourile din formatul celulei (%s)",
    async (format) => {
      expect((await readWith(format, 2, { t: "n", v: 123, z: "00000" }))?.code).toBe("00123");
      expect((await readWith(format, 2, { t: "n", v: 123 }))?.code).toBe("123");
    },
  );

  it.each(FORMATS)(
    "codul text își păstrează zerourile din față și se taie (%s)",
    async (format) => {
      expect((await readWith(format, 2, { t: "s", v: "  000456 " }))?.code).toBe("000456");
    },
  );

  it("cantitatea cu format «0000» rămâne valoarea exactă, fără zerouri adăugate", async () => {
    for (const format of FORMATS) {
      expect((await readWith(format, 4, { t: "n", v: 12, z: "0000" }))?.quantity).toBe("12");
    }
  });

  it("un rând «Total gestiune …» fără cod nu e rândul «Total»: rămâne rând de date", async () => {
    const aoa = reportAoa({ rows: [row()], total: false });
    aoa.push(["Total gestiune Depozit Test", null, null, null, 7, 1, 1]);
    const result = await readStockReportFile(workbookBuffer([aoa]));
    expect(result.counters.totalRows).toBe(0);
    expect(result.rows.map((r) => r.warehouse)).toEqual([
      "Depozit Test",
      "Total gestiune Depozit Test",
    ]);
  });

  it("cod, gestiune, unitate goale: null (planul le raportează)", async () => {
    const file = buildReport({ rows: [{ warehouse: null, code: null, unit: null, quantity: 3 }] });
    const out = (await readStockReportFile(file)).rows[0];
    expect(out).toEqual({ rowNumber: 11, warehouse: null, code: null, unit: null, quantity: "3" });
  });

  it("text care începe cu «=» sau «@» rămâne text, nu se evaluează și nu se modifică", async () => {
    const evil = "=cmd|' /C calc'!A0";
    const out = await readWith("xlsx", 2, { t: "s", v: evil });
    expect(out?.code).toBe(evil);
    expect((await readWith("xlsx", 3, { t: "s", v: "@SUM(1+1)" }))?.unit).toBe("@SUM(1+1)");
  });
});

describe("readStockReportFile: formule", () => {
  it("formula nu se evaluează și nu se citește: contează doar valoarea păstrată în celulă", async () => {
    const file = buildReport({ rows: [row()] }, (sheet) => {
      setCell(sheet, at(4, 0), { t: "n", v: 5, f: "2+3+SECRET_FORMULA" });
      setCell(sheet, at(2, 0), {
        t: "s",
        v: "00123",
        f: 'HYPERLINK("http://exemplu.invalid","x")',
      });
    });
    const result = await readStockReportFile(file);
    expect(result.rows[0]).toMatchObject({ code: "00123", quantity: "5" });
    expect(JSON.stringify(result)).not.toContain("SECRET_FORMULA");
    expect(JSON.stringify(result)).not.toContain("HYPERLINK");
  });

  it("formulă fără valoare păstrată: nu se calculează; cantitatea devine text nevalid", async () => {
    const file = buildReport({ rows: [row()] }, (sheet) => {
      setCell(sheet, at(4, 0), { t: "n", f: "A1+1" } as never);
    });
    const out = (await readStockReportFile(file)).rows[0];
    expect(out?.quantity === null || /\D/.test(out?.quantity ?? "")).toBe(true);
    expect(out?.quantity).not.toBe("1");
  });
});

describe("readStockReportFile: erori de structură", () => {
  it("foaie complet goală", async () => {
    expect(await codeOf(readStockReportFile(workbookBuffer([[]])))).toBe("STOCK_REPORT_FILE_EMPTY");
    expect(await codeOf(readStockReportFile(workbookBuffer([[]], "xls")))).toBe(
      "STOCK_REPORT_FILE_EMPTY",
    );
  });

  it("antet lipsă: niciun rând nu seamănă cu antetul", async () => {
    const aoa: unknown[][] = [["Raport"], ["Altceva", "Altceva 2"], ["a", "b"]];
    expect(await codeOf(readStockReportFile(workbookBuffer([aoa])))).toBe(
      "STOCK_REPORT_FILE_HEADER_NOT_FOUND",
    );
  });

  it("antet incomplet: spune ce coloane lipsesc, în ordinea antetului", async () => {
    const aoa: unknown[][] = [
      ["Gestiune", "Produs", "Stoc final"],
      ["Depozit Test", "x", 3],
    ];
    const error = await readStockReportFile(workbookBuffer([aoa])).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "STOCK_REPORT_FILE_COLUMNS_MISSING",
      details: { missing: ["Cod", "U.M."] },
    });
  });

  it("un singur nume de coloană într-un rând nu face un antet", async () => {
    const aoa: unknown[][] = [["Gestiune"], ["a", "b"]];
    expect(await codeOf(readStockReportFile(workbookBuffer([aoa])))).toBe(
      "STOCK_REPORT_FILE_HEADER_NOT_FOUND",
    );
  });

  it("coloană cerută de două ori în antet: ambiguu", async () => {
    const aoa: unknown[][] = [
      [...SMARTBILL_HEADER, "Cod"],
      ["Depozit Test", "x", "1", "BUC", 3, 5, 0, "2"],
    ];
    const error = await readStockReportFile(workbookBuffer([aoa])).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "STOCK_REPORT_FILE_COLUMNS_AMBIGUOUS",
      details: { columns: ["Cod"] },
    });
  });

  it("mesajele de eroare nu conțin valori din fișier", async () => {
    const aoa: unknown[][] = [
      ["FIRMA-SECRETA SRL"],
      ["Gestiune", "Alt-antet-SECRET"],
      ["VALOARE-SECRETA"],
    ];
    const error = (await readStockReportFile(workbookBuffer([aoa])).catch(
      (e: unknown) => e,
    )) as Error & {
      details?: unknown;
    };
    const text = `${error.message} ${JSON.stringify(error.details ?? {})}`;
    expect(text).not.toContain("SECRET");
  });
});

describe("readStockReportFile: fișiere prea mari sau suspecte", () => {
  const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

  it("peste 5 MB: respins înainte de orice citire", async () => {
    expect(STOCK_REPORT_MAX_BYTES).toBe(5 * 1024 * 1024);
    const big = Buffer.concat([ZIP, Buffer.alloc(STOCK_REPORT_MAX_BYTES + 1 - ZIP.length)]);
    expect(await codeOf(readStockReportFile(big))).toBe("STOCK_REPORT_FILE_TOO_LARGE");
  });

  it("exact 5 MB nu e «prea mare» (e respins pentru alt motiv: nu e un registru valid)", async () => {
    const edge = Buffer.concat([OLE, Buffer.alloc(STOCK_REPORT_MAX_BYTES - OLE.length)]);
    expect(await codeOf(readStockReportFile(edge))).not.toBe("STOCK_REPORT_FILE_TOO_LARGE");
  });

  it("fișier gol sau prea scurt: nu e Excel", async () => {
    expect(await codeOf(readStockReportFile(Buffer.alloc(0)))).toBe(
      "STOCK_REPORT_FILE_NOT_SPREADSHEET",
    );
    expect(await codeOf(readStockReportFile(Buffer.from([0x50, 0x4b])))).toBe(
      "STOCK_REPORT_FILE_NOT_SPREADSHEET",
    );
  });

  it.each([
    ["CSV", "Gestiune;Produs;Cod;U.M.;Stoc final\nDepozit;x;1;BUC;3\n"],
    ["HTML", "<html><body><table><tr><td>Gestiune</td></tr></table></body></html>"],
    ["XML (SpreadsheetML)", '<?xml version="1.0"?><Workbook/>'],
    ["PDF", "%PDF-1.7\n1 0 obj\n"],
    ["text oarecare", "Acesta nu este un registru de calcul."],
  ])("%s redenumit .xls: respins, deși SheetJS l-ar citi", async (_name, text) => {
    expect(await codeOf(readStockReportFile(Buffer.from(text)))).toBe(
      "STOCK_REPORT_FILE_NOT_SPREADSHEET",
    );
  });

  it.each(["xlsb", "ods"] as const)("arhivă ZIP care nu e .xlsx (%s): respinsă", async (type) => {
    const file = workbookBuffer([reportAoa({ rows: [row()] })], type);
    expect(file.subarray(0, 4).equals(ZIP)).toBe(true);
    expect(await codeOf(readStockReportFile(file))).toBe("STOCK_REPORT_FILE_NOT_SPREADSHEET");
  });

  it("ZIP trunchiat (fără sfârșitul arhivei): nu e un registru valid", async () => {
    const file = buildReport({ rows: [row()] });
    const cut = file.subarray(0, Math.floor(file.length / 2));
    expect(await codeOf(readStockReportFile(cut))).toBe("STOCK_REPORT_FILE_NOT_SPREADSHEET");
  });

  it(".xls trunchiat: eroare de fișier, nu rezultat parțial", async () => {
    const file = buildReport({ format: "xls", rows: [row(), row({ code: "B-2" })] });
    const cut = file.subarray(0, Math.floor(file.length / 3));
    const code = await codeOf(readStockReportFile(cut));
    expect(code).toMatch(/^STOCK_REPORT_FILE_/);
  });

  it("arhivă .xlsx care declară conținut uriaș (bombă ZIP): respinsă fără decomprimare", async () => {
    const file = buildReport({ rows: [row()] });
    const bomb = Buffer.from(file);
    let patched = 0;
    for (let i = 0; i + 46 < bomb.length; i += 1) {
      if (bomb.readUInt32LE(i) === 0x02014b50) {
        bomb.writeUInt32LE(0x7fffffff, i + 24);
        patched += 1;
      }
    }
    expect(patched).toBeGreaterThan(0);
    expect(await codeOf(readStockReportFile(bomb))).toBe("STOCK_REPORT_FILE_UNSAFE");
  });

  it("arhivă cu prea multe intrări: respinsă", async () => {
    const file = Buffer.from(buildReport({ rows: [row()] }));
    const eocd = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(eocd).toBeGreaterThan(0);
    file.writeUInt16LE(60_000, eocd + 8);
    file.writeUInt16LE(60_000, eocd + 10);
    expect(await codeOf(readStockReportFile(file))).toBe("STOCK_REPORT_FILE_UNSAFE");
  });

  it("arhivă ZIP64 (poziția directorului nu încape în 32 de biți): respinsă", async () => {
    const file = Buffer.from(buildReport({ rows: [row()] }));
    const eocd = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    file.writeUInt32LE(0xffffffff, eocd + 16);
    expect(await codeOf(readStockReportFile(file))).toBe("STOCK_REPORT_FILE_UNSAFE");
  });

  it("arhivă cu intrări criptate: respinsă", async () => {
    const file = Buffer.from(buildReport({ rows: [row()] }));
    for (let i = 0; i + 46 < file.length; i += 1) {
      if (file.readUInt32LE(i) === 0x02014b50)
        file.writeUInt16LE(file.readUInt16LE(i + 8) | 1, i + 8);
    }
    expect(await codeOf(readStockReportFile(file))).toBe("STOCK_REPORT_FILE_UNSAFE");
  });

  it("registru protejat cu parolă: mesaj dedicat", async () => {
    const cfb = XLSX.CFB.utils.cfb_new();
    XLSX.CFB.utils.cfb_add(cfb, "EncryptionInfo", Buffer.from([4, 0, 4, 0, 0x40, 0, 0, 0]));
    XLSX.CFB.utils.cfb_add(cfb, "EncryptedPackage", Buffer.alloc(64));
    const file = XLSX.CFB.write(cfb, { type: "buffer" }) as Buffer;
    expect(await codeOf(readStockReportFile(file))).toBe("STOCK_REPORT_FILE_PASSWORD");
  });

  it("foaia are mai multe rânduri decât limita: respinsă", async () => {
    const limit = STOCK_REPORT_MAX_SHEET_ROWS;
    const data = (count: number): unknown[][] => [
      ["Gestiune", "Cod", "U.M.", "Stoc final"],
      ...Array.from({ length: count - 1 }, (_, i) => ["D", `C${i}`, "BUC", 1]),
    ];
    const ok = await readStockReportFile(workbookBuffer([data(limit)]));
    expect(ok.rows).toHaveLength(limit - 1);
    expect(await codeOf(readStockReportFile(workbookBuffer([data(limit + 1)])))).toBe(
      "STOCK_REPORT_FILE_TOO_MANY_ROWS",
    );
  }, 60_000);
});

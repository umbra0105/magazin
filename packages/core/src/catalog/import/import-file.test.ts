import { strToU8, unzipSync, zipSync } from "fflate";
import writeExcelFile from "write-excel-file/node";
import { describe, expect, it } from "vitest";
import { encodeWindows1250 } from "../../../test/windows-1250";
import { toCsv } from "./import-csv";
import { IMPORT_FIELDS, suggestMapping } from "./import-fields";
import { buildTemplate } from "./import-template";
import {
  DEFAULT_IMPORT_LIMITS,
  detectDelimiter,
  detectFormat,
  parseCsv,
  parseImportFile,
  sanitizeXlsx,
  type ImportLimits,
} from "./import-file";

const limits: ImportLimits = { ...DEFAULT_IMPORT_LIMITS };
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("parseCsv", () => {
  it("câmpuri simple, ghilimele, ghilimele duble și linii noi în celule", () => {
    const text = 'a,b,c\r\n1,"x, y","ea a zis ""da"""\r\n2,"linia 1\nlinia 2",\r\n';
    expect(parseCsv(text, ",", limits)).toEqual([
      ["a", "b", "c"],
      ["1", "x, y", 'ea a zis "da"'],
      ["2", "linia 1\nlinia 2", ""],
    ]);
  });

  it("acceptă LF, CRLF și CR; ultimul rând fără linie nouă; delimitator ; și tab", () => {
    expect(parseCsv("a;b\n1;2\r3;4", ";", limits)).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(parseCsv("a\tb\n1\t2", "\t", limits)).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("o ghilimea în mijlocul unui câmp necitat rămâne literală", () => {
    expect(parseCsv('a,5" tub,c', ",", limits)).toEqual([["a", '5" tub', "c"]]);
  });

  it("refuză ghilimelele neînchise", () => {
    expect(() => parseCsv('a,"neînchis\n1,2', ",", limits)).toThrowError(/ghilimele neînchise/);
  });

  it("aplică limitele de rânduri, coloane și lungime de celulă", () => {
    const small: ImportLimits = { ...limits, maxRows: 2, maxColumns: 3, maxCellLength: 5 };
    expect(() => parseCsv("a\n1\n2\n3\n", ",", small)).toThrowError(/rânduri/);
    expect(() => parseCsv("a,b,c,d\n", ",", small)).toThrowError(/coloane/);
    expect(() => parseCsv("a\ndestul de lung\n", ",", small)).toThrowError(/depășește 5/);
    expect(() => parseCsv('a\n"destul de lung"\n', ",", small)).toThrowError(/depășește 5/);
  });
});

describe("detectDelimiter și detectFormat", () => {
  it("alege delimitatorul cel mai frecvent din antet, în afara ghilimelelor", () => {
    expect(detectDelimiter("SKU;Titlu;Preț\n1;2;3")).toBe(";");
    expect(detectDelimiter("SKU,Titlu,Preț\n1,2,3")).toBe(",");
    expect(detectDelimiter("SKU\tTitlu\tPreț")).toBe("\t");
    expect(detectDelimiter('"a;b;c",x,y')).toBe(",");
    expect(detectDelimiter("fără delimitator")).toBe(",");
  });

  it("recunoaște formatul din octeți, nu din extensie", () => {
    expect(detectFormat(bytes("a,b\n1,2"))).toBe("csv");
    expect(detectFormat(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]))).toBe("xlsx");
    expect(() => detectFormat(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1]))).toThrowError(/\.xls/);
    expect(() => detectFormat(new Uint8Array([0xff, 0xfe, 0x61, 0]))).toThrowError(/UTF-16/);
    expect(() => detectFormat(new Uint8Array([0x61, 0x00, 0x62]))).toThrowError(/nu e un CSV/);
    expect(() => detectFormat(new Uint8Array())).toThrowError(/gol/);
  });
});

describe("parseImportFile (CSV)", () => {
  it("citește un CSV cu BOM și delimitator ;, scoate rândurile goale, păstrează numărul rândului", async () => {
    const table = await parseImportFile(
      bytes("﻿SKU;Titlu;Preț\r\nA1;Pompă;199,90\r\n;;\r\nA2;Filtru;50\r\n"),
      limits,
    );
    expect(table).toMatchObject({
      format: "csv",
      delimiter: ";",
      encoding: "utf-8",
      headers: ["SKU", "Titlu", "Preț"],
      rows: [
        ["A1", "Pompă", "199,90"],
        ["A2", "Filtru", "50"],
      ],
      rowNumbers: [2, 4],
      warnings: [],
    });
  });

  it("completează rândurile scurte, taie antetul gol de la coadă și respectă delimitatorul cerut", async () => {
    const table = await parseImportFile(bytes("SKU,Titlu,\nA1\nA2,x,y"), limits, {
      delimiter: ",",
    });
    expect(table.headers).toEqual(["SKU", "Titlu"]);
    expect(table.rows).toEqual([
      ["A1", ""],
      ["A2", "x"],
    ]);
  });

  it("Windows-1250 când nu e UTF-8 valid, cu avertisment", async () => {
    // „Pompă” în Windows-1250: ă = 0xE3
    const table = await parseImportFile(
      new Uint8Array([...bytes("SKU;Titlu\nA1;Pomp"), 0xe3]),
      limits,
    );
    expect(table.encoding).toBe("windows-1250");
    expect(table.rows[0]).toEqual(["A1", "Pompă"]);
    expect(table.warnings[0]).toMatch(/Windows-1250/);
  });

  it("elimină caracterele de control și refuză fișierul fără rânduri de date", async () => {
    const table = await parseImportFile(bytes("SKU,Titlu\nA1,a\u0007b"), limits);
    expect(table.rows[0]).toEqual(["A1", "ab"]);
    await expect(parseImportFile(bytes("SKU,Titlu\n"), limits)).rejects.toMatchObject({
      code: "IMPORT_FILE_EMPTY",
    });
    await expect(parseImportFile(bytes(",,\n1,2,3"), limits)).rejects.toMatchObject({
      code: "IMPORT_FILE_EMPTY",
    });
  });
});

async function xlsxOf(rows: string[][]): Promise<Uint8Array> {
  const buffer = await writeExcelFile(
    rows.map((row) => row.map((value) => ({ value, type: String }))),
  ).toBuffer();
  return new Uint8Array(buffer);
}

describe("parseImportFile (XLSX)", () => {
  it("citește prima foaie; textul rămâne text (zerourile de la început se păstrează)", async () => {
    const file = await xlsxOf([
      ["SKU", "EAN", "Preț"],
      ["A1", "05901234123457", "199,90"],
    ]);
    const table = await parseImportFile(file, limits);
    expect(table).toMatchObject({ format: "xlsx", delimiter: null, encoding: null });
    expect(table.headers).toEqual(["SKU", "EAN", "Preț"]);
    expect(table.rows).toEqual([["A1", "05901234123457", "199,90"]]);
    expect(table.rowNumbers).toEqual([2]);
  });

  it("numerele devin text zecimal, fără exponent pentru valori obișnuite", async () => {
    const buffer = await writeExcelFile([
      [{ value: "SKU" }, { value: "Preț" }],
      [
        { value: "A1", type: String },
        { value: 199.9, type: Number },
      ],
      [
        { value: "A2", type: String },
        { value: 1250, type: Number },
      ],
    ]).toBuffer();
    const table = await parseImportFile(new Uint8Array(buffer), limits);
    expect(table.rows).toEqual([
      ["A1", "199.9"],
      ["A2", "1250"],
    ]);
  });

  it("formula: se citește valoarea din cache, nu se evaluează", async () => {
    const base = unzipSync(
      await xlsxOf([
        ["SKU", "X"],
        ["A1", "1"],
      ]),
    );
    const sheet = strToU8(
      `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
        `<row r="1"><c r="A1" t="inlineStr"><is><t>SKU</t></is></c><c r="B1" t="inlineStr"><is><t>X</t></is></c></row>` +
        `<row r="2"><c r="A2" t="inlineStr"><is><t>A1</t></is></c><c r="B2"><f>1+1</f><v>99</v></c></row>` +
        `<row r="3"><c r="A3" t="inlineStr"><is><t>A2</t></is></c><c r="B3"><f>HYPERLINK("http://x","y")</f></c></row>` +
        `</sheetData></worksheet>`,
    );
    const file = zipSync({ ...base, "xl/worksheets/sheet1.xml": sheet });
    const table = await parseImportFile(file, limits);
    expect(table.rows).toEqual([
      ["A1", "99"],
      ["A2", ""],
    ]);
  });

  it("refuză fișierul deteriorat și macro-urile", async () => {
    await expect(
      parseImportFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), limits),
    ).rejects.toMatchObject({ code: "IMPORT_FILE_CORRUPT" });
    const base = unzipSync(await xlsxOf([["SKU"], ["A1"]]));
    const withMacros = zipSync({ ...base, "xl/vbaProject.bin": new Uint8Array([1, 2, 3]) });
    await expect(parseImportFile(withMacros, limits)).rejects.toMatchObject({
      code: "IMPORT_FILE_MACROS",
    });
  });

  it("păstrează doar intrările necesare (restul se aruncă la curățare)", async () => {
    const base = unzipSync(await xlsxOf([["SKU"], ["A1"]]));
    const noisy = zipSync({
      ...base,
      "xl/media/image1.png": new Uint8Array(1000),
      "xl/externalLinks/externalLink1.xml": strToU8("<x/>"),
      "docProps/app.xml": strToU8("<x/>"),
    });
    const names = Object.keys(unzipSync(sanitizeXlsx(noisy, limits))).sort();
    expect(names.some((n) => n.includes("media") || n.includes("externalLinks"))).toBe(false);
    expect(names.some((n) => n.startsWith("docProps"))).toBe(false);
    expect(names).toContain("xl/workbook.xml");
    expect(names).toContain("xl/worksheets/sheet1.xml");
  });
});

describe("protecție împotriva arhivelor-bombă", () => {
  it("refuză o foaie al cărei conținut decomprimat depășește plafonul, fără să o decomprime", async () => {
    const base = unzipSync(await xlsxOf([["SKU"], ["A1"]]));
    const bomb = zipSync(
      { ...base, "xl/worksheets/sheet1.xml": new Uint8Array(30 * 1024 * 1024) },
      { level: 9 },
    );
    expect(bomb.length).toBeLessThan(100 * 1024);
    const strict: ImportLimits = { ...limits, maxUncompressedBytes: 5 * 1024 * 1024 };
    await expect(parseImportFile(bomb, strict)).rejects.toMatchObject({
      code: "IMPORT_FILE_TOO_LARGE",
    });
  });

  it("dimensiunea declarată mincinoasă nu ocolește plafonul: ce se citește e tăiat la dimensiunea declarată", () => {
    const z = zipSync(
      {
        "xl/workbook.xml": strToU8("<workbook/>"),
        "xl/worksheets/sheet1.xml": new Uint8Array(20 * 1024 * 1024),
      },
      { level: 9 },
    );
    const view = new DataView(z.buffer, z.byteOffset, z.byteLength);
    // dimensiunea necomprimată declarată: 1000, în antetul local și în directorul central
    for (let i = 0; i < z.length - 46; i++) {
      if (view.getUint32(i, true) === 0x04034b50) {
        const nameLength = view.getUint16(i + 26, true);
        const name = new TextDecoder().decode(z.subarray(i + 30, i + 30 + nameLength));
        if (name === "xl/worksheets/sheet1.xml") view.setUint32(i + 22, 1000, true);
      }
      if (view.getUint32(i, true) === 0x02014b50) {
        const nameLength = view.getUint16(i + 28, true);
        const name = new TextDecoder().decode(z.subarray(i + 46, i + 46 + nameLength));
        if (name === "xl/worksheets/sheet1.xml") view.setUint32(i + 24, 1000, true);
      }
    }
    const clean = sanitizeXlsx(z, limits);
    expect(unzipSync(clean)["xl/worksheets/sheet1.xml"]?.length).toBe(1000);
  });

  it("refuză o arhivă cu prea multe intrări", () => {
    const many: Record<string, Uint8Array> = { "xl/workbook.xml": strToU8("<workbook/>") };
    for (let i = 0; i < 150; i++) many[`xl/extra/${i}.xml`] = strToU8("<x/>");
    expect(() => sanitizeXlsx(zipSync(many), limits)).toThrowError(/prea multe componente/);
  });

  it("limitele de rânduri se aplică și la XLSX", async () => {
    const rows = [["SKU"], ...Array.from({ length: 6 }, (_, i) => [`A${i}`])];
    await expect(
      parseImportFile(await xlsxOf(rows), { ...limits, maxRows: 5 }),
    ).rejects.toMatchObject({
      code: "IMPORT_FILE_TOO_MANY_ROWS",
    });
  });
});

describe("linia «sep=» (convenția Excel)", () => {
  it("șablonul CSV generat de aplicație se importă fără avertismente; «sep=» nu devine antet", async () => {
    const template = await buildTemplate("csv");
    // BOM UTF-8, apoi linia sep=
    expect([...template.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(template.subarray(3, 12))).toBe("sep=;\r\nSK");
    const table = await parseImportFile(template, limits);
    expect(table).toMatchObject({
      delimiter: ";",
      delimiterSource: "sep-line",
      encoding: "utf-8",
      warnings: [],
    });
    expect(table.headers).toEqual(IMPORT_FIELDS.map((f) => f.label));
    expect(table.headers[0]).toBe("SKU");
    expect(table.rows).toHaveLength(2);
    // antetul rămâne rândul 1 (Excel nu afișează linia sep=)
    expect(table.rowNumbers).toEqual([2, 3]);
    expect(suggestMapping(table.headers).map((c) => c.field)).toEqual(
      IMPORT_FIELDS.map((f) => f.key),
    );
  });

  it("respectă un alt caracter: «sep=,» și «sep=<tab>», chiar dacă primul rând ar sugera altceva", async () => {
    const comma = await parseImportFile(bytes("sep=,\r\na;b;c,d\r\n1;2;3,4\r\n"), limits);
    expect(comma).toMatchObject({ delimiter: ",", delimiterSource: "sep-line" });
    expect(comma.headers).toEqual(["a;b;c", "d"]);
    const tab = await parseImportFile(bytes("sep=\t\nSKU\tTitlu\nA1\tb\n"), limits);
    expect(tab).toMatchObject({ delimiter: "\t", delimiterSource: "sep-line" });
    expect(tab.headers).toEqual(["SKU", "Titlu"]);
    // majuscule, spații după, linie nouă CR
    const odd = await parseImportFile(bytes("SEP=;  \rSKU;Titlu\rA1;b\r"), limits);
    expect(odd).toMatchObject({ delimiter: ";", headers: ["SKU", "Titlu"] });
  });

  it("alegerea explicită a delimitatorului bate linia sep=, iar linia tot nu devine antet", async () => {
    const table = await parseImportFile(bytes("sep=;\r\nSKU,Titlu\r\nA1,b\r\n"), limits, {
      delimiter: ",",
    });
    expect(table).toMatchObject({ delimiter: ",", delimiterSource: "chosen" });
    expect(table.headers).toEqual(["SKU", "Titlu"]);
  });

  it("un delimitator pe care importul nu îl poate folosi e refuzat cu mesaj clar", async () => {
    await expect(
      parseImportFile(bytes("sep=|\r\nSKU|Titlu\r\nA|b\r\n"), limits),
    ).rejects.toMatchObject({ code: "IMPORT_FILE_UNSUPPORTED" });
  });

  it("un fișier fără linie sep= merge ca până acum (delimitator detectat), iar un antet care seamănă nu e afectat", async () => {
    const plain = await parseImportFile(bytes("SKU;Titlu\r\nA1;b\r\n"), limits);
    expect(plain).toMatchObject({ delimiter: ";", delimiterSource: "detected" });
    expect(plain.headers).toEqual(["SKU", "Titlu"]);
    // «sep» fără «=», sau cu mai multe caractere după «=», sunt antete obișnuite
    const lookalike = await parseImportFile(bytes("sep;Titlu\r\nA1;b\r\n"), limits);
    expect(lookalike.headers).toEqual(["sep", "Titlu"]);
    const multi = await parseImportFile(bytes("sep=ab,Titlu\r\nA1,b\r\n"), limits);
    expect(multi.headers).toEqual(["sep=ab", "Titlu"]);
    // fără linie nouă după «sep=;» nu e o linie sep=
    expect((await parseImportFile(bytes("sep=;,x\r\nA,b\r\n"), limits)).headers[0]).toMatch(
      /^sep=/,
    );
  });
});

describe("CSV salvat din Excel pe un calculator cu separatorul «,» (Windows-1250)", () => {
  // ț și ș cu virgulă (forma corectă); Excel le salvează cu sedilă (ţ, ş), codul 0xFE / 0xBA
  const ti = String.fromCharCode(0x21b);
  const si = String.fromCharCode(0x219);
  const excelCsv = [
    '"SKU","Titlu","Preț (lei, cu TVA)","Categorii"',
    `"A1","Pompă de circula${ti}ie, ${si}i filtru","1299,50","Pompe > Circula${ti}ie"`,
    `"A2","Filtru","150,5",""`,
  ].join("\r\n");

  it("antetul în ghilimele cu virgulă înăuntru, diacritice românești și zecimale cu virgulă se citesc corect", async () => {
    const table = await parseImportFile(encodeWindows1250(excelCsv), limits);
    expect(table).toMatchObject({
      format: "csv",
      delimiter: ",",
      delimiterSource: "detected",
      encoding: "windows-1250",
    });
    expect(table.warnings[0]).toMatch(/Windows-1250/);
    expect(table.headers).toEqual(["SKU", "Titlu", "Preț (lei, cu TVA)", "Categorii"]);
    expect(table.rows[0]).toEqual([
      "A1",
      `Pompă de circula${ti}ie, ${si}i filtru`,
      "1299,50",
      `Pompe > Circula${ti}ie`,
    ]);
    expect(table.rows[1]).toEqual(["A2", "Filtru", "150,5", ""]);
    // antetul cu virgulă în interior se recunoaște ca preț
    expect(suggestMapping(table.headers).map((c) => c.field)).toEqual([
      "sku",
      "title",
      "price",
      "categories",
    ]);
  });

  it("ş și ţ cu sedilă (singurele din Windows-1250) devin ș și ț cu virgulă, forma corectă", async () => {
    const table = await parseImportFile(
      encodeWindows1250(`SKU,Titlu\r\nA1,${String.fromCharCode(0x15f, 0x163, 0x15e, 0x162)}\r\n`),
      limits,
    );
    expect(table.rows[0]?.[1]).toBe(String.fromCharCode(0x219, 0x21b, 0x218, 0x21a));
  });

  it("același fișier, salvat de Excel ca «CSV UTF-8», dă aceleași valori", async () => {
    const utf8 = await parseImportFile(
      new TextEncoder().encode(String.fromCharCode(0xfeff) + excelCsv),
      limits,
    );
    const legacy = await parseImportFile(encodeWindows1250(excelCsv), limits);
    expect(utf8.rows).toEqual(legacy.rows);
    expect(utf8.headers).toEqual(legacy.headers);
    expect(utf8.encoding).toBe("utf-8");
  });
});

describe("toCsv", () => {
  it("pune ghilimele unde trebuie și neutralizează celulele care ar fi formule", () => {
    const text = toCsv(
      [
        ["a", 'b"c', "d;e", "f\ng"],
        ["=SUM(A1)", "+1", "-1", "@x"],
      ],
      { delimiter: ";", bom: false, sep: false },
    );
    expect(text).toBe(`a;"b""c";"d;e";"f\ng"\r\n'=SUM(A1);'+1;'-1;'@x\r\n`);
  });

  it("începe implicit cu BOM UTF-8 și linia «sep=», apoi rândurile (Excel deschide corect fișierul)", () => {
    const bom = String.fromCharCode(0xfeff);
    expect(toCsv([["a", "b"]])).toBe(`${bom}sep=;\r\na;b\r\n`);
    expect(toCsv([["a", "b"]], { delimiter: "," })).toBe(`${bom}sep=,\r\na,b\r\n`);
    expect(toCsv([["a"]], { bom: false })).toBe("sep=;\r\na\r\n");
  });
});

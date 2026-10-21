import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_IMPORT_LIMITS, parseImportFile, type ImportLimits } from "./import-file";

/**
 * Regresii (Blocul C, C-01 și C-04): un XLSX mic NU are voie să ceară memorie sau timp disproporționat.
 *  - o celulă ocupată departe de date (ex. `XFD1048576`, 1,4 KB în total) făcea biblioteca de citire să aloce
 *    tabloul complet și procesul să cadă cu «JavaScript heap out of memory»;
 *  - un șir partajat de zeci de mii de caractere, referit de mii de celule, sau zeci de MB de spații în XML
 *    făceau citirea să dureze minute, deși fișierul e mic.
 * Cazurile periculoase rulează într-un proces copil cu heap de 192 MB: înainte de remediere procesul cădea
 * (ieșire fără JSON), acum fișierul e refuzat cu un cod stabil, în câteva secunde.
 */

const dir = mkdtempSync(join(tmpdir(), "ecom-xlsx-bounds-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CONTENT_TYPES = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`;
const ROOT_RELS = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
const WORKBOOK = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const WORKBOOK_RELS = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

function xlsx(sheetXml: string, extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(CONTENT_TYPES),
    "_rels/.rels": strToU8(ROOT_RELS),
    "xl/workbook.xml": strToU8(WORKBOOK),
    "xl/_rels/workbook.xml.rels": strToU8(WORKBOOK_RELS),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml),
    ...extra,
  });
}

const HEAD = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`;
const TAIL = `</sheetData></worksheet>`;
const inline = (ref: string, value: string) =>
  `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
const columnName = (index: number): string => {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    name = String.fromCharCode(65 + m) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
};

interface ChildResult {
  crashed: boolean;
  ok?: boolean;
  code?: string;
  rows?: number;
  ms: number;
}

/** Rulează `parseImportFile` într-un proces separat cu heap mic; un OOM = `crashed: true`. */
function parseInChild(
  bytes: Uint8Array,
  limits: ImportLimits = DEFAULT_IMPORT_LIMITS,
): ChildResult {
  const file = join(dir, `f-${Math.random().toString(36).slice(2)}.xlsx`);
  writeFileSync(file, bytes);
  const moduleUrl = new URL("./import-file.ts", import.meta.url).href;
  const script = `
    import { readFileSync } from "node:fs";
    import { parseImportFile } from ${JSON.stringify(moduleUrl)};
    try {
      const table = await parseImportFile(new Uint8Array(readFileSync(process.env.XLSX_FILE)), JSON.parse(process.env.XLSX_LIMITS));
      console.log("RESULT " + JSON.stringify({ ok: true, rows: table.rows.length }));
    } catch (error) {
      console.log("RESULT " + JSON.stringify({ ok: false, code: error.code ?? error.name }));
    }
  `;
  const started = Date.now();
  const run = spawnSync(
    process.execPath,
    ["--max-old-space-size=192", "--import", "tsx", "--input-type=module", "-e", script],
    {
      env: { ...process.env, XLSX_FILE: file, XLSX_LIMITS: JSON.stringify(limits) },
      encoding: "utf8",
      timeout: 90_000,
    },
  );
  const ms = Date.now() - started;
  const line = run.stdout.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) return { crashed: true, ms };
  return {
    crashed: false,
    ...(JSON.parse(line.slice(7)) as Omit<ChildResult, "crashed" | "ms">),
    ms,
  };
}

const TOO_BIG = [
  "IMPORT_FILE_TOO_MANY_ROWS",
  "IMPORT_FILE_TOO_MANY_COLUMNS",
  "IMPORT_FILE_TOO_LARGE",
];

describe("XLSX: forma foii nu poate cere memorie disproporționată (C-01)", () => {
  it("o celulă la XFD1048576 (1,4 KB) se refuză, nu doboară procesul", () => {
    const file = xlsx(
      `${HEAD}<row r="1">${inline("A1", "sku")}</row><row r="1048576">${inline("XFD1048576", "x")}</row>${TAIL}`,
    );
    expect(file.length).toBeLessThan(3_000);
    const result = parseInChild(file);
    expect(result.crashed).toBe(false);
    expect(result.ok).toBe(false);
    expect(TOO_BIG).toContain(result.code);
    expect(result.ms).toBeLessThan(30_000);
  }, 120_000);

  it("o celulă la rândul 1.000.000 se refuză cu «prea multe rânduri»", () => {
    const result = parseInChild(
      xlsx(
        `${HEAD}<row r="1">${inline("A1", "sku")}</row><row r="1000000">${inline("A1000000", "x")}</row>${TAIL}`,
      ),
    );
    expect(result.crashed).toBe(false);
    expect(result.code).toBe("IMPORT_FILE_TOO_MANY_ROWS");
  }, 120_000);

  it("o celulă pe coloana XFD, rândul 5001, se refuză cu «prea multe coloane»", () => {
    const result = parseInChild(
      xlsx(
        `${HEAD}<row r="1">${inline("A1", "sku")}</row><row r="5001">${inline("XFD5001", "x")}</row>${TAIL}`,
      ),
    );
    expect(result.crashed).toBe(false);
    expect(result.code).toBe("IMPORT_FILE_TOO_MANY_COLUMNS");
  }, 120_000);

  it("o celulă DOAR cu stil, departe de date, nu e o problemă (fără fals pozitiv)", async () => {
    const table = await parseImportFile(
      xlsx(
        `${HEAD}<row r="1">${inline("A1", "sku")}</row><row r="2">${inline("A2", "x")}</row><row r="1048576"><c r="XFD1048576" s="1"/></row>${TAIL}`,
      ),
      DEFAULT_IMPORT_LIMITS,
    );
    expect(table.headers).toEqual(["sku"]);
    expect(table.rows).toEqual([["x"]]);
  });

  it("un fișier obișnuit cu celule rare, în limite, se citește normal", async () => {
    const cells = `${inline("A1", "sku")}${inline("AD1", "col30")}`;
    const data = `${inline("A100", "S-1")}${inline("AD100", "x")}`;
    const table = await parseImportFile(
      xlsx(`${HEAD}<row r="1">${cells}</row><row r="100">${data}</row>${TAIL}`),
      DEFAULT_IMPORT_LIMITS,
    );
    expect(table.headers).toHaveLength(30);
    expect(table.rows).toHaveLength(1);
    expect(table.rowNumbers).toEqual([100]);
  });
});

describe("XLSX: costul nu poate fi disproporționat față de fișier (C-04)", () => {
  it("un șir partajat de 50.000 de caractere referit de 2.400 de celule se refuză (buget de text expandat)", () => {
    const rows = 12;
    const cols = 200;
    const sst = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>h</t></si><si><t>${"x".repeat(50_000)}</t></si></sst>`;
    let body = `<row r="1">${Array.from({ length: cols }, (_, c) => `<c r="${columnName(c)}1" t="s"><v>0</v></c>`).join("")}</row>`;
    for (let r = 2; r <= rows + 1; r++) {
      body += `<row r="${r}">${Array.from({ length: cols }, (_, c) => `<c r="${columnName(c)}${r}" t="s"><v>1</v></c>`).join("")}</row>`;
    }
    const file = xlsx(`${HEAD}${body}${TAIL}`, { "xl/sharedStrings.xml": strToU8(sst) });
    expect(file.length).toBeLessThan(100_000);
    const result = parseInChild(file);
    expect(result.crashed).toBe(false);
    expect(result.code).toBe("IMPORT_FILE_TOO_LARGE");
  }, 120_000);

  it("12 MB de spații în foaia XML se refuză, nu se parcurg", () => {
    const pad = " ".repeat(12 * 1024 * 1024);
    const file = xlsx(
      `${HEAD}<row r="1">${inline("A1", "sku")}</row>${pad}<row r="2">${inline("A2", "x")}</row>${TAIL}`,
    );
    expect(file.length).toBeLessThan(100_000);
    const result = parseInChild(file);
    expect(result.crashed).toBe(false);
    expect(result.code).toBe("IMPORT_FILE_TOO_LARGE");
    expect(result.ms).toBeLessThan(30_000);
  }, 120_000);

  it("șiruri partajate obișnuite (zeci de coloane, texte scurte) trec, iar XML-ul cu indentare normală la fel", async () => {
    const strings = Array.from({ length: 50 }, (_, i) => `valoare ${i}`);
    const sst = `<?xml version="1.0"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\n${strings.map((s) => `  <si>\n    <t>${s}</t>\n  </si>`).join("\n")}\n</sst>`;
    let body = `\n  <row r="1">\n${Array.from({ length: 20 }, (_, c) => `    <c r="${columnName(c)}1" t="s">\n      <v>${c}</v>\n    </c>`).join("\n")}\n  </row>`;
    for (let r = 2; r <= 300; r++) {
      body += `\n  <row r="${r}">\n${Array.from({ length: 20 }, (_, c) => `    <c r="${columnName(c)}${r}" t="s">\n      <v>${(r + c) % 50}</v>\n    </c>`).join("\n")}\n  </row>`;
    }
    const table = await parseImportFile(
      xlsx(`${HEAD}${body}\n${TAIL}`, { "xl/sharedStrings.xml": strToU8(sst) }),
      DEFAULT_IMPORT_LIMITS,
    );
    expect(table.headers).toHaveLength(20);
    expect(table.rows).toHaveLength(299);
    expect(table.rows[0]?.[0]).toBe("valoare 2");
  });
});

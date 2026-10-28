import * as XLSX from "xlsx";

/**
 * Fișiere de test FABRICATE pentru cititorul raportului «Stoc la zi»: aceeași structură ca raportul real (rânduri de titlu,
 * data, antet pe rândul 10, rând «Total» la sfârșit), dar cu firme, produse și valori INVENTATE. Raportul real nu se
 * folosește niciodată ca fixture.
 */

export type ReportFormat = "xls" | "xlsx";

export interface FabricatedRow {
  warehouse: string | null;
  product?: string;
  code: string | number | null;
  unit: string | null;
  quantity: string | number | boolean | null;
  /** Coloana «Sold final» (valoare la cost): cititorul o ignoră */
  soldFinal?: number | string | null;
  minStock?: number | null;
}

export interface FabricatedReport {
  format?: ReportFormat;
  /** Rândul cu data (implicit «Data: 28.10.2026»); `null` = fără rând de dată */
  dateText?: string | null;
  rows: readonly FabricatedRow[];
  /** Rândul «Total» de la sfârșit (implicit da) */
  total?: boolean;
  /** Rânduri goale între ultimul rând de date și «Total» */
  blankRowsBeforeTotal?: number;
  /** Antetul (implicit cel din SmartBill) */
  header?: readonly string[];
  /** Rânduri de titlu în plus, înaintea celor standard (mută antetul mai jos) */
  extraTitleRows?: number;
}

export const SMARTBILL_HEADER: readonly string[] = [
  "Gestiune",
  "Produs",
  "Cod",
  "U.M.",
  "Stoc final",
  "Sold final",
  "Stoc minim",
];

/** Matricea de celule a raportului (rândul 1 = primul rând din foaie). Antetul e pe rândul 10 (+ `extraTitleRows`). */
export function reportAoa(spec: FabricatedReport): unknown[][] {
  const aoa: unknown[][] = [];
  for (let i = 0; i < (spec.extraTitleRows ?? 0); i += 1) aoa.push([`Rând de titlu ${i + 1}`]);
  aoa.push(["Raport stoc la zi"]);
  aoa.push(["Societate Inventata SRL, CUI 000000"]);
  aoa.push([]);
  aoa.push(["Gestiuni selectate"]);
  aoa.push(spec.dateText === null ? [] : [spec.dateText ?? "Data: 28.10.2026"]);
  aoa.push(["Produse"]);
  aoa.push([null, null, null, null, null, null, "Tipărit la 29.10.2026"]);
  aoa.push([]);
  aoa.push([null, null, null, "Stoc", null, "Valoare"]);
  aoa.push([...(spec.header ?? SMARTBILL_HEADER)]);
  for (const row of spec.rows) {
    aoa.push([
      row.warehouse,
      row.product ?? "Produs inventat",
      row.code,
      row.unit,
      row.quantity,
      row.soldFinal ?? 123.45,
      row.minStock ?? 0,
    ]);
  }
  for (let i = 0; i < (spec.blankRowsBeforeTotal ?? 0); i += 1) aoa.push([]);
  if (spec.total ?? true) aoa.push(["Total", null, null, null, null, null, 999]);
  return aoa;
}

/** Registru de calcul cu o foaie (și, opțional, alte foi) din matrici de celule. */
export function workbookBuffer(
  sheets: ReadonlyArray<unknown[][]>,
  format: ReportFormat | "xlsb" | "ods" = "xlsx",
  tweak?: (sheet: XLSX.WorkSheet, index: number) => void,
): Buffer {
  const workbook = XLSX.utils.book_new();
  sheets.forEach((aoa, index) => {
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    tweak?.(sheet, index);
    XLSX.utils.book_append_sheet(workbook, sheet, `Foaie${index + 1}`);
  });
  const bookType = format === "xls" ? "biff8" : format;
  return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType }) as Uint8Array);
}

export function buildReport(
  spec: FabricatedReport,
  tweak?: (sheet: XLSX.WorkSheet, index: number) => void,
): Buffer {
  return workbookBuffer([reportAoa(spec)], spec.format ?? "xlsx", tweak);
}

/** Adaugă la o celulă `ws[adresă]` un tip, o valoare și (opțional) un format numeric. */
export function setCell(
  sheet: XLSX.WorkSheet,
  address: string,
  cell: { t: "s" | "n" | "b" | "e"; v: string | number | boolean; z?: string; f?: string },
): void {
  sheet[address] = cell;
}

export { XLSX };

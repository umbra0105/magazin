import writeExcelFile from "write-excel-file/node";
import { toCsv } from "./import-csv";
import { CLEAR_MARKER, IMPORT_FIELDS } from "./import-fields";
import type { ImportFormat } from "./import-file";

/**
 * Șablonul de import, generat din `IMPORT_FIELDS` (aceeași definiție ca importul): antet + două
 * rânduri de exemplu. XLSX-ul are în plus o foaie „Instrucțiuni” (a doua; importul citește doar prima).
 * Toate celulele sunt text, ca SKU-urile și EAN-urile să nu piardă zerourile de la început, iar
 * prețurile să rămână cu virgulă zecimală.
 */

export const TEMPLATE_FILE_NAMES: Record<ImportFormat, string> = {
  csv: "sablon-import-produse.csv",
  xlsx: "sablon-import-produse.xlsx",
};

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const GENERAL_NOTES: readonly string[] = [
  "Un rând = un produs, identificat prin SKU. SKU existent = se actualizează; SKU nou = produs nou (ciornă, o singură variantă).",
  "Se modifică DOAR coloanele pe care le mapezi. O celulă goală lasă valoarea neschimbată.",
  `Pentru a șterge o valoare, scrie ${CLEAR_MARKER} (o liniuță singură) în celulă; merge doar la câmpurile marcate „se poate șterge”.`,
  "Produsele arhivate sau din coșul de gunoi nu se actualizează: apar în raport ca „ignorate”.",
  "Imaginile nu se importă din acest fișier. Prețul de achiziție nu se importă niciodată.",
  "Mai întâi se face o verificare (fără nicio modificare), apoi aplici importul.",
];

export function templateRows(): string[][] {
  return [
    IMPORT_FIELDS.map((f) => f.label),
    IMPORT_FIELDS.map((f) => f.examples[0]),
    IMPORT_FIELDS.map((f) => f.examples[1]),
  ];
}

export function instructionRows(): string[][] {
  return [
    ["Câmp", "Obligatoriu", "Se poate șterge", "Descriere"],
    ...IMPORT_FIELDS.map((f) => [
      f.label,
      f.required === "key" ? "da (cheia rândului)" : f.required === "new" ? "la produs nou" : "nu",
      f.clearable ? "da" : "nu",
      f.help,
    ]),
    [],
    ...GENERAL_NOTES.map((note) => [note]),
  ];
}

/** Șablonul ca octeți (CSV cu BOM UTF-8 și `;`, ca Excel-ul în limba română; sau XLSX). */
export async function buildTemplate(format: ImportFormat): Promise<Uint8Array> {
  if (format === "csv") {
    return new TextEncoder().encode(toCsv(templateRows()));
  }
  const text = (value: string, bold = false) => ({
    value,
    type: String,
    ...(bold ? { fontWeight: "bold" as const } : {}),
  });
  const [header, ...examples] = templateRows();
  const columns = IMPORT_FIELDS.map((f) => ({ width: Math.max(14, f.label.length + 2) }));
  const buffer = await writeExcelFile([
    {
      sheet: "Produse",
      columns,
      data: [
        (header as string[]).map((label) => text(label, true)),
        ...examples.map((row) => row.map((value) => text(value))),
      ],
    },
    {
      sheet: "Instrucțiuni",
      columns: [{ width: 28 }, { width: 22 }, { width: 16 }, { width: 100 }],
      data: instructionRows().map((row, index) => row.map((value) => text(value, index === 0))),
    },
  ]).toBuffer();
  return new Uint8Array(buffer);
}

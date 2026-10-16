import writeExcelFile from "write-excel-file/node";
import { neutralizeCell } from "../import/cell-safety";
import { EXPORT_READONLY_COLUMNS, IMPORT_FIELDS } from "../import/import-fields";
import { XLSX_MIME } from "../import/import-template";
import type { ExportCell } from "./export-rows";
import type { PreparedExport } from "./export-service";

/**
 * Scriitorul XLSX al exportului de produse. Foaia «Produse» (prima, singura citită de import) are antetul
 * îngroșat și fixat, SKU, EAN și celelalte coduri ca TEXT (zerourile de la început se păstrează), prețurile
 * ca NUMERE cu formatul de lei, iar numerele întregi ca numere. Foaia «Despre export» (a doua) spune ce
 * conține fișierul: data, filtrele, numărul de rânduri, ce NU se exportă; fără date sensibile.
 *
 * Celulele de text care încep cu `=`, `+`, `-`, `@`, tab sau CR se neutralizează ca și în CSV (apostrof),
 * deși celulele text dintr-un XLSX nu se evaluează ca formule: așa cele două formate sunt identice la
 * reimport și un text copiat din XLSX într-o altă foaie nu devine formulă.
 */

const LEI_FORMAT = '#,##0.00" lei"';

type SheetCell = { value: string | number; type: StringConstructor | NumberConstructor } & {
  format?: string;
  fontWeight?: "bold";
};

function toSheetCell(cell: ExportCell): SheetCell | null {
  switch (cell.kind) {
    case "text":
      return { value: neutralizeCell(cell.value), type: String };
    case "money":
      return { value: cell.bani / 100, type: Number, format: LEI_FORMAT };
    case "int":
      return { value: cell.value, type: Number, format: "0" };
    default:
      return null;
  }
}

const bold = (value: string): SheetCell => ({ value, type: String, fontWeight: "bold" });
const plain = (value: string): SheetCell => ({ value, type: String });

function aboutRows(prepared: PreparedExport): (SheetCell | null)[][] {
  const { about } = prepared;
  const readonly = EXPORT_READONLY_COLUMNS.map((c) => c.label).join(", ");
  return [
    [bold("Despre acest export"), null],
    [plain("Exportat la"), plain(about.exportedAt)],
    [plain("Domeniu"), plain(about.scope)],
    [
      plain("Filtre aplicate"),
      plain(about.filters.length > 0 ? about.filters.join("; ") : "niciunul"),
    ],
    [plain("Coșul de gunoi"), plain(about.trash)],
    [plain("Rânduri (variante)"), { value: about.rows, type: Number, format: "0" }],
    [plain("Produse"), { value: about.products, type: Number, format: "0" }],
    ...(about.withoutVariants > 0
      ? [
          [
            plain("Produse fără variante (nu au rânduri)"),
            { value: about.withoutVariants, type: Number, format: "0" } as SheetCell,
          ],
        ]
      : []),
    [null, null],
    [bold("Cum se folosește"), null],
    [
      plain("Un rând"),
      plain("o variantă (un SKU); câmpurile produsului se repetă pe rândurile variantelor lui"),
    ],
    [
      plain("Reimport"),
      plain(
        `fișierul se poate reimporta fără mapare (aceleași antete); coloanele ${readonly} sunt doar informative și se ignoră la import`,
      ),
    ],
    [
      plain("Produse arhivate sau din coș"),
      plain("la reimport apar ca «ignorate»: dezarhivează-le sau restaurează-le întâi"),
    ],
    [plain("Prețuri"), plain("în lei, cu TVA inclus (cum le vede clientul)")],
    [
      plain("Ce NU se exportă"),
      plain(
        "prețul de achiziție, stocul, imaginile, documentele și variantele de produs complexe (opțiuni)",
      ),
    ],
  ];
}

/** Fișierul XLSX ca octeți: citește tot fluxul de rânduri al exportului (limitat de `productExport.maxRows`). */
export async function buildExportXlsx(prepared: PreparedExport): Promise<Uint8Array> {
  const data: (SheetCell | null)[][] = [prepared.headers.map(bold)];
  for await (const row of prepared.rows) data.push(row.map(toSheetCell));

  const widths = [
    ...IMPORT_FIELDS.map((f) => f.label),
    ...EXPORT_READONLY_COLUMNS.map((c) => c.label),
  ].map((label) => ({ width: Math.max(14, label.length + 2) }));
  const buffer = await writeExcelFile([
    { sheet: "Produse", columns: widths, data, stickyRowsCount: 1 },
    {
      sheet: "Despre export",
      columns: [{ width: 38 }, { width: 110 }],
      data: aboutRows(prepared),
    },
  ]).toBuffer();
  return new Uint8Array(buffer);
}

/** Descărcarea XLSX: atașament, fără cache și fără ghicirea tipului. */
export function xlsxResponse(bytes: Uint8Array, fileName: string): Response {
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Type": XLSX_MIME,
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}

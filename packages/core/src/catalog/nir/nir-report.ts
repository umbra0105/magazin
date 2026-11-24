import type { NirReport } from "./nir-plan";

/**
 * Raportul și șablonul importului NIR ca rânduri pentru `toCsv` / `csvResponse` (UTF-16LE cu BOM, TAB, fără linia de separator, antet în română;
 * singurul loc care scrie CSV e funcția comună, testul `csv-generation` păzește asta). ⚠️ Raportul conține prețuri de achiziție:
 * se descarcă DOAR cu `products.cost.view` (verificat de ruta de descărcare).
 */

/** Bani → «123,45» (lei, 2 zecimale), fără `float`. */
export function lei(minor: number): string {
  const whole = Math.trunc(minor / 100);
  return `${whole},${String(minor % 100).padStart(2, "0")}`;
}

/** `aaaa-ll-zz` → `zz/ll/aaaa`, ca în fișierele SmartBill. */
export function dateText(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

const HEADER = [
  "Categorie",
  "Rând",
  "Cod",
  "Data intrării",
  "Preț fără TVA (lei)",
  "Detalii",
] as const;

export const NIR_REPORT_CATEGORIES = {
  summary: "Rezumat",
  updated: "Actualizat",
  unchanged: "Neschimbat (data nu e mai nouă)",
  unknown: "Cod necunoscut",
  invalid: "Rând invalid",
  unitDifferent: "Unitate diferită, de verificat manual",
  multiSameDay: "Intrări multiple în aceeași zi (informație)",
  docType: "Tip de document (informație)",
} as const;

export function nirReportRows(report: NirReport): string[][] {
  const c = report.counters;
  const rows: string[][] = [[...HEADER]];
  const summary = (label: string, value: number) =>
    rows.push([NIR_REPORT_CATEGORIES.summary, "", "", "", "", `${label}: ${value}`]);
  summary("Rânduri de date în fișier", c.fileRows);
  summary("Actualizate", c.updated);
  summary("Neschimbate (data nu e mai nouă)", c.unchanged);
  summary("Coduri necunoscute", c.unknownCodes);
  summary("Rânduri invalide", c.invalid);
  summary("Ignorate (nu sunt intrări)", c.ignored);
  summary("Unitate diferită, de verificat manual", c.unitDifferent);
  summary("Coduri cu intrări multiple în aceeași zi", c.multiSameDay);

  for (const item of report.updated) {
    rows.push([
      NIR_REPORT_CATEGORIES.updated,
      String(item.row),
      item.code,
      dateText(item.date),
      lei(item.costMinor),
      "",
    ]);
  }
  for (const item of report.unchanged) {
    rows.push([
      NIR_REPORT_CATEGORIES.unchanged,
      String(item.row),
      item.code,
      dateText(item.date),
      lei(item.costMinor),
      "",
    ]);
  }
  for (const item of report.unknown) {
    rows.push([
      NIR_REPORT_CATEGORIES.unknown,
      String(item.row),
      item.code ?? "",
      "",
      "",
      item.reason,
    ]);
  }
  for (const item of report.invalid) {
    rows.push([
      NIR_REPORT_CATEGORIES.invalid,
      String(item.row),
      item.code ?? "",
      "",
      "",
      item.reason,
    ]);
  }
  for (const item of report.unitDifferent) {
    rows.push([
      NIR_REPORT_CATEGORIES.unitDifferent,
      String(item.row),
      item.code ?? "",
      "",
      "",
      item.fileUnit ? `${item.reason} (în fișier: ${item.fileUnit})` : item.reason,
    ]);
  }
  for (const item of report.multiSameDay) {
    rows.push([
      NIR_REPORT_CATEGORIES.multiSameDay,
      item.rows.join(", "),
      item.code,
      dateText(item.date),
      "",
      "a rămas ultimul rând din fișier",
    ]);
  }
  for (const item of report.otherDocTypes) {
    rows.push([
      NIR_REPORT_CATEGORIES.docType,
      "",
      "",
      "",
      "",
      `${item.type}: ${item.count} rânduri`,
    ]);
  }
  return rows;
}

/** Antetul exportului SmartBill «mișcări produse» (aceleași coloane, în aceeași ordine). */
export const NIR_TEMPLATE_HEADER: readonly string[] = [
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

const pad = (value: number): string => String(value).padStart(2, "0");

/**
 * Șablonul de import: antetul exportului SmartBill și trei rânduri-exemplu cu coduri INVENTATE (de înlocuit cu SKU-urile din
 * catalog), cu datele calculate față de ziua curentă (nu date fixe). Costul unitar e FĂRĂ TVA, cu până la 4 zecimale.
 */
export function nirTemplateRows(now: Date): string[][] {
  const day = (ago: number): string => {
    const date = new Date(now.getTime() - ago * 86_400_000);
    return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
  };
  const example = (
    code: string,
    name: string,
    unit: string,
    qty: string,
    cost: string,
    ago: number,
    doc: string,
  ) => ["Depozit principal", name, code, day(ago), "Receptie", doc, unit, qty, "0", cost, "", "0"];
  return [
    [...NIR_TEMPLATE_HEADER],
    example(
      "COD-EXEMPLU-1",
      "Produs de exemplu 1 (înlocuiește codul cu un SKU din catalog)",
      "buc",
      "10",
      "123.4567",
      7,
      "NIR 1",
    ),
    example("COD-EXEMPLU-2", "Produs de exemplu 2", "buc", "4", "49.9900", 3, "NIR 2"),
    example(
      "COD-EXEMPLU-3",
      "Produs de exemplu 3 (aici o unitate cu zecimale)",
      "kg",
      "25.5",
      "8.2500",
      1,
      "NIR 3",
    ),
  ];
}

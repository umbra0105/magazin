import { DomainError } from "@ecom/shared";
import { z } from "zod";
import { hasValidSirutaCheckDigit } from "./siruta-check";
import { normalizeDiacritics } from "./siruta-names";

/**
 * Datele SIRUTA (INS, registrul unităților administrativ-teritoriale): citirea fișierului sursă, validarea, raportul de
 * diferențe între versiuni și formatul fișierului derivat din repo. Funcții pure; scrierea în bază stă în `siruta-store.ts`.
 *
 * Reguli (decizia utilizatorului, 2026-11-18; vezi `docs/SIRUTA-SURSA.md`): fiecare cod trece verificarea cifrei de control
 * OFICIALE. Sunt acceptate doar excepțiile din listă, legate de tuplul EXACT (cod, nume, cod părinte, tip). Orice altă
 * nepotrivire, sau schimbarea numelui, părintelui sau tipului unui rând din listă, respinge TOT importul. Codul poștal din
 * fișierul sursă (`CODP`) NU se citește și nu se păstrează: codul poștal rămâne câmp introdus de client.
 */

export const CHECK_DIGIT_EXCEPTION_REASON =
  "nu respectă cifra de control oficială, preluat ca atare din INS S1 2026";

/** Nivelurile registrului: 1 = județ (și Municipiul București), 2 = UAT (municipiu, oraș, comună), 3 = localitate / sector. */
export type SirutaLevel = 1 | 2 | 3;

export interface SirutaRow {
  /** Codul SIRUTA (întreg, fără zerouri la stânga). */
  code: number;
  /** Codul județului (`JUD` din registru: 1–52, București = 40). */
  countyCode: number;
  /** Numele din registru, cu diacriticele normalizate (ș/ț); majuscule, pentru căutare și potrivire. */
  name: string;
  /** Codul SIRUTA al părintelui (`SIRSUP`); `null` la nivelul 1. */
  parentCode: number | null;
  /** `TIP`: 40 județ, 6 sector al Municipiului București, 1–4 municipii și orașe, 3 comună, 9–11 și 17–19 localități componente, 22–23 sate. */
  tip: number;
  level: SirutaLevel;
}

export interface CheckDigitException {
  code: number;
  name: string;
  parentCode: number | null;
  tip: number;
  reason: string;
}

/** Importul a fost respins: `problems` listează TOATE motivele (nu doar primul). */
export class SirutaImportError extends DomainError {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      "SIRUTA_IMPORT_REJECTED",
      `Importul SIRUTA a fost respins (${problems.length} probleme); nu s-a scris nimic.`,
      { total: problems.length, problems: problems.slice(0, 50) },
    );
    this.problems = problems;
  }
}

const REQUIRED_COLUMNS = ["SIRUTA", "DENLOC", "JUD", "SIRSUP", "TIP", "NIV"] as const;
const INTEGER = /^\d{1,9}$/;

/** Citește fișierul CSV al INS (UTF-8, `;`, cu sau fără BOM). Nu validează ierarhia și cifra de control (`validateSirutaRows`). */
export function parseSirutaCsv(text: string): SirutaRow[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const headerLine = lines[0] ?? "";
  const columns = headerLine.split(";").map((c) => c.trim());
  const missing = REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
  if (missing.length > 0) {
    throw new SirutaImportError([`antetul nu are coloanele: ${missing.join(", ")}`]);
  }
  const at = (name: (typeof REQUIRED_COLUMNS)[number]) => columns.indexOf(name);
  const idx = {
    code: at("SIRUTA"),
    name: at("DENLOC"),
    county: at("JUD"),
    parent: at("SIRSUP"),
    tip: at("TIP"),
    level: at("NIV"),
  };

  const problems: string[] = [];
  const rows: SirutaRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const cells = line.split(";");
    const lineNo = i + 1;
    const num = (index: number): number | null => {
      const raw = (cells[index] ?? "").trim();
      return INTEGER.test(raw) ? Number(raw) : null;
    };
    const code = num(idx.code);
    const countyCode = num(idx.county);
    const parent = num(idx.parent);
    const tip = num(idx.tip);
    const level = num(idx.level);
    const name = normalizeDiacritics((cells[idx.name] ?? "").trim());
    const bad: string[] = [];
    if (code === null) bad.push("SIRUTA nu e un număr");
    if (countyCode === null) bad.push("JUD nu e un număr");
    if (parent === null) bad.push("SIRSUP nu e un număr");
    if (tip === null) bad.push("TIP nu e un număr");
    if (level !== 1 && level !== 2 && level !== 3) bad.push("NIV trebuie să fie 1, 2 sau 3");
    if (name === "") bad.push("DENLOC e gol");
    if (bad.length > 0) {
      problems.push(`rândul ${lineNo}: ${bad.join("; ")}`);
      continue;
    }
    rows.push({
      code: code as number,
      countyCode: countyCode as number,
      name,
      parentCode: level === 1 ? null : (parent as number),
      tip: tip as number,
      level: level as SirutaLevel,
    });
  }
  if (problems.length > 0) throw new SirutaImportError(problems);
  return rows;
}

/** Rândurile cu cifra de control greșită (candidații la lista de excepții). */
export function findCheckDigitFailures(rows: readonly SirutaRow[]): SirutaRow[] {
  return rows.filter((r) => !hasValidSirutaCheckDigit(r.code));
}

const sameTuple = (a: SirutaRow, e: CheckDigitException): boolean =>
  a.name === e.name && a.parentCode === e.parentCode && a.tip === e.tip;

/**
 * Validează tot setul și aruncă `SirutaImportError` cu TOATE problemele: coduri în afara intervalului sau duplicate,
 * ierarhie (județ fără părinte; UAT sub un județ; localitate sub un UAT; același județ ca părintele) și cifra de control.
 * O excepție a cărei cod nu mai apare în fișier nu respinge importul (apare în raportul de diferențe).
 */
export function validateSirutaRows(
  rows: readonly SirutaRow[],
  exceptions: readonly CheckDigitException[],
): void {
  const problems: string[] = [];
  const byCode = new Map<number, SirutaRow>();
  for (const row of rows) {
    if (!Number.isInteger(row.code) || row.code < 1 || row.code > 999_999) {
      problems.push(`cod ${row.code}: în afara intervalului 1–999999`);
      continue;
    }
    if (byCode.has(row.code)) {
      problems.push(`cod ${row.code}: apare de două ori`);
      continue;
    }
    byCode.set(row.code, row);
  }
  const exceptionByCode = new Map(exceptions.map((e) => [e.code, e]));

  for (const row of rows) {
    if (row.level === 1) {
      if (row.parentCode !== null) problems.push(`cod ${row.code}: un județ nu are părinte`);
    } else {
      const expectedParentLevel = row.level === 2 ? 1 : 2;
      const parent = row.parentCode === null ? undefined : byCode.get(row.parentCode);
      if (!parent) {
        problems.push(`cod ${row.code}: părintele ${String(row.parentCode)} nu există`);
      } else if (parent.level !== expectedParentLevel) {
        problems.push(
          `cod ${row.code}: părintele ${parent.code} are nivelul ${parent.level}, nu ${expectedParentLevel}`,
        );
      } else if (parent.countyCode !== row.countyCode) {
        problems.push(`cod ${row.code}: județul diferă de al părintelui ${parent.code}`);
      }
    }

    if (!hasValidSirutaCheckDigit(row.code)) {
      const exception = exceptionByCode.get(row.code);
      if (!exception) {
        problems.push(`cod ${row.code}: cifra de control nu respectă algoritmul oficial`);
      } else if (!sameTuple(row, exception)) {
        problems.push(
          `cod ${row.code}: rând din lista de excepții cu numele, părintele sau tipul schimbat`,
        );
      }
    }
  }
  if (problems.length > 0) throw new SirutaImportError(problems);
}

export type SirutaChangedField = "name" | "parentCode" | "tip" | "countyCode" | "level";

export interface SirutaDiff {
  added: SirutaRow[];
  removed: SirutaRow[];
  changed: Array<{
    code: number;
    fields: SirutaChangedField[];
    before: SirutaRow;
    after: SirutaRow;
  }>;
  exceptions: {
    /** Coduri cu cifra greșită care nu erau în lista de excepții. */
    added: SirutaRow[];
    /** Excepții din lista veche care nu mai sunt în fișier sau nu mai au cifra greșită. */
    removed: CheckDigitException[];
    /** Excepții al căror nume, părinte sau tip s-a schimbat. */
    changed: Array<{ code: number; before: CheckDigitException; after: SirutaRow }>;
  };
}

const COMPARED_FIELDS: readonly SirutaChangedField[] = [
  "name",
  "parentCode",
  "tip",
  "countyCode",
  "level",
];

/**
 * Raportul de diferențe între versiunea veche (rânduri + excepții acceptate) și cea nouă. Include excepțiile (noi, dispărute,
 * schimbate); decizia asupra lor o ia utilizatorul, nu codul.
 */
export function diffSiruta(
  previousRows: readonly SirutaRow[],
  previousExceptions: readonly CheckDigitException[],
  nextRows: readonly SirutaRow[],
): SirutaDiff {
  const before = new Map(previousRows.map((r) => [r.code, r]));
  const after = new Map(nextRows.map((r) => [r.code, r]));
  const added = nextRows.filter((r) => !before.has(r.code));
  const removed = previousRows.filter((r) => !after.has(r.code));
  const changed: SirutaDiff["changed"] = [];
  for (const row of nextRows) {
    const prev = before.get(row.code);
    if (!prev) continue;
    const fields = COMPARED_FIELDS.filter((f) => prev[f] !== row[f]);
    if (fields.length > 0) changed.push({ code: row.code, fields, before: prev, after: row });
  }

  const failures = new Map(findCheckDigitFailures(nextRows).map((r) => [r.code, r]));
  const previousByCode = new Map(previousExceptions.map((e) => [e.code, e]));
  const exceptions: SirutaDiff["exceptions"] = { added: [], removed: [], changed: [] };
  for (const [code, row] of failures) {
    const prev = previousByCode.get(code);
    if (!prev) exceptions.added.push(row);
    else if (!sameTuple(row, prev)) exceptions.changed.push({ code, before: prev, after: row });
  }
  for (const prev of previousExceptions) {
    if (!failures.has(prev.code)) exceptions.removed.push(prev);
  }
  return { added, removed, changed, exceptions };
}

// ---------------------------------------------------------------------------------------------------------------------
// Fișierul derivat (din repo): doar coloanele necesare, cu atribuirea și lista de excepții.

const metaSchema = z.object({
  source: z.string().min(1),
  version: z.string().min(1),
  licence: z.string().min(1),
  licenceUrl: z.string().url(),
  attribution: z.string().min(1),
  modifications: z.string().min(1),
});

const exceptionSchema = z.object({
  code: z.number().int(),
  name: z.string().min(1),
  parentCode: z.number().int().nullable(),
  tip: z.number().int(),
  reason: z.literal(CHECK_DIGIT_EXCEPTION_REASON),
});

const rowSchema = z.tuple([
  z.number().int(), // cod
  z.number().int(), // județ
  z.string().min(1), // nume (normalizat)
  z.number().int().nullable(), // cod părinte
  z.number().int(), // tip
  z.union([z.literal(1), z.literal(2), z.literal(3)]), // nivel
]);

const derivedSchema = z.object({
  meta: metaSchema.extend({ rowCount: z.number().int().min(0) }),
  checkDigitExceptions: z.array(exceptionSchema),
  rows: z.array(rowSchema),
});

export type SirutaDerivedMeta = z.infer<typeof metaSchema>;
export type SirutaDerivedFile = z.infer<typeof derivedSchema>;

export function toDerivedFile(
  rows: readonly SirutaRow[],
  exceptions: readonly CheckDigitException[],
  meta: SirutaDerivedMeta,
): SirutaDerivedFile {
  return {
    meta: { ...meta, rowCount: rows.length },
    checkDigitExceptions: exceptions.map((e) => ({
      ...e,
    })) as SirutaDerivedFile["checkDigitExceptions"],
    rows: rows.map((r) => [r.code, r.countyCode, r.name, r.parentCode, r.tip, r.level]),
  };
}

/** Validează forma fișierului derivat (Zod) și îl desface; NU validează ierarhia și cifrele (`validateSirutaRows`). */
export function fromDerivedFile(input: unknown): {
  meta: SirutaDerivedMeta & { rowCount: number };
  exceptions: CheckDigitException[];
  rows: SirutaRow[];
} {
  const parsed = derivedSchema.safeParse(input);
  if (!parsed.success) {
    throw new SirutaImportError([
      `fișierul derivat are o formă greșită: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    ]);
  }
  const file = parsed.data;
  if (file.meta.rowCount !== file.rows.length) {
    throw new SirutaImportError(["fișierul derivat: numărul de rânduri nu corespunde cu antetul"]);
  }
  return {
    meta: file.meta,
    exceptions: file.checkDigitExceptions,
    rows: file.rows.map(([code, countyCode, name, parentCode, tip, level]) => ({
      code,
      countyCode,
      name,
      parentCode,
      tip,
      level,
    })),
  };
}

/**
 * Verificarea orei pozei (importul «stoc la zi»). Raportul SmartBill are doar DATA, fără oră; ora o confirmă utilizatorul
 * la încărcare (implicit ora curentă). Ora hotărăște ce ajustări manuale înlocuiește poza și ce comenzi rămân angajate
 * (D1), de aceea orice nepotrivire se semnalează, dar nu blochează: omul poate ști mai bine. O dată care nici nu există
 * (invalidă) se respinge. Funcții PURE.
 */

export interface FileDate {
  year: number;
  month: number;
  day: number;
}

export type SnapshotTimeWarningKind =
  "taken_at_invalid" | "taken_at_in_future" | "file_date_not_today" | "taken_at_not_on_file_date";

export interface SnapshotTimeWarning {
  kind: SnapshotTimeWarningKind;
  message: string;
}

export interface SnapshotTimeInput {
  /** Ora confirmată de utilizator */
  takenAt: Date;
  now: Date;
  /** Data scrisă în antetul raportului; `null` dacă fișierul nu o are */
  fileDate: FileDate | null;
  /** Fusul orar al magazinului (`regional.timezone`) */
  timeZone: string;
}

export interface SnapshotTimeResult {
  /** `false` doar pentru o dată invalidă */
  ok: boolean;
  warnings: SnapshotTimeWarning[];
}

const pad = (value: number | string, length: number): string => String(value).padStart(length, "0");

function dayKey(date: FileDate): string {
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

function showDay(date: FileDate): string {
  return `${pad(date.day, 2)}.${pad(date.month, 2)}.${pad(date.year, 4)}`;
}

/** Ziua calendaristică a unui moment, în fusul magazinului (nu în UTC). */
function localDay(moment: Date, timeZone: string): FileDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(moment);
  const get = (type: string): number => {
    const value = parts.find((p) => p.type === type)?.value ?? "";
    return Number.parseInt(value, 10);
  };
  return { year: get("year"), month: get("month"), day: get("day") };
}

export function checkSnapshotTime(input: SnapshotTimeInput): SnapshotTimeResult {
  if (Number.isNaN(input.takenAt.getTime())) {
    return {
      ok: false,
      warnings: [{ kind: "taken_at_invalid", message: "Data și ora raportului nu sunt valide." }],
    };
  }
  const warnings: SnapshotTimeWarning[] = [];
  const today = localDay(input.now, input.timeZone);
  const takenDay = localDay(input.takenAt, input.timeZone);

  if (input.takenAt.getTime() > input.now.getTime()) {
    warnings.push({
      kind: "taken_at_in_future",
      message:
        "Ora raportului este în viitor. O poză cu ora în viitor poate înlocui ajustări de stoc făcute între timp.",
    });
  }
  if (input.fileDate) {
    if (dayKey(input.fileDate) !== dayKey(today)) {
      warnings.push({
        kind: "file_date_not_today",
        message: `Raportul este din ${showDay(input.fileDate)}, iar azi este ${showDay(today)}. Verifică dacă ai încărcat raportul potrivit.`,
      });
    }
    if (dayKey(input.fileDate) !== dayKey(takenDay)) {
      warnings.push({
        kind: "taken_at_not_on_file_date",
        message: `Ora confirmată este în ziua ${showDay(takenDay)}, dar raportul este din ${showDay(input.fileDate)}.`,
      });
    }
  }
  return { ok: true, warnings };
}

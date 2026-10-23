import { localDateTime, zonedLocalToUtc } from "@ecom/shared/zoned-time";

/**
 * Data și ora efectivă a unei ajustări, ca TEXT (fără widget nativ de dată/oră: baloanele lui ies în limba browserului):
 * `zz.ll.aaaa` și `hh:mm`, în ora magazinului (`regional.timezone`). Pure, fără acces la browser sau server; folosite de
 * formularul «Ajustează» și, pentru afișare, de pagini.
 */

export type LocalDateTimeResult =
  { ok: true; date: Date } | { ok: false; field: "date" | "time"; error: "required" | "invalid" };

const DATE = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/;
const TIME = /^(\d{1,2})[:.](\d{2})$/;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/** Data (zz.ll.aaaa) și ora (hh:mm) în ora fusului dat → momentul real. Data se verifică întâi (focusul merge pe primul câmp greșit). */
export function parseLocalDateTime(
  dateText: string,
  timeText: string,
  timeZone: string,
): LocalDateTimeResult {
  const dateRaw = dateText.trim();
  const timeRaw = timeText.trim();
  if (dateRaw === "") return { ok: false, field: "date", error: "required" };
  const dateMatch = DATE.exec(dateRaw);
  if (!dateMatch) return { ok: false, field: "date", error: "invalid" };
  const day = Number.parseInt(dateMatch[1] ?? "0", 10);
  const month = Number.parseInt(dateMatch[2] ?? "0", 10);
  const year = Number.parseInt(dateMatch[3] ?? "0", 10);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    year < MIN_YEAR ||
    year > MAX_YEAR ||
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    return { ok: false, field: "date", error: "invalid" };
  }
  if (timeRaw === "") return { ok: false, field: "time", error: "required" };
  const timeMatch = TIME.exec(timeRaw);
  if (!timeMatch) return { ok: false, field: "time", error: "invalid" };
  const hour = Number.parseInt(timeMatch[1] ?? "0", 10);
  const minute = Number.parseInt(timeMatch[2] ?? "0", 10);
  if (hour > 23 || minute > 59) return { ok: false, field: "time", error: "invalid" };
  return { ok: true, date: zonedLocalToUtc({ year, month, day, hour, minute }, timeZone) };
}

export function formatLocalDate(date: Date, timeZone: string): string {
  const l = localDateTime(date, timeZone);
  return `${pad(l.day)}.${pad(l.month)}.${pad(l.year, 4)}`;
}

export function formatLocalTime(date: Date, timeZone: string): string {
  const l = localDateTime(date, timeZone);
  return `${pad(l.hour)}:${pad(l.minute)}`;
}

export function formatLocalDateTime(date: Date, timeZone: string): string {
  return `${formatLocalDate(date, timeZone)}, ${formatLocalTime(date, timeZone)}`;
}

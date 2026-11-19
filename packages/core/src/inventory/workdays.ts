import { localDateTime, zonedLocalToUtc } from "@ecom/shared";

/**
 * Termenele rezervărilor de stoc (D4): cardul ține `inventory.reservationMinutes` minute; transferul bancar ține
 * `inventory.transferReservationWorkdays` ZILE LUCRĂTOARE.
 *
 * Zi lucrătoare = luni–vineri, fără zilele din calendarul `regional.nonWorkingDates` (sărbători legale, zile libere ale
 * magazinului; date locale `AAAA-LL-ZZ`, editabile din admin). Ziua comenzii
 * nu se numără; rezervarea expiră la SFÂRȘITUL (23:59:59.999, ora locală) celei de-a N-a zile lucrătoare după ea, ca
 * clientul să aibă ziua întreagă. Ziua comenzii e ziua LOCALĂ din fusul magazinului (`regional.timezone`), nu cea UTC.
 */

export const MAX_RESERVATION_WORKDAYS = 365;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export type ReservationMethod = "card" | "transfer";

export interface ReservationExpirySettings {
  reservationMinutes: number;
  transferReservationWorkdays: number;
  timeZone: string;
  /** `regional.nonWorkingDates`: zile libere (date locale `AAAA-LL-ZZ`), sărite la numărarea zilelor lucrătoare. */
  nonWorkingDates?: readonly string[];
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Cheia unei zile calendaristice (UTC la miezul nopții) → `AAAA-LL-ZZ`. */
function dayKey(utcMidnightMs: number): string {
  const d = new Date(utcMidnightMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** O dată `AAAA-LL-ZZ` care există în calendar (nu 2026-02-30). */
export function isValidCalendarDate(value: string): boolean {
  const m = ISO_DAY.exec(value);
  if (!m) return false;
  const [year, month, day] = [1, 2, 3].map((i) => Number.parseInt(m[i] ?? "", 10)) as [
    number,
    number,
    number,
  ];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * Sfârșitul zilei (ora locală) a celei de-a `workdays`-a zile lucrătoare după ziua locală a lui `from`. Zilele din
 * `nonWorkingDates` (locale, `AAAA-LL-ZZ`) nu se numără; o dată nevalidă în listă e `RangeError` (nu se ignoră în tăcere).
 */
export function addWorkdaysEndOfDay(
  from: Date,
  workdays: number,
  timeZone: string,
  nonWorkingDates: readonly string[] = [],
): Date {
  if (!Number.isInteger(workdays) || workdays < 1 || workdays > MAX_RESERVATION_WORKDAYS) {
    throw new RangeError(
      `Zilele lucrătoare trebuie să fie un întreg între 1 și ${MAX_RESERVATION_WORKDAYS}`,
    );
  }
  for (const date of nonWorkingDates) {
    if (!isValidCalendarDate(date)) {
      throw new RangeError(`Data liberă «${date}» nu e o dată calendaristică AAAA-LL-ZZ`);
    }
  }
  const off = new Set(nonWorkingDates);
  const start = localDateTime(from, timeZone); // validează și momentul, și fusul
  let cursor = Date.UTC(start.year, start.month - 1, start.day);
  let remaining = workdays;
  while (remaining > 0) {
    cursor += DAY_MS;
    const weekday = new Date(cursor).getUTCDay(); // 0 = duminică, 6 = sâmbătă
    if (weekday !== 0 && weekday !== 6 && !off.has(dayKey(cursor))) remaining--;
  }
  const end = new Date(cursor);
  return zonedLocalToUtc(
    {
      year: end.getUTCFullYear(),
      month: end.getUTCMonth() + 1,
      day: end.getUTCDate(),
      hour: 23,
      minute: 59,
      second: 59,
      millisecond: 999,
    },
    timeZone,
  );
}

/** Până când ține o rezervare făcută acum. Ramburs și celelalte metode fără rezervare nu au termen. */
export function reservationExpiresAt(
  method: ReservationMethod,
  now: Date,
  settings: ReservationExpirySettings,
): Date {
  if (method === "card") {
    if (!Number.isInteger(settings.reservationMinutes) || settings.reservationMinutes < 1) {
      throw new RangeError("Minutele rezervării trebuie să fie un întreg de cel puțin 1");
    }
    return new Date(now.getTime() + settings.reservationMinutes * MINUTE_MS);
  }
  if (method === "transfer") {
    return addWorkdaysEndOfDay(
      now,
      settings.transferReservationWorkdays,
      settings.timeZone,
      settings.nonWorkingDates ?? [],
    );
  }
  throw new RangeError(
    `Metoda «${String(method)}» nu rezervă stoc, deci nu are termen de rezervare`,
  );
}

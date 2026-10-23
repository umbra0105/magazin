/**
 * Ora locală într-un fus orar IANA (de ex. `Europe/Bucharest`), fără biblioteci: ziua locală a unui moment, momentul (UTC)
 * al unei ore locale și următoarea rulare zilnică la o oră fixă. Folosit de joburile programate și de termenele în zile
 * lucrătoare. Ora repetată (toamna) se rezolvă la PRIMA apariție; ora care nu există (primăvara) se rezolvă cu offsetul de
 * dinainte de salt (deci 03:30 inexistentă devine 04:30 locală).
 */

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

export interface LocalDateTime {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  /** 0–23 */
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  /** 1 = luni … 7 = duminică */
  weekday: number;
}

export type LocalDateTimeInput = Pick<LocalDateTime, "year" | "month" | "day" | "hour" | "minute"> &
  Partial<Pick<LocalDateTime, "second" | "millisecond">>;

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  // Fusurile ca offset («+02:00») nu au reguli de vară/iarnă: nu sunt fusuri IANA și nu se acceptă.
  if (typeof timeZone !== "string" || timeZone.trim() === "" || /^[+-]/.test(timeZone.trim())) {
    throw new RangeError(`Fus orar necunoscut: «${String(timeZone)}»`);
  }
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    throw new RangeError(`Fus orar necunoscut: «${timeZone}»`);
  }
  formatters.set(timeZone, format);
  return format;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Ora locală a unui moment. */
export function localDateTime(instant: Date, timeZone: string): LocalDateTime {
  const time = instant.getTime();
  if (Number.isNaN(time)) throw new RangeError("Momentul nu este o dată validă");
  const parts = new Map<string, string>(
    formatterFor(timeZone)
      .formatToParts(instant)
      .map((p): [string, string] => [p.type, p.value]),
  );
  const read = (type: string): number => Number.parseInt(parts.get(type) ?? "0", 10);
  const year = read("year");
  const month = read("month");
  const day = read("day");
  return {
    year,
    month,
    day,
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second"),
    millisecond: ((time % 1000) + 1000) % 1000,
    weekday: ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1,
  };
}

/** Diferența dintre ora locală și UTC în momentul dat, în milisecunde. */
function offsetAt(instant: Date, timeZone: string): number {
  const l = localDateTime(instant, timeZone);
  const asUtc = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second, l.millisecond);
  return asUtc - instant.getTime();
}

/** Momentul (UTC) al unei ore locale: prima apariție dacă se repetă, offsetul de dinainte dacă nu există. */
export function zonedLocalToUtc(local: LocalDateTimeInput, timeZone: string): Date {
  formatterFor(timeZone);
  const second = local.second ?? 0;
  const millisecond = local.millisecond ?? 0;
  const guess = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    second,
    millisecond,
  );
  const before = offsetAt(new Date(guess - DAY_MS), timeZone);
  const after = offsetAt(new Date(guess + DAY_MS), timeZone);
  const matches = [...new Set([before, after])]
    .map((offset) => new Date(guess - offset))
    .filter((candidate) => {
      const l = localDateTime(candidate, timeZone);
      return (
        l.year === local.year &&
        l.month === local.month &&
        l.day === local.day &&
        l.hour === local.hour &&
        l.minute === local.minute &&
        l.second === second
      );
    })
    .sort((a, b) => a.getTime() - b.getTime());
  return matches[0] ?? new Date(guess - before);
}

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Următoarea rulare zilnică la `HH:MM` ora locală, STRICT după `after`. */
export function nextDailyRunAt(after: Date, time: string, timeZone: string): Date {
  const match = TIME_OF_DAY.exec(time);
  if (!match) throw new RangeError(`Ora trebuie scrisă HH:MM (24 de ore), nu «${time}»`);
  const hour = Number.parseInt(match[1] ?? "0", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  const today = localDateTime(after, timeZone);
  for (let ahead = 0; ahead <= 2; ahead++) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + ahead));
    const candidate = zonedLocalToUtc(
      {
        year: day.getUTCFullYear(),
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
        hour,
        minute,
      },
      timeZone,
    );
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  // nu se poate ajunge aici (în 3 zile există mereu o apariție), dar nu întoarcem un moment ghicit
  throw new RangeError(`Nu am găsit următoarea rulare la ${time} în ${timeZone}`);
}

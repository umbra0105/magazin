/**
 * Data și ora în fusul orar al MAGAZINULUI (setarea `regional.timezone`), nu în cel al browserului:
 * o promoție „de la 1 noiembrie 00:00” înseamnă 00:00 la București indiferent de unde editează
 * adminul. Formatul de schimb cu `<input type="datetime-local">` e „AAAA-LL-ZZTHH:mm”.
 */

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function partsIn(date: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const out: Record<string, number> = {};
  for (const part of parts) if (part.type !== "literal") out[part.type] = Number(part.value);
  return out;
}

/** Diferența dintre ora locală din `timeZone` și UTC la momentul `date`, în milisecunde. */
function offsetMs(date: Date, timeZone: string): number {
  const p = partsIn(date, timeZone);
  const asUtc = Date.UTC(
    p["year"] as number,
    (p["month"] as number) - 1,
    p["day"] as number,
    p["hour"] as number,
    p["minute"] as number,
    p["second"] as number,
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Momentul UTC → „AAAA-LL-ZZTHH:mm” în fusul magazinului. */
export function formatZonedLocal(date: Date, timeZone: string): string {
  const p = partsIn(date, timeZone);
  const pad = (n: number | undefined, width = 2) => String(n ?? 0).padStart(width, "0");
  return `${pad(p["year"], 4)}-${pad(p["month"])}-${pad(p["day"])}T${pad(p["hour"])}:${pad(p["minute"])}`;
}

/**
 * „AAAA-LL-ZZTHH:mm” în fusul magazinului → momentul UTC; `null` dacă formatul e greșit sau ora nu
 * există (ex. în golul orei de vară).
 */
export function parseZonedLocal(local: string, timeZone: string): Date | null {
  const m = LOCAL_PATTERN.exec(local);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let result = guess - offsetMs(new Date(guess), timeZone);
  // al doilea pas stabilizează ora la schimbarea de oră (offset-ul diferă între ghicire și rezultat)
  result = guess - offsetMs(new Date(result), timeZone);
  const date = new Date(result);
  return formatZonedLocal(date, timeZone) === local ? date : null;
}

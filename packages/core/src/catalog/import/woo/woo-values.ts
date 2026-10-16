import { parseDecimalInput } from "@ecom/shared/decimal";

/**
 * Parsarea valorilor unui export WooCommerce: unități (kg → g, cm → mm) cu aritmetică zecimală EXACTĂ
 * (pe șirul de cifre, fără `float`), date de promoție în fusul magazinului, liste separate prin virgulă
 * (cu virgula escapată «\,» a WooCommerce) și căi de categorii «Părinte > Copil».
 */

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Mută virgula zecimală cu `shift` poziții spre dreapta («0.5», 3 → 500; «12.5», 1 → 125). Fracțiunea rămasă
 * trebuie să fie zero: 0,0005 kg ar fi 0,5 g, care nu e un număr întreg de grame.
 */
export function shiftDecimalToInteger(canonical: string, shift: number): Parsed<number> {
  const negative = canonical.startsWith("-");
  const body = negative ? canonical.slice(1) : canonical;
  const [whole = "0", fraction = ""] = body.split(".");
  const padded = fraction.padEnd(shift, "0");
  const integerPart = `${whole}${padded.slice(0, shift)}`.replace(/^0+(?=\d)/, "");
  const rest = padded.slice(shift);
  if (/[1-9]/.test(rest))
    return { ok: false, error: "nu e un număr întreg în unitatea aplicației" };
  const value = Number(integerPart);
  if (!Number.isSafeInteger(value)) return { ok: false, error: "valoare prea mare" };
  return { ok: true, value: negative ? -value : value };
}

export type WeightUnit = "kg" | "g";
export type DimensionUnit = "cm" | "mm" | "m";

export const WEIGHT_SHIFT: Readonly<Record<WeightUnit, number>> = { kg: 3, g: 0 };
export const DIMENSION_SHIFT: Readonly<Record<DimensionUnit, number>> = { cm: 1, mm: 0, m: 3 };

export const isWeightUnit = (value: string | null): value is WeightUnit =>
  value === "kg" || value === "g";
export const isDimensionUnit = (value: string | null): value is DimensionUnit =>
  value === "cm" || value === "mm" || value === "m";

/** Valoarea unei măsurători în unitatea aplicației (g sau mm); `0` / gol = lipsă (WooCommerce scrie uneori 0). */
export function parseMeasure(raw: string, shift: number): Parsed<number | null> {
  const canonical = parseDecimalInput(raw);
  if (canonical === null)
    return { ok: false, error: "valoare invalidă (număr, cu virgulă sau punct)" };
  if (canonical.startsWith("-")) return { ok: false, error: "valoarea nu poate fi negativă" };
  const converted = shiftDecimalToInteger(canonical, shift);
  if (!converted.ok) return converted;
  return { ok: true, value: converted.value === 0 ? null : converted.value };
}

/** Împarte o listă WooCommerce după virgulă; «\,» rămâne în interiorul elementului. */
export function splitWooList(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (ch === "\\" && raw[i + 1] === ",") {
      current += ",";
      i++;
    } else if (ch === ",") {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** O cale de categorie «Părinte > Copil» → nivelurile ei (fără spații la capete). */
export function splitCategoryPath(path: string): string[] {
  return path.split(">").map((name) => name.trim());
}

/** Starea publicată: «1» = publicat; «0», «-1», «draft», «private», «pending» = nepublicat. */
export function isPublished(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "publish" || v === "published" || v === "da" || v === "yes";
}

// ---------------------------------------------------------------------------
// Date de promoție
// ---------------------------------------------------------------------------

/** Diferența (ms) dintre ora locală din `timeZone` și UTC la momentul `at`. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Ora de perete (an, lună, zi, oră...) din fusul magazinului → instantul UTC corespunzător. */
export function zonedToUtc(
  wall: { y: number; mo: number; d: number; h: number; mi: number; s: number },
  timeZone: string,
): Date {
  const guess = Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s);
  let offset = zoneOffsetMs(new Date(guess), timeZone);
  let result = guess - offset;
  // la trecerea între ora de vară și cea de iarnă offsetul se corectează o dată
  const corrected = zoneOffsetMs(new Date(result), timeZone);
  if (corrected !== offset) {
    offset = corrected;
    result = guess - offset;
  }
  return new Date(result);
}

/**
 * Data unei promoții: «2026-05-01», «2026-05-01 10:30[:00]», «2026-05-01T10:30:00», «01.05.2026» sau
 * «01/05/2026». Fără oră: începutul zilei pentru «de la», sfârșitul zilei pentru «până la». Ora se
 * interpretează în fusul magazinului.
 */
export function parseWooDate(raw: string, timeZone: string, edge: "start" | "end"): Parsed<Date> {
  const text = raw.trim();
  let y: number;
  let mo: number;
  let d: number;
  let time: RegExpExecArray | null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  const ro = /^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (iso) {
    y = Number(iso[1]);
    mo = Number(iso[2]);
    d = Number(iso[3]);
    time = iso;
  } else if (ro) {
    y = Number(ro[3]);
    mo = Number(ro[2]);
    d = Number(ro[1]);
    time = ro;
  } else {
    return { ok: false, error: "dată necunoscută (folosește AAAA-LL-ZZ sau ZZ.LL.AAAA)" };
  }
  const calendar = new Date(Date.UTC(y, mo - 1, d));
  if (
    mo < 1 ||
    mo > 12 ||
    calendar.getUTCFullYear() !== y ||
    calendar.getUTCMonth() !== mo - 1 ||
    calendar.getUTCDate() !== d
  ) {
    return { ok: false, error: "dată inexistentă" };
  }
  const hasTime = time?.[4] !== undefined;
  const h = hasTime ? Number(time?.[4]) : edge === "start" ? 0 : 23;
  const mi = hasTime ? Number(time?.[5]) : edge === "start" ? 0 : 59;
  const s = hasTime ? Number(time?.[6] ?? 0) : edge === "start" ? 0 : 59;
  if (h > 23 || mi > 59 || s > 59) return { ok: false, error: "oră invalidă" };
  return { ok: true, value: zonedToUtc({ y, mo, d, h, mi, s }, timeZone) };
}

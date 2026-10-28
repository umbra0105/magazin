/**
 * Unitățile din raportul SmartBill «Stoc la zi», normalizate printr-un TABEL EXPLICIT (nu prin ghicire). SmartBill lasă
 * unitatea ca text liber, deci aceeași unitate apare scrisă în mai multe feluri (BUC / buc / bucata / UNIT; MP / M2 …).
 * Comparația nu ține seama de litere mari/mici, de diacritice și de spații în plus. O unitate care nu e în tabel NU se
 * ghicește: planul de import o raportează ca eroare (vezi `stock-report-plan.ts`).
 *
 * Funcții PURE. Tabelul se extinde aici, într-un singur loc.
 */

/** Cheia canonică a unei unități de stoc (nu e codul `MeasureUnit` din baza de date: e doar pentru comparație). */
export type SmartbillUnitKey = "buc" | "ml" | "mp" | "mc" | "kg" | "l" | "sac" | "cutie" | "rola";

export type SmartbillUnitClass =
  { kind: "unit"; key: SmartbillUnitKey } | { kind: "service" } | { kind: "unknown"; text: string };

/** Text comparabil: tăiat, litere mici, fără diacritice, spații comprimate, fără punct la sfârșit. */
export function normalizeUnitText(text: string | null | undefined): string {
  if (typeof text !== "string") return "";
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "")
    .trim();
}

const UNIT_ALIASES: Readonly<Record<SmartbillUnitKey, readonly string[]>> = {
  buc: ["buc", "bucata", "bucati", "bucat", "unitate", "unit", "unitati"],
  ml: ["ml", "metru liniar", "metri liniari"],
  mp: ["mp", "m2", "metru patrat", "metri patrati"],
  mc: ["mc", "m3", "metru cub", "metri cubi"],
  kg: ["kg", "kilogram", "kilograme"],
  l: ["l", "lt", "litru", "litri"],
  sac: ["sac", "saci"],
  cutie: ["cutie", "cutii"],
  rola: ["rola", "role"],
};

/** Unitățile de SERVICII din raport: nu au stoc, deci rândurile lor se ignoră la import. */
const SERVICE_ALIASES: readonly string[] = ["curs", "xpp", "turn"];

const BY_ALIAS: ReadonlyMap<string, SmartbillUnitKey> = new Map(
  (Object.entries(UNIT_ALIASES) as Array<[SmartbillUnitKey, readonly string[]]>).flatMap(
    ([key, aliases]) => aliases.map((alias): [string, SmartbillUnitKey] => [alias, key]),
  ),
);

const SERVICES: ReadonlySet<string> = new Set(SERVICE_ALIASES);

export function classifySmartbillUnit(text: string | null | undefined): SmartbillUnitClass {
  const normalized = normalizeUnitText(text);
  const key = BY_ALIAS.get(normalized);
  if (key) return { kind: "unit", key };
  if (SERVICES.has(normalized)) return { kind: "service" };
  return { kind: "unknown", text: normalized };
}

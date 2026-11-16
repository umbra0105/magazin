/**
 * Filtrele listelor din vitrină (Faza 7, pasul C): marcă (selecție multiplă), interval numeric pe atribute filtrabile (debit,
 * putere, volum piscină) și opțiuni ale atributelor de tip listă. Se citesc din adresă (`?marca=a,b&f_debit=10-50&f_material=id1`),
 * deci pagina se poate partaja, reîncărca și funcționează fără JavaScript. Funcții pure; orice valoare greșită se ignoră.
 */

export const BRAND_PARAM = "marca";
export const ATTRIBUTE_PARAM_PREFIX = "f_";

export interface NumericRange {
  min: number | null;
  max: number | null;
}

export interface ListingFilters {
  /** Slug-urile mărcilor alese (selecție multiplă). */
  brands: string[];
  /** Interval pe un atribut numeric, după codul atributului. */
  ranges: Record<string, NumericRange>;
  /** Opțiunile alese la un atribut de tip listă, după codul atributului. */
  options: Record<string, string[]>;
}

export const EMPTY_FILTERS: ListingFilters = { brands: [], ranges: {}, options: {} };

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CODE = /^[a-z0-9_]{1,40}$/;
const OPTION_ID = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_ITEMS = 20;
/** Plafon pentru valorile numerice acceptate (ca o adresă să nu ceară numere absurde). */
const NUMBER_LIMIT = 1e12;

type Raw = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/** Valori separate prin virgulă, sau parametru repetat (casetele aceluiași formular trimit `marca=a&marca=b`). */
function list(value: string | string[] | undefined, pattern: RegExp): string[] {
  const items = (Array.isArray(value) ? value : [value ?? ""])
    .flatMap((part) => part.split(","))
    .map((item) => item.trim())
    .filter((item) => pattern.test(item));
  return [...new Set(items)].slice(0, MAX_ITEMS);
}

function parseNumber(text: string): number | null {
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && Math.abs(value) <= NUMBER_LIMIT ? value : null;
}

/** «10-50», «10-» (doar minim), «-50» (doar maxim), «10» (exact). Capetele inversate se întorc. `null` = nimic valid. */
export function parseRange(text: string): NumericRange | null {
  const trimmed = text.trim();
  const exact = /^(\d+(?:\.\d+)?)$/.exec(trimmed);
  if (exact) {
    const value = parseNumber(exact[1] as string);
    return value === null ? null : { min: value, max: value };
  }
  const pair = /^(\d+(?:\.\d+)?)?-(\d+(?:\.\d+)?)?$/.exec(trimmed);
  if (!pair || (pair[1] === undefined && pair[2] === undefined)) return null;
  const min = pair[1] === undefined ? null : parseNumber(pair[1]);
  const max = pair[2] === undefined ? null : parseNumber(pair[2]);
  if ((pair[1] !== undefined && min === null) || (pair[2] !== undefined && max === null))
    return null;
  if (min !== null && max !== null && min > max) return { min: max, max: min };
  return { min, max };
}

export function formatRange(range: NumericRange): string {
  if (range.min !== null && range.min === range.max) return String(range.min);
  return `${range.min ?? ""}-${range.max ?? ""}`;
}

/** Filtrele dintr-un obiect de parametri (`searchParams`). Parametrii necunoscuți se ignoră. */
export function parseListingFilters(params: Raw): ListingFilters {
  const filters: ListingFilters = {
    brands: list(params[BRAND_PARAM], SLUG),
    ranges: {},
    options: {},
  };
  for (const [name, value] of Object.entries(params)) {
    if (!name.startsWith(ATTRIBUTE_PARAM_PREFIX)) continue;
    const code = name.slice(ATTRIBUTE_PARAM_PREFIX.length);
    if (!CODE.test(code)) continue;
    const text = first(value);
    // un atribut e fie interval (cifre și «-»), fie listă de opțiuni (identificatori separați prin virgulă)
    if (/^[\d.-]+$/.test(text) && !text.includes(",")) {
      const range = parseRange(text);
      if (range) filters.ranges[code] = range;
    } else {
      const options = list(value, OPTION_ID);
      if (options.length > 0) filters.options[code] = options;
    }
  }
  // formularul fără JavaScript trimite capetele intervalului separat: `min_<cod>` și `max_<cod>` (se aduc la `f_<cod>=min-max`)
  for (const [name, value] of Object.entries(params)) {
    const side = name.startsWith("min_") ? "min" : name.startsWith("max_") ? "max" : null;
    if (!side) continue;
    const code = name.slice(4);
    if (!CODE.test(code) || filters.ranges[code]) continue;
    const text = first(value).trim().replace(",", ".");
    const other = first(params[`${side === "min" ? "max" : "min"}_${code}`])
      .trim()
      .replace(",", ".");
    const range = parseRange(`${side === "min" ? text : other}-${side === "min" ? other : text}`);
    if (range) filters.ranges[code] = range;
  }
  return filters;
}

/** Adresa conține forme de formular (`min_`/`max_`, parametri repetați) care se aduc la forma canonică (`f_`, liste cu virgulă). */
export function hasNonCanonicalFilterParams(params: Raw): boolean {
  return Object.entries(params).some(
    ([name, value]) =>
      name.startsWith("min_") ||
      name.startsWith("max_") ||
      (Array.isArray(value) && value.length > 1),
  );
}

export function hasActiveFilters(filters: ListingFilters): boolean {
  return (
    filters.brands.length > 0 ||
    Object.keys(filters.ranges).length > 0 ||
    Object.keys(filters.options).length > 0
  );
}

/** Parametrii adresei pentru filtre, în ordine stabilă (aceeași adresă pentru aceleași filtre). */
export function filtersToParams(filters: ListingFilters): [string, string][] {
  const out: [string, string][] = [];
  if (filters.brands.length > 0) out.push([BRAND_PARAM, [...filters.brands].sort().join(",")]);
  for (const code of Object.keys(filters.ranges).sort()) {
    out.push([
      `${ATTRIBUTE_PARAM_PREFIX}${code}`,
      formatRange(filters.ranges[code] as NumericRange),
    ]);
  }
  for (const code of Object.keys(filters.options).sort()) {
    out.push([
      `${ATTRIBUTE_PARAM_PREFIX}${code}`,
      [...(filters.options[code] as string[])].sort().join(","),
    ]);
  }
  return out;
}

/** Aceleași filtre fără unul singur (pentru chip-ul eliminabil): marca, intervalul sau opțiunea indicată. */
export function withoutFilter(
  filters: ListingFilters,
  target:
    | { kind: "brand"; slug: string }
    | { kind: "range"; code: string }
    | { kind: "option"; code: string; id: string },
): ListingFilters {
  const next: ListingFilters = {
    brands: [...filters.brands],
    ranges: { ...filters.ranges },
    options: Object.fromEntries(Object.entries(filters.options).map(([k, v]) => [k, [...v]])),
  };
  if (target.kind === "brand") next.brands = next.brands.filter((slug) => slug !== target.slug);
  if (target.kind === "range") delete next.ranges[target.code];
  if (target.kind === "option") {
    const remaining = (next.options[target.code] ?? []).filter((id) => id !== target.id);
    if (remaining.length > 0) next.options[target.code] = remaining;
    else delete next.options[target.code];
  }
  return next;
}

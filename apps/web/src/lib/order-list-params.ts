import {
  ORDER_SORTS,
  PAGE_SIZES,
  type OrderListQuery,
  type OrderSort,
  type OrderView,
} from "@ecom/core";
import { zonedLocalToUtc } from "@ecom/shared";
import { parseMoneyInput } from "./money-input";

/**
 * Parametrii din adresă ai listei de comenzi ↔ interogarea tipizată. Toate valorile sunt validate (liste albe, date calendaristice
 * reale, sume în lei cu cel mult 2 zecimale): o valoare necunoscută se ignoră și se raportează ca eroare pe câmp, niciodată nu ajunge
 * în interogare. Vederile salvate păstrează DOAR parametrii de filtru de aici (fără pagină), deci nu pot purta altceva.
 */
const VIEW_PARAM: Record<string, OrderView> = {
  toate: "all",
  "de-procesat": "to_process",
  "plata-asteptare": "payment_pending",
  atentie: "attention",
  furnizor: "supplier",
};
const VIEW_SLUG: Record<OrderView, string> = {
  all: "toate",
  to_process: "de-procesat",
  payment_pending: "plata-asteptare",
  attention: "atentie",
  supplier: "furnizor",
};
const SORT_PARAM: Record<string, OrderSort> = {
  noi: "placed_desc",
  vechi: "placed_asc",
  "total-desc": "total_desc",
  "total-asc": "total_asc",
  "numar-desc": "number_desc",
  "numar-asc": "number_asc",
};
const SORT_SLUG = Object.fromEntries(
  Object.entries(SORT_PARAM).map(([slug, id]) => [id, slug]),
) as Record<OrderSort, string>;

export const ORDER_STATUS_VALUES = [
  "draft",
  "pending",
  "confirmed",
  "processing",
  "completed",
  "cancelled",
  "returned",
] as const;
export const PAYMENT_STATUS_VALUES = [
  "pending",
  "authorized",
  "paid",
  "partially_refunded",
  "refunded",
  "failed",
  "cancelled",
  "chargeback",
] as const;
export const FULFILLMENT_STATUS_VALUES = [
  "unfulfilled",
  "partially_fulfilled",
  "fulfilled",
  "in_transit",
  "delivered",
  "returned",
  "cancelled",
] as const;
export const METHOD_VALUES = ["cod", "bank_transfer", "card"] as const;
export const INSTALLATION_VALUES = [
  "requested",
  "contacted",
  "scheduled",
  "done",
  "declined",
] as const;

/** Parametrii de filtru (fără pagină) care se păstrează într-o vedere salvată. */
export const FILTER_PARAMS = [
  "vedere",
  "q",
  "stare",
  "plata",
  "expediere",
  "metoda",
  "livrare",
  "de-la",
  "pana-la",
  "suma-min",
  "suma-max",
  "furnizor",
  "atentie",
  "instalare",
  "sortare",
] as const;

export interface AppliedFilter {
  /** Parametrul din adresă pe care îl scoate eticheta. */
  param: (typeof FILTER_PARAMS)[number];
  /** La liste: valoarea scoasă (restul rămân). */
  value?: string;
  label: string;
}

export interface ParsedOrderList {
  query: OrderListQuery;
  /** Eroarea pe câmp (cheia = numele parametrului), în română, pentru formular. */
  errors: Record<string, "date" | "range" | "amount" | "amountRange">;
  applied: AppliedFilter[];
  view: OrderView;
}

type Source = URLSearchParams | Record<string, string | string[] | undefined>;

function read(source: Source, name: string): string {
  if (source instanceof URLSearchParams) return source.get(name) ?? "";
  const value = source[name];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function csv(raw: string, allowed: readonly string[]): string[] {
  return [...new Set(raw.split(",").map((part) => part.trim()))].filter((part) =>
    allowed.includes(part),
  );
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
function parseDate(raw: string, timeZone: string): Date | null {
  const match = DATE.exec(raw);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return zonedLocalToUtc({ year, month, day, hour: 0, minute: 0 }, timeZone);
}

/** Ziua următoare, pentru limita «până la» (exclusivă): data aleasă se include întreagă. */
function nextDay(date: Date, timeZone: string): Date {
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date(date.getTime() + 12 * 3_600_000))
    .split("-")
    .map(Number);
  return zonedLocalToUtc(
    {
      year: local[0] as number,
      month: local[1] as number,
      day: (local[2] as number) + 1,
      hour: 0,
      minute: 0,
    },
    timeZone,
  );
}

export function parseOrderListParams(
  source: Source,
  options: { timeZone: string; labels: Record<string, Record<string, string>> },
): ParsedOrderList {
  const errors: ParsedOrderList["errors"] = {};
  const applied: AppliedFilter[] = [];
  const query: OrderListQuery = {};
  const L = options.labels;

  const view = VIEW_PARAM[read(source, "vedere")] ?? "all";
  if (view !== "all") query.view = view;

  const q = read(source, "q").trim().slice(0, 100);
  if (q !== "") {
    query.q = q;
    applied.push({ param: "q", label: `«${q}»` });
  }

  const list = (
    param: "stare" | "plata" | "expediere" | "metoda" | "instalare",
    allowed: readonly string[],
    target: "status" | "paymentStatus" | "fulfillmentStatus" | "paymentMethod" | "installation",
    labelGroup: string,
  ) => {
    const values = csv(read(source, param), allowed);
    if (values.length === 0) return;
    query[target] = values;
    for (const value of values) {
      applied.push({ param, value, label: L[labelGroup]?.[value] ?? value });
    }
  };
  list("stare", ORDER_STATUS_VALUES, "status", "statuses");
  list("plata", PAYMENT_STATUS_VALUES, "paymentStatus", "paymentStatuses");
  list("expediere", FULFILLMENT_STATUS_VALUES, "fulfillmentStatus", "fulfillmentStatuses");
  list("metoda", METHOD_VALUES, "paymentMethod", "methods");
  list("instalare", INSTALLATION_VALUES, "installation", "installationStatuses");

  const delivery = read(source, "livrare");
  if (delivery === "curier" || delivery === "ridicare") {
    query.delivery = delivery === "curier" ? "courier" : "pickup";
    applied.push({ param: "livrare", label: L["deliveryKinds"]?.[query.delivery] ?? delivery });
  }

  const fromRaw = read(source, "de-la");
  const toRaw = read(source, "pana-la");
  const from = fromRaw ? parseDate(fromRaw, options.timeZone) : null;
  const to = toRaw ? parseDate(toRaw, options.timeZone) : null;
  if (fromRaw && !from) errors["de-la"] = "date";
  if (toRaw && !to) errors["pana-la"] = "date";
  if (from && to && from.getTime() > to.getTime()) {
    errors["de-la"] = "range";
  } else {
    if (from) {
      query.from = from;
      applied.push({ param: "de-la", label: `de la ${fromRaw}` });
    }
    if (to) {
      query.to = nextDay(to, options.timeZone);
      applied.push({ param: "pana-la", label: `până la ${toRaw}` });
    }
  }

  const minRaw = read(source, "suma-min").trim();
  const maxRaw = read(source, "suma-max").trim();
  const min = minRaw ? parseMoneyInput(minRaw) : null;
  const max = maxRaw ? parseMoneyInput(maxRaw) : null;
  if (minRaw && min === null) errors["suma-min"] = "amount";
  if (maxRaw && max === null) errors["suma-max"] = "amount";
  if (min !== null && max !== null && min > max) {
    errors["suma-min"] = "amountRange";
  } else {
    if (min !== null) {
      query.minTotalMinor = min;
      applied.push({ param: "suma-min", label: `de la ${minRaw} lei` });
    }
    if (max !== null) {
      query.maxTotalMinor = max;
      applied.push({ param: "suma-max", label: `până la ${maxRaw} lei` });
    }
  }

  if (read(source, "furnizor") === "1") {
    query.supplier = true;
    applied.push({ param: "furnizor", label: "La furnizor" });
  }
  if (read(source, "atentie") === "1") {
    query.attention = true;
    applied.push({ param: "atentie", label: "Necesită atenție" });
  }

  const sort = SORT_PARAM[read(source, "sortare")];
  if (sort) query.sort = sort;

  const pageSize = Number.parseInt(read(source, "pe-pagina"), 10);
  query.pageSize = (PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : 25;
  const page = Number.parseInt(read(source, "pagina"), 10);
  query.page = Number.isFinite(page) && page > 1 ? Math.min(page, 100_000) : 1;
  return { query, errors, applied, view };
}

/** Șirul de parametri al filtrelor (fără pagină), în ordine stabilă, pentru adrese și vederi salvate. */
export function filterQueryString(source: Source): string {
  const out = new URLSearchParams();
  for (const name of FILTER_PARAMS) {
    const value = read(source, name).trim();
    if (value !== "") out.set(name, value);
  }
  return out.toString();
}

/** Vederea salvată: doar parametrii de filtru cunoscuți (orice altceva din șir se aruncă). */
export function sanitizeSavedQuery(raw: string): string {
  return filterQueryString(new URLSearchParams(raw.replace(/^\?/, "")));
}

export const viewSlug = (view: OrderView): string => VIEW_SLUG[view];
export const sortSlug = (sort: OrderSort): string => SORT_SLUG[sort];
export const SORT_SLUGS = ORDER_SORTS.map((id) => ({ id, slug: SORT_SLUG[id] }));

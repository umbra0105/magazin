import type { Db } from "../db-tx";

/**
 * Citirea unei comenzi pentru client: pagina de confirmare și urmărirea (`/comanda/urmarire`). Conține doar ce are voie să vadă
 * cel care a plasat comanda: stările, liniile, sumele, livrarea și localitatea de livrare. NU conține strada, telefonul, emailul
 * (urmărirea cere emailul, nu îl întoarce), CUI-ul sau vreo dată de achiziție.
 */

export interface OrderSummaryLine {
  title: string;
  variantTitle: string | null;
  imageUrl: string | null;
  /** Cantitatea în zecimi de miime, ca șir (bigint nu trece prin JSON), cu unitatea. */
  quantityTicks: string;
  unitSymbol: string;
  unitDecimals: number;
  lineTotalMinor: number;
  stockState: string;
  leadTimeDays: number | null;
}

export interface OrderSummary {
  number: string;
  placedAt: Date;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  paymentMethod: string;
  shipping: {
    carrier: string;
    service: string;
    kind: string;
    estimatedDays: number | null;
    freeShipping: boolean;
  };
  destination: { countyName: string; localityName: string } | null;
  /** Transfer bancar: până când ține rezervarea. */
  reservationExpiresAt: Date | null;
  /** Termenul cel mai lung dintre liniile «La comandă» (livrare toată odată). */
  longestLeadTimeDays: number | null;
  lines: OrderSummaryLine[];
  totals: {
    subtotalMinor: number;
    shippingMinor: number;
    codFeeMinor: number;
    taxMinor: number;
    totalMinor: number;
  };
  installationRequested: boolean;
}

const SELECT = {
  number: true,
  placedAt: true,
  status: true,
  paymentStatus: true,
  fulfillmentStatus: true,
  paymentMethod: true,
  shippingSnapshot: true,
  reservationExpiresAt: true,
  subtotalMinor: true,
  shippingMinor: true,
  codFeeMinor: true,
  taxMinor: true,
  totalMinor: true,
  installationRequested: true,
  lines: {
    orderBy: { createdAt: "asc" },
    select: {
      title: true,
      variantTitle: true,
      imageUrl: true,
      quantity: true,
      unitSymbol: true,
      unitDecimals: true,
      lineTotalMinor: true,
      stockState: true,
      leadTimeDays: true,
    },
  },
  addresses: { where: { kind: "shipping" }, select: { countyName: true, localityName: true } },
} as const;

type Row = NonNullable<Awaited<ReturnType<typeof load>>>;

function load(db: Db, where: { id: string } | { number: string; email: string }) {
  return db.order.findFirst({ where, select: SELECT });
}

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

function toSummary(row: Row): OrderSummary {
  const snapshot = (row.shippingSnapshot ?? {}) as Record<string, unknown>;
  const lead = row.lines.flatMap((line) =>
    line.stockState === "on_order" && line.leadTimeDays !== null ? [line.leadTimeDays] : [],
  );
  const address = row.addresses[0];
  return {
    number: row.number,
    placedAt: row.placedAt,
    status: row.status,
    paymentStatus: row.paymentStatus,
    fulfillmentStatus: row.fulfillmentStatus,
    paymentMethod: row.paymentMethod,
    shipping: {
      carrier: text(snapshot["carrier"]),
      service: text(snapshot["service"]),
      kind: text(snapshot["kind"], "courier"),
      estimatedDays:
        typeof snapshot["estimatedDays"] === "number" ? snapshot["estimatedDays"] : null,
      freeShipping: snapshot["freeShipping"] === true,
    },
    destination: address
      ? { countyName: address.countyName, localityName: address.localityName }
      : null,
    reservationExpiresAt: row.reservationExpiresAt,
    longestLeadTimeDays: lead.length > 0 ? Math.max(...lead) : null,
    lines: row.lines.map((line) => ({
      title: line.title,
      variantTitle: line.variantTitle,
      imageUrl: line.imageUrl,
      quantityTicks: line.quantity.toString(),
      unitSymbol: line.unitSymbol,
      unitDecimals: line.unitDecimals,
      lineTotalMinor: line.lineTotalMinor,
      stockState: line.stockState,
      leadTimeDays: line.leadTimeDays,
    })),
    totals: {
      subtotalMinor: row.subtotalMinor,
      shippingMinor: row.shippingMinor,
      codFeeMinor: row.codFeeMinor,
      taxMinor: row.taxMinor,
      totalMinor: row.totalMinor,
    },
    installationRequested: row.installationRequested,
  };
}

/** Rezumatul unei comenzi după id (pagina de confirmare: accesul e verificat de apelant, prin cookie semnat). */
export async function getOrderSummary(db: Db, orderId: string): Promise<OrderSummary | null> {
  const row = await load(db, { id: orderId });
  return row ? toSummary(row) : null;
}

/** Numărul se scrie cu majuscule și fără spații; emailul cu litere mici (cum se salvează la plasare). */
export function normalizeTrackingKey(
  number: string,
  email: string,
): { number: string; email: string } {
  return { number: number.replace(/\s+/g, "").toUpperCase(), email: email.trim().toLowerCase() };
}

/**
 * Urmărirea pentru oaspete: număr de comandă + email. O pereche necunoscută dă `null`, identic indiferent dacă numărul sau
 * emailul e cel greșit (nicio informație despre ce există). Limitarea cererilor e a apelantului.
 */
export async function trackOrder(
  db: Db,
  input: { number: string; email: string },
): Promise<OrderSummary | null> {
  const key = normalizeTrackingKey(input.number, input.email);
  if (key.number === "" || key.email === "") return null;
  const row = await load(db, key);
  return row ? toSummary(row) : null;
}

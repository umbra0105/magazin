import type { Prisma } from "@ecom/db";
import type { Db } from "../db-tx";

/**
 * Comenzile de expediat în masă (Faza 12): confirmate (plătite sau cu ramburs), încă neexpediate, cu livrare la adresă prin curier.
 * NU intră: ridicarea personală (fără AWB), transportul paletizat (AWB manual, din detaliul comenzii) și comenzile care au deja o
 * expediere activă. Cele mai vechi întâi. Fără date personale în afară de localitate și județ (destinația).
 */
export interface ReadyToShipRow {
  orderId: string;
  number: string;
  placedAt: Date;
  paymentMethod: string;
  paymentStatus: string;
  totalMinor: number;
  countyName: string | null;
  localityName: string | null;
}

export async function listOrdersReadyToShip(
  db: Db,
  options: { limit?: number; offset?: number } = {},
): Promise<{ rows: ReadyToShipRow[]; total: number }> {
  const where: Prisma.OrderWhereInput = {
    status: { in: ["confirmed", "processing"] },
    fulfillmentStatus: "unfulfilled",
    shippingMethodCode: { notIn: ["pickup", "pallet"] },
    externalId: null,
    shipments: { none: { kind: "outbound", status: { not: "cancelled" } } },
  };
  const [orders, total] = await Promise.all([
    db.order.findMany({
      where,
      orderBy: [{ placedAt: "asc" }, { id: "asc" }],
      take: options.limit ?? 100,
      skip: options.offset ?? 0,
      select: {
        id: true,
        number: true,
        placedAt: true,
        paymentMethod: true,
        paymentStatus: true,
        totalMinor: true,
        addresses: {
          where: { kind: "shipping" },
          select: { countyName: true, localityName: true },
        },
      },
    }),
    db.order.count({ where }),
  ]);
  return {
    total,
    rows: orders.map((order) => ({
      orderId: order.id,
      number: order.number,
      placedAt: order.placedAt,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      totalMinor: order.totalMinor,
      countyName: order.addresses[0]?.countyName ?? null,
      localityName: order.addresses[0]?.localityName ?? null,
    })),
  };
}

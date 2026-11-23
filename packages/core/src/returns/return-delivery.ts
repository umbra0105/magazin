import type { Db } from "../db-tx";
import { settingGroups } from "../settings/registry";
import { isReturnWindowOpen, returnWindowEnd } from "./return-eligibility";

/**
 * Momentul livrării unei comenzi și fereastra de retur (decizia 2026-11-22):
 *  - livrare cu curier: `deliveredAt` al expedierii «outbound» livrate (altfel momentul evenimentului `order.delivered`);
 *  - ridicare personală: momentul în care adminul a marcat comanda ca ridicată (`order.picked_up`);
 *  - fără o dată de livrare, clientul NU poate iniția returul din cont.
 * Nu se blochează nimic pe baza «la comandă», «paletizat» sau «supradimensionat» (INTREBARI-AVOCAT 1.6).
 */
export const DELIVERY_EVENT_TYPES = ["order.delivered", "order.picked_up"] as const;

export async function readReturnWindowDays(db: Db): Promise<number> {
  const row = await db.setting.findUnique({ where: { key: "returns.windowDays" } });
  const parsed = settingGroups.returns.windowDays.safeParse(row?.value);
  return parsed.success ? parsed.data : settingGroups.returns.windowDays.parse(undefined);
}

/** Prima livrare consemnată a comenzii, sau `null` dacă nu există. */
export async function resolveDeliveredAt(db: Db, orderId: string): Promise<Date | null> {
  const shipment = await db.shipment.findFirst({
    where: { orderId, kind: "outbound", status: "delivered", deliveredAt: { not: null } },
    orderBy: { deliveredAt: "asc" },
    select: { deliveredAt: true },
  });
  if (shipment?.deliveredAt) return shipment.deliveredAt;
  const event = await db.orderEvent.findFirst({
    where: { orderId, type: { in: [...DELIVERY_EVENT_TYPES] } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  return event?.createdAt ?? null;
}

export interface ReturnWindow {
  deliveredAt: Date | null;
  windowDays: number;
  /** Sfârșitul ferestrei; nul dacă nu există o livrare consemnată. */
  endsAt: Date | null;
  open: boolean;
}

export async function resolveReturnWindow(
  db: Db,
  orderId: string,
  now: Date,
): Promise<ReturnWindow> {
  const [deliveredAt, windowDays] = await Promise.all([
    resolveDeliveredAt(db, orderId),
    readReturnWindowDays(db),
  ]);
  if (!deliveredAt) return { deliveredAt: null, windowDays, endsAt: null, open: false };
  return {
    deliveredAt,
    windowDays,
    endsAt: returnWindowEnd(deliveredAt, windowDays),
    open: isReturnWindowOpen(now, deliveredAt, windowDays),
  };
}

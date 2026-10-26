import type { StockAlerts } from "@ecom/core";
import { snapshotView, type Tone } from "./stock-view";
import { stockHref } from "./stock-url";

/**
 * Cardurile de stoc din Panou (funcții PURE): numerele vin de la serviciu (`StockOverviewService.alerts`), legăturile duc la
 * vederea «Stoc mic» a paginii Stoc (cu motivul pentru «Doar rest nevandabil»), iar starea pozei SmartBill folosește aceleași
 * texte ca banner-ul paginii Stoc.
 */

export interface AlertCardsView {
  lowStock: { total: number; outOfStock: number; href: string };
  remainder: { count: number; href: string };
  snapshot: {
    status: "fresh" | "stale" | "never" | "none";
    tone: Tone;
    text: string;
    href: string;
  };
}

export function alertCardsView(
  alerts: Pick<StockAlerts, "lowStock" | "freshness" | "settings">,
): AlertCardsView {
  const { lowStock, freshness, settings } = alerts;
  const snapshot = snapshotView(freshness, settings.timeZone, settings.snapshotStaleHours);
  return {
    lowStock: {
      total: lowStock.total,
      outOfStock: lowStock.outOfStock,
      href: stockHref({ lowStockOnly: true }),
    },
    remainder: {
      count: lowStock.remainderOnly,
      href: stockHref({ lowStockOnly: true, reason: "remainder_only" }),
    },
    snapshot: {
      status: freshness?.status ?? "none",
      tone: snapshot.tone,
      text: snapshot.text,
      href: stockHref({}),
    },
  };
}

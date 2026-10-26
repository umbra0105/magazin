import Link from "next/link";
import type { StockAlerts } from "@ecom/core";
import { Badge, cn } from "@ecom/ui";
import { alertCardsView } from "@/lib/stock-alerts";
import { getMessages } from "@/messages";
import { badgeVariant } from "../inventory/stock-parts";

const m = getMessages().admin.dashboard.stock;

const CARD =
  "relative flex h-full flex-col gap-1 rounded-md border p-4 hover:bg-border/30 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

/**
 * Cardurile de stoc din Panou: «Stoc mic», «Doar rest nevandabil» și «Sincronizare SmartBill». Fiecare e o legătură spre vederea
 * «Stoc mic» (sau spre pagina Stoc, pentru poză). Se afișează doar cu `inventory.read`: pagina Panou nici nu citește stocul fără
 * acest drept.
 */
export function StockAlertCards({
  alerts,
}: {
  alerts: Pick<StockAlerts, "lowStock" | "freshness" | "settings">;
}) {
  const view = alertCardsView(alerts);
  const attention = view.lowStock.total > 0;
  return (
    <section
      aria-labelledby="stock-alerts-heading"
      data-stock-alerts
      className="flex flex-col gap-3"
    >
      <h2 id="stock-alerts-heading" className="text-lg font-semibold">
        {m.heading}
      </h2>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <li>
          <Link
            href={view.lowStock.href}
            aria-label={m.lowStock.aria(view.lowStock.total)}
            data-alert="low-stock"
            className={cn(CARD, attention ? "border-border" : "border-success/50")}
          >
            <span className="text-sm text-muted-foreground">{m.lowStock.title}</span>
            <span className="text-3xl font-semibold" data-value>
              {view.lowStock.total}
            </span>
            <span className="text-xs text-muted-foreground">
              {m.lowStock.detail(view.lowStock.outOfStock)}
            </span>
          </Link>
        </li>
        <li>
          <Link
            href={view.remainder.href}
            aria-label={m.remainder.aria(view.remainder.count)}
            data-alert="remainder"
            className={cn(CARD, "border-border")}
          >
            <span className="text-sm text-muted-foreground">{m.remainder.title}</span>
            <span className="text-3xl font-semibold" data-value>
              {view.remainder.count}
            </span>
            <span className="text-xs text-muted-foreground">{m.remainder.detail}</span>
          </Link>
        </li>
        <li>
          <Link
            href={view.snapshot.href}
            aria-label={m.snapshot.aria}
            data-alert="snapshot"
            data-status={view.snapshot.status}
            data-tone={view.snapshot.tone}
            className={cn(
              CARD,
              view.snapshot.tone === "danger" ? "border-danger bg-danger/10" : "border-border",
            )}
          >
            <span className="text-sm text-muted-foreground">{m.snapshot.title}</span>
            <span>
              <Badge variant={badgeVariant(view.snapshot.tone)} className="whitespace-nowrap">
                {m.snapshot.status[view.snapshot.status]}
              </Badge>
            </span>
            <span className="text-xs text-muted-foreground">{view.snapshot.text}</span>
          </Link>
        </li>
      </ul>
    </section>
  );
}

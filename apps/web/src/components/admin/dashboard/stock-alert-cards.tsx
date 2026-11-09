import Link from "next/link";
import type { StockAlerts } from "@ecom/core";
import { Badge, KpiContent, cn, kpiCardVariants } from "@ecom/ui";
import { alertCardsView } from "@/lib/stock-alerts";
import { badgeVariant } from "@/lib/stock-view";
import { getMessages } from "@/messages";
import { StockHealth } from "../inventory/stock-parts";

const m = getMessages().admin.dashboard.stock;

/**
 * Cardurile de stoc din Panou (docs/17 §4.4): «Stoc mic», «Doar rest nevandabil» și «Sincronizare SmartBill» ca carduri de
 * indicator, fiecare o legătură spre vederea «Stoc mic» (sau spre pagina Stoc, pentru sincronizare), și dedesubt bara de stoc
 * segmentată. Se afișează doar cu `inventory.read`: pagina Panou nici nu citește stocul fără acest drept. Starea nu stă în culoarea
 * fundalului: «Sincronizare» are pastilă cu cuvântul (La zi / Neactualizat / Neimportat), «Stoc mic» are cifra și explicația.
 */
export function StockAlertCards({
  alerts,
}: {
  alerts: Pick<StockAlerts, "lowStock" | "freshness" | "settings" | "managedVariants">;
}) {
  const view = alertCardsView(alerts);
  const attention = view.lowStock.total > 0;
  return (
    <section
      aria-labelledby="stock-alerts-heading"
      data-stock-alerts
      className="flex flex-col gap-4"
    >
      <h2 id="stock-alerts-heading" className="text-section">
        {m.heading}
      </h2>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <li>
          <Link
            href={view.lowStock.href}
            aria-label={m.lowStock.aria(view.lowStock.total)}
            data-alert="low-stock"
            className={cn(
              kpiCardVariants({ tone: attention ? "peach" : "green", interactive: true }),
              "h-full",
            )}
          >
            <KpiContent
              label={m.lowStock.title}
              value={view.lowStock.total}
              detail={m.lowStock.detail(view.lowStock.outOfStock)}
            />
          </Link>
        </li>
        <li>
          <Link
            href={view.remainder.href}
            aria-label={m.remainder.aria(view.remainder.count)}
            data-alert="remainder"
            className={cn(kpiCardVariants({ tone: "indigo", interactive: true }), "h-full")}
          >
            <KpiContent
              label={m.remainder.title}
              value={view.remainder.count}
              detail={m.remainder.detail}
            />
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
              kpiCardVariants({
                tone: view.snapshot.status === "fresh" ? "green" : "peach",
                interactive: true,
              }),
              "h-full",
            )}
          >
            <KpiContent
              label={m.snapshot.title}
              value={
                <Badge variant={badgeVariant(view.snapshot.tone)} dot>
                  {view.snapshot.label}
                </Badge>
              }
              detail={view.snapshot.text}
            />
          </Link>
        </li>
      </ul>
      <StockHealth lowStock={alerts.lowStock} managedVariants={alerts.managedVariants} heading />
    </section>
  );
}

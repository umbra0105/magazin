import type { Metadata } from "next";
import { can } from "@ecom/core";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ecom/ui";
import { StockAlertCards } from "@/components/admin/dashboard/stock-alert-cards";
import { requireAdmin } from "@/lib/admin-page";
import { getStockOverviewService } from "@/lib/inventory";
import { getMessages } from "@/messages";

const m = getMessages().admin.dashboard;

export const metadata: Metadata = { title: m.title };

/** Alertele de stoc: doar cu `inventory.read` (fără el nici nu se citește stocul); fără depozit nu se arată nimic. */
async function loadStockAlerts(subject: Awaited<ReturnType<typeof requireAdmin>>) {
  if (!can(subject, "inventory.read")) return null;
  try {
    return await getStockOverviewService().alerts(subject);
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "STOCK_NO_WAREHOUSE") return null;
    throw error;
  }
}

export default async function AdminHomePage() {
  const subject = await requireAdmin();
  const alerts = await loadStockAlerts(subject);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{m.title}</h1>
      {alerts && <StockAlertCards alerts={alerts} />}
      <Card>
        <CardHeader>
          <CardTitle>{m.description}</CardTitle>
          <CardDescription>{m.placeholder}</CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </div>
  );
}

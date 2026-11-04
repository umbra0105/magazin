import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { can } from "@ecom/core";
import { buttonVariants } from "@ecom/ui";
import { StockActivationPanel } from "@/components/admin/inventory/stock-activation-panel";
import { requireAdmin } from "@/lib/admin-page";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.inventory.stockActivation;

export const metadata: Metadata = { title: m.title };

/** Mărimea maximă a raportului, în MB (aceeași cu `STOCK_REPORT_MAX_BYTES`). */
const MAX_MB = 5;

/**
 * Pornirea în masă a gestionării stocului din fișierul SmartBill. Cere `inventory.write` ȘI `products.write` (și ruta de
 * încărcare le verifică din nou). Ecranul face parte din «Stoc»: nu are element propriu în meniu.
 */
export default async function StockActivationPage() {
  const subject = await requireAdmin({ permission: "inventory.write" });
  if (!can(subject, "products.write")) redirect("/admin/acces-interzis");
  const regional = await getSettings().getGroup("regional");

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-semibold">{m.title}</h1>
          <Link
            href="/admin/produse/stoc/import"
            className={buttonVariants({ variant: "outline" })}
          >
            {m.back}
          </Link>
        </div>
        <p className="text-sm text-muted-foreground">{m.description}</p>
      </header>
      <StockActivationPanel timeZone={regional.timezone} locale={regional.locale} maxMb={MAX_MB} />
    </div>
  );
}

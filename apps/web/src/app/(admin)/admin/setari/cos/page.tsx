import type { Metadata } from "next";
import { can } from "@ecom/core";
import { CartSettingsForm } from "@/components/admin/cart-settings/cart-settings-form";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { formatMoneyInput } from "@/lib/money-input";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.cartSettings;

export const metadata: Metadata = { title: m.title };

/** Setările coșului (pragul de transport gratuit). Cere `settings.read`; salvarea cere `settings.write` (verificat și în acțiune). */
export default async function CartSettingsPage() {
  const subject = await requireAdmin({ permission: "settings.read" });
  const threshold = await getSettings().get("checkout.freeShippingThreshold");
  const regional = await getSettings().getGroup("regional");
  const canSave = can(subject, "settings.write");
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={m.title} description={m.description} notes={canSave ? [] : [m.readOnly]} />
      <CartSettingsForm
        canSave={canSave}
        currency={regional.currency}
        initial={{ threshold: threshold === null ? "" : formatMoneyInput(threshold) }}
      />
    </div>
  );
}

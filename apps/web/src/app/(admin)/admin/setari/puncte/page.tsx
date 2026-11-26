import type { Metadata } from "next";
import { LoyaltySettingsForm } from "@/components/admin/loyalty/loyalty-settings-form";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { formatMoneyInput } from "@/lib/money-input";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.loyalty.settings;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

/** Setările programului «Puncte de loialitate» (Faza 15b). Pagina și salvarea cer `loyalty.configure` și flag-ul `loyalty`. */
export default async function LoyaltySettingsPage() {
  await requireAdmin({ permission: "loyalty.configure", feature: "loyalty" });
  const settings = getSettings();
  const [loyalty, regional] = await Promise.all([
    settings.getGroup("loyalty"),
    settings.getGroup("regional"),
  ]);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={m.title} description={m.description} />
      <LoyaltySettingsForm
        currency={regional.currency}
        initial={{
          enabled: loyalty.enabled,
          vatMode: loyalty.vatMode ?? "",
          earnRate: formatMoneyInput(loyalty.earnRate),
          earnOnDiscountedItems: loyalty.earnOnDiscountedItems,
          pointValue: formatMoneyInput(loyalty.pointValue),
          minRedeemPoints: String(loyalty.minRedeemPoints),
          maxRedeemPercent:
            loyalty.maxRedeemPercent === null ? "" : String(loyalty.maxRedeemPercent),
          minCashAmount: formatMoneyInput(loyalty.minCashAmount),
          expiryMonths: String(loyalty.expiryMonths),
          expiryWarningDays: String(loyalty.expiryWarningDays),
          releasedGraceDays: String(loyalty.releasedGraceDays),
        }}
      />
    </div>
  );
}

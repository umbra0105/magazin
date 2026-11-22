import type { Metadata } from "next";
import { can } from "@ecom/core";
import { PageHeader } from "@/components/admin/page-header";
import { PalletSettingsForm } from "@/components/admin/shipping/pallet-settings-form";
import { requireAdmin } from "@/lib/admin-page";
import { formatMoneyInput } from "@/lib/money-input";
import { formatScaledInput } from "@/lib/scaled-input";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.shipping.pallet;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

/** Setările transportului paletizat: preț fix per palet, prag, capacitate. Citire cu `settings.read`, scriere cu `settings.write`. */
export default async function PalletSettingsPage() {
  const subject = await requireAdmin({ permission: "settings.read" });
  const [shipping, regional] = await Promise.all([
    getSettings().getGroup("shipping"),
    getSettings().getGroup("regional"),
  ]);
  const canSave = can(subject, "settings.write");
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader
        title={m.title}
        description={m.description}
        notes={canSave ? [m.simplification] : [m.readOnly, m.simplification]}
      />
      <PalletSettingsForm
        canSave={canSave}
        currency={regional.currency}
        initial={{
          price: formatMoneyInput(shipping.palletPriceMinor),
          threshold: formatMoneyInput(shipping.palletSwitchThresholdMinor),
          maxWeightKg: formatScaledInput(shipping.palletMaxWeightGrams, 3),
          maxVolumeM3: formatScaledInput(shipping.palletMaxVolumeCm3, 6),
          manualCarriers: shipping.manualCarriers.join("\n"),
        }}
      />
    </div>
  );
}

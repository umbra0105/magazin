import type { Metadata } from "next";
import {
  FreeShippingExclusionService,
  can,
  formatPickupAddress,
  isPickupAddressComplete,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { CartSettingsForm } from "@/components/admin/cart-settings/cart-settings-form";
import { FreeShippingExclusions } from "@/components/admin/cart-settings/free-shipping-exclusions";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { formatMoneyInput } from "@/lib/money-input";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.cartSettings;

export const metadata: Metadata = { title: m.title };

/** Setările coșului, transportului, plății și numerotării comenzilor. Cere `settings.read`; salvarea cere `settings.write`. */
export default async function CartSettingsPage() {
  const subject = await requireAdmin({ permission: "settings.read" });
  const settings = getSettings();
  const [checkout, shipping, payment, regional, company] = await Promise.all([
    settings.getGroup("checkout"),
    settings.getGroup("shipping"),
    settings.getGroup("payment"),
    settings.getGroup("regional"),
    settings.getGroup("company"),
  ]);
  const canSave = can(subject, "settings.write");
  const exclusions = await new FreeShippingExclusionService(getDb()).list();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={m.title} description={m.description} notes={canSave ? [] : [m.readOnly]} />
      <CartSettingsForm
        canSave={canSave}
        currency={regional.currency}
        pickupAddress={
          isPickupAddressComplete(company.address) ? formatPickupAddress(company.address) : null
        }
        extra={<FreeShippingExclusions initial={exclusions} canWrite={canSave} />}
        initial={{
          threshold:
            checkout.freeShippingThreshold === null
              ? ""
              : formatMoneyInput(checkout.freeShippingThreshold),
          classes: [...checkout.freeShippingClasses],
          pickupEnabled: shipping.pickupEnabled,
          groundNotice: shipping.groundLevelNotice,
          codIndividual: formatMoneyInput(payment.codMaxAmountIndividual),
          codCompany: formatMoneyInput(payment.codMaxAmountCompany),
          orderPrefix: checkout.orderNumberPrefix,
          orderDigits: String(checkout.orderNumberDigits),
          nonWorkingDates: regional.nonWorkingDates.join("\n"),
        }}
      />
    </div>
  );
}

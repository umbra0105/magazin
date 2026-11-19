import type { Metadata } from "next";
import { GeoService, ShippingZoneService, can } from "@ecom/core";
import { getDb } from "@ecom/db";
import { PageHeader } from "@/components/admin/page-header";
import { ZoneManager } from "@/components/admin/shipping-zones/zone-manager";
import { requireAdmin } from "@/lib/admin-page";
import { formatMoneyInput } from "@/lib/money-input";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.shippingZones;

export const metadata: Metadata = { title: m.title };

/** Zonele de livrare pe județe (rezerva când furnizorul de tarife nu răspunde). Cere `settings.read`; scrierea cere `settings.write`. */
export default async function ShippingZonesPage() {
  const subject = await requireAdmin({ permission: "settings.read" });
  const db = getDb();
  const [zones, counties, regional] = await Promise.all([
    new ShippingZoneService(db).list(),
    new GeoService(db).counties(),
    getSettings().getGroup("regional"),
  ]);
  const canWrite = can(subject, "settings.write");
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={m.title}
        count={zones.length}
        description={m.description}
        notes={canWrite ? [] : [m.readOnly]}
      />
      <ZoneManager
        canWrite={canWrite}
        currency={regional.currency}
        counties={counties}
        zones={zones.map((zone) => ({
          id: zone.id,
          name: zone.name,
          isActive: zone.isActive,
          countyCodes: zone.countyCodes,
          methodName: zone.method.name,
          carrier: zone.method.carrier ?? "",
          type: zone.method.type,
          price: formatMoneyInput(zone.method.priceMinor),
          includedKg: String(zone.method.includedKg).replace(".", ","),
          perExtraKg: formatMoneyInput(zone.method.perExtraKgMinor),
          freeAbove:
            zone.method.freeAboveMinor === null ? "" : formatMoneyInput(zone.method.freeAboveMinor),
          codFee: formatMoneyInput(zone.method.codFeeMinor),
          days: zone.method.estimatedDays === null ? "" : String(zone.method.estimatedDays),
        }))}
      />
    </div>
  );
}

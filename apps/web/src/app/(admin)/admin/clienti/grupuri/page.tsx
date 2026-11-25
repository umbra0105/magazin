import type { Metadata } from "next";
import { can } from "@ecom/core";
import { GroupManager } from "@/components/admin/customers/group-manager";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { getCustomerGroupService } from "@/lib/customers";
import { getMessages } from "@/messages";

const m = getMessages().admin.customerGroups;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

const TONES = ["neutral", "info", "success", "warning", "danger"] as const;

/** Grupurile de clienți (Faza 15). Se văd cu `customers.read`; creare, editare și ștergere cer `customers.groups.manage`. */
export default async function CustomerGroupsPage() {
  const subject = await requireAdmin({ permission: "customers.read" });
  const groups = await getCustomerGroupService().list(subject);
  const canWrite = can(subject, "customers.groups.manage");

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <PageHeader
        title={m.title}
        count={groups.length}
        description={m.description}
        notes={canWrite ? [] : [m.readOnly]}
      />
      <GroupManager
        canWrite={canWrite}
        rows={groups.map((group) => ({
          id: group.id,
          name: group.name,
          pricingType: group.pricingType,
          discountBps: group.discountBps,
          markupBps: group.markupBps,
          stacksWithSalePrice: group.stacksWithSalePrice,
          earnsLoyaltyPoints: group.earnsLoyaltyPoints,
          tone: TONES.find((tone) => tone === group.tone) ?? "neutral",
          isSystem: group.isSystem,
          isActive: group.isActive,
          memberCount: group.memberCount,
          orderCount: group.orderCount,
        }))}
      />
    </div>
  );
}

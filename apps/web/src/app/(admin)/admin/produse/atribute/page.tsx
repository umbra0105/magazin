import type { Metadata } from "next";
import { can } from "@ecom/core";
import { AttributeManager } from "@/components/admin/attributes/attribute-manager";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { getAttributeService } from "@/lib/catalog";
import { getMessages } from "@/messages";

const m = getMessages().admin.attributes;

export const metadata: Metadata = { title: m.title };

/**
 * Definițiile atributelor. Cere `products.read`; crearea, modificarea și ștergerea cer
 * `products.write` (verificat din nou pe server la fiecare acțiune).
 */
export default async function AttributesPage() {
  const subject = await requireAdmin({ permission: "products.read" });
  const attributes = await getAttributeService().list(subject);
  const canWrite = can(subject, "products.write");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={m.title}
        count={attributes.length}
        description={m.description}
        notes={canWrite ? [] : [m.readOnly]}
      />
      <AttributeManager
        canWrite={canWrite}
        attributes={attributes.map((a) => ({
          id: a.id,
          code: a.code,
          name: a.name,
          type: a.type,
          unit: a.unit,
          isFilterable: a.isFilterable,
          sortOrder: a.sortOrder,
          productCount: a.productCount,
          options: a.options.map((o) => ({
            id: o.id,
            value: o.value,
            productCount: o.productCount,
          })),
        }))}
      />
    </div>
  );
}

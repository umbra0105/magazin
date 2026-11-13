import type { Metadata } from "next";
import { can } from "@ecom/core";
import { PageHeader } from "@/components/admin/page-header";
import { DiagramList } from "@/components/admin/diagrams/diagram-list";
import { requireAdmin } from "@/lib/admin-page";
import { getPartsDiagramService } from "@/lib/catalog";
import { getMessages } from "@/messages";

const m = getMessages().admin.diagrams;

export const metadata: Metadata = { title: m.title };

/**
 * Fișele explodate. Cere `products.read` ȘI flag-ul `partsDiagrams`: cu flag-ul oprit ruta răspunde
 * 404 (la fel ca meniul, care dispare). Crearea și ștergerea cer `products.write`, re-verificat pe
 * server la fiecare acțiune.
 */
export default async function DiagramsPage() {
  const subject = await requireAdmin({ permission: "products.read", feature: "partsDiagrams" });
  const diagrams = await getPartsDiagramService().list(subject);
  const canWrite = can(subject, "products.write");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={m.title}
        count={diagrams.length}
        description={m.description}
        notes={canWrite ? [] : [m.readOnly]}
      />
      <DiagramList
        canWrite={canWrite}
        diagrams={diagrams.map((d) => ({
          id: d.id,
          title: d.title,
          hotspotCount: d.hotspotCount,
          productCount: d.productCount,
          imageUrl: d.image.url,
          imageName: d.image.name,
        }))}
      />
    </div>
  );
}

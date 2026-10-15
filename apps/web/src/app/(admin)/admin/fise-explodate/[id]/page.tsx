import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { can } from "@ecom/core";
import { DiagramEditor } from "@/components/admin/diagrams/diagram-editor";
import { requireAdmin } from "@/lib/admin-page";
import { getPartsDiagramService } from "@/lib/catalog";
import { getMessages } from "@/messages";

const m = getMessages().admin.diagrams;

export const metadata: Metadata = { title: m.editTitle };

/** Editorul unei fișe. Același regim ca lista: `products.read` + flag `partsDiagrams` (altfel 404). */
export default async function DiagramEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const subject = await requireAdmin({ permission: "products.read", feature: "partsDiagrams" });
  const { id } = await params;
  let diagram;
  try {
    diagram = await getPartsDiagramService().get(subject, id);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "DIAGRAM_NOT_FOUND") notFound();
    throw error;
  }

  return (
    <DiagramEditor
      canWrite={can(subject, "products.write")}
      diagram={{
        id: diagram.id,
        title: diagram.title,
        image: {
          mediaId: diagram.image.mediaId,
          name: diagram.image.name,
          alt: diagram.image.alt,
          url: diagram.image.url,
          width: diagram.image.width,
          height: diagram.image.height,
        },
        hotspots: diagram.hotspots.map((h) => ({
          id: h.id,
          number: h.number,
          xBp: h.xBp,
          yBp: h.yBp,
          label: h.label,
          product: h.product,
        })),
        products: diagram.products,
      }}
    />
  );
}

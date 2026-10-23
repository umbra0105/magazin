import type { Metadata } from "next";
import { can } from "@ecom/core";
import { BrandManager } from "@/components/admin/brands/brand-manager";
import { requireAdmin } from "@/lib/admin-page";
import { getBrandService } from "@/lib/catalog";
import { getMediaLibrary } from "@/lib/media";
import { getMessages } from "@/messages";

const m = getMessages().admin.brands;

export const metadata: Metadata = { title: m.title };

type SearchParams = Record<string, string | string[] | undefined>;

/** Brandurile. Cere `products.read`; scrierea după permisiunile din catalog (vezi `docs/04` §6). */
export default async function BrandsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const subject = await requireAdmin({ permission: "products.read" });
  const params = await searchParams;
  const editParam = params["edit"];
  const editId = (Array.isArray(editParam) ? editParam[0] : editParam) ?? null;

  const brands = await getBrandService().list(subject);
  const capabilities = {
    structure: can(subject, "products.write"),
    content: can(subject, "products.content.write"),
    legacy: can(subject, "catalog.legacy.edit"),
    pickMedia: can(subject, "media.read"),
  };

  const thumbs: Record<string, string> = {};
  const logoIds = [...new Set(brands.map((b) => b.logoMediaId).filter((v): v is string => !!v))];
  if (capabilities.pickMedia && logoIds.length > 0) {
    const items = await getMediaLibrary().statuses(subject, logoIds.slice(0, 60));
    for (const item of items) if (item.thumb) thumbs[item.id] = item.thumb.url;
  }

  const canEdit = capabilities.structure || capabilities.content;
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{m.title}</h1>
        <p className="text-sm text-muted-foreground">{m.description}</p>
        {!canEdit && (
          <p role="note" className="mt-2 rounded-md border border-border bg-border/30 p-3 text-sm">
            {m.readOnly}
          </p>
        )}
        {canEdit && !capabilities.structure && (
          <p role="note" className="mt-2 rounded-md border border-border bg-border/30 p-3 text-sm">
            {m.contentOnly}
          </p>
        )}
      </header>
      <BrandManager rows={brands} capabilities={capabilities} thumbs={thumbs} editId={editId} />
    </div>
  );
}

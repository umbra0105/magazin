import type { Metadata } from "next";
import { MAX_CATEGORY_DEPTH, can, childrenOf, validParents, type CategoryNode } from "@ecom/core";
import { CategoryManager } from "@/components/admin/categories/category-manager";
import type { CategoryRow } from "@/components/admin/categories/category-types";
import { requireAdmin } from "@/lib/admin-page";
import { getCategoryService } from "@/lib/catalog";
import { getMediaLibrary } from "@/lib/media";
import { getMessages } from "@/messages";

const m = getMessages().admin.categories;

export const metadata: Metadata = { title: m.title };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Categoriile. Pagina cere `products.read`; butoanele de structură apar cu `products.write`, editarea
 * conținutului cu `products.content.write`, câmpurile din magazinul vechi cu `catalog.legacy.edit`
 * (serverul verifică oricum fiecare acțiune). Părinții permiși pentru mutare se calculează aici, pe
 * server, cu aceeași logică ca validarea mutării.
 */
export default async function CategoriesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const subject = await requireAdmin({ permission: "products.read" });
  const params = await searchParams;
  const editParam = params["edit"];
  const editId = (Array.isArray(editParam) ? editParam[0] : editParam) ?? null;

  const tree = await getCategoryService().tree(subject);
  const nodes: CategoryNode[] = tree.map((c) => ({
    id: c.id,
    parentId: c.parentId,
    slug: c.slug,
    name: c.name,
    path: c.path,
    depth: c.depth,
    sortOrder: c.sortOrder,
  }));
  const byId = new Map(tree.map((c) => [c.id, c]));

  // lista plată în ordinea afișării (în adâncime, frații după ordine)
  const rows: CategoryRow[] = [];
  const walk = (parentId: string | null) => {
    const siblings = childrenOf(nodes, parentId);
    siblings.forEach((node, index) => {
      const c = byId.get(node.id);
      if (!c) return;
      rows.push({
        id: c.id,
        parentId: c.parentId,
        name: c.name,
        slug: c.slug,
        path: c.path,
        depth: c.depth,
        index,
        siblingCount: siblings.length,
        productCount: c.productCount,
        description: c.description,
        seoTitle: c.seoTitle,
        seoDescription: c.seoDescription,
        imageMediaId: c.imageMediaId,
        excludeFromGroupDiscount: c.excludeFromGroupDiscount,
        legacyId: c.legacyId,
        legacyUrl: c.legacyUrl,
        validParentIds: validParents(nodes, c.id),
      });
      walk(c.id);
    });
  };
  walk(null);

  const capabilities = {
    structure: can(subject, "products.write"),
    content: can(subject, "products.content.write"),
    legacy: can(subject, "catalog.legacy.edit"),
    pickMedia: can(subject, "media.read"),
  };

  // miniaturile imaginilor (doar cu `media.read`)
  const thumbs: Record<string, string> = {};
  const imageIds = [...new Set(rows.map((r) => r.imageMediaId).filter((v): v is string => !!v))];
  if (capabilities.pickMedia && imageIds.length > 0) {
    const items = await getMediaLibrary().statuses(subject, imageIds.slice(0, 60));
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
      <CategoryManager
        rows={rows}
        capabilities={capabilities}
        maxDepth={MAX_CATEGORY_DEPTH}
        thumbs={thumbs}
        editId={editId}
      />
    </div>
  );
}

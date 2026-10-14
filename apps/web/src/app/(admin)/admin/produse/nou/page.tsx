import type { Metadata } from "next";
import Link from "next/link";
import { childrenOf, type CategoryNode } from "@ecom/core";
import { NewProductForm } from "@/components/admin/products/new-product-form";
import { requireAdmin } from "@/lib/admin-page";
import { getBrandService, getCategoryService } from "@/lib/catalog";
import { getMessages } from "@/messages";

const m = getMessages().admin.products;

export const metadata: Metadata = { title: m.editor.createTitle };

/**
 * Produs nou: formular de creare rapidă. Cere `products.write` (un Editor nu creează produse: nu
 * are preț, stoc sau stare de gestionat). Serverul verifică permisiunea din nou la salvare.
 */
export default async function NewProductPage() {
  const subject = await requireAdmin({ permission: "products.write" });
  const [brands, categoryRows] = await Promise.all([
    getBrandService().list(subject),
    getCategoryService().tree(subject),
  ]);

  const nodes: CategoryNode[] = categoryRows.map((c) => ({
    id: c.id,
    parentId: c.parentId,
    slug: c.slug,
    name: c.name,
    path: c.path,
    depth: c.depth,
    sortOrder: c.sortOrder,
  }));
  const categories: { id: string; label: string }[] = [];
  const walk = (parentId: string | null) => {
    for (const node of childrenOf(nodes, parentId)) {
      categories.push({ id: node.id, label: `${"— ".repeat(node.depth)}${node.name}` });
      walk(node.id);
    }
  };
  walk(null);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <Link
          href="/admin/produse"
          className="text-sm text-primary underline-offset-2 hover:underline"
        >
          {m.editor.back}
        </Link>
        <h1 className="text-2xl font-semibold">{m.editor.createTitle}</h1>
        <p className="text-sm text-muted-foreground">{m.editor.createDescription}</p>
      </header>
      <NewProductForm
        brands={brands.map((b) => ({ id: b.id, label: b.name }))}
        categories={categories}
      />
    </div>
  );
}

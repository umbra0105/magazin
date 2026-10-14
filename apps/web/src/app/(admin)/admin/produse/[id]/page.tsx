import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { can, childrenOf, type CategoryNode } from "@ecom/core";
import { percentToBasisPoints } from "@ecom/shared/vat";
import { PurchasePanel } from "@/components/admin/products/purchase-panel";
import { ProductEditor } from "@/components/admin/products/product-editor";
import type { EditorVariant } from "@/components/admin/products/editor-types";
import { requireAdmin } from "@/lib/admin-page";
import {
  getBrandService,
  getCategoryService,
  getProductAssignmentsService,
  getProductService,
} from "@/lib/catalog";
import { getSettings } from "@/lib/services";
import { formatZonedLocal } from "@/lib/zoned-time";
import { getMessages } from "@/messages";

const m = getMessages().admin.products;

export const metadata: Metadata = { title: m.editor.breadcrumbEdit };

type SearchParams = Record<string, string | string[] | undefined>;

const TAB_IDS = ["general", "preturi", "stoc", "categorii", "media", "seo"] as const;

const one = (value: string | string[] | undefined): string | null =>
  (Array.isArray(value) ? value[0] : value) ?? null;

/**
 * Editorul unui produs. Cere `products.read`; ce poate modifica cineva se decide pe capabilități
 * (`products.write` pentru preț/stoc/livrare/stare/brand/categorii, `products.content.write` pentru
 * conținut) și se re-verifică pe server la fiecare salvare. Pagina nu citește prețul de achiziție:
 * panoul lui e o componentă de server separată, randată doar cu `products.cost.view`.
 */
export default async function ProductEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const subject = await requireAdmin({ permission: "products.read" });
  const { id } = await params;
  const query = await searchParams;

  let loaded;
  try {
    loaded = await getProductService().getForEdit(subject, id);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "CATALOG_PRODUCT_NOT_FOUND") notFound();
    throw error;
  }
  const { product, variants } = loaded;
  if (product.deletedAt) notFound();

  const assignments = getProductAssignmentsService();
  const [assigned, mediaItems, brands, categoryRows, tax, regional, inventory, catalog] =
    await Promise.all([
      assignments.getCategories(subject, id),
      assignments.listMedia(subject, id),
      getBrandService().list(subject),
      getCategoryService().tree(subject),
      getSettings().getGroup("tax"),
      getSettings().getGroup("regional"),
      getSettings().getGroup("inventory"),
      getSettings().getGroup("catalog"),
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
  const categoryOptions: { id: string; name: string; depth: number }[] = [];
  const walk = (parentId: string | null) => {
    for (const node of childrenOf(nodes, parentId)) {
      categoryOptions.push({ id: node.id, name: node.name, depth: node.depth });
      walk(node.id);
    }
  };
  walk(null);

  const zone = regional.timezone;
  const editorVariants: EditorVariant[] = variants.map((v) => ({
    id: v.id,
    sku: v.sku,
    ean: v.ean,
    warrantyMonths: v.warrantyMonths,
    price: v.price,
    salePrice: v.salePrice,
    saleStartsAtLocal: v.saleStartsAt ? formatZonedLocal(v.saleStartsAt, zone) : null,
    saleEndsAtLocal: v.saleEndsAt ? formatZonedLocal(v.saleEndsAt, zone) : null,
    isDefault: v.isDefault,
  }));

  const tabParam = one(query["tab"]);
  const defaultTab = (TAB_IDS as readonly string[]).includes(tabParam ?? "")
    ? (tabParam as string)
    : "general";

  const primary = assigned.find((c) => c.isPrimary)?.categoryId ?? null;

  return (
    <div className="flex flex-col gap-4">
      {one(query["created"]) === "1" && (
        <p role="status" className="rounded-md border border-border bg-border/30 p-3 text-sm">
          {m.editor.created}
        </p>
      )}
      <ProductEditor
        product={{
          id: product.id,
          slug: product.slug,
          title: product.title,
          subtitle: product.subtitle,
          description: product.description,
          status: product.status,
          brandId: product.brandId,
          shippingClass: product.shippingClass,
          requiresInstallation: product.requiresInstallation,
          excludeFromGroupDiscount: product.excludeFromGroupDiscount,
          manageStock: product.manageStock,
          stockStatus: product.stockStatus,
          seoTitle: product.seoTitle,
          seoDescription: product.seoDescription,
        }}
        variants={editorVariants}
        brands={brands.map((b) => ({ id: b.id, label: b.name }))}
        categoryOptions={categoryOptions}
        assigned={{ ids: assigned.map((c) => c.categoryId), primaryId: primary }}
        media={mediaItems.map((item) => ({
          id: item.id,
          mediaId: item.mediaId,
          name: item.name,
          alt: item.alt,
          status: item.status,
          thumb: item.thumb,
        }))}
        caps={{
          canWrite: can(subject, "products.write"),
          canContent: can(subject, "products.content.write"),
        }}
        pricing={{
          vatRateBps: percentToBasisPoints(tax.standardRate),
          vatRateLabel: String(tax.standardRate).replace(".", ","),
          currency: regional.currency,
          locale: regional.locale,
          timezone: zone,
          defaultWarrantyMonths: catalog.defaultWarrantyMonths,
        }}
        storeManagesStock={inventory.manageStock}
        defaultTab={defaultTab}
        purchaseSlot={
          <PurchasePanel
            subject={subject}
            productId={product.id}
            variants={variants.map((v) => ({ id: v.id, sku: v.sku }))}
            status={one(query["purchase"])}
          />
        }
      />
    </div>
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  ADJUSTMENT_NOTE_MAX,
  ADJUSTMENT_REASONS,
  ADJUSTMENT_REASON_LABELS,
  ADJUSTMENT_SIGN_RULES,
  can,
  childrenOf,
  hasCopySkuMarker,
  type CategoryNode,
  type ProductStockView,
} from "@ecom/core";
import { percentToBasisPoints } from "@ecom/shared/vat";
import type { ReasonOption } from "@/components/admin/inventory/adjust-stock-dialog";
import { ProductStockPanel } from "@/components/admin/products/product-stock-panel";
import { PurchasePanel } from "@/components/admin/products/purchase-panel";
import { ProductEditor } from "@/components/admin/products/product-editor";
import type { EditorVariant } from "@/components/admin/products/editor-types";
import { requireAdmin } from "@/lib/admin-page";
import {
  getBrandService,
  getCategoryService,
  getProductAssignmentsService,
  getProductAttributesService,
  getProductRelationsService,
  getPartsDiagramService,
  getProductService,
} from "@/lib/catalog";
import { getMeasureUnitService, getStockOverviewService } from "@/lib/inventory";
import { getProductDocumentsService } from "@/lib/product-documents";
import { getFeatureFlags, getSettings } from "@/lib/services";
import { formatZonedLocal } from "@/lib/zoned-time";
import { getMessages } from "@/messages";

const m = getMessages().admin.products;

export const metadata: Metadata = { title: m.editor.breadcrumbEdit };

type SearchParams = Record<string, string | string[] | undefined>;

const TAB_IDS = [
  "general",
  "preturi",
  "vanzare",
  "variante",
  "stoc",
  "categorii",
  "atribute",
  "asociate",
  "piese",
  "documente",
  "conformitate",
  "media",
  "seo",
] as const;

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
  const { product } = loaded;
  if (product.deletedAt) notFound();

  // Fișele explodate: doar cu flag-ul pornit (altfel tabul nu există și serviciul nici nu e chemat)
  let spareParts: {
    attached: {
      id: string;
      title: string;
      hotspotCount: number;
      productCount: number;
      imageUrl: string | null;
    }[];
    available: {
      id: string;
      title: string;
      hotspotCount: number;
      productCount: number;
      imageUrl: string | null;
    }[];
  } | null = null;
  if (await getFeatureFlags().isEnabled("partsDiagrams")) {
    const diagrams = getPartsDiagramService();
    const [attachedRows, allRows] = await Promise.all([
      diagrams.forProduct(subject, id),
      diagrams.list(subject),
    ]);
    const shape = (d: (typeof allRows)[number]) => ({
      id: d.id,
      title: d.title,
      hotspotCount: d.hotspotCount,
      productCount: d.productCount,
      imageUrl: d.image.url,
    });
    const attachedIds = new Set(attachedRows.map((d) => d.id));
    spareParts = {
      attached: attachedRows.map(shape),
      available: allRows.filter((d) => !attachedIds.has(d.id)).map(shape),
    };
  }

  const assignments = getProductAssignmentsService();
  const [
    assigned,
    mediaItems,
    variantData,
    attributeEntries,
    relationRows,
    documentRows,
    brands,
    categoryRows,
    tax,
    regional,
    inventory,
    catalog,
    documentSettings,
    measureUnits,
  ] = await Promise.all([
    assignments.getCategories(subject, id),
    assignments.listMedia(subject, id),
    getProductService().getVariantsForEdit(subject, id),
    getProductAttributesService().get(subject, id),
    getProductRelationsService().list(subject, id),
    getProductDocumentsService().list(subject, id),
    getBrandService().list(subject),
    getCategoryService().tree(subject),
    getSettings().getGroup("tax"),
    getSettings().getGroup("regional"),
    getSettings().getGroup("inventory"),
    getSettings().getGroup("catalog"),
    getSettings().getGroup("documents"),
    getMeasureUnitService().list(subject),
  ]);

  // Stocul produsului: starea cu `products.read`, cantitățile (redactate pe server) cu `inventory.read`; fără depozit, `null`
  let stockView: ProductStockView | null = null;
  try {
    stockView = await getStockOverviewService().forProduct(subject, id);
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== "STOCK_NO_WAREHOUSE") throw error;
  }
  const reasons: ReasonOption[] = ADJUSTMENT_REASONS.map((value) => ({
    value,
    label: ADJUSTMENT_REASON_LABELS[value],
    rule: ADJUSTMENT_SIGN_RULES[value],
  }));

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
  const variants = variantData.variants;
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
    weightGrams: v.weightGrams,
    manufacturerPartNumber: v.manufacturerPartNumber,
    measureUnitId: v.measureUnitId,
    priceBasis: v.priceBasis,
    saleStep: v.saleStep,
    minSteps: v.minSteps,
    smartbillMode: v.smartbillMode,
    smartbillUnitName: v.smartbillUnitName,
    smartbillRatio: v.smartbillRatio,
    manageStock: v.manageStock,
    stockStatus: v.stockStatus,
    label: v.selections.map((s) => `${s.option}: ${s.value}`).join(", "),
  }));

  const tabParam = one(query["tab"]);
  const defaultTab = (TAB_IDS as readonly string[]).includes(tabParam ?? "")
    ? (tabParam as string)
    : "general";

  const primary = assigned.find((c) => c.isPrimary)?.categoryId ?? null;

  return (
    <div className="flex flex-col gap-4">
      {one(query["copied"]) === "1" && (
        <p role="status" className="rounded-md border border-border bg-border/30 p-3 text-sm">
          {m.lifecycle.duplicatedNotes(Number(one(query["docs"]) ?? 0) || 0)}
        </p>
      )}
      {variants.some((v) => hasCopySkuMarker(v.sku)) && (
        <p role="note" data-copy-note className="rounded-md border border-border p-3 text-sm">
          {m.editor.copyNote}
        </p>
      )}
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
          measureUnitId: product.measureUnitId,
          priceBasis: product.priceBasis,
          saleStep: product.saleStep,
          minSteps: product.minSteps,
          showStepPrice: product.showStepPrice,
          saleStepLabel: product.saleStepLabel,
          type: product.type,
          allowBackorder: product.allowBackorder,
          leadTimeDays: product.leadTimeDays,
          seoTitle: product.seoTitle,
          seoDescription: product.seoDescription,
          energyClass: product.energyClass,
          eprelUrl: product.eprelUrl,
          gpsrManufacturerName: product.gpsrManufacturerName,
          gpsrManufacturerContact: product.gpsrManufacturerContact,
          gpsrResponsibleName: product.gpsrResponsibleName,
          gpsrResponsibleContact: product.gpsrResponsibleContact,
          safetyWarnings: product.safetyWarnings,
        }}
        documents={documentRows.map((doc) => ({
          id: doc.id,
          type: doc.type,
          title: doc.title,
          originalName: doc.originalName,
          mime: doc.mime,
          sizeBytes: doc.sizeBytes,
          language: doc.language,
          showInTab: doc.showInTab,
        }))}
        spareParts={spareParts}
        documentMaxMb={Math.max(1, Math.floor(documentSettings.maxUploadBytes / (1024 * 1024)))}
        variants={editorVariants}
        units={measureUnits.map((u) => ({
          id: u.id,
          code: u.code,
          name: u.name,
          symbol: u.symbol,
          decimals: u.decimals,
          isActive: u.isActive,
        }))}
        variantOptions={variantData.options}
        attributes={attributeEntries.map((entry) => ({
          id: entry.attribute.id,
          code: entry.attribute.code,
          name: entry.attribute.name,
          type: entry.attribute.type,
          unit: entry.attribute.unit,
          isFilterable: entry.attribute.isFilterable,
          options: entry.attribute.options.map((o) => ({ id: o.id, value: o.value })),
          value: entry.value,
        }))}
        relations={relationRows.map((rel) => ({
          id: rel.id,
          type: rel.type,
          position: rel.position,
          direction: rel.direction,
          product: rel.product,
        }))}
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
        stockLeadTime={{
          brandDays: brands.find((b) => b.id === product.brandId)?.defaultLeadTimeDays ?? null,
          brandName: brands.find((b) => b.id === product.brandId)?.name ?? null,
          globalDays: inventory.defaultLeadTimeDays,
        }}
        stockSlot={
          <ProductStockPanel
            view={stockView}
            canWrite={can(subject, "inventory.write")}
            reasons={reasons}
            timeZone={zone}
            noteMax={ADJUSTMENT_NOTE_MAX}
          />
        }
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

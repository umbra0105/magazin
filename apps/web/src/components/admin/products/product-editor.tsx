"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, Tabs, type TabItem } from "@ecom/ui";
import { getMessages } from "@/messages";
import { CategoriesTab, type CategoryOption } from "./categories-tab";
import type {
  EditorCaps,
  EditorMediaItem,
  EditorProduct,
  EditorVariant,
  PickOption,
} from "./editor-types";
import { GeneralTab } from "./general-tab";
import { MediaTab } from "./media-tab";
import { PricingTab } from "./pricing-tab";
import { SeoTab } from "./seo-tab";
import { StockTab } from "./stock-tab";
import { UnsavedChangesProvider, useDirtyKeys } from "./unsaved-changes";

const m = getMessages().admin.products;
const e = m.editor;

export interface ProductEditorProps {
  product: EditorProduct;
  variants: readonly EditorVariant[];
  brands: readonly PickOption[];
  categoryOptions: readonly CategoryOption[];
  assigned: { ids: string[]; primaryId: string | null };
  media: readonly EditorMediaItem[];
  caps: EditorCaps;
  pricing: {
    vatRateBps: number;
    vatRateLabel: string;
    currency: string;
    locale: string;
    timezone: string;
    defaultWarrantyMonths: number;
  };
  storeManagesStock: boolean;
  defaultTab: string;
  /** Panoul prețului de achiziție, randat pe server; `null` fără permisiunea de vizualizare. */
  purchaseSlot: ReactNode;
}

/**
 * Editorul de produs pe taburi. Fiecare tab are formularul și salvarea lui; starea „modificat” a
 * fiecăruia alimentează avertismentul la părăsirea paginii. Taburile Variante, Atribute, Asociate,
 * Documente, GPSR și Fișa explodată vin în blocurile următoare (11b, 11c).
 */
export function ProductEditor(props: ProductEditorProps) {
  return (
    <UnsavedChangesProvider message={e.unsavedConfirm}>
      <EditorBody {...props} />
    </UnsavedChangesProvider>
  );
}

function EditorBody({
  product,
  variants,
  brands,
  categoryOptions,
  assigned,
  media,
  caps,
  pricing,
  storeManagesStock,
  defaultTab,
  purchaseSlot,
}: ProductEditorProps) {
  const dirty = useDirtyKeys();
  const badge = (key: string) =>
    dirty.includes(key) ? (
      <span>
        <span aria-hidden className="text-primary">
          ●
        </span>
        <span className="sr-only"> ({e.unsavedMark})</span>
      </span>
    ) : undefined;

  const tabs: TabItem[] = [
    {
      id: "general",
      label: e.tabs.general,
      badge: badge("general"),
      panel: <GeneralTab product={product} brands={brands} caps={caps} />,
    },
    {
      id: "preturi",
      label: e.tabs.pricing,
      badge: badge("pricing"),
      panel: (
        <PricingTab variants={variants} caps={caps} context={pricing} purchaseSlot={purchaseSlot} />
      ),
    },
    {
      id: "stoc",
      label: e.tabs.stock,
      badge: badge("stock"),
      panel: <StockTab product={product} caps={caps} storeManagesStock={storeManagesStock} />,
    },
    {
      id: "categorii",
      label: e.tabs.categories,
      badge: badge("categories"),
      panel: (
        <CategoriesTab
          productId={product.id}
          options={categoryOptions}
          initial={assigned}
          caps={caps}
        />
      ),
    },
    {
      id: "media",
      label: e.tabs.media,
      badge: badge("media"),
      panel: <MediaTab productId={product.id} initial={media} caps={caps} />,
    },
    {
      id: "seo",
      label: e.tabs.seo,
      badge: badge("seo"),
      panel: <SeoTab product={product} caps={caps} />,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <Link
          href="/admin/produse"
          className="text-sm text-primary underline-offset-2 hover:underline"
        >
          {e.back}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{e.editTitle(product.title)}</h1>
          <Badge>{(m.statuses as Record<string, string>)[product.status] ?? product.status}</Badge>
        </div>
        {!caps.canWrite && caps.canContent && (
          <p role="note" className="rounded-md border border-border bg-border/30 p-3 text-sm">
            {e.notices.contentOnly}
          </p>
        )}
        {!caps.canWrite && !caps.canContent && (
          <p role="note" className="rounded-md border border-border bg-border/30 p-3 text-sm">
            {e.notices.readOnly}
          </p>
        )}
      </header>
      <Tabs label={e.tabsLabel} tabs={tabs} defaultTab={defaultTab} />
    </div>
  );
}

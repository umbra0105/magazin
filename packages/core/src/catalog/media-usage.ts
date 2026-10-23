import type { PrismaClient } from "@ecom/db";
import { MediaUsageRegistry, type MediaUsage, type MediaUsageProvider } from "../media/usage";

type Db = Pick<PrismaClient, "productMedia" | "partsDiagram" | "category" | "brand">;

export const PRODUCT_MEDIA_USAGE_PROVIDER = "product-media";

export const PARTS_DIAGRAM_MEDIA_USAGE_PROVIDER = "parts-diagram-media";
export const CATEGORY_MEDIA_USAGE_PROVIDER = "category-media";
export const BRAND_MEDIA_USAGE_PROVIDER = "brand-media";

/** Tipurile de utilizare raportate de provider (chei stabile, nu text afișat). */
export const PRODUCT_USAGE_KINDS = { product: "product", variant: "product_variant" } as const;

/**
 * Unde sunt folosite fișierele media în catalog: rândurile `ProductMedia` (la nivel de produs sau de
 * variantă). Include și produsele șterse (soft delete): ele încă referă fișierul, iar baza de date
 * refuză ștergerea (FK `Restrict`), deci biblioteca trebuie să explice refuzul, nu să cadă cu o eroare.
 */
export function createProductMediaUsageProvider(db: Db): MediaUsageProvider {
  return {
    name: PRODUCT_MEDIA_USAGE_PROVIDER,
    async findUsages(mediaIds) {
      const out = new Map<string, MediaUsage[]>();
      if (mediaIds.length === 0) return out;
      const rows = await db.productMedia.findMany({
        where: { mediaId: { in: [...mediaIds] } },
        select: {
          mediaId: true,
          product: { select: { id: true, title: true, deletedAt: true } },
          variant: { select: { sku: true } },
        },
        orderBy: [{ product: { title: "asc" } }, { position: "asc" }],
      });
      for (const row of rows) {
        // produs șters definitiv între citiri: relația vine `null` (Prisma o citește separat); rândul se omite (C-34)
        if (!row.product) continue;
        const deleted = row.product.deletedAt ? " (șters)" : "";
        const usage: MediaUsage = {
          kind: row.variant ? PRODUCT_USAGE_KINDS.variant : PRODUCT_USAGE_KINDS.product,
          label: row.variant
            ? `Produs: ${row.product.title}, varianta ${row.variant.sku}${deleted}`
            : `Produs: ${row.product.title}${deleted}`,
          href: `/admin/produse/${row.product.id}`,
        };
        out.set(row.mediaId, [...(out.get(row.mediaId) ?? []), usage]);
      }
      return out;
    },
  };
}

/** Fișele explodate care folosesc fișierul ca imagine; linkul duce la editorul fișei. */
export function createPartsDiagramMediaUsageProvider(db: Db): MediaUsageProvider {
  return {
    name: PARTS_DIAGRAM_MEDIA_USAGE_PROVIDER,
    async findUsages(mediaIds) {
      const out = new Map<string, MediaUsage[]>();
      if (mediaIds.length === 0) return out;
      const rows = await db.partsDiagram.findMany({
        where: { mediaId: { in: [...mediaIds] } },
        select: { id: true, mediaId: true, title: true },
        orderBy: { title: "asc" },
      });
      for (const row of rows) {
        out.set(row.mediaId, [
          ...(out.get(row.mediaId) ?? []),
          {
            kind: "parts_diagram",
            label: `Fișă explodată: ${row.title}`,
            href: `/admin/produse/fise-explodate/${row.id}`,
          },
        ]);
      }
      return out;
    },
  };
}

/** Categoriile care folosesc fișierul ca imagine. Linkul duce la pagina categoriilor, cu editorul deschis. */
export function createCategoryMediaUsageProvider(db: Db): MediaUsageProvider {
  return {
    name: CATEGORY_MEDIA_USAGE_PROVIDER,
    async findUsages(mediaIds) {
      const out = new Map<string, MediaUsage[]>();
      if (mediaIds.length === 0) return out;
      const rows = await db.category.findMany({
        where: { imageMediaId: { in: [...mediaIds] } },
        select: { id: true, name: true, imageMediaId: true },
        orderBy: { name: "asc" },
      });
      for (const row of rows) {
        if (!row.imageMediaId) continue;
        out.set(row.imageMediaId, [
          ...(out.get(row.imageMediaId) ?? []),
          {
            kind: "category",
            label: `Categorie: ${row.name}`,
            href: `/admin/produse/categorii?edit=${row.id}`,
          },
        ]);
      }
      return out;
    },
  };
}

/** Brandurile care folosesc fișierul ca logo. */
export function createBrandMediaUsageProvider(db: Db): MediaUsageProvider {
  return {
    name: BRAND_MEDIA_USAGE_PROVIDER,
    async findUsages(mediaIds) {
      const out = new Map<string, MediaUsage[]>();
      if (mediaIds.length === 0) return out;
      const rows = await db.brand.findMany({
        where: { logoMediaId: { in: [...mediaIds] } },
        select: { id: true, name: true, logoMediaId: true },
        orderBy: { name: "asc" },
      });
      for (const row of rows) {
        if (!row.logoMediaId) continue;
        out.set(row.logoMediaId, [
          ...(out.get(row.logoMediaId) ?? []),
          {
            kind: "brand",
            label: `Brand: ${row.name}`,
            href: `/admin/produse/branduri?edit=${row.id}`,
          },
        ]);
      }
      return out;
    },
  };
}

/**
 * Modelele Prisma care referă `Media` printr-o relație și providerul care le raportează. E lista pe
 * care o verifică testul de arhitectură: un model nou care referă `Media` fără intrare aici (sau fără
 * provider înregistrat) face testul să pice, deci un fișier folosit nu poate ajunge ștergibil în tăcere.
 * (`MediaFolder` nu referă fișiere: fișierele referă folderul.)
 */
export const MEDIA_REFERENCING_MODELS: Readonly<Record<string, string>> = {
  ProductMedia: PRODUCT_MEDIA_USAGE_PROVIDER,
  PartsDiagram: PARTS_DIAGRAM_MEDIA_USAGE_PROVIDER,
  Category: CATEGORY_MEDIA_USAGE_PROVIDER,
  Brand: BRAND_MEDIA_USAGE_PROVIDER,
};

/**
 * Registrul de utilizare media cu toți providerii nucleului. Aplicația îl folosește pentru
 * `getMediaUsageRegistry()`; fazele următoare (pagini, bannere: Faza 16) își adaugă aici providerul.
 */
export function createMediaUsageRegistry(db: Db): MediaUsageRegistry {
  const registry = new MediaUsageRegistry();
  registry.register(createProductMediaUsageProvider(db));
  registry.register(createPartsDiagramMediaUsageProvider(db));
  registry.register(createCategoryMediaUsageProvider(db));
  registry.register(createBrandMediaUsageProvider(db));
  return registry;
}

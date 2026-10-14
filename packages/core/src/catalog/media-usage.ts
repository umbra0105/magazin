import type { PrismaClient } from "@ecom/db";
import { MediaUsageRegistry, type MediaUsage, type MediaUsageProvider } from "../media/usage";

type Db = Pick<PrismaClient, "productMedia" | "partsDiagram">;

export const PRODUCT_MEDIA_USAGE_PROVIDER = "product-media";

export const PARTS_DIAGRAM_MEDIA_USAGE_PROVIDER = "parts-diagram-media";

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

/** Fișele explodate care folosesc fișierul ca imagine. Fără link: editorul lor vine mai târziu. */
export function createPartsDiagramMediaUsageProvider(db: Db): MediaUsageProvider {
  return {
    name: PARTS_DIAGRAM_MEDIA_USAGE_PROVIDER,
    async findUsages(mediaIds) {
      const out = new Map<string, MediaUsage[]>();
      if (mediaIds.length === 0) return out;
      const rows = await db.partsDiagram.findMany({
        where: { mediaId: { in: [...mediaIds] } },
        select: { mediaId: true, title: true },
        orderBy: { title: "asc" },
      });
      for (const row of rows) {
        out.set(row.mediaId, [
          ...(out.get(row.mediaId) ?? []),
          { kind: "parts_diagram", label: `Fișă explodată: ${row.title}` },
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
};

/**
 * Registrul de utilizare media cu toți providerii nucleului. Aplicația îl folosește pentru
 * `getMediaUsageRegistry()`; fazele următoare (pagini, bannere: Faza 16) își adaugă aici providerul.
 */
export function createMediaUsageRegistry(db: Db): MediaUsageRegistry {
  const registry = new MediaUsageRegistry();
  registry.register(createProductMediaUsageProvider(db));
  registry.register(createPartsDiagramMediaUsageProvider(db));
  return registry;
}

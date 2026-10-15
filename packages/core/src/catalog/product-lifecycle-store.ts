import type { Prisma, PrismaClient } from "@ecom/db";
import { effectivePrice } from "./catalog-support";

/**
 * Accesul la date pentru ciclul de viață al produsului (duplicare, arhivare, ștergere soft și
 * definitivă). Citirile de variante folosesc `select` explicit, fără coloanele prețului de achiziție
 * (testul de arhitectură al costului acoperă acest fișier): copia nu poate moșteni ce nu se citește.
 */

export interface LifecycleProductRow {
  id: string;
  slug: string;
  title: string;
  status: string;
  deletedAt: Date | null;
}

export interface DuplicateCommand {
  sourceId: string;
  title: string;
  slug: string;
  /** Codul nou al fiecărei variante, după id-ul variantei sursă. */
  skuByVariantId: ReadonlyMap<string, string>;
  at: Date;
}

export interface DuplicateOutcome {
  product: { id: string; slug: string; title: string };
  variants: { id: string; sku: string }[];
  copied: {
    variants: number;
    options: number;
    attributes: number;
    categories: number;
    media: number;
    relations: number;
  };
  /** Ce NU s-a copiat și exista pe sursă (pentru raport). */
  skipped: { documents: number; collections: number; diagrams: number; channelListings: number };
}

export interface TransitionCommand {
  ids: readonly string[];
  /** Cine e eligibil: starea (dacă e dată) și dacă e șters. Se re-verifică în aceeași instrucțiune. */
  eligible: { statuses?: readonly string[]; deleted: boolean };
  data: { status?: string; deletedAt?: Date | null };
}

/** Ce s-ar șterge odată cu produsul și ce l-ar bloca. */
export interface PurgeImpact {
  id: string;
  slug: string;
  title: string;
  deleted: boolean;
  counts: {
    variants: number;
    media: number;
    documents: number;
    categories: number;
    attributes: number;
    relations: number;
    relatedBy: number;
    collections: number;
    channelListings: number;
  };
  /** Fișele la care produsul e asociat (asocierea dispare, fișa rămâne). */
  diagrams: { id: string; title: string }[];
  /** Hotspot-urile legate de produs: rămân în fișă, „fără produs”. */
  hotspots: { diagramId: string; diagramTitle: string; number: number }[];
  /** Ofertele de canal în stare `active` sau `pending`: blochează ștergerea definitivă. */
  blockingListings: number;
}

export interface ProductLifecycleStore {
  getMany(ids: readonly string[]): Promise<LifecycleProductRow[]>;
  /** Variantele produsului, în ordinea afișării (id și cod). */
  listVariantSkus(productId: string): Promise<{ id: string; sku: string }[]>;
  /** Copiază produsul ÎNTR-O SINGURĂ tranzacție; întoarce `null` dacă sursa nu mai există. */
  duplicate(command: DuplicateCommand): Promise<DuplicateOutcome | null>;
  /**
   * Schimbă starea produselor, TOT SAU NIMIC: dacă vreunul nu mai e eligibil la momentul scrierii,
   * nu se modifică nimic și se întoarce numărul celor eligibile (mai mic decât `ids.length`).
   */
  transition(command: TransitionCommand): Promise<number>;
  purgeImpact(id: string): Promise<PurgeImpact | null>;
  /**
   * Șterge definitiv un produs deja șters soft (legăturile lui se șterg în cascadă; hotspot-urile
   * rămân fără produs). Întoarce cheile fișierelor documentelor ca să fie șterse din storage.
   */
  purge(id: string): Promise<{ deleted: boolean; documentKeys: string[] }>;
}

type Db = PrismaClient | Prisma.TransactionClient;

/** Tranzacția interactivă a unei copii mari: peste valoarea implicită de 5 secunde. */
const TRANSACTION_TIMEOUT_MS = 30_000;

async function inTransaction<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  if ("$transaction" in db) return db.$transaction(fn, { timeout: TRANSACTION_TIMEOUT_MS });
  return fn(db);
}

class TransitionMismatch extends Error {
  constructor(readonly matched: number) {
    super("transition-mismatch");
  }
}

const productRow = {
  id: true,
  slug: true,
  title: true,
  status: true,
  deletedAt: true,
} satisfies Prisma.ProductSelect;

export function createPrismaProductLifecycleStore(db: Db): ProductLifecycleStore {
  return {
    getMany: (ids) => db.product.findMany({ where: { id: { in: [...ids] } }, select: productRow }),

    async listVariantSkus(productId) {
      return db.productVariant.findMany({
        where: { productId },
        orderBy: [{ isDefault: "desc" }, { position: "asc" }, { id: "asc" }],
        select: { id: true, sku: true },
      });
    },

    async duplicate(command) {
      return inTransaction(db, async (tx) => {
        const source = await tx.product.findUnique({
          where: { id: command.sourceId },
          select: {
            // câmpurile copiate, EXPLICIT: ce nu e aici nu ajunge pe copie (EAN, identificatori din
            // magazinul vechi, clasa energetică și linkul EPREL, data reaprovizionării, metadate)
            type: true,
            subtitle: true,
            description: true,
            brandId: true,
            taxClassId: true,
            shippingClass: true,
            requiresInstallation: true,
            allowBackorder: true,
            manageStock: true,
            stockStatus: true,
            excludeFromGroupDiscount: true,
            seoTitle: true,
            seoDescription: true,
            sortOrder: true,
            gpsrManufacturerName: true,
            gpsrManufacturerContact: true,
            gpsrResponsibleName: true,
            gpsrResponsibleContact: true,
            safetyWarnings: true,
            variants: {
              orderBy: [{ position: "asc" }, { id: "asc" }],
              select: {
                id: true,
                warrantyMonths: true,
                price: true,
                salePrice: true,
                saleStartsAt: true,
                saleEndsAt: true,
                weightGrams: true,
                lengthMm: true,
                widthMm: true,
                heightMm: true,
                manufacturerName: true,
                manageStock: true,
                stockStatus: true,
                position: true,
                isDefault: true,
                optionValues: { select: { optionId: true, optionValueId: true } },
              },
            },
            options: {
              orderBy: { position: "asc" },
              select: {
                id: true,
                name: true,
                position: true,
                values: {
                  orderBy: { position: "asc" },
                  select: { id: true, value: true, position: true },
                },
              },
            },
            categories: { select: { categoryId: true, isPrimary: true } },
            attributes: {
              select: {
                attributeId: true,
                textValue: true,
                numberValue: true,
                boolValue: true,
                optionId: true,
              },
            },
            media: {
              orderBy: { position: "asc" },
              select: { mediaId: true, variantId: true, position: true },
            },
            relations: {
              select: { relatedProductId: true, type: true, position: true },
            },
            _count: {
              select: {
                documents: true,
                collections: true,
                partsDiagrams: true,
                channelListings: true,
              },
            },
          },
        });
        if (!source) return null;

        const created = await tx.product.create({
          data: {
            title: command.title,
            slug: command.slug,
            status: "draft",
            type: source.type,
            subtitle: source.subtitle,
            description: source.description,
            brandId: source.brandId,
            taxClassId: source.taxClassId,
            shippingClass: source.shippingClass,
            requiresInstallation: source.requiresInstallation,
            allowBackorder: source.allowBackorder,
            manageStock: source.manageStock,
            stockStatus: source.stockStatus,
            excludeFromGroupDiscount: source.excludeFromGroupDiscount,
            seoTitle: source.seoTitle,
            seoDescription: source.seoDescription,
            sortOrder: source.sortOrder,
            gpsrManufacturerName: source.gpsrManufacturerName,
            gpsrManufacturerContact: source.gpsrManufacturerContact,
            gpsrResponsibleName: source.gpsrResponsibleName,
            gpsrResponsibleContact: source.gpsrResponsibleContact,
            safetyWarnings: source.safetyWarnings,
          },
          select: { id: true, slug: true, title: true },
        });

        for (const category of source.categories) {
          await tx.productCategory.create({
            data: {
              productId: created.id,
              categoryId: category.categoryId,
              isPrimary: category.isPrimary,
            },
          });
        }

        // opțiunile și valorile, cu id-uri noi (cheile compuse leagă variantele de opțiunile COPIEI)
        const optionMap = new Map<string, string>();
        const valueMap = new Map<string, string>();
        for (const option of source.options) {
          const copy = await tx.productOption.create({
            data: { productId: created.id, name: option.name, position: option.position },
            select: { id: true },
          });
          optionMap.set(option.id, copy.id);
          for (const value of option.values) {
            const valueCopy = await tx.optionValue.create({
              data: { optionId: copy.id, value: value.value, position: value.position },
              select: { id: true },
            });
            valueMap.set(value.id, valueCopy.id);
          }
        }

        const variantMap = new Map<string, string>();
        const variants: { id: string; sku: string }[] = [];
        for (const variant of source.variants) {
          const sku = command.skuByVariantId.get(variant.id);
          if (sku === undefined) throw new Error("cod lipsă pentru o variantă a copiei");
          const copy = await tx.productVariant.create({
            data: {
              productId: created.id,
              sku,
              // fără EAN, fără identificatori vechi, fără codul producătorului: identifică un singur articol
              warrantyMonths: variant.warrantyMonths,
              price: variant.price,
              salePrice: variant.salePrice,
              saleStartsAt: variant.saleStartsAt,
              saleEndsAt: variant.saleEndsAt,
              weightGrams: variant.weightGrams,
              lengthMm: variant.lengthMm,
              widthMm: variant.widthMm,
              heightMm: variant.heightMm,
              manufacturerName: variant.manufacturerName,
              manageStock: variant.manageStock,
              stockStatus: variant.stockStatus,
              position: variant.position,
              isDefault: variant.isDefault,
            },
            select: { id: true },
          });
          variantMap.set(variant.id, copy.id);
          variants.push({ id: copy.id, sku });

          for (const selection of variant.optionValues) {
            const optionId = optionMap.get(selection.optionId);
            const optionValueId = valueMap.get(selection.optionValueId);
            if (!optionId || !optionValueId) throw new Error("opțiune lipsă la copierea variantei");
            await tx.variantOptionValue.create({
              data: { variantId: copy.id, productId: created.id, optionId, optionValueId },
            });
          }
          // istoricul prețurilor (Omnibus) pornește de la zero, cu prețul efectiv de acum
          await tx.priceHistory.create({
            data: {
              variantId: copy.id,
              price: effectivePrice(variant, command.at),
              effectiveFrom: command.at,
            },
          });
        }

        for (const item of source.media) {
          const variantId =
            item.variantId === null ? null : (variantMap.get(item.variantId) ?? null);
          // aceleași fișiere din bibliotecă: nu se dublează nimic în storage
          await tx.productMedia.create({
            data: {
              productId: created.id,
              mediaId: item.mediaId,
              variantId,
              position: item.position,
            },
          });
        }

        for (const value of source.attributes) {
          await tx.attributeValue.create({
            data: {
              productId: created.id,
              attributeId: value.attributeId,
              textValue: value.textValue,
              numberValue: value.numberValue,
              boolValue: value.boolValue,
              optionId: value.optionId,
            },
          });
        }

        for (const relation of source.relations) {
          await tx.productRelation.create({
            data: {
              productId: created.id,
              relatedProductId: relation.relatedProductId,
              type: relation.type,
              position: relation.position,
            },
          });
        }

        return {
          product: created,
          variants,
          copied: {
            variants: variants.length,
            options: source.options.length,
            attributes: source.attributes.length,
            categories: source.categories.length,
            media: source.media.length,
            relations: source.relations.length,
          },
          skipped: {
            documents: source._count.documents,
            collections: source._count.collections,
            diagrams: source._count.partsDiagrams,
            channelListings: source._count.channelListings,
          },
        };
      });
    },

    async transition(command) {
      const ids = [...command.ids];
      try {
        return await inTransaction(db, async (tx) => {
          const result = await tx.product.updateMany({
            where: {
              id: { in: ids },
              deletedAt: command.eligible.deleted ? { not: null } : null,
              ...(command.eligible.statuses
                ? { status: { in: [...command.eligible.statuses] } }
                : {}),
            },
            data: command.data,
          });
          // vreunul nu mai e eligibil: se anulează TOT (tranzacția se întoarce)
          if (result.count !== ids.length) throw new TransitionMismatch(result.count);
          return result.count;
        });
      } catch (error) {
        if (error instanceof TransitionMismatch) return error.matched;
        throw error;
      }
    },

    async purgeImpact(id) {
      const row = await db.product.findUnique({
        where: { id },
        select: {
          id: true,
          slug: true,
          title: true,
          deletedAt: true,
          _count: {
            select: {
              variants: true,
              media: true,
              documents: true,
              categories: true,
              attributes: true,
              relations: true,
              relatedTo: true,
              collections: true,
              channelListings: true,
            },
          },
          channelListings: { select: { status: true } },
          // citire prin relațiile produsului (nu prin delegatele fișelor): funcționează și cu
          // flag-ul `partsDiagrams` oprit, ca ștergerea să nu ascundă ce afectează
          partsDiagrams: { select: { diagram: { select: { id: true, title: true } } } },
          hotspots: {
            orderBy: [{ diagramId: "asc" }, { number: "asc" }],
            select: { number: true, diagram: { select: { id: true, title: true } } },
          },
        },
      });
      if (!row) return null;
      return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        deleted: row.deletedAt !== null,
        counts: {
          variants: row._count.variants,
          media: row._count.media,
          documents: row._count.documents,
          categories: row._count.categories,
          attributes: row._count.attributes,
          relations: row._count.relations,
          relatedBy: row._count.relatedTo,
          collections: row._count.collections,
          channelListings: row._count.channelListings,
        },
        diagrams: row.partsDiagrams.map((p) => ({ id: p.diagram.id, title: p.diagram.title })),
        hotspots: row.hotspots.map((h) => ({
          diagramId: h.diagram.id,
          diagramTitle: h.diagram.title,
          number: h.number,
        })),
        blockingListings: row.channelListings.filter(
          (l) => l.status === "active" || l.status === "pending",
        ).length,
      };
    },

    async purge(id) {
      return inTransaction(db, async (tx) => {
        const documents = await tx.productDocument.findMany({
          where: { productId: id },
          select: { storageKey: true },
        });
        // `deletedAt` în condiție: un produs care nu e în coșul de gunoi nu se șterge definitiv
        const result = await tx.product.deleteMany({ where: { id, deletedAt: { not: null } } });
        return {
          deleted: result.count === 1,
          documentKeys: result.count === 1 ? documents.map((d) => d.storageKey) : [],
        };
      });
    },
  };
}

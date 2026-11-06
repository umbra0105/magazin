import { Prisma, type PrismaClient } from "@ecom/db";
import { parseDecimalInput } from "@ecom/shared/decimal";
import type { ImportSnapshot } from "../import-plan";
import type { WooAttributeDef, WooDescriptionInfo, WooSnapshotExtras } from "./woo-types";

/**
 * Interogările profilului WooCommerce: ce există deja (pentru comparare) și scrierile care nu trec prin
 * serviciile catalogului (ID-ul din magazinul vechi). Toate au `select` EXPLICIT; prețul de achiziție nu e
 * citit nicăieri (fișierul nu e pe lista celor care îl pot numi, deci testul de arhitectură al costului
 * pică dacă apare).
 */

type Db = PrismaClient | Prisma.TransactionClient;

const LOOKUP_CHUNK = 1000;
const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export interface WooLookups {
  skus: readonly string[];
  legacyIds: readonly string[];
  /** Hash-urile adreselor de imagini din fișier (pentru fișierele deja aduse din aceleași adrese). */
  imageHashes: readonly string[];
  /** Modul «doar descrieri»: se încarcă și descrierea curentă, coșul de gunoi și «editată manual» (din audit). */
  descriptionInfo?: boolean;
}

export interface WooQueries {
  /** Atributele definite (pentru potrivirea cu atributele din fișier). */
  listAttributes(): Promise<WooAttributeDef[]>;
  loadExtras(base: ImportSnapshot, lookups: WooLookups): Promise<WooSnapshotExtras>;
  findProductIdsBySku(skus: readonly string[]): Promise<Map<string, string>>;
  findProductIdsByLegacyId(ids: readonly string[]): Promise<Map<string, string>>;
  /** `false` dacă ID-ul e deja al altui produs (indexul unic). */
  setProductLegacyId(productId: string, legacyId: string): Promise<boolean>;
  setVariantLegacyId(variantId: string, legacyId: string): Promise<boolean>;
}

const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === "P2002";

export function createWooQueries(db: Db): WooQueries {
  async function findProductIdsBySku(skus: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const lower = [...new Set(skus.map((s) => s.toLowerCase()))];
    for (const part of chunks(lower, LOOKUP_CHUNK)) {
      const rows = await db.$queryRaw<{ productId: string; sku: string }[]>(Prisma.sql`
        SELECT "productId", sku FROM product_variant WHERE lower(sku) = ANY(${part}::text[])
      `);
      for (const row of rows) out.set(row.sku.toLowerCase(), row.productId);
    }
    return out;
  }

  async function findProductIdsByLegacyId(ids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const part of chunks([...new Set(ids)], LOOKUP_CHUNK)) {
      const rows = await db.product.findMany({
        where: { legacyId: { in: part } },
        select: { id: true, legacyId: true },
      });
      for (const row of rows) if (row.legacyId) out.set(row.legacyId, row.id);
    }
    return out;
  }

  async function listAttributes(): Promise<WooAttributeDef[]> {
    const rows = await db.attribute.findMany({
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        options: { select: { id: true, value: true }, orderBy: { position: "asc" } },
      },
    });
    return rows.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      type: a.type as WooAttributeDef["type"],
      options: a.options,
    }));
  }

  /**
   * Descrierea curentă a produselor și dacă a fost editată manual (15c, pasul 8, D4). Regula: se ia ULTIMUL eveniment de
   * audit care a scris descrierea (`product.update` cu cheia `description`, sau crearea produsului) și descrierea e «editată manual»
   * dacă acel eveniment nu vine dintr-un import (`after.importId` lipsește). O descriere FĂRĂ niciun astfel de eveniment
   * (produs anterior auditului pe entitate, C-12) e «fără istoric» și e protejată la fel; fără descriere (NULL) nu e nimic de proteja.
   */
  async function loadDescriptionInfo(
    productIds: readonly string[],
  ): Promise<Map<string, WooDescriptionInfo>> {
    const out = new Map<string, WooDescriptionInfo>();
    for (const part of chunks(productIds, LOOKUP_CHUNK)) {
      const products = await db.product.findMany({
        where: { id: { in: part } },
        select: { id: true, description: true, deletedAt: true },
      });
      const lastWriter = await db.$queryRaw<{ entityId: string; fromImport: boolean }[]>(Prisma.sql`
        SELECT DISTINCT ON ("entityId") "entityId",
               COALESCE(jsonb_exists(after, 'importId'), false) AS "fromImport"
        FROM audit_log
        WHERE entity = 'product'
          AND outcome = 'success'
          AND "entityId" = ANY(${part}::text[])
          AND (action = 'product.create' OR (action = 'product.update' AND jsonb_exists(after, 'description')))
        ORDER BY "entityId", "createdAt" DESC, id DESC
      `);
      const manualById = new Map(lastWriter.map((row) => [row.entityId, !row.fromImport]));
      for (const row of products) {
        out.set(row.id, {
          description: row.description,
          deleted: row.deletedAt !== null,
          manuallyEdited: row.description !== null && (manualById.get(row.id) ?? false),
          // descriere fără niciun eveniment care a scris-o: nu se știe de unde vine, deci e protejată
          noHistory: row.description !== null && !manualById.has(row.id),
        });
      }
    }
    return out;
  }

  return {
    listAttributes,
    findProductIdsBySku,
    findProductIdsByLegacyId,

    async loadExtras(base, lookups) {
      const [categories, brands, attributeRows] = await Promise.all([
        db.category.findMany({ select: { id: true, name: true, parentId: true } }),
        db.brand.findMany({ select: { id: true, name: true } }),
        db.attribute.findMany({
          select: {
            id: true,
            code: true,
            name: true,
            type: true,
            options: { select: { id: true, value: true }, orderBy: { position: "asc" } },
          },
        }),
      ]);
      const attributes: WooAttributeDef[] = attributeRows.map((a) => ({
        id: a.id,
        code: a.code,
        name: a.name,
        type: a.type as WooAttributeDef["type"],
        options: a.options,
      }));
      const typeOf = new Map(attributes.map((a) => [a.id, a.type]));

      const variants: WooSnapshotExtras["variants"] = new Map();
      const products: WooSnapshotExtras["products"] = new Map();
      const variantIds = [...base.variantsBySku.values()].map((v) => v.variantId);
      const productIds = [...new Set([...base.variantsBySku.values()].map((v) => v.productId))];

      for (const part of chunks(variantIds, LOOKUP_CHUNK)) {
        const rows = await db.productVariant.findMany({
          where: { id: { in: part } },
          select: { id: true, saleStartsAt: true, saleEndsAt: true, legacyId: true },
        });
        for (const row of rows) {
          variants.set(row.id, {
            saleStartsAt: row.saleStartsAt,
            saleEndsAt: row.saleEndsAt,
            legacyId: row.legacyId,
          });
        }
      }
      for (const part of chunks(productIds, LOOKUP_CHUNK)) {
        for (const row of await db.product.findMany({
          where: { id: { in: part } },
          select: { id: true, legacyId: true },
        })) {
          products.set(row.id, {
            legacyId: row.legacyId,
            attributes: new Map(),
            relations: new Set(),
          });
        }
        for (const row of await db.attributeValue.findMany({
          where: { productId: { in: part } },
          select: {
            productId: true,
            attributeId: true,
            textValue: true,
            numberValue: true,
            boolValue: true,
            optionId: true,
          },
        })) {
          const type = typeOf.get(row.attributeId);
          const value =
            type === "number"
              ? parseDecimalInput(String(row.numberValue ?? ""))
              : type === "bool"
                ? String(row.boolValue)
                : type === "select"
                  ? row.optionId
                  : row.textValue;
          if (value !== null && value !== undefined) {
            products.get(row.productId)?.attributes.set(row.attributeId, value);
          }
        }
        for (const row of await db.productRelation.findMany({
          where: { productId: { in: part }, type: { in: ["upsell", "crosssell"] } },
          select: { productId: true, relatedProductId: true, type: true },
        })) {
          products.get(row.productId)?.relations.add(`${row.type}|${row.relatedProductId}`);
        }
      }

      const mediaBySourceHash = new Map<string, string>();
      for (const part of chunks([...new Set(lookups.imageHashes)], LOOKUP_CHUNK)) {
        for (const row of await db.media.findMany({
          where: { sourceHash: { in: part } },
          select: { id: true, sourceHash: true },
        })) {
          if (row.sourceHash) mediaBySourceHash.set(row.sourceHash, row.id);
        }
      }
      const productMedia = new Map<string, Set<string>>();
      for (const part of chunks(productIds, LOOKUP_CHUNK)) {
        for (const row of await db.productMedia.findMany({
          where: { productId: { in: part }, variantId: null },
          select: { productId: true, mediaId: true },
        })) {
          const set = productMedia.get(row.productId) ?? new Set<string>();
          set.add(row.mediaId);
          productMedia.set(row.productId, set);
        }
      }

      const productIdBySku = new Map<string, string>();
      for (const [sku, variant] of base.variantsBySku) productIdBySku.set(sku, variant.productId);
      const productIdByLegacyId = await findProductIdsByLegacyId(lookups.legacyIds);
      const variantIdByLegacyId = new Map<string, string>();
      for (const part of chunks([...new Set(lookups.legacyIds)], LOOKUP_CHUNK)) {
        for (const row of await db.productVariant.findMany({
          where: { legacyId: { in: part } },
          select: { id: true, legacyId: true },
        })) {
          if (row.legacyId) variantIdByLegacyId.set(row.legacyId, row.id);
        }
      }
      return {
        categories,
        brands,
        attributes,
        variants,
        products,
        productIdBySku,
        productIdByLegacyId,
        variantIdByLegacyId,
        mediaBySourceHash,
        productMedia,
        ...(lookups.descriptionInfo && {
          descriptionInfo: await loadDescriptionInfo([
            ...new Set([...productIdBySku.values(), ...productIdByLegacyId.values()]),
          ]),
        }),
      };
    },

    async setProductLegacyId(productId, legacyId) {
      try {
        await db.product.update({ where: { id: productId }, data: { legacyId } });
        return true;
      } catch (error) {
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    },

    async setVariantLegacyId(variantId, legacyId) {
      try {
        await db.productVariant.update({ where: { id: variantId }, data: { legacyId } });
        return true;
      } catch (error) {
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    },
  };
}

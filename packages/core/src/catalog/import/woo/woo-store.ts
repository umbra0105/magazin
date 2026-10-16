import { Prisma, type PrismaClient } from "@ecom/db";
import { parseDecimalInput } from "@ecom/shared/decimal";
import type { ImportSnapshot } from "../import-plan";
import type { WooAttributeDef, WooSnapshotExtras } from "./woo-types";

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

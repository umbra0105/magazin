import type { Prisma, PrismaClient } from "@ecom/db";
import type { OptionInput } from "./variant-generator";
import { combinationKey } from "./variant-generator";

/**
 * Accesul la date pentru produse și variante. NICIUN `select` de aici nu include coloanele
 * prețului de achiziție sau istoricul lui: se citesc și se scriu doar prin serviciul dedicat acestuia
 * (`cost-price.ts`). Testul de arhitectură al costului pică dacă acest fișier îl menționează.
 */

export interface ProductRecord {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  status: string;
  type: string;
  brandId: string | null;
  shippingClass: string;
  requiresInstallation: boolean;
  manageStock: boolean;
  stockStatus: string;
  allowBackorder: boolean;
  expectedRestockDate: Date | null;
  excludeFromGroupDiscount: boolean;
  energyClass: string | null;
  eprelUrl: string | null;
  gpsrManufacturerName: string | null;
  gpsrManufacturerContact: string | null;
  gpsrResponsibleName: string | null;
  gpsrResponsibleContact: string | null;
  safetyWarnings: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  deletedAt: Date | null;
}

export interface VariantRecord {
  id: string;
  productId: string;
  sku: string;
  ean: string | null;
  warrantyMonths: number | null;
  price: number;
  salePrice: number | null;
  saleStartsAt: Date | null;
  saleEndsAt: Date | null;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  manufacturerPartNumber: string | null;
  manufacturerName: string | null;
  manageStock: boolean | null;
  stockStatus: string | null;
  position: number;
  isDefault: boolean;
}

/** Varianta cu alegerile ei de opțiuni, în ordinea opțiunilor produsului. */
export interface VariantWithOptions extends VariantRecord {
  selections: { option: string; value: string }[];
}

export interface SlugOwner {
  id: string;
  title: string;
  deletedAt: Date | null;
}

export type ProductFieldsData = Partial<Omit<ProductRecord, "id" | "deletedAt">> & {
  slug: string;
  title: string;
};
export type VariantFieldsData = Partial<Omit<VariantRecord, "id" | "productId">> & {
  sku: string;
  price: number;
};

export interface NewVariantRow {
  data: VariantFieldsData;
  /** Prețul efectiv la creare (pentru istoricul Omnibus). */
  effectivePrice: number;
  /** Doar la produsele cu opțiuni: valoarea fiecărei opțiuni pentru această variantă. */
  selections?: readonly { option: string; value: string }[];
}

export interface GeneratedVariantRow {
  sku: string;
  price: number;
  selections: readonly { option: string; value: string }[];
}

export interface BulkVariantUpdate {
  variantId: string;
  price: number;
  salePrice: number | null;
  /** Prețul efectiv nou, de scris în istoric, dacă s-a schimbat. */
  priceRecord: { price: number; at: Date } | null;
}

export interface BulkApplyCommand {
  productIds: readonly string[];
  /** Câmpuri de produs aplicate tuturor produselor. */
  productData: Partial<
    Pick<ProductRecord, "status" | "shippingClass" | "stockStatus" | "manageStock" | "brandId">
  >;
  /** Categorie în care se adaugă toate produsele (fără să le scoată din altele). */
  addCategoryId: string | null;
  variantUpdates: readonly BulkVariantUpdate[];
}

export interface ProductStore {
  /** Produsul care deține adresa, ȘTERS SAU NU, fără diferență de majuscule. */
  findSlugOwner(slug: string, excludeProductId?: string): Promise<SlugOwner | null>;
  getProduct(id: string): Promise<ProductRecord | null>;
  getVariant(id: string): Promise<VariantRecord | null>;
  /** SKU-urile (din `skus`) care există deja, fără diferență de majuscule. */
  findExistingSkus(skus: readonly string[], excludeVariantId?: string): Promise<string[]>;
  /** `categoryIds`: categoriile produsului (prima e cea principală), create în aceeași tranzacție. */
  createProduct(
    data: ProductFieldsData,
    variants: readonly NewVariantRow[],
    at: Date,
    categoryIds?: readonly string[],
    /** Opțiunile produsului (cu valorile lor), create odată cu el; variantele le aleg prin `selections`. */
    options?: readonly { name: string; values: readonly string[] }[],
  ): Promise<{ product: ProductRecord; variants: VariantRecord[] }>;
  updateProduct(id: string, data: Partial<ProductFieldsData>): Promise<ProductRecord>;
  /** `priceRecord` != null: scrie în istoric noul preț efectiv, în aceeași tranzacție. */
  updateVariant(
    id: string,
    data: Partial<VariantFieldsData>,
    priceRecord: { price: number; at: Date } | null,
  ): Promise<VariantRecord>;
  /** Combinațiile (cheie stabilă) ale variantelor produsului, pe baza valorilor de opțiune. */
  listVariantCombinationKeys(productId: string): Promise<string[]>;
  /** Codul variantei implicite (pentru a deriva SKU-urile generate). */
  getDefaultSku(productId: string): Promise<string | null>;
  /** Variantele unui produs, în ordinea afișării. */
  listVariantsOf(productId: string): Promise<VariantRecord[]>;
  /** Variantele cu alegerile lor de opțiuni (pentru tabul Variante). */
  listVariantsDetailed(productId: string): Promise<VariantWithOptions[]>;
  /** Opțiunile produsului cu valorile lor, în ordine. */
  listOptions(productId: string): Promise<{ name: string; values: string[] }[]>;
  /**
   * Șterge o variantă (legăturile ei de opțiuni, media și istoricele se șterg în cascadă). Dacă era
   * implicită, prima rămasă devine implicită, în aceeași tranzacție. Întoarce ce s-a șters.
   */
  deleteVariant(
    id: string,
  ): Promise<{ productId: string; sku: string; wasDefault: boolean; remaining: number } | null>;
  /** Produsele cerute (existente), cu variantele lor. */
  getManyWithVariants(
    ids: readonly string[],
  ): Promise<{ id: string; slug: string; deletedAt: Date | null; variants: VariantRecord[] }[]>;
  categoryExists(id: string): Promise<boolean>;
  brandExists(id: string): Promise<boolean>;
  /**
   * Pune garanția implicită pe variantele produselor date care nu au una (`NULL`); cele cu valoare
   * proprie rămân neatinse. Întoarce câte variante au fost actualizate.
   */
  applyDefaultWarranty(productIds: readonly string[], months: number): Promise<number>;
  /** Aplică o editare în masă, ATOMIC (tot sau nimic). */
  bulkApply(command: BulkApplyCommand): Promise<void>;
  addGeneratedVariants(
    productId: string,
    options: readonly OptionInput[],
    rows: readonly GeneratedVariantRow[],
    at: Date,
  ): Promise<VariantRecord[]>;
}

const productSelect = {
  id: true,
  slug: true,
  title: true,
  subtitle: true,
  description: true,
  status: true,
  type: true,
  brandId: true,
  shippingClass: true,
  requiresInstallation: true,
  manageStock: true,
  stockStatus: true,
  allowBackorder: true,
  expectedRestockDate: true,
  excludeFromGroupDiscount: true,
  energyClass: true,
  eprelUrl: true,
  gpsrManufacturerName: true,
  gpsrManufacturerContact: true,
  gpsrResponsibleName: true,
  gpsrResponsibleContact: true,
  safetyWarnings: true,
  seoTitle: true,
  seoDescription: true,
  deletedAt: true,
} satisfies Prisma.ProductSelect;

const variantSelect = {
  id: true,
  productId: true,
  sku: true,
  ean: true,
  warrantyMonths: true,
  price: true,
  salePrice: true,
  saleStartsAt: true,
  saleEndsAt: true,
  weightGrams: true,
  lengthMm: true,
  widthMm: true,
  heightMm: true,
  manufacturerPartNumber: true,
  manufacturerName: true,
  manageStock: true,
  stockStatus: true,
  position: true,
  isDefault: true,
} satisfies Prisma.ProductVariantSelect;

type Db = PrismaClient | Prisma.TransactionClient;

/** Rulează `fn` într-o tranzacție; dacă `db` e deja o tranzacție (teste), rulează direct. */
async function inTransaction<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  if ("$transaction" in db) return db.$transaction(fn);
  return fn(db);
}

export function createPrismaProductStore(db: Db): ProductStore {
  return {
    async findSlugOwner(slug, excludeProductId) {
      return db.product.findFirst({
        where: {
          slug: { equals: slug, mode: "insensitive" },
          ...(excludeProductId ? { id: { not: excludeProductId } } : {}),
        },
        select: { id: true, title: true, deletedAt: true },
      });
    },

    getProduct: (id) => db.product.findUnique({ where: { id }, select: productSelect }),

    getVariant: (id) => db.productVariant.findUnique({ where: { id }, select: variantSelect }),

    async findExistingSkus(skus, excludeVariantId) {
      if (skus.length === 0) return [];
      const rows = await db.productVariant.findMany({
        where: {
          OR: skus.map((sku) => ({ sku: { equals: sku, mode: "insensitive" as const } })),
          ...(excludeVariantId ? { id: { not: excludeVariantId } } : {}),
        },
        select: { sku: true },
      });
      return rows.map((r) => r.sku);
    },

    async createProduct(data, variants, at, categoryIds = [], options = []) {
      return inTransaction(db, async (tx) => {
        const product = await tx.product.create({ data, select: productSelect });
        for (const [index, categoryId] of categoryIds.entries()) {
          await tx.productCategory.create({
            data: { productId: product.id, categoryId, isPrimary: index === 0 },
          });
        }
        // opțiuni și valori (doar la produsele variabile)
        const lower = (value: string): string => value.toLocaleLowerCase("ro");
        const optionIds = new Map<string, string>();
        const valueIds = new Map<string, string>();
        for (const [optionIndex, option] of options.entries()) {
          const createdOption = await tx.productOption.create({
            data: { productId: product.id, name: option.name, position: optionIndex },
          });
          optionIds.set(lower(option.name), createdOption.id);
          for (const [valueIndex, value] of option.values.entries()) {
            const createdValue = await tx.optionValue.create({
              data: { optionId: createdOption.id, value, position: valueIndex },
            });
            valueIds.set(
              `${lower(option.name)}${String.fromCharCode(0)}${lower(value)}`,
              createdValue.id,
            );
          }
        }
        const created: VariantRecord[] = [];
        for (const [index, row] of variants.entries()) {
          const variant = await tx.productVariant.create({
            data: { ...row.data, productId: product.id, position: row.data.position ?? index },
            select: variantSelect,
          });
          for (const selection of row.selections ?? []) {
            const optionId = optionIds.get(lower(selection.option));
            const valueId = valueIds.get(
              `${lower(selection.option)}${String.fromCharCode(0)}${lower(selection.value)}`,
            );
            if (!optionId || !valueId)
              throw new Error("opțiune sau valoare lipsă la crearea produsului");
            await tx.variantOptionValue.create({
              data: {
                variantId: variant.id,
                productId: product.id,
                optionId,
                optionValueId: valueId,
              },
            });
          }
          await tx.priceHistory.create({
            data: { variantId: variant.id, price: row.effectivePrice, effectiveFrom: at },
          });
          created.push(variant);
        }
        return { product, variants: created };
      });
    },

    updateProduct: (id, data) => db.product.update({ where: { id }, data, select: productSelect }),

    async updateVariant(id, data, priceRecord) {
      return inTransaction(db, async (tx) => {
        const variant = await tx.productVariant.update({
          where: { id },
          data,
          select: variantSelect,
        });
        if (priceRecord) {
          await tx.priceHistory.upsert({
            where: { variantId_effectiveFrom: { variantId: id, effectiveFrom: priceRecord.at } },
            create: { variantId: id, price: priceRecord.price, effectiveFrom: priceRecord.at },
            update: { price: priceRecord.price },
          });
        }
        return variant;
      });
    },

    async listVariantCombinationKeys(productId) {
      const variants = await db.productVariant.findMany({
        where: { productId },
        select: {
          optionValues: {
            select: {
              option: { select: { name: true, position: true } },
              value: { select: { value: true } },
            },
          },
        },
      });
      return variants
        .map((v) =>
          combinationKey(
            [...v.optionValues]
              .sort((a, b) => a.option.position - b.option.position)
              .map((ov) => ({ option: ov.option.name, value: ov.value.value })),
          ),
        )
        .filter((key) => key !== "");
    },

    async getDefaultSku(productId) {
      const row = await db.productVariant.findFirst({
        where: { productId },
        orderBy: [{ isDefault: "desc" }, { position: "asc" }],
        select: { sku: true },
      });
      return row?.sku ?? null;
    },

    async listVariantsOf(productId) {
      return db.productVariant.findMany({
        where: { productId },
        orderBy: [{ isDefault: "desc" }, { position: "asc" }],
        select: variantSelect,
      });
    },

    async listVariantsDetailed(productId) {
      const rows = await db.productVariant.findMany({
        where: { productId },
        orderBy: [{ isDefault: "desc" }, { position: "asc" }],
        select: {
          ...variantSelect,
          optionValues: {
            select: {
              option: { select: { name: true, position: true } },
              value: { select: { value: true } },
            },
          },
        },
      });
      return rows.map(({ optionValues, ...variant }) => ({
        ...variant,
        selections: [...optionValues]
          .sort((a, b) => a.option.position - b.option.position)
          .map((ov) => ({ option: ov.option.name, value: ov.value.value })),
      }));
    },

    async listOptions(productId) {
      const rows = await db.productOption.findMany({
        where: { productId },
        orderBy: { position: "asc" },
        select: {
          name: true,
          values: { orderBy: { position: "asc" }, select: { value: true } },
        },
      });
      return rows.map((o) => ({ name: o.name, values: o.values.map((v) => v.value) }));
    },

    async deleteVariant(id) {
      return inTransaction(db, async (tx) => {
        const variant = await tx.productVariant.findUnique({
          where: { id },
          select: { id: true, productId: true, sku: true, isDefault: true },
        });
        if (!variant) return null;
        await tx.productVariant.delete({ where: { id } });
        const remaining = await tx.productVariant.findMany({
          where: { productId: variant.productId },
          orderBy: { position: "asc" },
          select: { id: true },
        });
        if (variant.isDefault && remaining[0]) {
          await tx.productVariant.update({
            where: { id: remaining[0].id },
            data: { isDefault: true },
          });
        }
        return {
          productId: variant.productId,
          sku: variant.sku,
          wasDefault: variant.isDefault,
          remaining: remaining.length,
        };
      });
    },

    async getManyWithVariants(ids) {
      return db.product.findMany({
        where: { id: { in: [...ids] } },
        select: {
          id: true,
          slug: true,
          deletedAt: true,
          variants: { orderBy: { position: "asc" }, select: variantSelect },
        },
      });
    },

    async applyDefaultWarranty(productIds, months) {
      if (productIds.length === 0) return 0;
      const result = await db.productVariant.updateMany({
        where: { productId: { in: [...productIds] }, warrantyMonths: null },
        data: { warrantyMonths: months },
      });
      return result.count;
    },

    async categoryExists(id) {
      return (await db.category.count({ where: { id } })) > 0;
    },

    async brandExists(id) {
      return (await db.brand.count({ where: { id } })) > 0;
    },

    async bulkApply(command) {
      await inTransaction(db, async (tx) => {
        const ids = [...command.productIds];
        if (Object.keys(command.productData).length > 0) {
          await tx.product.updateMany({ where: { id: { in: ids } }, data: command.productData });
        } else {
          // atinge `updatedAt` și când se schimbă doar prețurile sau categoria
          await tx.product.updateMany({
            where: { id: { in: ids } },
            data: { updatedAt: new Date() },
          });
        }
        if (command.addCategoryId) {
          await tx.productCategory.createMany({
            data: ids.map((productId) => ({
              productId,
              categoryId: command.addCategoryId as string,
              isPrimary: false,
            })),
            skipDuplicates: true,
          });
        }
        for (const update of command.variantUpdates) {
          await tx.productVariant.update({
            where: { id: update.variantId },
            data: { price: update.price, salePrice: update.salePrice },
          });
          if (update.priceRecord) {
            await tx.priceHistory.upsert({
              where: {
                variantId_effectiveFrom: {
                  variantId: update.variantId,
                  effectiveFrom: update.priceRecord.at,
                },
              },
              create: {
                variantId: update.variantId,
                price: update.priceRecord.price,
                effectiveFrom: update.priceRecord.at,
              },
              update: { price: update.priceRecord.price },
            });
          }
        }
      });
    },

    async addGeneratedVariants(productId, options, rows, at) {
      return inTransaction(db, async (tx) => {
        // Opțiunile și valorile: se refolosesc (fără diferență de majuscule) sau se creează.
        const existingOptions = await tx.productOption.findMany({
          where: { productId },
          include: { values: true },
          orderBy: { position: "asc" },
        });
        const optionId = new Map<string, string>();
        const valueId = new Map<string, string>();
        const lower = (s: string) => s.toLocaleLowerCase("ro");
        let position = existingOptions.length;
        for (const option of options) {
          let current = existingOptions.find((o) => lower(o.name) === lower(option.name));
          if (!current) {
            const created = await tx.productOption.create({
              data: { productId, name: option.name, position: position++ },
              include: { values: true },
            });
            current = created;
            existingOptions.push(created);
          }
          optionId.set(lower(option.name), current.id);
          let valuePosition = current.values.length;
          for (const value of option.values) {
            const found = current.values.find((v) => lower(v.value) === lower(value));
            const id =
              found?.id ??
              (
                await tx.optionValue.create({
                  data: { optionId: current.id, value, position: valuePosition++ },
                })
              ).id;
            valueId.set(`${lower(option.name)}\u0000${lower(value)}`, id);
          }
        }

        const last = await tx.productVariant.findFirst({
          where: { productId },
          orderBy: { position: "desc" },
          select: { position: true },
        });
        let nextPosition = (last?.position ?? -1) + 1;
        const created: VariantRecord[] = [];
        for (const row of rows) {
          const variant = await tx.productVariant.create({
            data: { productId, sku: row.sku, price: row.price, position: nextPosition++ },
            select: variantSelect,
          });
          for (const selection of row.selections) {
            const oId = optionId.get(lower(selection.option));
            const vId = valueId.get(`${lower(selection.option)}\u0000${lower(selection.value)}`);
            if (!oId || !vId) throw new Error("opțiune sau valoare lipsă la generarea variantelor");
            await tx.variantOptionValue.create({
              data: { variantId: variant.id, productId, optionId: oId, optionValueId: vId },
            });
          }
          await tx.priceHistory.create({
            data: { variantId: variant.id, price: row.price, effectiveFrom: at },
          });
          created.push(variant);
        }
        return created;
      });
    },
  };
}

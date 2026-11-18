import { DomainError } from "@ecom/shared";
import type { Db } from "../db-tx";

/**
 * Produsele la care pragul de transport gratuit NU se aplică (decizia magazinului, din ecranul «Coș și transport»): o pompă de
 * 8.000 de lei nu trebuie să scutească de transport o comandă. Pe lângă excluderea pe CLASĂ (setarea
 * checkout.freeShippingClasses), acest tabel exclude PE PRODUS. Produsul se adaugă după SKU-ul oricărei variante.
 */

export interface FreeShippingExclusionDto {
  productId: string;
  title: string;
  /** SKU-ul variantei implicite (pentru recunoaștere în listă). */
  sku: string | null;
}

export class FreeShippingExclusionService {
  constructor(private readonly db: Db) {}

  async list(): Promise<FreeShippingExclusionDto[]> {
    const rows = await this.db.freeShippingExclusion.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        productId: true,
        product: {
          select: {
            title: true,
            variants: {
              orderBy: [{ isDefault: "desc" }, { position: "asc" }],
              take: 1,
              select: { sku: true },
            },
          },
        },
      },
    });
    return rows.map((row) => ({
      productId: row.productId,
      title: row.product.title,
      sku: row.product.variants[0]?.sku ?? null,
    }));
  }

  /** Adaugă produsul căruia îi aparține SKU-ul dat; idempotent. Aruncă `FREE_SHIPPING_SKU_NOT_FOUND` dacă SKU-ul nu există. */
  async addBySku(rawSku: string): Promise<FreeShippingExclusionDto> {
    const sku = rawSku.trim();
    if (sku === "" || sku.length > 100) {
      throw new DomainError("FREE_SHIPPING_SKU_NOT_FOUND", "Scrie SKU-ul unui produs", { sku });
    }
    const variant = await this.db.productVariant.findFirst({
      where: { sku: { equals: sku, mode: "insensitive" }, product: { deletedAt: null } },
      select: { productId: true },
    });
    if (!variant) {
      throw new DomainError("FREE_SHIPPING_SKU_NOT_FOUND", "Nu există niciun produs cu acest SKU", {
        sku,
      });
    }
    await this.db.freeShippingExclusion.upsert({
      where: { productId: variant.productId },
      create: { productId: variant.productId },
      update: {},
    });
    const found = (await this.list()).find((entry) => entry.productId === variant.productId);
    if (!found)
      throw new DomainError(
        "FREE_SHIPPING_SKU_NOT_FOUND",
        "Excluderea nu a putut fi citită după salvare",
      );
    return found;
  }

  async remove(productId: string): Promise<boolean> {
    const removed = await this.db.freeShippingExclusion.deleteMany({ where: { productId } });
    return removed.count > 0;
  }
}

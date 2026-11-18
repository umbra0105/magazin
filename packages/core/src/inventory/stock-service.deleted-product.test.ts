import { quantityFromTicks, type QuantityDelta } from "@ecom/shared";
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@ecom/db";
import { StockError } from "./stock-errors";
import { StockService } from "./stock-service";

/**
 * Punctul din docs/06 (Faza 9): Prisma 7.10 execută `select`-ul imbricat ca interogări separate, deci produsul unei variante
 * poate veni `null` dacă a fost șters definitiv între citiri. `prepare` și `adjustPhysical` trebuie să dea
 * `STOCK_VARIANT_NOT_FOUND`, nu un `TypeError` (`variant.product.type` pe `null`).
 */

/** Un client fals: `$transaction` rulează funcția pe «tranzacția» falsă; variantele au `product: null`. */
function fakeDb(): PrismaClient {
  const variant = {
    id: "v1",
    sku: "SKU-1",
    manageStock: null,
    saleStep: null,
    minSteps: null,
    measureUnit: null,
    product: null,
  };
  const tx = {
    warehouse: {
      findFirst: async () => ({ id: "w1" }),
      findUnique: async () => ({ id: "w1" }),
    },
    productVariant: {
      findMany: async () => [variant],
      findUnique: async () => variant,
    },
  };
  return { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as unknown as PrismaClient;
}

describe("variantă al cărei produs a dispărut între citiri", () => {
  it("reserve (prin prepare) dă STOCK_VARIANT_NOT_FOUND, nu TypeError", async () => {
    const service = new StockService({ db: fakeDb() });
    const error = await service
      .reserve(
        { refType: "stock_test", refId: "r1" },
        [{ variantId: "v1", quantity: quantityFromTicks(10_000n) }],
        new Date(Date.now() + 60_000),
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StockError);
    expect((error as StockError).code).toBe("STOCK_VARIANT_NOT_FOUND");
  });

  it("commitDirect (prin prepare) dă STOCK_VARIANT_NOT_FOUND, nu TypeError", async () => {
    const service = new StockService({ db: fakeDb() });
    const error = await service
      .commitDirect({ refType: "stock_test", refId: "r2" }, [
        { variantId: "v1", quantity: quantityFromTicks(10_000n) },
      ])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StockError);
    expect((error as StockError).code).toBe("STOCK_VARIANT_NOT_FOUND");
  });

  it("adjustPhysical dă STOCK_VARIANT_NOT_FOUND, nu TypeError", async () => {
    const service = new StockService({ db: fakeDb() });
    const error = await service
      .adjustPhysical({
        variantId: "v1",
        delta: 10_000n as QuantityDelta,
        reason: "receipt",
        note: "recepție de test",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StockError);
    expect((error as StockError).code).toBe("STOCK_VARIANT_NOT_FOUND");
  });
});

import type { PrismaClient } from "@ecom/db";
import type { ApplyCostCommand, CostHistoryEntry, CostPriceStore, VariantCost } from "./cost-price";

type Db = Pick<PrismaClient, "productVariant" | "costPriceHistory">;

export function createPrismaCostPriceStore(db: Db): CostPriceStore {
  return {
    async getVariantCost(variantId): Promise<VariantCost | null> {
      return db.productVariant.findUnique({
        where: { id: variantId },
        select: { costPrice: true, costPriceDate: true },
      });
    },

    async apply(command: ApplyCostCommand): Promise<void> {
      const history = {
        costPrice: command.costPrice,
        effectiveDate: command.effectiveDate,
        source: command.source,
        importId: command.importId,
      };
      if (command.updateVariant) {
        // O singură interogare (tranzacție implicită Prisma): varianta și rândul de istoric.
        await db.productVariant.update({
          where: { id: command.variantId },
          data: {
            costPrice: command.costPrice,
            costPriceDate: command.effectiveDate,
            costHistory: { create: history },
          },
        });
      } else {
        await db.costPriceHistory.create({ data: { variantId: command.variantId, ...history } });
      }
    },

    async listHistory(variantId): Promise<CostHistoryEntry[]> {
      return db.costPriceHistory.findMany({
        where: { variantId },
        orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }],
        select: { id: true, costPrice: true, effectiveDate: true, source: true, createdAt: true },
      });
    },
  };
}

import { Prisma, type PrismaClient } from "@ecom/db";
import type { MeasureUnitStore } from "./measure-unit-service";

/** Accesul la date pentru unitățile de măsură (separat de serviciu: testele unitare nu importă `@ecom/db`). */
const select = {
  id: true,
  code: true,
  name: true,
  symbol: true,
  smartbillName: true,
  decimals: true,
  isActive: true,
  isSystem: true,
  sortOrder: true,
} satisfies Prisma.MeasureUnitSelect;

export function createPrismaMeasureUnitStore(
  db: PrismaClient | Prisma.TransactionClient,
): MeasureUnitStore {
  return {
    async listAll() {
      const rows = await db.measureUnit.findMany({
        select: { ...select, _count: { select: { products: true, variants: true } } },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      });
      return rows.map(({ _count, ...row }) => ({
        ...row,
        productCount: _count.products,
        variantCount: _count.variants,
      }));
    },
    get: (id) => db.measureUnit.findUnique({ where: { id }, select }),
    findByCode: (value) =>
      db.measureUnit.findFirst({ where: { code: { equals: value, mode: "insensitive" } }, select }),
    create: (data) => db.measureUnit.create({ data, select }),
    update: (id, data) => db.measureUnit.update({ where: { id }, data, select }),
    async findDecimalConflicts(id, newDecimals) {
      const granularity = 10n ** BigInt(4 - newDecimals);
      const [row] = await db.$queryRaw<Array<{ steps: number; stock: number }>>(Prisma.sql`
        SELECT
          (SELECT count(*)::int FROM product_variant v
             JOIN product p ON p."id" = v."productId"
            WHERE COALESCE(v."measureUnitId", p."measureUnitId") = ${id}
              AND COALESCE(v."saleStep", p."saleStep") IS NOT NULL
              AND COALESCE(v."saleStep", p."saleStep")::bigint % ${granularity}::bigint <> 0) AS steps,
          (SELECT count(*)::int FROM inventory_item i
             JOIN product_variant v ON v."id" = i."variantId"
             JOIN product p ON p."id" = v."productId"
            WHERE COALESCE(v."measureUnitId", p."measureUnitId") = ${id}
              AND (i."physical" % ${granularity}::bigint <> 0
                OR i."committed" % ${granularity}::bigint <> 0
                OR i."reserved" % ${granularity}::bigint <> 0
                OR i."safetyBuffer" % ${granularity}::bigint <> 0)) AS stock
      `);
      return { steps: row?.steps ?? 0, stock: row?.stock ?? 0 };
    },
  };
}

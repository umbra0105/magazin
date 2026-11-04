import { Prisma, type PrismaClient } from "@ecom/db";
import {
  WarehouseCodeTakenError,
  type WarehouseRecord,
  type WarehouseStore,
  type WarehouseWithUsage,
} from "./warehouse-service";

/** Accesul la date pentru depozite (separat de serviciu: testele unitare nu importă `@ecom/db`). */
const select = {
  id: true,
  code: true,
  name: true,
  isDefault: true,
  isActive: true,
} satisfies Prisma.WarehouseSelect;

type Db = PrismaClient | Prisma.TransactionClient;

/** Rândurile de stoc cu cantitate nenulă (fizică, angajată sau rezervată), pe depozit; opțional doar al unuia */
async function stockedItems(db: Db, warehouseId?: string): Promise<Map<string, number>> {
  const rows = await db.$queryRaw<Array<{ warehouseId: string; items: number }>>(Prisma.sql`
    SELECT "warehouseId", count(*)::int AS items
    FROM inventory_item
    WHERE (physical > 0 OR committed > 0 OR reserved > 0)
      ${warehouseId === undefined ? Prisma.empty : Prisma.sql`AND "warehouseId" = ${warehouseId}`}
    GROUP BY "warehouseId"`);
  return new Map(rows.map((row) => [row.warehouseId, row.items]));
}

export function createPrismaWarehouseStore(db: Db): WarehouseStore {
  return {
    async listAll(): Promise<WarehouseWithUsage[]> {
      const [rows, stocked] = await Promise.all([
        db.warehouse.findMany({ select, orderBy: [{ isDefault: "desc" }, { name: "asc" }] }),
        stockedItems(db),
      ]);
      return rows.map((row) => ({ ...row, stockedItems: stocked.get(row.id) ?? 0 }));
    },
    async get(id: string): Promise<WarehouseWithUsage | null> {
      const row = await db.warehouse.findUnique({ where: { id }, select });
      if (!row) return null;
      const stocked = await stockedItems(db, id);
      return { ...row, stockedItems: stocked.get(id) ?? 0 };
    },
    async create(data: { code: string; name: string }): Promise<WarehouseRecord> {
      try {
        return await db.warehouse.create({
          data: { code: data.code, name: data.name, isDefault: false, isActive: true },
          select,
        });
      } catch (error) {
        // depozitul nou nu e niciodată implicit, deci singurul index unic pe care îl poate încălca aici este cel al codului
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new WarehouseCodeTakenError(data.code);
        }
        throw error;
      }
    },
    update: (id, data) => db.warehouse.update({ where: { id }, data, select }),
  };
}

import { Prisma, type PrismaClient } from "@ecom/db";
import type { PricingType } from "./constants";
import type { CustomerGroupFields, CustomerGroupRecord } from "./group-rules";

type Db = PrismaClient | Prisma.TransactionClient;

/** Un grup, cu numărul de clienți și de comenzi care îl folosesc (ca ecranul de admin să știe ce nu se poate șterge). */
export interface CustomerGroupWithUsage extends CustomerGroupRecord {
  memberCount: number;
  orderCount: number;
}

export interface CustomerListFilter {
  query: string | null;
  /** `null` = toți; altfel grupul ales (la grupul de sistem intră și clienții fără grup). */
  groupId: string | null;
  page: number;
  pageSize: number;
  /** Căutarea se face și în email (doar cu dreptul la datele personale; altfel doar după nume). */
  matchEmail: boolean;
}

export interface CustomerRow {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  /** `null` = fără grup atribuit (se comportă ca «Client standard»). */
  groupId: string | null;
}

export interface BulkAssignOutcome {
  /** Clienții găsiți și mutați, cu grupul de dinainte. */
  moved: Array<{ userId: string; previousGroupId: string | null }>;
  /** Id-urile care nu corespund niciunui client. */
  missing: string[];
}

export interface CustomerGroupStore {
  list(): Promise<CustomerGroupWithUsage[]>;
  get(id: string): Promise<CustomerGroupRecord | null>;
  getSystem(): Promise<CustomerGroupRecord | null>;
  create(
    data: CustomerGroupFields & { slug: string; sortOrder: number },
  ): Promise<CustomerGroupRecord>;
  update(id: string, data: Partial<CustomerGroupFields>): Promise<CustomerGroupRecord>;
  /** Șterge doar un grup fără clienți și fără comenzi (blochează rândul grupului, apoi numără). */
  deleteUnused(id: string): Promise<"deleted" | "in_use">;
  /**
   * Dezactivează grupul doar dacă nu are clienți (blochează rândul grupului, apoi numără: o atribuire simultană fie se termină
   * înainte, fie nu mai găsește grupul activ).
   */
  deactivateIfEmpty(id: string): Promise<"deactivated" | "has_members">;
  slugExists(slug: string): Promise<boolean>;
  maxSortOrder(): Promise<number>;
  listCustomers(filter: CustomerListFilter): Promise<{ rows: CustomerRow[]; total: number }>;
  /** Mută clienții în grup (sau îi scoate din grup cu `null`), atomic; grupul trebuie să fie activ. */
  assign(
    userIds: readonly string[],
    groupId: string | null,
  ): Promise<BulkAssignOutcome | "group_inactive">;
}

const SELECT = {
  id: true,
  name: true,
  slug: true,
  pricingType: true,
  discountBps: true,
  markupBps: true,
  stacksWithSalePrice: true,
  earnsLoyaltyPoints: true,
  tone: true,
  isSystem: true,
  isActive: true,
  sortOrder: true,
} as const;

type Row = Prisma.CustomerGroupGetPayload<{ select: typeof SELECT }>;

const toRecord = (row: Row): CustomerGroupRecord => ({
  ...row,
  pricingType: row.pricingType as PricingType,
  tone: row.tone as CustomerGroupRecord["tone"],
});

export function createPrismaCustomerGroupStore(db: Db): CustomerGroupStore {
  const transact = async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
    const client = db as PrismaClient;
    return typeof client.$transaction === "function" ? client.$transaction((tx) => fn(tx)) : fn(db);
  };

  return {
    async list() {
      const rows = await db.customerGroup.findMany({
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: { ...SELECT, _count: { select: { users: true, orders: true } } },
      });
      return rows.map(({ _count, ...row }) => ({
        ...toRecord(row),
        memberCount: _count.users,
        orderCount: _count.orders,
      }));
    },

    async get(id) {
      const row = await db.customerGroup.findUnique({ where: { id }, select: SELECT });
      return row ? toRecord(row) : null;
    },

    async getSystem() {
      const row = await db.customerGroup.findFirst({ where: { isSystem: true }, select: SELECT });
      return row ? toRecord(row) : null;
    },

    async create(data) {
      const row = await db.customerGroup.create({
        data: {
          name: data.name,
          slug: data.slug,
          pricingType: data.pricingType,
          discountBps: data.discountBps ?? null,
          markupBps: data.markupBps ?? null,
          stacksWithSalePrice: data.stacksWithSalePrice,
          earnsLoyaltyPoints: data.earnsLoyaltyPoints,
          tone: data.tone,
          isActive: data.isActive,
          sortOrder: data.sortOrder,
        },
        select: SELECT,
      });
      return toRecord(row);
    },

    async update(id, data) {
      const row = await db.customerGroup.update({ where: { id }, data, select: SELECT });
      return toRecord(row);
    },

    async deleteUnused(id) {
      return transact(async (tx) => {
        await tx.$queryRaw`SELECT id FROM customer_group WHERE id = ${id} FOR UPDATE`;
        const [members, orders] = await Promise.all([
          tx.user.count({ where: { customerGroupId: id } }),
          tx.order.count({ where: { customerGroupId: id } }),
        ]);
        if (members > 0 || orders > 0) return "in_use" as const;
        await tx.customerGroup.delete({ where: { id } });
        return "deleted" as const;
      });
    },

    async deactivateIfEmpty(id) {
      return transact(async (tx) => {
        await tx.$queryRaw`SELECT id FROM customer_group WHERE id = ${id} FOR UPDATE`;
        const members = await tx.user.count({ where: { customerGroupId: id } });
        if (members > 0) return "has_members" as const;
        await tx.customerGroup.update({ where: { id }, data: { isActive: false } });
        return "deactivated" as const;
      });
    },

    async slugExists(slug) {
      return (await db.customerGroup.count({ where: { slug } })) > 0;
    },

    async maxSortOrder() {
      const row = await db.customerGroup.aggregate({ _max: { sortOrder: true } });
      return row._max.sortOrder ?? 0;
    },

    async listCustomers(filter) {
      const system = await db.customerGroup.findFirst({
        where: { isSystem: true },
        select: { id: true },
      });
      const where: Prisma.UserWhereInput = {
        // doar clienții: fără conturile de personal și fără conturile anonimizate
        anonymizedAt: null,
        roles: { none: {} },
        ...(filter.groupId === null
          ? {}
          : filter.groupId === system?.id
            ? { OR: [{ customerGroupId: filter.groupId }, { customerGroupId: null }] }
            : { customerGroupId: filter.groupId }),
        ...(filter.query
          ? {
              AND: [
                {
                  OR: [
                    { name: { contains: filter.query, mode: "insensitive" } },
                    ...(filter.matchEmail
                      ? [{ email: { contains: filter.query, mode: "insensitive" as const } }]
                      : []),
                  ],
                },
              ],
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        db.user.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          skip: (filter.page - 1) * filter.pageSize,
          take: filter.pageSize,
          select: {
            id: true,
            name: true,
            email: true,
            emailVerified: true,
            createdAt: true,
            customerGroupId: true,
          },
        }),
        db.user.count({ where }),
      ]);
      return {
        rows: rows.map(({ customerGroupId, ...row }) => ({ ...row, groupId: customerGroupId })),
        total,
      };
    },

    async assign(userIds, groupId) {
      return transact(async (tx) => {
        if (groupId !== null) {
          // FOR SHARE: o dezactivare simultană a grupului așteaptă încheierea atribuirii
          const active = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM customer_group WHERE id = ${groupId} AND "isActive" = true FOR SHARE`;
          if (active.length === 0) return "group_inactive" as const;
        }
        const ids = [...new Set(userIds)].sort();
        const moved = await tx.$queryRaw<Array<{ userId: string; previousGroupId: string | null }>>`
          WITH locked AS (
            SELECT id, "customerGroupId" FROM "user" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE
          ), changed AS (
            UPDATE "user" u SET "customerGroupId" = ${groupId}, "updatedAt" = now()
            FROM locked l WHERE u.id = l.id
            RETURNING u.id AS "userId", l."customerGroupId" AS "previousGroupId"
          )
          SELECT "userId", "previousGroupId" FROM changed ORDER BY "userId"`;
        const found = new Set(moved.map((row) => row.userId));
        return { moved, missing: ids.filter((id) => !found.has(id)) };
      });
    },
  };
}

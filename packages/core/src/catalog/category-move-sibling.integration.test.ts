import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { createLogger } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { CategoryService } from "./category-service";
import { createPrismaCategoryStore } from "./category-store";

/** Mutarea față de un frate (C-35): `beforeId`/`afterId` în loc de index absolut; referința dispărută refuză mutarea. */
const db = getDb();
afterAll(() => db.$disconnect());

const subject: PermissionSubject = {
  userId: "u-sibling",
  email: "sibling@magazin.test",
  roles: ["owner"],
  permissions: new Set(["products.write"]),
};

function service() {
  return new CategoryService({
    store: createPrismaCategoryStore(db),
    audit: new AuditService({ append: async () => undefined, list: async () => [] }),
    logger: createLogger({ destination: { write() {} } }),
  });
}

async function withRoots<T>(
  names: string[],
  fn: (ids: Record<string, string>, tag: string) => Promise<T>,
): Promise<T> {
  const tag = randomUUID().slice(0, 8);
  const created: string[] = [];
  const ids: Record<string, string> = {};
  try {
    // frați la rădăcină, în ordinea dată, la sfârșitul listei existente
    const last = await db.category.aggregate({
      where: { parentId: null },
      _max: { sortOrder: true },
    });
    let order = (last._max.sortOrder ?? -1) + 1;
    for (const name of names) {
      const row = await db.category.create({
        data: {
          name: `ZZ ${name} ${tag}`,
          slug: `zz-${name.toLowerCase()}-${tag}`,
          path: `zz-${name.toLowerCase()}-${tag}`,
          depth: 0,
          sortOrder: order++,
        },
        select: { id: true },
      });
      created.push(row.id);
      ids[name] = row.id;
    }
    return await fn(ids, tag);
  } finally {
    await db.category.deleteMany({ where: { id: { in: created } } });
  }
}

const order = async (ids: Record<string, string>, names: string[]): Promise<string[]> => {
  const rows = await db.category.findMany({
    where: { id: { in: names.map((n) => ids[n] as string) } },
    orderBy: { sortOrder: "asc" },
    select: { id: true },
  });
  const byId = Object.fromEntries(Object.entries(ids).map(([name, id]) => [id, name]));
  return rows.map((r) => byId[r.id] as string);
};

describe("CategoryService.move cu beforeId/afterId", () => {
  it("beforeId și afterId așază categoria față de un frate", async () => {
    await withRoots(["A", "B", "C", "D"], async (ids) => {
      const s = service();
      await s.move(subject, ids["D"] as string, { parentId: null, beforeId: ids["B"] as string });
      expect(await order(ids, ["A", "B", "C", "D"])).toEqual(["A", "D", "B", "C"]);
      await s.move(subject, ids["A"] as string, { parentId: null, afterId: ids["C"] as string });
      expect(await order(ids, ["A", "B", "C", "D"])).toEqual(["D", "B", "C", "A"]);
    });
  });

  it("un frate adăugat între timp NU strică poziția: aceeași referință, loc corect (cu index absolut ar fi nimerit altundeva)", async () => {
    await withRoots(["A", "B", "C"], async (ids, tag) => {
      const s = service();
      // interfața «vede» A, B, C și vrea C după A; între timp alt administrator inserează N între A și B
      const inserted = await db.category.create({
        data: {
          name: `ZZ N ${tag}`,
          slug: `zz-n-${tag}`,
          path: `zz-n-${tag}`,
          depth: 0,
          sortOrder: (await db.category.findUniqueOrThrow({ where: { id: ids["A"] as string } }))
            .sortOrder,
        },
        select: { id: true },
      });
      try {
        await s.move(subject, ids["C"] as string, { parentId: null, afterId: ids["A"] as string });
        const names = { ...ids, N: inserted.id };
        const rows = await db.category.findMany({
          where: { id: { in: Object.values(names) } },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
          select: { id: true },
        });
        const labels = rows.map((r) => Object.entries(names).find(([, id]) => id === r.id)?.[0]);
        // C vine imediat după A, indiferent de N
        expect(labels.indexOf("C")).toBe(labels.indexOf("A") + 1);
      } finally {
        await db.category.delete({ where: { id: inserted.id } });
      }
    });
  });

  it("referința ștearsă sau care nu mai e frate: refuz cu cod stabil, nimic mutat", async () => {
    await withRoots(["A", "B", "C"], async (ids) => {
      const s = service();
      await expect(
        s.move(subject, ids["C"] as string, { parentId: null, beforeId: "inexistent-id" }),
      ).rejects.toMatchObject({ code: "CATEGORY_SIBLING_GONE" });
      // referința e chiar categoria mutată
      await expect(
        s.move(subject, ids["C"] as string, { parentId: null, afterId: ids["C"] as string }),
      ).rejects.toMatchObject({ code: "CATEGORY_SIBLING_GONE" });
      expect(await order(ids, ["A", "B", "C"])).toEqual(["A", "B", "C"]);
    });
  });

  it("două poziții deodată (index + beforeId) sunt respinse de validare; fără poziție, la sfârșit", async () => {
    await withRoots(["A", "B", "C"], async (ids) => {
      const s = service();
      await expect(
        s.move(subject, ids["A"] as string, {
          parentId: null,
          index: 0,
          beforeId: ids["B"] as string,
        }),
      ).rejects.toBeDefined();
      await s.move(subject, ids["A"] as string, { parentId: null });
      expect((await order(ids, ["A", "B", "C"])).at(-1)).toBe("A");
    });
  });
});

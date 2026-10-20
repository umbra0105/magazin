import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { createLogger } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { CategoryService } from "./category-service";
import { createPrismaCategoryStore, type CategoryStore } from "./category-store";

/**
 * Două mutări de categorii simultane (doi administratori, sau două teste în paralel) NU se pierd.
 * Înainte: `move` citea tot arborele, calcula planul și scria rândurile COMPLETE ale fraților (inclusiv
 * părintele) din citirea veche; a doua scriere readuce la părintele vechi categoria mutată de prima:
 * răspuns „reușit”, mutare dispărută (găsit în E2E «glisare…», unde două workere mută categorii frate).
 *
 * Determinist: o barieră în `listAll` face ca ambele mutări să citească ÎNAINTE ca vreuna să scrie, iar
 * mutarea lui Y își aplică scrierea abia după cea a lui X. Cu serializarea corectă (blocare pe structura
 * arborelui), Y nici nu poate citi până nu termină X, deci bariera expiră și rezultatul e corect.
 */

const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const subject: PermissionSubject = {
  userId: "u-concurrency",
  email: "concurrency@magazin.test",
  roles: ["owner"],
  permissions: new Set(["products.write"]),
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("CategoryService.move: mutări simultane", () => {
  it("ambele mutări rămân, chiar dacă citesc arborele înainte ca vreuna să scrie", async () => {
    const tag = randomUUID().slice(0, 8);
    const ids: string[] = [];
    const make = async (name: string, sortOrder: number): Promise<string> => {
      const row = await db.category.create({
        data: {
          name: `ZZ ${name} ${tag}`,
          slug: `zz-${name.toLowerCase()}-${tag}`,
          path: `/zz-${name.toLowerCase()}-${tag}`,
          depth: 0,
          sortOrder,
        },
        select: { id: true },
      });
      ids.push(row.id);
      return row.id;
    };

    try {
      // frați la rădăcină, în această ordine: P, Y, Q, X (X are ordinea cea mai mare)
      const p = await make("P", 0);
      const y = await make("Y", 1);
      const q = await make("Q", 2);
      const x = await make("X", 3);

      const real = createPrismaCategoryStore(db);
      let reads = 0;
      let readersReady: () => void = () => undefined;
      const bothRead = new Promise<void>((resolve) => {
        readersReady = resolve;
      });
      let xApplied: () => void = () => undefined;
      const xDone = new Promise<void>((resolve) => {
        xApplied = resolve;
      });
      const store: CategoryStore = {
        ...real,
        async listAll() {
          const rows = await real.listAll();
          reads++;
          if (reads >= 2) readersReady();
          // prima mutare așteaptă să citească și a doua (sau, dacă a doua e blocată de serializare, expiră)
          if (reads === 1) await Promise.race([bothRead, sleep(600)]);
          return rows;
        },
        async applyUpdates(updates) {
          const isX = updates.some((u) => u.id === x && u.parentId === p);
          // mutarea lui Y scrie abia după cea a lui X (cu planul calculat din citirea veche)
          if (!isX) await Promise.race([xDone, sleep(5000)]);
          await real.applyUpdates(updates);
          if (isX) xApplied();
        },
      };
      const service = new CategoryService({
        store,
        audit: new AuditService({ append: async () => undefined, list: async () => [] }),
        logger: createLogger({ destination: { write() {} } }),
      });

      // X intră sub P; Y intră sub Q (ordinea pornirii: X întâi)
      const moveX = service.move(subject, x, { parentId: p });
      await sleep(50);
      const moveY = service.move(subject, y, { parentId: q });
      await Promise.all([moveX, moveY]);

      const rows = await db.category.findMany({
        where: { id: { in: ids } },
        select: { id: true, parentId: true, depth: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(x)).toMatchObject({ parentId: p, depth: 1 });
      expect(byId.get(y)).toMatchObject({ parentId: q, depth: 1 });
    } finally {
      // întâi copiii, apoi părinții
      await db.category.deleteMany({ where: { id: { in: ids }, depth: { gt: 0 } } });
      await db.category.deleteMany({ where: { id: { in: ids } } });
    }
  }, 30_000);
});

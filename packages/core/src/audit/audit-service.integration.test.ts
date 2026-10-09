import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { AuditService } from "./audit-service";
import { createPrismaAuditStore } from "./prisma-store";
import { inRolledBackTransaction as rolledBack, type TestTx } from "../test-utils/rollback";

const db = getDb();
const inRolledBackTransaction = <T>(fn: (tx: TestTx) => Promise<T>) => rolledBack(db, fn);

async function errorOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    return String(error);
  }
}

describe("audit_log în Postgres", () => {
  afterAll(async () => {
    await db.$disconnect();
  });

  it("stochează valori mascate (niciun secret în clar în tabelă)", async () => {
    const text = await inRolledBackTransaction(async (tx) => {
      const audit = new AuditService(createPrismaAuditStore(tx));
      await audit.record({
        actorId: "u-int-1",
        actorLabel: "admin@magazin.test",
        action: "integration.update",
        entity: "integration",
        entityId: "payment:netopia",
        before: { credentials: "v1:aaa:bbb:ccc-SECRET", costPrice: 98765 },
        after: { config: { apiKey: "sk_live_SECRET", mode: "test" } },
      });
      const [row] = await tx.$queryRaw<{ t: string }[]>`
        select row_to_json(a)::text as t from audit_log a where "actorId" = 'u-int-1'`;
      return row?.t ?? "";
    });
    expect(text).toContain("payment:netopia");
    expect(text).toContain('"mode": "test"');
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("98765");
    expect(text).toContain("[ascuns]");
  });

  it("Postgres respinge UPDATE, DELETE și TRUNCATE pe audit_log", async () => {
    const seed = (tx: TestTx) =>
      new AuditService(createPrismaAuditStore(tx)).record({
        actorId: "u-int-2",
        actorLabel: null,
        action: "a",
        entity: "e",
      });

    const update = await inRolledBackTransaction(async (tx) => {
      await seed(tx);
      return errorOf(tx.$executeRaw`update audit_log set action = 'modificat'`);
    });
    const remove = await inRolledBackTransaction(async (tx) => {
      await seed(tx);
      return errorOf(tx.$executeRaw`delete from audit_log where "actorId" = 'u-int-2'`);
    });
    const truncate = await inRolledBackTransaction(async (tx) => {
      await seed(tx);
      return errorOf(tx.$executeRaw`truncate audit_log`);
    });

    expect(update).toContain("doar de adaugare");
    expect(remove).toContain("doar de adaugare");
    expect(truncate).toContain("doar de adaugare");
  });

  it("nimic nu a rămas în tabelă după teste", async () => {
    expect(await db.auditLog.count({ where: { actorId: { startsWith: "u-int-" } } })).toBe(0);
  });
});

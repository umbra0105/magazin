import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { runWithRequestContext } from "@ecom/shared";
import { inRolledBackTransaction as rolledBack, type TestTx } from "../test-utils/rollback";
import { AuditService } from "./audit-service";
import { createPrismaAuditStore } from "./prisma-store";
import { createWithAudit } from "./with-audit";

const db = getDb();
const inTx = <T>(fn: (tx: TestTx) => Promise<T>) => rolledBack(db, fn);

async function errorOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    // Prisma mapează restrict_violation la P2003; mesajul din Postgres e în meta.
    return `${String(error)} ${JSON.stringify((error as { meta?: unknown }).meta ?? {})}`;
  }
}

describe("audit_log: garanții în Postgres (în tranzacții anulate)", () => {
  afterAll(async () => {
    await db.$disconnect();
  });

  it("triggerele de protecție sunt ACTIVE în baza de date (nu doar în migrație)", async () => {
    const rows = await db.$queryRaw<{ tgname: string; tgenabled: string }[]>`
      select tgname::text as tgname, tgenabled::text as tgenabled from pg_trigger
      where tgrelid = 'audit_log'::regclass and not tgisinternal order by tgname`;
    expect(rows).toEqual([
      { tgname: "audit_log_no_truncate", tgenabled: "O" },
      { tgname: "audit_log_no_update_delete", tgenabled: "O" },
    ]);
  });

  it("clientul Prisma (calea reală din aplicație) nu poate modifica sau șterge rânduri", async () => {
    const results = await inTx(async (tx) => {
      const audit = new AuditService(createPrismaAuditStore(tx));
      await audit.record({ actorId: "u-int-3", actorLabel: null, action: "a", entity: "e" });
      const [row] = await tx.auditLog.findMany({ where: { actorId: "u-int-3" } });
      return { id: row?.id ?? "" };
    });
    expect(results.id).not.toBe("");

    // Fiecare încercare într-o tranzacție proprie: după o eroare, Postgres anulează tranzacția.
    const attempt = async (run: (tx: TestTx) => Promise<unknown>) =>
      inTx(async (tx) => {
        await new AuditService(createPrismaAuditStore(tx)).record({
          actorId: "u-int-3",
          actorLabel: null,
          action: "a",
          entity: "e",
        });
        return errorOf(run(tx));
      });

    const update = await attempt((tx) =>
      tx.auditLog.updateMany({ where: { actorId: "u-int-3" }, data: { action: "modificat" } }),
    );
    const remove = await attempt((tx) => tx.auditLog.deleteMany({ where: { actorId: "u-int-3" } }));
    expect(update).toContain("doar de adaugare");
    expect(remove).toContain("doar de adaugare");
  });

  it("withAudit cap-coadă: actor, requestId, entityId și valori mascate ajung în tabelă", async () => {
    const row = await inTx(async (tx) => {
      const audit = new AuditService(createPrismaAuditStore(tx));
      const withAudit = createWithAudit({
        audit,
        getActor: async () => ({ id: "u-int-4", label: "admin@magazin.test" }),
      });
      const save = withAudit<{ provider: string }, { provider: string; apiKey: string }>(
        {
          action: "integration.save",
          entity: "integration",
          entityId: (input) => input.provider,
          before: async () => ({ provider: "netopia", apiKey: "SECRET_VECHI" }),
        },
        async (input) => ({ provider: input.provider, apiKey: "SECRET_NOU" }),
      );
      await runWithRequestContext({ requestId: "req-int-4" }, () => save({ provider: "netopia" }));
      return tx.auditLog.findFirstOrThrow({ where: { actorId: "u-int-4" } });
    });
    expect(row).toMatchObject({
      actorId: "u-int-4",
      actorLabel: "admin@magazin.test",
      action: "integration.save",
      entity: "integration",
      entityId: "netopia",
      requestId: "req-int-4",
    });
    const stored = JSON.stringify([row.before, row.after]);
    expect(stored).not.toContain("SECRET");
    expect(stored).toContain("netopia");
    expect(stored).toContain("[ascuns]");
  });

  it("list(): filtrează după entitate/actor, sortează descrescător și plafonează la 200", async () => {
    const out = await inTx(async (tx) => {
      const audit = new AuditService(createPrismaAuditStore(tx));
      for (const [actorId, entity, action] of [
        ["u-int-5", "setting", "prima"],
        ["u-int-5", "product", "a doua"],
        ["u-int-6", "setting", "a treia"],
      ] as const) {
        await audit.record({ actorId, actorLabel: null, action, entity });
        // createdAt are precizie de milisecunde; o pauză mică garantează ordinea.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return {
        byEntity: (await audit.list({ entity: "setting", actorId: "u-int-5" })).map(
          (r) => r.action,
        ),
        byActor: (await audit.list({ actorId: "u-int-5" })).map((r) => r.action),
        limited: (await audit.list({ actorId: "u-int-5", limit: 1 })).map((r) => r.action),
        huge: (await audit.list({ limit: 100_000 })).length,
      };
    });
    expect(out.byEntity).toEqual(["prima"]);
    expect(out.byActor).toEqual(["a doua", "prima"]);
    expect(out.limited).toEqual(["a doua"]);
    expect(out.huge).toBeLessThanOrEqual(200);
  });
});

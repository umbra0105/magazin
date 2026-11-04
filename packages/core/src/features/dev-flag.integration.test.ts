import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { getDb, type PrismaClient } from "@ecom/db";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { runDevFlag } from "./dev-flag";
import { FEATURE_FLAGS_CACHE_KEY, FeatureFlagService } from "./feature-flag-service";
import { createPrismaFeatureFlagStore } from "./prisma-store";

/**
 * `dev:flag` pe Postgres și Redis de test.
 *
 *  - Scrierea cu audit rulează în-proces, într-o tranzacție ANULATĂ: `audit_log` nu se poate șterge (trigger append-only), iar un
 *    rând comis `feature_flag.update` strică testele care numără rândurile de audit ale acestei acțiuni.
 *  - Procesul real (aceeași cale ca `npm.cmd run dev:flag`) se rulează doar pe căi care NU scriu audit: refuzuri, starea, comanda
 *    «off» pe un steag deja oprit (nimic de înregistrat) și Redis oprit. Testele de refuz folosesc tot «off»: dacă garda s-ar strica,
 *    procesul ar scrie în `feature_flag` (testul pică), dar nu ar lăsa un rând de audit care nu se mai poate șterge.
 *
 * Mediul vine din mediul testelor de integrare (bază `*_test`, Redis DB ≠ 0), deci garda scriptului îl acceptă.
 */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SCRIPT = "packages/core/scripts/dev-flag.ts";

const db = getDb();
const redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
const service = new FeatureFlagService(createPrismaFeatureFlagStore(db), redis);

function runScript(args: string[], envOverride: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...envOverride },
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

type Client = Pick<PrismaClient, "$queryRaw" | "$queryRawUnsafe">;

/** Numărul de rânduri din fiecare tabel, ca să vedem ce atinge scriptul. */
async function rowCounts(client: Client): Promise<Record<string, number>> {
  const tables = await client.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
  const counts: Record<string, number> = {};
  for (const { table_name } of tables) {
    const rows = await client.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM "${table_name}"`,
    );
    counts[table_name] = Number(rows[0]?.n ?? 0);
  }
  return counts;
}

const changedTables = (before: Record<string, number>, after: Record<string, number>): string[] =>
  Object.keys(after)
    .filter((table) => after[table] !== before[table])
    .sort();

const dbUrl = new URL(process.env["DATABASE_URL"] ?? "postgresql://x@localhost/x_test");

beforeEach(async () => {
  await db.featureFlag.deleteMany();
  await redis.del(FEATURE_FLAGS_CACHE_KEY);
});

afterAll(async () => {
  await db.featureFlag.deleteMany();
  await redis.del(FEATURE_FLAGS_CACHE_KEY);
  redis.disconnect();
  await db.$disconnect();
});

/** Rulează `runDevFlag` pe Postgres și Redis reale, în tranzacția dată. */
function runIn(tx: TestTx, command: Parameters<typeof runDevFlag>[0]["command"]) {
  return runDevFlag({
    command,
    store: createPrismaFeatureFlagStore(tx as unknown as PrismaClient),
    redis,
    auditStore: createPrismaAuditStore(tx),
  });
}

const scriptAudit = (tx: TestTx) =>
  tx.auditLog.findMany({
    where: { actorLabel: "script de dezvoltare", entity: "feature_flag" },
    orderBy: { createdAt: "asc" },
  });

describe("dev:flag: scrierea cu audit (Postgres + Redis reale, tranzacție anulată)", () => {
  it("pornește steagul: rând în feature_flag, audit cu actorul scriptului, cache-ul din Redis șters", async () => {
    // cache vechi, populat de «aplicație»: steagul apare oprit
    expect(await service.isEnabled("multiWarehouse")).toBe(false);
    expect(await redis.exists(FEATURE_FLAGS_CACHE_KEY)).toBe(1);

    await inRolledBackTransaction(db, async (tx) => {
      const auditBefore = (await scriptAudit(tx)).length;
      const result = await runIn(tx, { kind: "set", key: "multiWarehouse", enabled: true });

      expect(result).toMatchObject({
        before: false,
        after: true,
        changed: true,
        cacheCleared: true,
      });
      const row = await tx.featureFlag.findUniqueOrThrow({ where: { key: "multiWarehouse" } });
      expect(row.enabled).toBe(true);

      const audit = await scriptAudit(tx);
      expect(audit).toHaveLength(auditBefore + 1);
      expect(audit.at(-1)).toMatchObject({
        actorId: "dev-script",
        actorLabel: "script de dezvoltare",
        action: "feature_flag.update",
        entity: "feature_flag",
        entityId: "multiWarehouse",
        outcome: "success",
        before: { enabled: false },
        after: { enabled: true },
      });
    });
    // cheia veche nu mai e în Redis: aplicația citește din baza de date la următoarea cerere
    expect(await redis.exists(FEATURE_FLAGS_CACHE_KEY)).toBe(0);
  });

  it("«on» apoi «off»: două rânduri de audit, cu diferențele înainte/după", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const auditBefore = (await scriptAudit(tx)).length;
      await runIn(tx, { kind: "set", key: "multiWarehouse", enabled: true });
      await runIn(tx, { kind: "set", key: "multiWarehouse", enabled: false });
      const added = (await scriptAudit(tx)).slice(auditBefore);
      expect(added.map((a) => [a.before, a.after])).toEqual([
        [{ enabled: false }, { enabled: true }],
        [{ enabled: true }, { enabled: false }],
      ]);
    });
  });

  it("a doua pornire nu mai scrie audit", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await runIn(tx, { kind: "set", key: "multiWarehouse", enabled: true });
      const auditAfterFirst = (await scriptAudit(tx)).length;
      const again = await runIn(tx, { kind: "set", key: "multiWarehouse", enabled: true });
      expect(again).toMatchObject({ changed: false });
      expect((await scriptAudit(tx)).length).toBe(auditAfterFirst);
    });
  });

  it("atinge doar feature_flag și audit_log; celelalte steaguri rămân cum erau", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await tx.featureFlag.create({ data: { key: "blog", enabled: true, description: "Blog" } });
      const before = await rowCounts(tx);
      await runIn(tx, { kind: "set", key: "multiWarehouse", enabled: true });
      const after = await rowCounts(tx);
      expect(changedTables(before, after)).toEqual(["audit_log", "feature_flag"]);
      expect(after["feature_flag"]).toBe((before["feature_flag"] ?? 0) + 1);
      expect(after["audit_log"]).toBe((before["audit_log"] ?? 0) + 1);
      expect((await tx.featureFlag.findUniqueOrThrow({ where: { key: "blog" } })).enabled).toBe(
        true,
      );
    });
  });

  it("starea: citește din baza de date, fără să scrie nimic", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await tx.featureFlag.create({
        data: { key: "multiWarehouse", enabled: true, description: "Multi-depozit" },
      });
      const before = await rowCounts(tx);
      const result = await runIn(tx, { kind: "status" });
      if (result.kind !== "status") throw new Error("status așteptat");
      expect(result.flags.find((f) => f.key === "multiWarehouse")?.enabled).toBe(true);
      expect(changedTables(before, await rowCounts(tx))).toEqual([]);
    });
  });
});

describe("dev:flag: procesul real (npm.cmd run dev:flag)", () => {
  const auditCount = async () =>
    db.auditLog.count({ where: { actorLabel: "script de dezvoltare" } });

  it("«off» pe un steag oprit: șterge cache-ul vechi din Redis și nu scrie audit; atinge doar feature_flag", async () => {
    // cache vechi care spune «pornit», deși în bază nu există nimic
    await redis.set(FEATURE_FLAGS_CACHE_KEY, JSON.stringify({ multiWarehouse: true }), "EX", 300);
    expect(await service.isEnabled("multiWarehouse")).toBe(true);
    const before = await rowCounts(db);

    const run = runScript(["multiWarehouse", "off"]);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toMatch(/deja oprit/);
    expect(run.output).toMatch(/Cache-ul Redis al steagurilor a fost șters/);

    // aplicația (alt serviciu, același Redis) vede adevărul, fără repornire și fără 5 minute de așteptare
    expect(await service.isEnabled("multiWarehouse")).toBe(false);
    expect(changedTables(before, await rowCounts(db))).toEqual(["feature_flag"]);
  });

  it("fără argumente: arată starea, fără să scrie", async () => {
    await db.featureFlag.create({
      data: { key: "multiWarehouse", enabled: true, description: "Multi-depozit" },
    });
    const before = await rowCounts(db);
    const run = runScript([]);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toMatch(/multiWarehouse\s.*pornit/);
    expect(run.output).toMatch(/blog\s.*oprit/);
    expect(await rowCounts(db)).toEqual(before);
  });

  it("steag necunoscut: iese cu eroare, arată steagurile valide și nu scrie nimic", async () => {
    const before = await rowCounts(db);
    const run = runScript(["multiWarehose", "on"]);
    expect(run.status).toBe(1);
    expect(run.output).toContain("multiWarehouse");
    expect(await rowCounts(db)).toEqual(before);
  });

  it("refuză o bază care nu e locală, fără să afișeze adresa sau parola și fără să scrie", async () => {
    const before = await rowCounts(db);
    const run = runScript(["multiWarehouse", "off"], {
      DATABASE_URL: "postgresql://utilizator:parola-secreta@db.exemplu-productie.com:5432/ecom",
    });
    expect(run.status).toBe(1);
    expect(run.output).not.toContain("parola-secreta");
    expect(run.output).not.toContain("exemplu-productie");
    expect(await rowCounts(db)).toEqual(before);
  });

  it("refuză un Redis care nu e local", async () => {
    const before = await rowCounts(db);
    const run = runScript(["multiWarehouse", "off"], {
      REDIS_URL: "redis://:parola-secreta@cache.exemplu-productie.com:6379/1",
    });
    expect(run.status).toBe(1);
    expect(run.output).not.toContain("parola-secreta");
    expect(run.output).not.toContain("exemplu-productie");
    expect(await rowCounts(db)).toEqual(before);
  });

  it("refuză în producție", async () => {
    const before = await rowCounts(db);
    const run = runScript(["multiWarehouse", "off"], { APP_ENV: "production" });
    expect(run.status).toBe(1);
    expect(await rowCounts(db)).toEqual(before);
  });

  it("baza locală nu răspunde: eroare scurtă, fără adresă, gazdă sau parolă", async () => {
    const run = runScript(["multiWarehouse", "off"], {
      DATABASE_URL: "postgresql://utilizator:parola-secreta@127.0.0.1:1/ecom_test",
    });
    expect(run.status).toBe(1);
    expect(run.output).toMatch(/Eroare neașteptată/);
    expect(run.output).not.toContain("parola-secreta");
    expect(run.output).not.toContain("127.0.0.1");
    expect(await db.featureFlag.count()).toBe(0);
  });

  it("Redis local oprit: starea se scrie, dar scriptul spune clar că cache-ul nu s-a șters (cod de ieșire 1)", async () => {
    const auditBefore = await auditCount();
    // «off» pe un steag oprit: nu are nimic de înregistrat în audit, deci nu lasă rânduri comise
    const run = runScript(["multiWarehouse", "off"], { REDIS_URL: "redis://127.0.0.1:1/1" });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/Cache-ul Redis nu a putut fi șters/);
    expect(run.output).toMatch(/5 minute/);
    expect(
      (await db.featureFlag.findUniqueOrThrow({ where: { key: "multiWarehouse" } })).enabled,
    ).toBe(false);
    expect(await auditCount()).toBe(auditBefore);
  });

  it("nu afișează adresa bazei, utilizatorul sau parola (rulare reușită)", async () => {
    const run = runScript(["multiWarehouse", "off"]);
    expect(run.status, run.output).toBe(0);
    expect(run.output).not.toContain(dbUrl.href);
    if (dbUrl.password) expect(run.output).not.toContain(decodeURIComponent(dbUrl.password));
    expect(run.output).not.toContain(process.env["REDIS_URL"] ?? "redis://");
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { inRolledBackTransaction, type TestTx } from "../../test-utils/rollback";

/**
 * Faza 15, tabela `nir_import`. Fiecare constrângere are un test care o încalcă, iar CHECK-urile compuse au și cazul «una setată,
 * una nulă» (un CHECK cu rezultat NULL TRECE). Testele nu presupun date de seed.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const uid = (): string => randomUUID().slice(0, 8);

const base = () => ({
  fileName: "miscari.xls",
  format: "xls",
  sizeBytes: 1_000,
  fileHash: "a".repeat(64),
  rowCount: 10,
  itemCount: 4,
  plan: [],
  report: {},
  expiresAt: new Date("2030-01-01T00:00:00Z"),
});

const make = (tx: TestTx, over: Record<string, unknown> = {}) =>
  tx.nirImport.create({ data: { ...base(), ...over } as never });

describe("nir_import: valori implicite și valide", () => {
  it("un import nou e «previewed», fără progres, fără date de pornire sau de încheiere", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const row = await make(tx);
      expect(row).toMatchObject({
        status: "previewed",
        processedItems: 0,
        startedAt: null,
        finishedAt: null,
        errorMessage: null,
        createdById: null,
      });
    });
  });

  it("stările și formatele valide trec", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      for (const format of ["csv", "xls", "xlsx"]) await make(tx, { format });
      for (const status of ["previewed", "queued"]) await make(tx, { status });
      await make(tx, { status: "running", startedAt: new Date() });
      const now = new Date();
      for (const status of ["completed", "failed"]) {
        await make(tx, { status, startedAt: now, finishedAt: now });
      }
    });
  });

  it("cel care a făcut importul poate dispărea: importul rămâne (SET NULL)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const user = await tx.user.create({
        data: { id: `u_${uid()}`, name: "Admin", email: `a-${uid()}@exemplu.test` },
      });
      const row = await make(tx, { createdById: user.id });
      await tx.user.delete({ where: { id: user.id } });
      expect(
        (await tx.nirImport.findUniqueOrThrow({ where: { id: row.id } })).createdById,
      ).toBeNull();
    });
  });
});

describe("nir_import: constrângeri", () => {
  it.each([
    ["stare necunoscută", { status: "nou" }],
    ["stare goală", { status: "" }],
    ["format necunoscut", { format: "pdf" }],
    ["mărime negativă", { sizeBytes: -1 }],
    ["rânduri negative", { rowCount: -1 }],
    ["elemente negative", { itemCount: -1 }],
    ["progres negativ", { processedItems: -1 }],
    ["progres peste numărul de elemente", { itemCount: 4, processedItems: 5 }],
    ["hash prea scurt", { fileHash: "abc" }],
    ["nume de fișier gol", { fileName: "  " }],
  ])("%s e refuzat", async (_label, over) => {
    await inRolledBackTransaction(db, async (tx) => {
      await expect(make(tx, over)).rejects.toThrow();
    });
  });

  it.each([
    [
      "«completed» fără finishedAt (una setată, una nulă)",
      { status: "completed", startedAt: new Date() },
    ],
    ["«failed» fără finishedAt", { status: "failed", startedAt: new Date() }],
    ["«previewed» cu finishedAt", { status: "previewed", finishedAt: new Date() }],
    ["«queued» cu finishedAt", { status: "queued", finishedAt: new Date() }],
    [
      "«running» cu finishedAt",
      { status: "running", startedAt: new Date(), finishedAt: new Date() },
    ],
    ["«running» fără startedAt", { status: "running" }],
    ["«completed» fără startedAt", { status: "completed", finishedAt: new Date() }],
  ])("%s e refuzat", async (_label, over) => {
    await inRolledBackTransaction(db, async (tx) => {
      await expect(make(tx, over)).rejects.toThrow();
    });
  });

  it("tranziția unui import existent într-o combinație invalidă e refuzată", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const row = await make(tx);
      await expect(
        tx.nirImport.update({ where: { id: row.id }, data: { status: "completed" } }),
      ).rejects.toThrow();
    });
    await inRolledBackTransaction(db, async (tx) => {
      const row = await make(tx);
      await expect(
        tx.nirImport.update({ where: { id: row.id }, data: { processedItems: 99 } }),
      ).rejects.toThrow();
    });
  });
});

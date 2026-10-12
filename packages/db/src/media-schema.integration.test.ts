import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "./index";

const db = getDb();
type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

class Rollback extends Error {}

/** Rulează `fn` într-o tranzacție anulată mereu (un eșec SQL strică tranzacția: un caz = o tranzacție). */
async function rolledBack<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await db
    .$transaction(async (tx) => {
      result = await fn(tx);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
  return result as T;
}

const media = (key: string, overrides: Record<string, unknown> = {}) => ({
  mime: "image/jpeg",
  sizeBytes: 1000,
  checksum: "a".repeat(64),
  originalName: "poza.jpg",
  storageKey: key,
  ...overrides,
});

describe("schema Media", () => {
  afterAll(async () => {
    await db.$disconnect();
  });

  it("are tabelele media și media_folder, cu valorile implicite așteptate", async () => {
    const row = await rolledBack((tx) => tx.media.create({ data: media("media/test/implicit") }));
    expect(row.status).toBe("pending");
    expect(row.alt).toBe("");
    expect(row.tags).toEqual([]);
    expect(row.variants).toEqual([]);
    expect(row.folderId).toBeNull();
  });

  it("refuză un status în afara listei și o mărime negativă (CHECK)", async () => {
    await expect(
      rolledBack((tx) => tx.media.create({ data: media("media/test/s", { status: "gata" }) })),
    ).rejects.toThrow();
    await expect(
      rolledBack((tx) => tx.media.create({ data: media("media/test/n", { sizeBytes: -1 }) })),
    ).rejects.toThrow();
  });

  it("cheia de stocare e unică", async () => {
    await expect(
      rolledBack(async (tx) => {
        await tx.media.create({ data: media("media/test/dup") });
        await tx.media.create({ data: media("media/test/dup") });
      }),
    ).rejects.toThrow();
  });

  it("numele folderului e unic în același părinte, fără diferență de majuscule, inclusiv în rădăcină", async () => {
    await expect(
      rolledBack(async (tx) => {
        await tx.mediaFolder.create({ data: { name: "Produse" } });
        await tx.mediaFolder.create({ data: { name: "produse" } });
      }),
    ).rejects.toThrow();
    await expect(
      rolledBack(async (tx) => {
        const parent = await tx.mediaFolder.create({ data: { name: "Radacina" } });
        await tx.mediaFolder.create({ data: { name: "Pompe", parentId: parent.id } });
        await tx.mediaFolder.create({ data: { name: "POMPE", parentId: parent.id } });
      }),
    ).rejects.toThrow();
  });

  it("același nume e permis în părinți diferiți", async () => {
    const count = await rolledBack(async (tx) => {
      const a = await tx.mediaFolder.create({ data: { name: "A" } });
      const b = await tx.mediaFolder.create({ data: { name: "B" } });
      await tx.mediaFolder.create({ data: { name: "Poze", parentId: a.id } });
      await tx.mediaFolder.create({ data: { name: "Poze", parentId: b.id } });
      return tx.mediaFolder.count({ where: { name: "Poze" } });
    });
    expect(count).toBe(2);
  });

  it("un folder cu fișiere sau subfoldere nu se poate șterge (RESTRICT)", async () => {
    await expect(
      rolledBack(async (tx) => {
        const folder = await tx.mediaFolder.create({ data: { name: "Cu fisiere" } });
        await tx.media.create({ data: media("media/test/in-folder", { folderId: folder.id }) });
        await tx.mediaFolder.delete({ where: { id: folder.id } });
      }),
    ).rejects.toThrow();
    await expect(
      rolledBack(async (tx) => {
        const parent = await tx.mediaFolder.create({ data: { name: "Parinte" } });
        await tx.mediaFolder.create({ data: { name: "Copil", parentId: parent.id } });
        await tx.mediaFolder.delete({ where: { id: parent.id } });
      }),
    ).rejects.toThrow();
  });

  it("filtrează după tag", async () => {
    const found = await rolledBack(async (tx) => {
      await tx.media.create({ data: media("media/test/t1", { tags: ["piscina", "pompa"] }) });
      await tx.media.create({ data: media("media/test/t2", { tags: ["liner"] }) });
      return tx.media.findMany({
        where: { storageKey: { startsWith: "media/test/t" }, tags: { has: "pompa" } },
      });
    });
    expect(found.map((m) => m.storageKey)).toEqual(["media/test/t1"]);
  });

  it("la ștergerea utilizatorului, fișierul rămâne, cu uploadedById nul", async () => {
    const out = await rolledBack(async (tx) => {
      const user = await tx.user.create({
        data: { id: "media-test-user", name: "Test", email: "media-test@example.test" },
      });
      const row = await tx.media.create({
        data: media("media/test/owner", { uploadedById: user.id }),
      });
      await tx.user.delete({ where: { id: user.id } });
      return tx.media.findUniqueOrThrow({ where: { id: row.id } });
    });
    expect(out.uploadedById).toBeNull();
  });
});

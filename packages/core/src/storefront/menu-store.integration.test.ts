import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import type { StorageDriver } from "@ecom/integrations";
import { inRolledBackTransaction } from "../test-utils/rollback";
import { createPrismaMenuStore } from "./menu-store";

const db = getDb();
afterAll(async () => {
  await db.$disconnect();
});

const storage = {
  publicUrl: (key: string) => `https://cdn.test/${key}`,
} as unknown as StorageDriver;
const uid = () => Math.random().toString(36).slice(2, 10);

describe("magazinul meniului: imaginea categoriei", () => {
  it("categoria cu fișier media gata primește varianta `medium`; fără fișier, cu fișier neprocesat sau fără driver rămâne text", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const tag = uid();
      const media = (status: string, variants: unknown) =>
        tx.media.create({
          data: {
            status,
            mime: "image/webp",
            sizeBytes: 10,
            width: 1600,
            height: 800,
            checksum: `c-${tag}-${status}`,
            originalName: "m.webp",
            storageKey: `public/media/${tag}-${status}/original.webp`,
            alt: status === "ready" ? "Pompe de căldură în curte" : "",
            variants: variants as never,
          },
        });
      const ready = await media("ready", [
        {
          name: "medium",
          format: "webp",
          mime: "image/webp",
          key: `public/media/${tag}/medium.webp`,
          width: 800,
          height: 400,
          sizeBytes: 5,
        },
      ]);
      const pending = await media("processing", []);
      const category = (slug: string, imageMediaId: string | null) =>
        tx.category.create({
          data: { slug: `${slug}-${tag}`, name: slug, path: `${slug}-${tag}`, imageMediaId },
        });
      const withImage = await category("cu-imagine", ready.id);
      const withPending = await category("neprocesat", pending.id);
      const without = await category("fara-imagine", null);

      const find = (rows: { id: string; image?: unknown }[], id: string) =>
        rows.find((row) => row.id === id);

      const rows = await createPrismaMenuStore(tx, { storage }).listCategories();
      expect(find(rows, withImage.id)?.image).toEqual({
        src: `https://cdn.test/public/media/${tag}/medium.webp`,
        width: 800,
        height: 400,
        alt: "Pompe de căldură în curte",
      });
      expect(find(rows, withPending.id)?.image).toBeNull();
      expect(find(rows, without.id)?.image).toBeNull();

      const noStorage = await createPrismaMenuStore(tx).listCategories();
      expect(find(noStorage, withImage.id)?.image).toBeNull();
    });
  });
});

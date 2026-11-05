import type { PrismaClient } from "@ecom/db";
import type { StorageDriver } from "@ecom/integrations";
import { describe, expect, it, vi } from "vitest";
import { createDbMediaResolver } from "./media-resolver";

const storage = { publicUrl: (key: string) => `/media/${key}` } as unknown as StorageDriver;

const variant = (name: string, format: string, width: number) => ({
  name,
  format,
  mime: `image/${format}`,
  key: `public/media/m1/${name}.${format}`,
  width,
  height: Math.round(width * 0.75),
  sizeBytes: 100,
});

interface Row {
  id: string;
  storageKey: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  variants: unknown;
}

function fakeDb(rows: Row[]) {
  const findMany = vi.fn(async (args: { where: { id: { in: string[] } } }) =>
    rows.filter((row) => args.where.id.in.includes(row.id)),
  );
  return { db: { media: { findMany } } as unknown as Pick<PrismaClient, "media">, findMany };
}

const base = {
  storageKey: "public/media/m1/original.jpg",
  width: 3000,
  height: 2000,
  blurhash: null,
};

describe("createDbMediaResolver", () => {
  it("întreabă doar fișiere de tip imagine care nu au eșuat și nu citește altceva decât câmpurile de adresă", async () => {
    const { db, findMany } = fakeDb([]);
    await createDbMediaResolver(db, storage)(["a", "b"]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: { in: ["a", "b"] }, mime: { startsWith: "image/" }, status: { not: "failed" } },
      select: {
        id: true,
        storageKey: true,
        width: true,
        height: true,
        blurhash: true,
        variants: true,
      },
    });
  });

  it("fără id-uri nu interoghează baza", async () => {
    const { db, findMany } = fakeDb([]);
    expect((await createDbMediaResolver(db, storage)([])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("alege formatul WebP: srcset cu toate lățimile lui, src = cea mai mică variantă de cel puțin 800 px", async () => {
    const { db } = fakeDb([
      {
        id: "m1",
        ...base,
        variants: [
          variant("w320", "webp", 320),
          variant("w800", "webp", 800),
          variant("w1600", "webp", 1600),
          variant("w320", "jpeg", 320),
          variant("w800", "jpeg", 800),
          variant("w320", "avif", 320),
        ],
      },
    ]);
    const result = await createDbMediaResolver(db, storage)(["m1"]);
    expect(result.get("m1")).toEqual({
      src: "/media/public/media/m1/w800.webp",
      srcset:
        "/media/public/media/m1/w320.webp 320w, /media/public/media/m1/w800.webp 800w, /media/public/media/m1/w1600.webp 1600w",
      width: 3000,
      height: 2000,
    });
  });

  it("srcset aparține formatului ales, chiar dacă alt format apare primul în listă", async () => {
    const { db } = fakeDb([
      {
        id: "m1",
        ...base,
        variants: [
          variant("w320", "jpeg", 320),
          variant("w320", "webp", 320),
          variant("w800", "webp", 800),
        ],
      },
    ]);
    const result = (await createDbMediaResolver(db, storage)(["m1"])).get("m1");
    expect(result?.srcset).toBe(
      "/media/public/media/m1/w320.webp 320w, /media/public/media/m1/w800.webp 800w",
    );
    expect(result?.src).toBe("/media/public/media/m1/w800.webp");
  });

  it("dacă nicio variantă nu ajunge la 800 px, src = cea mai mare", async () => {
    const { db } = fakeDb([
      { id: "m1", ...base, variants: [variant("w320", "webp", 320), variant("w640", "webp", 640)] },
    ]);
    expect((await createDbMediaResolver(db, storage)(["m1"])).get("m1")?.src).toBe(
      "/media/public/media/m1/w640.webp",
    );
  });

  it("fără WebP folosește JPEG, apoi orice format prezent", async () => {
    const jpegOnly = fakeDb([
      { id: "m1", ...base, variants: [variant("w800", "jpeg", 800), variant("w800", "avif", 800)] },
    ]);
    expect((await createDbMediaResolver(jpegOnly.db, storage)(["m1"])).get("m1")?.src).toBe(
      "/media/public/media/m1/w800.jpeg",
    );
    const avifOnly = fakeDb([{ id: "m1", ...base, variants: [variant("w800", "avif", 800)] }]);
    expect((await createDbMediaResolver(avifOnly.db, storage)(["m1"])).get("m1")?.src).toBe(
      "/media/public/media/m1/w800.avif",
    );
  });

  it("cât timp fișierul nu are variante (încă se procesează), folosește originalul, fără srcset", async () => {
    const { db } = fakeDb([{ id: "m1", ...base, variants: [] }]);
    expect((await createDbMediaResolver(db, storage)(["m1"])).get("m1")).toEqual({
      src: "/media/public/media/m1/original.jpg",
      srcset: null,
      width: 3000,
      height: 2000,
    });
  });

  it("variantele stricate (valoare care nu e listă) sunt ignorate", async () => {
    const { db } = fakeDb([{ id: "m1", ...base, variants: "nu-e-lista" }]);
    expect((await createDbMediaResolver(db, storage)(["m1"])).get("m1")?.src).toBe(
      "/media/public/media/m1/original.jpg",
    );
  });

  it("id-urile fără rând în bază lipsesc din rezultat", async () => {
    const { db } = fakeDb([{ id: "m1", ...base, variants: [] }]);
    const result = await createDbMediaResolver(db, storage)(["m1", "lipsa"]);
    expect([...result.keys()]).toEqual(["m1"]);
  });
});

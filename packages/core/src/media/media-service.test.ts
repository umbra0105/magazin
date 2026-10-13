import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Readable } from "node:stream";
import type { PutOptions, StorageDriver, StoredObject } from "@ecom/integrations";
import { MediaError } from "./errors";
import { MediaService, type UploadCommand } from "./media-service";
import type { MediaRow, MediaStore, NewMedia } from "./media-store";

class MemoryStorage implements StorageDriver {
  readonly kind = "local" as const;
  readonly objects = new Map<string, { body: Buffer; options: PutOptions }>();
  readonly deleted: string[] = [];
  async put(key: string, body: Buffer, options: PutOptions): Promise<StoredObject> {
    this.objects.set(key, { body, options });
    return { key, size: body.length, contentType: options.contentType };
  }
  async get(): Promise<{ stream: Readable; object: StoredObject }> {
    throw new Error("nefolosit");
  }
  async stat(): Promise<StoredObject | null> {
    return null;
  }
  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
  }
  publicUrl(key: string): string {
    return `https://magazin.test/media/${key.slice("public/".length)}`;
  }
  async signedUrl(): Promise<string> {
    throw new Error("nefolosit");
  }
}

function store(overrides: Partial<MediaStore> = {}): MediaStore & { created: NewMedia[] } {
  const created: NewMedia[] = [];
  return {
    created,
    async folderExists() {
      return true;
    },
    async create(data) {
      created.push(data);
      const row: MediaRow = {
        id: "m1",
        status: "pending",
        mime: data.mime,
        sizeBytes: data.sizeBytes,
        width: data.width,
        height: data.height,
        storageKey: data.storageKey,
        alt: data.alt,
        folderId: data.folderId,
        createdAt: new Date(),
      };
      return row;
    },
    ...overrides,
  };
}

const jpeg = () =>
  sharp({ create: { width: 30, height: 20, channels: 3, background: "#ffffff" } })
    .jpeg()
    .toBuffer();

const command = async (extra: Partial<UploadCommand> = {}): Promise<UploadCommand> => ({
  bytes: await jpeg(),
  originalName: "poza.jpg",
  uploadedById: "u1",
  limits: { allowedMimeTypes: ["image/jpeg"], maxInputPixels: 40_000_000 },
  ...extra,
});

describe("MediaService.upload", () => {
  it("scrie originalul sub public/media/<uuid>/original.<ext>, cu cache imutabil, și creează rândul", async () => {
    const storage = new MemoryStorage();
    const s = store();
    const out = await new MediaService({ store: s, storage }).upload(await command({ alt: "x" }));

    const [key] = [...storage.objects.keys()];
    expect(key).toMatch(/^public\/media\/[0-9a-f-]{36}\/original\.jpg$/);
    expect(storage.objects.get(key!)?.options).toEqual({
      contentType: "image/jpeg",
      cacheControl: "public, max-age=31536000, immutable",
    });
    expect(s.created[0]).toMatchObject({
      storageKey: key,
      mime: "image/jpeg",
      width: 30,
      height: 20,
      originalName: "poza.jpg",
      uploadedById: "u1",
      alt: "x",
      folderId: null,
    });
    expect(out.url).toBe(`https://magazin.test/media/${key!.slice("public/".length)}`);
  });

  it("dacă baza de date eșuează, obiectul din storage se șterge", async () => {
    const storage = new MemoryStorage();
    const failing = store({
      create: async () => {
        throw new Error("baza de date a căzut");
      },
    });
    await expect(
      new MediaService({ store: failing, storage }).upload(await command()),
    ).rejects.toThrow("baza de date a căzut");
    expect(storage.objects.size).toBe(0);
    expect(storage.deleted).toHaveLength(1);
  });

  it("un fișier invalid nu scrie nimic în storage", async () => {
    const storage = new MemoryStorage();
    const s = store();
    await expect(
      new MediaService({ store: s, storage }).upload(
        await command({ bytes: Buffer.from("nu sunt imagine") }),
      ),
    ).rejects.toMatchObject({ code: "MEDIA_UNSUPPORTED_TYPE" });
    expect(storage.objects.size).toBe(0);
    expect(s.created).toHaveLength(0);
  });

  it("folder inexistent: eroare și niciun obiect scris", async () => {
    const storage = new MemoryStorage();
    const s = store({ folderExists: async () => false });
    const error = await new MediaService({ store: s, storage })
      .upload(await command({ folderId: "nu-exista" }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaError);
    expect((error as MediaError).code).toBe("MEDIA_FOLDER_NOT_FOUND");
    expect(storage.objects.size).toBe(0);
  });

  it("o eroare la pornirea procesării nu anulează încărcarea", async () => {
    const storage = new MemoryStorage();
    const service = new MediaService({
      store: store(),
      storage,
      onCreated: async () => {
        throw new Error("Redis căzut");
      },
    });
    const out = await service.upload(await command());
    expect(out.status).toBe("pending");
    expect(storage.objects.size).toBe(1);
  });

  it("alt-ul e limitat la 300 de caractere", async () => {
    const s = store();
    await new MediaService({ store: s, storage: new MemoryStorage() }).upload(
      await command({ alt: "a".repeat(1000) }),
    );
    expect(s.created[0]?.alt).toHaveLength(300);
  });
});

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Readable } from "node:stream";
import type { PutOptions, StorageDriver, StoredObject } from "@ecom/integrations";
import { MemoryDecodeLimiter } from "./decode-limiter";
import { MediaError } from "./errors";
import { sanitizeImage } from "./image";
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

describe("MediaService.upload: limita globală de decodări", () => {
  const limits = { allowedMimeTypes: ["image/jpeg"], maxInputPixels: 40_000_000 };

  it("fără loc liber: MEDIA_BUSY, fără decodare, fără storage, fără rând", async () => {
    const limiter = new MemoryDecodeLimiter({ slots: 2 });
    const held = [await limiter.tryAcquire(), await limiter.tryAcquire()];
    const storage = new MemoryStorage();
    const s = store();
    let decoded = 0;
    const service = new MediaService({
      store: s,
      storage,
      limiter,
      sanitize: async (...args) => {
        decoded += 1;
        return sanitizeImage(...args);
      },
    });

    const error = await service.upload(await command()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaError);
    expect((error as MediaError).code).toBe("MEDIA_BUSY");
    expect(decoded).toBe(0);
    expect(storage.objects.size).toBe(0);
    expect(s.created).toHaveLength(0);

    await held[0]?.release();
    await service.upload(await command());
    expect(decoded).toBe(1);
    await held[1]?.release();
  });

  it("locul se eliberează după decodare, chiar dacă imaginea e invalidă", async () => {
    const limiter = new MemoryDecodeLimiter({ slots: 1 });
    const service = new MediaService({ store: store(), storage: new MemoryStorage(), limiter });
    await expect(
      service.upload(await command({ bytes: Buffer.from("nu e imagine"), limits })),
    ).rejects.toMatchObject({ code: "MEDIA_UNSUPPORTED_TYPE" });
    expect(await limiter.tryAcquire()).not.toBeNull();
  });

  it("sub încărcare: niciodată mai mult de 2 decodări simultane; restul primesc MEDIA_BUSY", async () => {
    const limiter = new MemoryDecodeLimiter({ slots: 2 });
    let inFlight = 0;
    let maxInFlight = 0;
    const service = new MediaService({
      store: store(),
      storage: new MemoryStorage(),
      limiter,
      sanitize: async (...args) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, 40)); // decodare „lentă”
          return await sanitizeImage(...args);
        } finally {
          inFlight -= 1;
        }
      },
    });

    const bytes = await jpeg();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        service.upload({ bytes, originalName: "p.jpg", uploadedById: "u", limits }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const busy = results.filter(
      (r) => r.status === "rejected" && (r.reason as MediaError).code === "MEDIA_BUSY",
    ).length;

    expect(maxInFlight).toBe(2);
    expect(ok).toBe(2);
    expect(busy).toBe(6);
    expect(ok + busy).toBe(8);
    // după ce s-au terminat, locurile sunt din nou libere
    expect(await limiter.tryAcquire()).not.toBeNull();
  });
});

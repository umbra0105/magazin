import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Readable } from "node:stream";
import { Readable as NodeReadable } from "node:stream";
import {
  StorageError,
  type PutOptions,
  type StorageDriver,
  type StoredObject,
} from "@ecom/integrations";
import { z } from "zod";
import { settingGroups } from "../settings/registry";
import { MemoryDecodeLimiter } from "./decode-limiter";
import { MemoryMediaLock } from "./media-lock";
import {
  MediaProcessingError,
  MediaProcessor,
  requestMediaProcessing,
  type MediaProcessingStore,
  type ProcessingErrorCode,
  type ProcessingResult,
  type ProcessingRow,
  type StoredVariant,
} from "./processing";
import type { MediaSettings } from "./upload-handler";

class MemoryStorage implements StorageDriver {
  readonly kind = "local" as const;
  readonly objects = new Map<string, Buffer>();
  failPut: ((key: string) => Error | null) | null = null;
  puts = 0;

  async put(key: string, body: Buffer, options: PutOptions): Promise<StoredObject> {
    this.puts += 1;
    const failure = this.failPut?.(key);
    if (failure) throw failure;
    this.objects.set(key, body);
    return { key, size: body.length, contentType: options.contentType };
  }
  async get(key: string): Promise<{ stream: Readable; object: StoredObject }> {
    const body = this.objects.get(key);
    if (!body) throw new StorageError("STORAGE_NOT_FOUND", "Obiectul nu există");
    return {
      stream: NodeReadable.from([body]),
      object: { key, size: body.length, contentType: "application/octet-stream" },
    };
  }
  async stat(key: string): Promise<StoredObject | null> {
    const body = this.objects.get(key);
    return body ? { key, size: body.length, contentType: "x" } : null;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  publicUrl(key: string): string {
    return `https://magazin.test/media/${key}`;
  }
  async list(): Promise<{ objects: []; truncated: false }> {
    return { objects: [], truncated: false };
  }
  async signedUrl(): Promise<string> {
    throw new Error("nefolosit");
  }
}

class MemoryProcessingStore implements MediaProcessingStore {
  readonly history: string[] = [];
  row:
    | (ProcessingRow & {
        processingError: string | null;
        blurhash: string | null;
        width: number | null;
        height: number | null;
      })
    | null;
  constructor(storageKey: string) {
    this.row = {
      id: "m1",
      status: "pending",
      storageKey,
      variants: [],
      processingError: null,
      blurhash: null,
      width: null,
      height: null,
    };
  }
  async get(id: string) {
    return this.row && this.row.id === id ? this.row : null;
  }
  async markPending() {
    this.history.push("pending");
    Object.assign(this.row!, { status: "pending", processingError: null });
  }
  async markProcessing() {
    this.history.push("processing");
    this.row!.status = "processing";
  }
  async markRetrying(_id: string, code: ProcessingErrorCode) {
    this.history.push(`retrying:${code}`);
    Object.assign(this.row!, { status: "pending", processingError: code });
  }
  async markReady(_id: string, result: ProcessingResult) {
    this.history.push("ready");
    Object.assign(this.row!, {
      status: "ready",
      processingError: null,
      variants: result.variants,
      blurhash: result.blurhash,
      width: result.width,
      height: result.height,
    });
  }
  async markFailed(_id: string, code: ProcessingErrorCode) {
    this.history.push(`failed:${code}`);
    Object.assign(this.row!, { status: "failed", processingError: code });
  }
}

const settings = (extra: Partial<MediaSettings> = {}): MediaSettings => ({
  ...z.object(settingGroups.media).parse({}),
  thumbWidth: 64,
  mediumWidth: 200,
  largeWidth: 400,
  avifQuality: 50,
  ...extra,
});

const KEY = "public/media/abc-123/original.jpg";

async function setup(options: { settings?: Partial<MediaSettings>; original?: Buffer } = {}) {
  const storage = new MemoryStorage();
  const original =
    options.original ??
    (await sharp({ create: { width: 600, height: 300, channels: 3, background: "#2288cc" } })
      .jpeg()
      .toBuffer());
  storage.objects.set(KEY, original);
  const store = new MemoryProcessingStore(KEY);
  const limiter = new MemoryDecodeLimiter({ slots: 2 });
  const lock = new MemoryMediaLock();
  let current = settings(options.settings);
  const logs: string[] = [];
  const processor = new MediaProcessor({
    store,
    storage,
    limiter,
    lock,
    getSettings: async () => current,
    logger: {
      info: (o, m) => logs.push(JSON.stringify({ ...o, m })),
      warn: (o, m) => logs.push(JSON.stringify({ ...o, m })),
    },
  });
  return {
    storage,
    store,
    limiter,
    lock,
    processor,
    logs,
    setSettings: (s: Partial<MediaSettings>) => (current = settings(s)),
  };
}

async function failureOf(promise: Promise<unknown>): Promise<MediaProcessingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MediaProcessingError) return error;
    throw error;
  }
  throw new Error("trebuia să eșueze");
}

describe("MediaProcessor", () => {
  it("generează variantele, le scrie lângă original (cheie cu hash) și marchează ready", async () => {
    const { processor, store, storage } = await setup();
    const outcome = await processor.process("m1", { finalAttempt: false });
    expect(outcome).toEqual({ status: "ready" });
    expect(store.history).toEqual(["processing", "ready"]);

    const row = store.row!;
    expect(row.status).toBe("ready");
    expect(row.processingError).toBeNull();
    expect(row.width).toBe(600);
    expect(row.height).toBe(300);
    expect(row.blurhash).toMatch(/^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]{6,}$/);
    expect(row.variants).toHaveLength(9);
    for (const v of row.variants as StoredVariant[]) {
      expect(v.key).toMatch(
        /^public\/media\/abc-123\/(thumb|medium|large)\.[0-9a-f]{8}\.(avif|webp|jpg)$/,
      );
      expect(storage.objects.get(v.key)?.length).toBe(v.sizeBytes);
    }
    // originalul rămâne
    expect(storage.objects.has(KEY)).toBe(true);
  });

  it("limita de decodări plină → busy, fără nicio schimbare (nici stare, nici storage)", async () => {
    const { processor, store, storage, limiter } = await setup();
    const a = await limiter.tryAcquire();
    const b = await limiter.tryAcquire();
    const outcome = await processor.process("m1", { finalAttempt: true });
    expect(outcome).toEqual({ status: "busy" });
    expect(store.history).toEqual([]);
    expect(store.row?.status).toBe("pending");
    expect(storage.puts).toBe(0);

    await a?.release();
    expect(await processor.process("m1", { finalAttempt: false })).toEqual({ status: "ready" });
    await b?.release();
  });

  it("același fișier nu se procesează în paralel: lock luat → busy, fără să atingă nimic", async () => {
    const { processor, store, storage, limiter, lock } = await setup();
    const held = await lock.tryLock("m1");
    expect(held).not.toBeNull();

    expect(await processor.process("m1", { finalAttempt: false })).toEqual({ status: "busy" });
    expect(store.history).toEqual([]);
    expect(storage.puts).toBe(0);
    // nici locul din limita de decodări nu rămâne ocupat
    const probes = [await limiter.tryAcquire(), await limiter.tryAcquire()];
    expect(probes.every((l) => l !== null)).toBe(true);
    await Promise.all(probes.map((l) => l?.release()));

    await held?.release();
    expect(await processor.process("m1", { finalAttempt: false })).toEqual({ status: "ready" });
    // lock-ul se eliberează după procesare
    expect(await lock.tryLock("m1")).not.toBeNull();
  });

  it("limita de decodări plină → busy și lock-ul fișierului se eliberează", async () => {
    const { processor, limiter, lock } = await setup();
    await limiter.tryAcquire();
    await limiter.tryAcquire();
    expect(await processor.process("m1", { finalAttempt: false })).toEqual({ status: "busy" });
    expect(await lock.tryLock("m1")).not.toBeNull();
  });

  it("eliberează locul și când procesarea eșuează", async () => {
    const { processor, storage, limiter } = await setup();
    storage.failPut = () => new StorageError("STORAGE_FAILED", "x");
    await failureOf(processor.process("m1", { finalAttempt: false }));
    // ambele locuri sunt libere
    const leases = [await limiter.tryAcquire(), await limiter.tryAcquire()];
    expect(leases.every((l) => l !== null)).toBe(true);
  });

  it("storage căzut: reîncercabil → pending cu cod; la ultima încercare → failed", async () => {
    const { processor, store, storage } = await setup();
    storage.failPut = () =>
      new StorageError("STORAGE_FAILED", "Scrierea în S3 a eșuat", {
        errorName: "NoSuchBucket",
        status: 404,
      });

    const first = await failureOf(processor.process("m1", { finalAttempt: false }));
    expect(first).toMatchObject({ code: "STORAGE_UNAVAILABLE", retryable: true });
    expect(store.row).toMatchObject({ status: "pending", processingError: "STORAGE_UNAVAILABLE" });

    const last = await failureOf(processor.process("m1", { finalAttempt: true }));
    expect(last.retryable).toBe(true);
    expect(store.row).toMatchObject({ status: "failed", processingError: "STORAGE_UNAVAILABLE" });
    expect(store.history).toEqual([
      "processing",
      "retrying:STORAGE_UNAVAILABLE",
      "processing",
      "failed:STORAGE_UNAVAILABLE",
    ]);
  });

  it("imagine coruptă: eșec definitiv imediat, chiar la prima încercare", async () => {
    const { processor, store } = await setup({ original: Buffer.from("nu e o imagine") });
    const error = await failureOf(processor.process("m1", { finalAttempt: false }));
    expect(error).toMatchObject({ code: "IMAGE_CORRUPT", retryable: false });
    expect(store.row).toMatchObject({ status: "failed", processingError: "IMAGE_CORRUPT" });
  });

  it("limita de pixeli (coborâtă între timp) se aplică și la procesare, fără reîncercări", async () => {
    const big = await sharp({
      create: { width: 2000, height: 1500, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
    const { processor, store, storage } = await setup({
      original: big,
      settings: { maxInputPixels: 1_000_000 },
    });
    const error = await failureOf(processor.process("m1", { finalAttempt: false }));
    expect(error).toMatchObject({ code: "IMAGE_TOO_LARGE", retryable: false });
    expect(store.row).toMatchObject({ status: "failed", processingError: "IMAGE_TOO_LARGE" });
    expect(storage.puts).toBe(0);
  });

  it("original lipsă din storage: ORIGINAL_MISSING, definitiv", async () => {
    const { processor, store, storage } = await setup();
    storage.objects.delete(KEY);
    const error = await failureOf(processor.process("m1", { finalAttempt: false }));
    expect(error).toMatchObject({ code: "ORIGINAL_MISSING", retryable: false });
    expect(store.row?.status).toBe("failed");
  });

  it("rând șters între timp: skipped, fără erori", async () => {
    const { processor, store } = await setup();
    store.row = null;
    expect(await processor.process("m1", { finalAttempt: false })).toEqual({ status: "skipped" });
  });

  it("motivul eșecului e doar un cod: fără mesajul original, chei, căi sau parole", async () => {
    const { processor, store, storage, logs } = await setup();
    storage.failPut = () =>
      new Error(
        "connect ECONNREFUSED 10.0.0.5:9000 password=SUPER-SECRET key=public/media/abc-123",
      );
    const error = await failureOf(processor.process("m1", { finalAttempt: true }));
    expect(error.code).toBe("UNEXPECTED");
    expect(error.message).toBe("UNEXPECTED");
    const everything = JSON.stringify({
      status: store.row?.status,
      processingError: store.row?.processingError,
      message: error.message,
      logs,
    });
    for (const leak of ["ECONNREFUSED", "10.0.0.5", "SUPER-SECRET", "password", "public/media"]) {
      expect(everything).not.toContain(leak);
    }
  });

  it("regenerarea scrie variante noi și scoate din storage pe cele vechi rămase nefolosite", async () => {
    const { processor, store, storage, setSettings } = await setup();
    await processor.process("m1", { finalAttempt: false });
    const before = new Set((store.row!.variants as StoredVariant[]).map((v) => v.key));
    expect(before.size).toBe(9);

    setSettings({ thumbWidth: 100, mediumWidth: 250, largeWidth: 500 });
    await requestMediaProcessing({ store, queue: { enqueueProcess: async () => undefined } }, "m1");
    expect(store.row).toMatchObject({ status: "pending", processingError: null });

    await processor.process("m1", { finalAttempt: false });
    const after = (store.row!.variants as StoredVariant[]).map((v) => v.key);
    expect(after).toHaveLength(9);
    for (const key of after) expect(storage.objects.has(key)).toBe(true);
    for (const key of before) expect(storage.objects.has(key)).toBe(false); // lățimi diferite → cheile vechi dispar
    expect(storage.objects.has(KEY)).toBe(true);
    expect([...storage.objects.keys()].length).toBe(10); // original + 9
  });

  it("regenerare cu aceleași setări: cheile identice nu se șterg", async () => {
    const { processor, store, storage } = await setup();
    await processor.process("m1", { finalAttempt: false });
    const keys = (store.row!.variants as StoredVariant[]).map((v) => v.key);
    await processor.process("m1", { finalAttempt: false });
    expect((store.row!.variants as StoredVariant[]).map((v) => v.key).sort()).toEqual(keys.sort());
    for (const key of keys) expect(storage.objects.has(key)).toBe(true);
  });
});

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redis } from "ioredis";
import { crc32, deflateSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  MediaProcessor,
  RedisDecodeLimiter,
  RedisMediaLock,
  createPrismaProcessingStore,
  requestMediaProcessing,
  defaultMediaSettings,
  type MediaSettings,
  type StoredVariant,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import {
  LocalStorageDriver,
  S3StorageDriver,
  StorageError,
  deriveSigningKey,
  ensureS3Bucket,
  type StorageDriver,
} from "@ecom/integrations";
import { assertTestBucket } from "../../../test/support/test-env";
import type { JobLogger } from "./email-processor";
import { createMediaQueue, enqueueMediaProcessing, mediaJobQueue } from "./media-queue";
import { startMediaWorker } from "./media-worker";

/**
 * Coada `media` pe Redis REAL, baza de test REALĂ și storage real (disc local și MinIO, într-un
 * bucket de test). Rândurile `Media` create aici sunt committed (workerul le citește pe altă
 * conexiune) și se șterg la final, împreună cu obiectele din storage.
 */
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379/1";
const db = getDb();
let redis: Redis;
let base: string;

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  base = await mkdtemp(join(tmpdir(), "ecom-media-queue-"));
});

afterAll(async () => {
  redis.disconnect();
  await rm(base, { recursive: true, force: true });
  await db.$disconnect();
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** PNG RGB de o singură culoare, scris de mână (fără dependențe): doar pentru a avea imagini valide. */
function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 biți
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const baseSettings = (extra: Partial<MediaSettings> = {}): MediaSettings => ({
  ...defaultMediaSettings(),
  thumbWidth: 64,
  mediumWidth: 200,
  largeWidth: 400,
  avifQuality: 50,
  ...extra,
});

function localStorage(): LocalStorageDriver {
  return new LocalStorageDriver({
    rootDir: join(base, randomBytes(4).toString("hex")),
    appUrl: "https://magazin.test",
    signingKey: deriveSigningKey(Buffer.alloc(32, 9).toString("base64")),
  });
}

interface Setup {
  storage: StorageDriver;
  settings?: Partial<MediaSettings>;
  attempts?: number;
  busyDelayMs?: number;
  slots?: number;
}

function setup(options: Setup) {
  const queueName = `media-test-${randomBytes(4).toString("hex")}`;
  const attempts = options.attempts ?? 3;
  const queue = createMediaQueue(REDIS_URL, { queueName, backoffDelayMs: 40, attempts });
  const limiterKey = `ecom:test:decode:${randomBytes(4).toString("hex")}`;
  const limiter = new RedisDecodeLimiter(redis, { key: limiterKey, slots: options.slots ?? 2 });
  const logs: string[] = [];
  const logger: JobLogger = {
    info: (o, m) => logs.push(JSON.stringify({ ...o, m })),
    warn: (o, m) => logs.push(JSON.stringify({ ...o, m })),
    error: (o, m) => logs.push(JSON.stringify({ ...o, m })),
  };
  let settings = baseSettings(options.settings);
  const processor = new MediaProcessor({
    store: createPrismaProcessingStore(db),
    storage: options.storage,
    limiter,
    lock: new RedisMediaLock(redis, { prefix: `${limiterKey}:lock:` }),
    getSettings: async () => settings,
    logger,
  });
  const worker = startMediaWorker({
    redisUrl: REDIS_URL,
    queueName,
    processor,
    logger,
    concurrency: 2,
    busyDelayMs: options.busyDelayMs ?? 150,
  });
  const created: string[] = [];
  cleanups.push(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await redis.del(limiterKey);
    await db.media.deleteMany({ where: { id: { in: created } } });
  });

  async function createMedia(width = 600, height = 300): Promise<string> {
    const original = solidPng(width, height, [0x33, 0x77, 0xaa]);
    const key = `public/media/${randomUUID()}/original.png`;
    await options.storage.put(key, original, { contentType: "image/png" });
    const row = await db.media.create({
      data: {
        mime: "image/png",
        sizeBytes: original.length,
        width,
        height,
        checksum: "a".repeat(64),
        originalName: "test.jpg",
        storageKey: key,
      },
    });
    created.push(row.id);
    cleanups.push(async () => {
      const current = await db.media.findUnique({ where: { id: row.id } });
      const keys = [
        key,
        ...((current?.variants as unknown as StoredVariant[] | undefined) ?? []).map((v) => v.key),
      ];
      await Promise.all(keys.map((k) => options.storage.delete(k).catch(() => undefined)));
    });
    return row.id;
  }

  return {
    queue,
    limiter,
    logs,
    processor,
    createMedia,
    setSettings: (s: Partial<MediaSettings>) => (settings = baseSettings(s)),
    row: (id: string) => db.media.findUniqueOrThrow({ where: { id } }),
  };
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout așteptând condiția");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("coada media pe disc local (Redis + Postgres reale)", () => {
  it("procesează un fișier: ready, 9 variante în storage, blurhash, job șters", async () => {
    const storage = localStorage();
    const t = setup({ storage });
    const id = await t.createMedia();
    await enqueueMediaProcessing(t.queue, id);

    await waitFor(async () => (await t.row(id)).status === "ready");
    const row = await t.row(id);
    const variants = row.variants as unknown as StoredVariant[];
    expect(variants).toHaveLength(9);
    expect(row.blurhash).toMatch(/^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]{6,}$/);
    expect(row.processingError).toBeNull();
    for (const v of variants) {
      const stat = await storage.stat(v.key);
      expect(stat).toMatchObject({ size: v.sizeBytes, contentType: v.mime });
    }
    await waitFor(
      async () => (await t.queue.getJobs(["completed", "waiting", "active"])).length === 0,
    );
  });

  it("limita de decodări plină: jobul așteaptă în queue (delayed), nu eșuează, apoi se procesează", async () => {
    const t = setup({ storage: localStorage(), busyDelayMs: 200 });
    const held = [await t.limiter.tryAcquire(), await t.limiter.tryAcquire()];
    expect(held.every((l) => l !== null)).toBe(true);

    const id = await t.createMedia();
    await enqueueMediaProcessing(t.queue, id);

    await waitFor(async () => (await t.queue.getJobs(["delayed"])).length === 1);
    // cât timp nu e loc: rândul neatins, nicio încercare consumată, nimic eșuat
    await new Promise((r) => setTimeout(r, 700));
    const waiting = await t.row(id);
    expect(waiting.status).toBe("pending");
    expect(waiting.variants).toEqual([]);
    expect(await t.queue.getJobs(["failed"])).toHaveLength(0);
    const [job] = await t.queue.getJobs(["delayed", "waiting", "active"]);
    expect(job?.attemptsMade).toBe(0);

    // se eliberează locurile → jobul trece
    await Promise.all(held.map((l) => l?.release()));
    await waitFor(async () => (await t.row(id)).status === "ready");
  });

  it("niciodată mai mult de 2 fișiere decodate simultan, indiferent câte joburi sunt", async () => {
    const t = setup({ storage: localStorage(), busyDelayMs: 50, slots: 2 });
    const ids = await Promise.all(Array.from({ length: 6 }, () => t.createMedia(300, 200)));
    let maxHeld = 0;
    const probe = setInterval(() => {
      void redis.zcard((t.limiter as unknown as { key: string }).key).then((n) => {
        maxHeld = Math.max(maxHeld, n);
      });
    }, 10);
    await Promise.all(ids.map((id) => enqueueMediaProcessing(t.queue, id)));
    await waitFor(async () => {
      const rows = await Promise.all(ids.map((id) => t.row(id)));
      return rows.every((r) => r.status === "ready");
    }, 60_000);
    clearInterval(probe);
    expect(maxHeld).toBeLessThanOrEqual(2);
    expect(maxHeld).toBeGreaterThan(0);
  });

  it("reîncearcă cu backoff: storage cade de 2 ori, a 3-a reușește", async () => {
    const real = localStorage();
    let failures = 2;
    const flaky = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "put") {
          return async (key: string, ...rest: unknown[]) => {
            if (key.includes("/thumb.") && failures > 0) {
              failures -= 1;
              throw new StorageError("STORAGE_FAILED", "căzut", { errorName: "ECONNRESET" });
            }
            return (target.put as (...a: unknown[]) => Promise<unknown>).call(target, key, ...rest);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const t = setup({ storage: flaky, attempts: 5 });
    const id = await t.createMedia();
    await enqueueMediaProcessing(t.queue, id);

    await waitFor(async () => (await t.row(id)).status === "ready");
    expect(failures).toBe(0);
    expect((await t.row(id)).processingError).toBeNull();
    const text = t.logs.join("\n");
    expect(text).toContain("media: procesarea a eșuat");
    expect(text).not.toContain("ECONNRESET");
  });

  it("storage mereu căzut: după toate încercările status failed, cu motiv-cod, fără date sensibile", async () => {
    const real = localStorage();
    let puts = 0;
    const broken = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "put") {
          return async (key: string) => {
            if (key.endsWith("original.png")) return { key, size: 0, contentType: "image/jpeg" };
            puts += 1;
            throw new StorageError("STORAGE_FAILED", "Scrierea în S3 a eșuat", {
              errorName: "NoSuchBucket",
              status: 404,
            });
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const t = setup({ storage: broken, attempts: 3 });
    // originalul îl scriem direct pe driverul real
    const original = solidPng(300, 200, [0xaa, 0x55, 0x33]);
    const key = `public/media/${randomUUID()}/original.png`;
    await real.put(key, original, { contentType: "image/png" });
    const row = await db.media.create({
      data: {
        mime: "image/png",
        sizeBytes: original.length,
        width: 300,
        height: 200,
        checksum: "b".repeat(64),
        originalName: "x.jpg",
        storageKey: key,
      },
    });
    cleanups.push(async () => {
      await db.media.delete({ where: { id: row.id } }).catch(() => undefined);
    });
    await enqueueMediaProcessing(t.queue, row.id);

    await waitFor(async () => (await t.row(row.id)).status === "failed");
    const failed = await t.row(row.id);
    expect(failed.processingError).toBe("STORAGE_UNAVAILABLE");
    expect(puts).toBeGreaterThanOrEqual(3); // câte o scriere eșuată pe încercare
    await waitFor(async () => (await t.queue.getJobs(["failed"])).length === 1);
    const [job] = await t.queue.getJobs(["failed"]);
    expect(job?.attemptsMade).toBe(3);
    expect(job?.failedReason).toBe("STORAGE_UNAVAILABLE");

    const everything = JSON.stringify({
      row: { ...failed, storageKey: "[cheie]" },
      job: job?.failedReason,
      logs: t.logs,
    });
    for (const leak of ["NoSuchBucket", "404", "Scrierea în S3", "ECONN"]) {
      expect(everything).not.toContain(leak);
    }
  });

  it("limita de pixeli se aplică și la procesare: failed IMAGE_TOO_LARGE, fără reîncercări", async () => {
    const t = setup({
      storage: localStorage(),
      settings: { maxInputPixels: 1_000_000 },
      attempts: 5,
    });
    const id = await t.createMedia(1500, 1000); // 1,5 MP > 1 MP
    await enqueueMediaProcessing(t.queue, id);

    await waitFor(async () => (await t.row(id)).status === "failed");
    expect((await t.row(id)).processingError).toBe("IMAGE_TOO_LARGE");
    await waitFor(async () => (await t.queue.getJobs(["failed"])).length === 1);
    const [job] = await t.queue.getJobs(["failed"]);
    expect(job?.attemptsMade).toBe(1);
  });

  it("regenerarea din original: variante noi, cele vechi se scot din storage", async () => {
    const storage = localStorage();
    const t = setup({ storage });
    const id = await t.createMedia();
    await enqueueMediaProcessing(t.queue, id);
    await waitFor(async () => (await t.row(id)).status === "ready");
    const before = ((await t.row(id)).variants as unknown as StoredVariant[]).map((v) => v.key);

    t.setSettings({ thumbWidth: 80, mediumWidth: 240, largeWidth: 480 });
    await requestMediaProcessing(
      { store: createPrismaProcessingStore(db), queue: mediaJobQueue(t.queue) },
      id,
    );
    expect((await t.row(id)).processingError).toBeNull();

    await waitFor(async () => {
      const row = await t.row(id);
      const widths = new Set((row.variants as unknown as StoredVariant[]).map((v) => v.width));
      return row.status === "ready" && widths.has(80) && widths.has(480);
    });
    const after = ((await t.row(id)).variants as unknown as StoredVariant[]).map((v) => v.key);
    expect(after).toHaveLength(9);
    for (const key of after) expect(await storage.stat(key)).not.toBeNull();
    for (const key of before) expect(await storage.stat(key)).toBeNull();
  });

  it("o regenerare cerută cât jobul rulează încă NU se pierde și nu rulează în paralel cu el", async () => {
    const real = localStorage();
    let inFlight = 0;
    let maxInFlight = 0;
    let slow = true;
    // scrierile încetinite țin jobul în starea „active” destul cât să cerem regenerarea
    const slowStorage = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "put") {
          return async (key: string, ...rest: unknown[]) => {
            if (!key.endsWith("original.png")) {
              inFlight += 1;
              maxInFlight = Math.max(maxInFlight, inFlight);
              if (slow) await new Promise((r) => setTimeout(r, 120));
              inFlight -= 1;
            }
            return (target.put as (...a: unknown[]) => Promise<unknown>).call(target, key, ...rest);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const t = setup({ storage: slowStorage, busyDelayMs: 100 });
    const id = await t.createMedia(500, 250);
    await enqueueMediaProcessing(t.queue, id);
    await waitFor(async () => (await t.row(id)).status === "processing");

    // setări noi + cerere de regenerare cât jobul inițial e activ
    t.setSettings({ thumbWidth: 70, mediumWidth: 210, largeWidth: 420 });
    await requestMediaProcessing(
      { store: createPrismaProcessingStore(db), queue: mediaJobQueue(t.queue) },
      id,
    );
    slow = false;

    await waitFor(async () => {
      const row = await t.row(id);
      const widths = new Set((row.variants as unknown as StoredVariant[]).map((v) => v.width));
      return row.status === "ready" && widths.has(70);
    }, 40_000);
    expect(maxInFlight).toBeLessThanOrEqual(1); // niciodată două scrieri ale aceluiași fișier simultan
    const keys = ((await t.row(id)).variants as unknown as StoredVariant[]).map((v) => v.key);
    expect(keys).toHaveLength(9);
    for (const key of keys) expect(await real.stat(key)).not.toBeNull();
  });

  it("un fișier eșuat se poate regenera (jobul vechi eșuat nu blochează), iar un job activ nu se dublează", async () => {
    const t = setup({
      storage: localStorage(),
      settings: { maxInputPixels: 1_000_000 },
      attempts: 1,
    });
    const id = await t.createMedia(1500, 1000);
    await enqueueMediaProcessing(t.queue, id);
    await waitFor(async () => (await t.row(id)).status === "failed");

    // ridicăm limita și reluăm
    t.setSettings({ maxInputPixels: 40_000_000 });
    await requestMediaProcessing(
      { store: createPrismaProcessingStore(db), queue: mediaJobQueue(t.queue) },
      id,
    );
    await waitFor(async () => (await t.row(id)).status === "ready");

    // încă o cerere în timp ce jobul trece prin amânări: nu apar decât cele două joburi permise
    const held = [await t.limiter.tryAcquire(), await t.limiter.tryAcquire()];
    await enqueueMediaProcessing(t.queue, id);
    await enqueueMediaProcessing(t.queue, id);
    await enqueueMediaProcessing(t.queue, id);
    const ids = (await t.queue.getJobs(["delayed", "waiting", "active"])).map((j) => j.id);
    expect(ids.length).toBeLessThanOrEqual(2);
    for (const jobId of ids) expect([`media-${id}`, `media-${id}-rerun`]).toContain(jobId);
    await Promise.all(held.map((l) => l?.release()));
    await waitFor(async () => (await t.row(id)).status === "ready");
  });
});

describe("enqueueMediaProcessing: dedupe (fără worker, Redis real)", () => {
  it("cereri repetate cât jobul așteaptă = un singur job; după ce a fost scos, se poate adăuga din nou", async () => {
    const queueName = `media-test-${randomBytes(4).toString("hex")}`;
    const queue = createMediaQueue(REDIS_URL, { queueName });
    cleanups.push(async () => {
      await queue.obliterate({ force: true });
      await queue.close();
    });
    const id = randomUUID();

    await enqueueMediaProcessing(queue, id);
    await enqueueMediaProcessing(queue, id);
    await enqueueMediaProcessing(queue, id);
    const jobs = await queue.getJobs(["waiting", "delayed", "active", "prioritized"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe(`media-${id}`);
    expect(jobs[0]?.data).toEqual({ mediaId: id }); // în Redis nu e nimic sensibil

    await jobs[0]?.remove();
    await enqueueMediaProcessing(queue, id);
    expect(await queue.getJobs(["waiting"])).toHaveLength(1);
  });
});

describe("procesare pe S3 real (MinIO, bucket de test)", () => {
  const bucket = process.env["S3_BUCKET"];
  assertTestBucket(bucket);

  function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} lipsește: testele cer MinIO pornit și variabilele S3_*.`);
    return value;
  }

  const connection = () => ({
    endpoint: requireEnv("S3_ENDPOINT"),
    region: process.env["S3_REGION"] ?? "us-east-1",
    accessKeyId: requireEnv("S3_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY"),
    forcePathStyle: (process.env["S3_FORCE_PATH_STYLE"] ?? "true") === "true",
  });

  beforeAll(async () => {
    await ensureS3Bucket({ ...connection(), bucket });
  });

  const s3 = (name = bucket) =>
    new S3StorageDriver({ ...connection(), bucket: name, appUrl: "https://magazin.test" });

  it("variantele ajung în bucket cu tipul corect și se pot citi înapoi", async () => {
    const storage = s3();
    const t = setup({ storage });
    const id = await t.createMedia(700, 350);
    await enqueueMediaProcessing(t.queue, id);

    await waitFor(async () => (await t.row(id)).status === "ready", 40_000);
    const row = await t.row(id);
    const variants = row.variants as unknown as StoredVariant[];
    expect(variants).toHaveLength(9);
    for (const v of variants) {
      const { stream, object } = await storage.get(v.key);
      expect(object.contentType).toBe(v.mime);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
      const body = Buffer.concat(chunks);
      expect(body.length).toBe(v.sizeBytes);
      const head = body.subarray(0, 16);
      if (v.format === "jpeg")
        expect(head.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
      if (v.format === "webp") {
        expect(head.subarray(0, 4).toString("ascii")).toBe("RIFF");
        expect(head.subarray(8, 12).toString("ascii")).toBe("WEBP");
      }
      if (v.format === "avif") expect(head.subarray(4, 8).toString("ascii")).toBe("ftyp");
    }
  });

  it("regenerarea pe S3: obiectele vechi dispar din bucket", async () => {
    const storage = s3();
    const t = setup({ storage });
    const id = await t.createMedia(700, 350);
    await enqueueMediaProcessing(t.queue, id);
    await waitFor(async () => (await t.row(id)).status === "ready", 40_000);
    const before = ((await t.row(id)).variants as unknown as StoredVariant[]).map((v) => v.key);

    t.setSettings({ thumbWidth: 90, mediumWidth: 260, largeWidth: 520 });
    await requestMediaProcessing(
      { store: createPrismaProcessingStore(db), queue: mediaJobQueue(t.queue) },
      id,
    );
    await waitFor(async () => {
      const row = await t.row(id);
      return (
        row.status === "ready" &&
        (row.variants as unknown as StoredVariant[]).some((v) => v.width === 90)
      );
    }, 40_000);
    for (const key of before) expect(await storage.stat(key)).toBeNull();
    for (const v of (await t.row(id)).variants as unknown as StoredVariant[]) {
      expect(await storage.stat(v.key)).not.toBeNull();
    }
  });

  it("bucket lipsă (cazul real întâlnit): failed STORAGE_UNAVAILABLE după încercări, fără detalii", async () => {
    const missing = `ecom-test-missing-${randomBytes(4).toString("hex")}`;
    assertTestBucket(missing);
    const good = s3();
    const gone = s3(missing);
    // originalul se află în bucketul bun; scrierea variantelor merge pe bucketul inexistent
    const hybrid = new Proxy(good, {
      get(target, prop, receiver) {
        if (prop === "put") {
          return (key: string, ...rest: unknown[]) =>
            key.endsWith("original.png")
              ? (target.put as (...a: unknown[]) => Promise<unknown>).call(target, key, ...rest)
              : (gone.put as (...a: unknown[]) => Promise<unknown>).call(gone, key, ...rest);
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const t = setup({ storage: hybrid as StorageDriver, attempts: 2 });
    const id = await t.createMedia(400, 200);
    await enqueueMediaProcessing(t.queue, id);

    await waitFor(async () => (await t.row(id)).status === "failed", 40_000);
    const row = await t.row(id);
    expect(row.processingError).toBe("STORAGE_UNAVAILABLE");
    const text = JSON.stringify({ e: row.processingError, logs: t.logs });
    expect(text).not.toContain(missing);
    expect(text).not.toContain("NoSuchBucket");
  });
});

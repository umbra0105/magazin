import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisDecodeLimiter } from "./decode-limiter";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379/1";
let redis: Redis;
const keys: string[] = [];

const newKey = (): string => {
  const key = `ecom:test:decode-slots:${randomBytes(4).toString("hex")}`;
  keys.push(key);
  return key;
};

beforeAll(() => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
});

afterAll(async () => {
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
});

describe("RedisDecodeLimiter (Redis real)", () => {
  it("limita e globală: două instanțe (două procese) împart aceleași 2 locuri", async () => {
    const key = newKey();
    const web = new RedisDecodeLimiter(redis, { key, slots: 2 });
    const worker = new RedisDecodeLimiter(new Redis(REDIS_URL), { key, slots: 2 });

    const a = await web.tryAcquire();
    const b = await worker.tryAcquire();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(await web.tryAcquire()).toBeNull();
    expect(await worker.tryAcquire()).toBeNull();

    await a?.release();
    expect(await worker.tryAcquire()).not.toBeNull();
  });

  it("sub cereri simultane nu se depășește niciodată limita", async () => {
    const key = newKey();
    const limiter = new RedisDecodeLimiter(redis, { key, slots: 2 });
    const attempts = await Promise.all(Array.from({ length: 20 }, () => limiter.tryAcquire()));
    expect(attempts.filter((l) => l !== null)).toHaveLength(2);
  });

  it("release e idempotent și nu eliberează locul altcuiva", async () => {
    const key = newKey();
    const limiter = new RedisDecodeLimiter(redis, { key, slots: 1 });
    const first = await limiter.tryAcquire();
    await first?.release();
    const second = await limiter.tryAcquire();
    expect(second).not.toBeNull();
    await first?.release();
    expect(await limiter.tryAcquire()).toBeNull();
  });

  it("un lease uitat expiră singur (ceasul Redis)", async () => {
    const key = newKey();
    const limiter = new RedisDecodeLimiter(redis, { key, slots: 1, leaseSeconds: 1 });
    expect(await limiter.tryAcquire()).not.toBeNull();
    expect(await limiter.tryAcquire()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(await limiter.tryAcquire()).not.toBeNull();
  });
});

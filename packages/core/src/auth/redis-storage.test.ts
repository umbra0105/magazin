import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { createRedisSecondaryStorage, DEFAULT_AUTH_PREFIX } from "./redis-storage";

/** Un Redis de mână care înregistrează cheile cu care e apelat. */
function recordingRedis() {
  const keys: string[] = [];
  const client = {
    async get(key: string) {
      keys.push(key);
      return null;
    },
    async getdel(key: string) {
      keys.push(key);
      return null;
    },
    async set(key: string) {
      keys.push(key);
      return "OK";
    },
    async del(key: string) {
      keys.push(key);
      return 1;
    },
    async eval(_script: string, _count: number, key: string) {
      keys.push(key);
      return 1;
    },
  };
  return { redis: client as unknown as Redis, keys };
}

async function touchAll(prefix?: string): Promise<string[]> {
  const { redis, keys } = recordingRedis();
  const storage = createRedisSecondaryStorage(redis, prefix);
  await storage.get("a");
  await storage.getAndDelete("b");
  await storage.set("c", "v", 60);
  await storage.set("d", "v");
  await storage.delete("e");
  await storage.increment("f", 30);
  return keys;
}

describe("createRedisSecondaryStorage: prefixul cheilor", () => {
  it("prefixul implicit al producției e «ecom:auth:»", async () => {
    expect(DEFAULT_AUTH_PREFIX).toBe("ecom:auth:");
    expect(await touchAll()).toEqual([
      "ecom:auth:a",
      "ecom:auth:b",
      "ecom:auth:c",
      "ecom:auth:d",
      "ecom:auth:e",
      "ecom:auth:f",
    ]);
  });

  it("un prefix dat se aplică la TOATE operațiile și înlocuiește complet pe cel implicit", async () => {
    const keys = await touchAll("ecom:auth:t-abc:");
    expect(keys).toEqual(["a", "b", "c", "d", "e", "f"].map((k) => `ecom:auth:t-abc:${k}`));
  });
});

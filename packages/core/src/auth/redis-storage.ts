import type { Redis } from "ioredis";

const PREFIX = "ecom:auth:";

/** Interfața `secondaryStorage` din Better Auth: sesiunile se citesc din Redis, sursa rămâne DB. */
export interface AuthSecondaryStorage {
  get(key: string): Promise<string | null>;
  getAndDelete(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  increment(key: string, ttlSeconds?: number): Promise<number>;
}

// Atomic: TTL-ul se pune doar la creare, incrementările ulterioare nu-l prelungesc.
const INCREMENT_SCRIPT = `
local v = redis.call('INCR', KEYS[1])
if v == 1 and tonumber(ARGV[1]) > 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return v`;

export function createRedisSecondaryStorage(redis: Redis): AuthSecondaryStorage {
  return {
    get: (key) => redis.get(PREFIX + key),
    getAndDelete: (key) => redis.getdel(PREFIX + key),
    async set(key, value, ttlSeconds) {
      if (ttlSeconds && ttlSeconds > 0) await redis.set(PREFIX + key, value, "EX", ttlSeconds);
      else await redis.set(PREFIX + key, value);
    },
    async delete(key) {
      await redis.del(PREFIX + key);
    },
    async increment(key, ttlSeconds) {
      return Number(await redis.eval(INCREMENT_SCRIPT, 1, PREFIX + key, ttlSeconds ?? 0));
    },
  };
}

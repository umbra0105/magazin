import type { KeyValueCache } from "../cache/read-through";

/** Cache în memorie pentru teste unitare; ține minte TTL-ul cu care s-a scris fiecare cheie. */
export function createFakeCache() {
  const data = new Map<string, string>();
  const ttls = new Map<string, number>();
  const cache: KeyValueCache = {
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value, _mode, seconds) {
      data.set(key, value);
      ttls.set(key, seconds);
      return "OK";
    },
    async del(key) {
      ttls.delete(key);
      return data.delete(key) ? 1 : 0;
    },
  };
  return { cache, data, ttls };
}

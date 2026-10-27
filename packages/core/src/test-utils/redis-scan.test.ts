import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { deleteByScan, MGET_BATCH, mgetAll, scanKeys } from "./redis-scan";

/**
 * Un Redis de mână: SCAN pe pagini mici (cu cursor), `mget` și `unlink` cu evidența dimensiunii loturilor. Nu are `keys`:
 * orice citire prin `KEYS` ar arunca (regula: SCAN, ca să nu blocheze Redis și să nu depindă de numărul total de chei).
 */
function fakeRedis(initial: Record<string, string>, pageSize = 100, duplicatePages = false) {
  const store = new Map(Object.entries(initial));
  const calls = {
    scans: 0,
    mgets: [] as number[],
    unlinks: [] as number[],
    matches: [] as string[],
  };
  const matches = (pattern: string, key: string) =>
    pattern.endsWith("*") ? key.startsWith(pattern.slice(0, -1)) : key === pattern;
  const client = {
    async scan(cursor: string, _match: "MATCH", pattern: string) {
      calls.scans++;
      calls.matches.push(pattern);
      const all = [...store.keys()];
      const start = Number(cursor);
      const page = all.slice(start, start + pageSize);
      const next = start + pageSize >= all.length ? "0" : String(start + pageSize);
      const found = page.filter((k) => matches(pattern, k));
      // SCAN poate întoarce aceeași cheie de mai multe ori
      return [
        next,
        duplicatePages && found.length > 0 ? [...found, found[0] as string] : found,
      ] as [string, string[]];
    },
    async mget(...keys: string[]) {
      calls.mgets.push(keys.length);
      return keys.map((k) => store.get(k) ?? null);
    },
    async unlink(...keys: string[]) {
      calls.unlinks.push(keys.length);
      let removed = 0;
      for (const k of keys) if (store.delete(k)) removed++;
      return removed;
    },
  };
  return { redis: client as unknown as Redis, store, calls };
}

const many = (prefix: string, count: number): Record<string, string> =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i}`, `v${i}`]));

describe("scanKeys", () => {
  it("adună cheile de pe toate paginile SCAN, doar cele care se potrivesc", async () => {
    const { redis, calls } = fakeRedis({ ...many("a:", 250), ...many("b:", 130) });
    const keys = await scanKeys(redis, "a:*");
    expect(keys).toHaveLength(250);
    expect(keys.every((k) => k.startsWith("a:"))).toBe(true);
    expect(calls.scans).toBeGreaterThan(3);
    expect(new Set(calls.matches)).toEqual(new Set(["a:*"]));
  });

  it("elimină dublurile (SCAN poate întoarce aceeași cheie de două ori)", async () => {
    const { redis } = fakeRedis(many("a:", 220), 100, true);
    const keys = await scanKeys(redis, "a:*");
    expect(keys).toHaveLength(220);
    expect(new Set(keys).size).toBe(220);
  });

  it("niciun rezultat: listă goală", async () => {
    const { redis } = fakeRedis(many("b:", 10));
    expect(await scanKeys(redis, "a:*")).toEqual([]);
  });
});

describe("mgetAll", () => {
  it("citește în loturi de MGET_BATCH și păstrează ordinea și valorile lipsă (null)", async () => {
    const data = many("k:", MGET_BATCH * 2 + 1);
    const { redis, calls } = fakeRedis(data);
    const keys = [...Object.keys(data), "k:lipsa"];
    const values = await mgetAll(redis, keys);
    expect(calls.mgets).toEqual([MGET_BATCH, MGET_BATCH, 2]);
    expect(values).toHaveLength(keys.length);
    expect(values[0]).toBe("v0");
    expect(values[MGET_BATCH * 2]).toBe(`v${MGET_BATCH * 2}`);
    expect(values[keys.length - 1]).toBeNull();
  });

  it("fără chei: nicio cerere", async () => {
    const { redis, calls } = fakeRedis({});
    expect(await mgetAll(redis, [])).toEqual([]);
    expect(calls.mgets).toEqual([]);
  });
});

describe("deleteByScan", () => {
  it("șterge doar cheile potrivite, în loturi, și întoarce câte au fost", async () => {
    const { redis, store, calls } = fakeRedis({
      ...many("t:", MGET_BATCH + 40),
      ...many("alta:", 30),
    });
    const removed = await deleteByScan(redis, "t:*");
    expect(removed).toBe(MGET_BATCH + 40);
    expect([...store.keys()].every((k) => k.startsWith("alta:"))).toBe(true);
    expect(store.size).toBe(30);
    expect(calls.unlinks.every((n) => n <= MGET_BATCH)).toBe(true);
  });

  it("nimic de șters: 0 și nicio cerere de ștergere", async () => {
    const { redis, calls } = fakeRedis(many("alta:", 5));
    expect(await deleteByScan(redis, "t:*")).toBe(0);
    expect(calls.unlinks).toEqual([]);
  });
});

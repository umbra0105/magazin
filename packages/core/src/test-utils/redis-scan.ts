import type { Redis } from "ioredis";

/**
 * Citiri și ștergeri în masă pe Redis pentru teste: SCAN (nu KEYS) și loturi (MGET / UNLINK), ca numărul de chei
 * din index să nu însemne câte o călătorie de rețea pe cheie (incidentul `auth-email`: 41.761 de `GET`-uri în serie).
 */

/** Câte chei intră într-un MGET / UNLINK. */
export const MGET_BATCH = 500;

/** Cheile care se potrivesc cu `pattern`, fără dubluri (SCAN poate întoarce aceeași cheie de mai multe ori). */
export async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const found = new Set<string>();
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", MGET_BATCH);
    cursor = next;
    for (const key of keys) found.add(key);
  } while (cursor !== "0");
  return [...found];
}

/** Valorile cheilor, în aceeași ordine (`null` pentru o cheie dispărută între timp), citite în loturi. */
export async function mgetAll(redis: Redis, keys: readonly string[]): Promise<(string | null)[]> {
  const values: (string | null)[] = [];
  for (let start = 0; start < keys.length; start += MGET_BATCH) {
    values.push(...(await redis.mget(...keys.slice(start, start + MGET_BATCH))));
  }
  return values;
}

/** Șterge (UNLINK, în loturi) cheile care se potrivesc cu `pattern`; întoarce câte au fost șterse. */
export async function deleteByScan(redis: Redis, pattern: string): Promise<number> {
  const keys = await scanKeys(redis, pattern);
  let removed = 0;
  for (let start = 0; start < keys.length; start += MGET_BATCH) {
    removed += await redis.unlink(...keys.slice(start, start + MGET_BATCH));
  }
  return removed;
}

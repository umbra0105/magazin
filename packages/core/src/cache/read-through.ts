import { getLogger } from "@ecom/shared";

/** Ce îi trebuie de la Redis (satisfăcut de ioredis). */
export interface KeyValueCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface ReadThroughOptions<T> {
  cache: KeyValueCache;
  key: string;
  ttlSeconds: number;
  /** Numele cache-ului, doar pentru mesajele din loguri. */
  label: string;
  load: () => Promise<T>;
}

/**
 * Citește din Redis; la lipsă sau când Redis e picat, citește din sursă (DB) și încearcă să
 * repopuleze cache-ul. O eroare de Redis nu ajunge niciodată la apelant.
 */
export async function readThrough<T>({
  cache,
  key,
  ttlSeconds,
  label,
  load,
}: ReadThroughOptions<T>): Promise<T> {
  try {
    const cached = await cache.get(key);
    if (cached) return JSON.parse(cached) as T;
  } catch (error) {
    getLogger().warn({ err: error }, `citirea cache-ului de ${label} a eșuat, citesc din DB`);
  }
  const value = await load();
  try {
    await cache.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch (error) {
    getLogger().warn({ err: error }, `scrierea cache-ului de ${label} a eșuat`);
  }
  return value;
}

/** Invalidează cheia; eroarea de Redis se loghează, nu se propagă (TTL-ul scurt acoperă restul). */
export async function invalidateCache(
  cache: KeyValueCache,
  key: string,
  label: string,
): Promise<void> {
  try {
    await cache.del(key);
  } catch (error) {
    getLogger().warn({ err: error }, `invalidarea cache-ului de ${label} a eșuat`);
  }
}

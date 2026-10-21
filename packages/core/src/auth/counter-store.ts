import type { Redis } from "ioredis";

/** Contoare cu expirare, pentru limite de cereri și blocări. Cheile sunt opace pentru depozit. */
export interface CounterStore {
  /** +1 pe fereastră fixă: TTL-ul se pune la prima creștere și nu se prelungește. */
  increment(key: string, ttlSeconds: number): Promise<{ count: number; ttlSeconds: number }>;
  /** Pune un marcaj cu expirare (ex. cont blocat). */
  set(key: string, ttlSeconds: number): Promise<void>;
  /** Secundele rămase până la expirare; 0 dacă cheia nu există. */
  ttl(key: string): Promise<number>;
  delete(...keys: string[]): Promise<void>;
  /** Șterge toate cheile care încep cu `prefix` (rar: deblocarea unui cont, fără a cunoaște adresele IP). */
  deleteByPrefix(prefix: string): Promise<void>;
}

export class MemoryCounterStore implements CounterStore {
  private readonly entries = new Map<string, { count: number; expiresAt: number }>();
  private static readonly MAX_ENTRIES = 50_000;

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string) {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private prune(): void {
    if (this.entries.size < MemoryCounterStore.MAX_ENTRIES) return;
    for (const key of [...this.entries.keys()]) this.live(key);
    // Încă plin (atac cu chei unice): scoatem cele mai vechi, ca memoria să rămână mărginită.
    for (const key of this.entries.keys()) {
      if (this.entries.size < MemoryCounterStore.MAX_ENTRIES) break;
      this.entries.delete(key);
    }
  }

  private remaining(expiresAt: number): number {
    return Math.max(1, Math.ceil((expiresAt - this.now()) / 1000));
  }

  async increment(key: string, ttlSeconds: number) {
    const entry = this.live(key);
    if (entry) {
      entry.count += 1;
      return { count: entry.count, ttlSeconds: this.remaining(entry.expiresAt) };
    }
    this.prune();
    const expiresAt = this.now() + ttlSeconds * 1000;
    this.entries.set(key, { count: 1, expiresAt });
    return { count: 1, ttlSeconds };
  }

  async set(key: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { count: 1, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async ttl(key: string): Promise<number> {
    const entry = this.live(key);
    return entry ? this.remaining(entry.expiresAt) : 0;
  }

  async delete(...keys: string[]): Promise<void> {
    for (const key of keys) this.entries.delete(key);
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    for (const key of [...this.entries.keys()])
      if (key.startsWith(prefix)) this.entries.delete(key);
  }
}

const PREFIX = "ecom:rl:";

const INCREMENT_SCRIPT = `
local v = redis.call('INCR', KEYS[1])
if v == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return {v, redis.call('TTL', KEYS[1])}`;

export class RedisCounterStore implements CounterStore {
  constructor(private readonly redis: Redis) {}

  async increment(key: string, ttlSeconds: number) {
    const [count, ttl] = (await this.redis.eval(INCREMENT_SCRIPT, 1, PREFIX + key, ttlSeconds)) as [
      number,
      number,
    ];
    return { count, ttlSeconds: Math.max(1, ttl) };
  }

  async set(key: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(PREFIX + key, "1", "EX", ttlSeconds);
  }

  async ttl(key: string): Promise<number> {
    return Math.max(0, await this.redis.ttl(PREFIX + key));
  }

  async delete(...keys: string[]): Promise<void> {
    if (keys.length > 0) await this.redis.del(...keys.map((k) => PREFIX + k));
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    // SCAN (nu KEYS): nu blochează Redis; prefixul nu conține caractere speciale de glob (chei generate de aplicație)
    let cursor = "0";
    do {
      const [next, found] = await this.redis.scan(
        cursor,
        "MATCH",
        `${PREFIX}${prefix}*`,
        "COUNT",
        500,
      );
      cursor = next;
      if (found.length > 0) await this.redis.del(...found);
    } while (cursor !== "0");
  }
}

export interface ResilientLogger {
  warn(obj: object, msg: string): void;
}

/**
 * Redis ca sursă principală; dacă nu răspunde (eroare sau depășirea timpului) se folosește un depozit
 * în memoria procesului, cu aceleași limite (fail-closed: limitarea nu dispare când pică Redis).
 * Marcajele de blocare se scriu în ambele locuri și se citesc din ambele, deci o blocare pusă cât
 * Redis era căzut (sau înainte) nu se pierde în același proces. Avertismentul în log e limitat
 * la unul pe minut.
 */
export class ResilientCounterStore implements CounterStore {
  private lastWarnAt = 0;

  constructor(
    private readonly primary: CounterStore,
    private readonly fallback: CounterStore,
    private readonly logger: ResilientLogger,
    private readonly timeoutMs = 300,
    private readonly now: () => number = Date.now,
  ) {}

  private async tryPrimary<T>(
    op: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const value = await Promise.race([
        op(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout Redis")), this.timeoutMs);
        }),
      ]);
      return { ok: true, value };
    } catch (error) {
      if (this.now() - this.lastWarnAt >= 60_000) {
        this.lastWarnAt = this.now();
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "Redis indisponibil: rate limiting și blocările folosesc memoria procesului (limite per proces)",
        );
      }
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async increment(key: string, ttlSeconds: number) {
    const r = await this.tryPrimary(() => this.primary.increment(key, ttlSeconds));
    return r.ok ? r.value : this.fallback.increment(key, ttlSeconds);
  }

  async set(key: string, ttlSeconds: number): Promise<void> {
    await this.fallback.set(key, ttlSeconds);
    await this.tryPrimary(() => this.primary.set(key, ttlSeconds));
  }

  async ttl(key: string): Promise<number> {
    const [local, remote] = await Promise.all([
      this.fallback.ttl(key),
      this.tryPrimary(() => this.primary.ttl(key)),
    ]);
    return Math.max(local, remote.ok ? remote.value : 0);
  }

  async delete(...keys: string[]): Promise<void> {
    await this.fallback.delete(...keys);
    await this.tryPrimary(() => this.primary.delete(...keys));
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    await this.fallback.deleteByPrefix(prefix);
    await this.tryPrimary(() => this.primary.deleteByPrefix(prefix));
  }
}

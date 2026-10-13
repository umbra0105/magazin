import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

/** Un loc ocupat într-o limitare de concurență. `release` e idempotent. */
export interface DecodeLease {
  release(): Promise<void>;
}

/**
 * Limită GLOBALĂ de decodări/codificări de imagini simultane (implicit 2): o imagine de 40 MP
 * ocupă ~160 MB RAM în timpul decodării, iar aplicația și workerul rulează în procese diferite.
 * `tryAcquire` nu așteaptă: întoarce `null` când nu mai e loc, iar apelantul decide (upload: 503
 * cu Retry-After; worker: jobul se amână în queue).
 */
export interface DecodeLimiter {
  tryAcquire(): Promise<DecodeLease | null>;
}

export const DEFAULT_DECODE_SLOTS = 2;
/** Un lease uitat (proces mort) expiră singur după acest timp; mai mare decât orice decodare reală. */
export const DEFAULT_LEASE_SECONDS = 120;

export interface LimiterOptions {
  slots?: number;
  leaseSeconds?: number;
}

/** În memoria procesului: limită per proces. Folosit în teste și ca rezervă când Redis cade. */
export class MemoryDecodeLimiter implements DecodeLimiter {
  private readonly leases = new Map<string, number>();
  private readonly slots: number;
  private readonly leaseMs: number;

  constructor(
    options: LimiterOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    this.slots = options.slots ?? DEFAULT_DECODE_SLOTS;
    this.leaseMs = (options.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1000;
  }

  async tryAcquire(): Promise<DecodeLease | null> {
    const now = this.now();
    for (const [token, expiresAt] of this.leases) {
      if (expiresAt <= now) this.leases.delete(token);
    }
    if (this.leases.size >= this.slots) return null;
    const token = randomUUID();
    this.leases.set(token, now + this.leaseMs);
    return { release: async () => void this.leases.delete(token) };
  }
}

const ACQUIRE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[1]) then
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[3])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) + 1000)
  return 1
end
return 0`;

/**
 * Semafor în Redis: un ZSET de lease-uri cu expirare (ceasul e al serverului Redis, deci
 * identic pentru toate procesele). Atomic printr-un script Lua.
 */
export class RedisDecodeLimiter implements DecodeLimiter {
  private readonly slots: number;
  private readonly leaseMs: number;

  constructor(
    private readonly redis: Redis,
    options: LimiterOptions & { key?: string } = {},
  ) {
    this.slots = options.slots ?? DEFAULT_DECODE_SLOTS;
    this.leaseMs = (options.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1000;
    this.key = options.key ?? "ecom:media:decode-slots";
  }

  private readonly key: string;

  async tryAcquire(): Promise<DecodeLease | null> {
    const token = randomUUID();
    const granted = await this.redis.eval(
      ACQUIRE,
      1,
      this.key,
      String(this.slots),
      String(this.leaseMs),
      token,
    );
    if (granted !== 1) return null;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        // Dacă Redis nu răspunde, lease-ul expiră singur.
        await this.redis.zrem(this.key, token).catch(() => undefined);
      },
    };
  }
}

export interface LimiterLogger {
  warn(obj: object, msg: string): void;
}

/**
 * Redis ca sursă principală; dacă nu răspunde, limita rămâne în memoria procesului (fail-closed:
 * limitarea nu dispare când pică Redis, doar devine per proces).
 */
export class ResilientDecodeLimiter implements DecodeLimiter {
  private lastWarnAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly primary: DecodeLimiter,
    private readonly fallback: DecodeLimiter,
    private readonly logger: LimiterLogger,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = 500,
  ) {}

  async tryAcquire(): Promise<DecodeLease | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.primary.tryAcquire(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout Redis")), this.timeoutMs);
        }),
      ]);
    } catch (error) {
      if (this.now() - this.lastWarnAt >= 60_000) {
        this.lastWarnAt = this.now();
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "Redis indisponibil: limita de decodări de imagini e doar per proces",
        );
      }
      return this.fallback.tryAcquire();
    } finally {
      clearTimeout(timer);
    }
  }
}

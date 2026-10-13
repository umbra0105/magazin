import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

export interface MediaLockHandle {
  release(): Promise<void>;
}

/**
 * Excludere mutuală per fișier: două joburi (ex. procesarea inițială și o regenerare cerută cât
 * rulează ea) nu trebuie să scrie variantele aceluiași fișier în același timp. `tryLock` nu
 * așteaptă: dacă fișierul e luat, apelantul amână jobul (fără să consume o încercare).
 */
export interface MediaLock {
  tryLock(mediaId: string): Promise<MediaLockHandle | null>;
}

/** Un lock uitat (proces mort) expiră singur după acest timp. */
export const DEFAULT_LOCK_SECONDS = 10 * 60;

export class MemoryMediaLock implements MediaLock {
  private readonly held = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly lockSeconds = DEFAULT_LOCK_SECONDS,
    private readonly now: () => number = Date.now,
  ) {}

  async tryLock(mediaId: string): Promise<MediaLockHandle | null> {
    const current = this.held.get(mediaId);
    if (current && current.expiresAt > this.now()) return null;
    const token = randomUUID();
    this.held.set(mediaId, { token, expiresAt: this.now() + this.lockSeconds * 1000 });
    return {
      release: async () => {
        if (this.held.get(mediaId)?.token === token) this.held.delete(mediaId);
      },
    };
  }
}

const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

/** Lock în Redis (`SET NX PX`), eliberat doar de cine l-a luat (compară tokenul). */
export class RedisMediaLock implements MediaLock {
  constructor(
    private readonly redis: Redis,
    private readonly options: { lockSeconds?: number; prefix?: string } = {},
  ) {}

  async tryLock(mediaId: string): Promise<MediaLockHandle | null> {
    const key = `${this.options.prefix ?? "ecom:media:lock:"}${mediaId}`;
    const token = randomUUID();
    const ttlMs = (this.options.lockSeconds ?? DEFAULT_LOCK_SECONDS) * 1000;
    const ok = await this.redis.set(key, token, "PX", ttlMs, "NX");
    if (ok !== "OK") return null;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await this.redis.eval(RELEASE, 1, key, token).catch(() => undefined);
      },
    };
  }
}

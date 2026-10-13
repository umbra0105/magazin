import { describe, expect, it } from "vitest";
import {
  MemoryDecodeLimiter,
  ResilientDecodeLimiter,
  type DecodeLease,
  type DecodeLimiter,
} from "./decode-limiter";

describe("MemoryDecodeLimiter", () => {
  it("dă cel mult 2 locuri simultan; al treilea primește null", async () => {
    const limiter = new MemoryDecodeLimiter({ slots: 2 });
    const a = await limiter.tryAcquire();
    const b = await limiter.tryAcquire();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(await limiter.tryAcquire()).toBeNull();
  });

  it("eliberarea unui loc îl face disponibil", async () => {
    const limiter = new MemoryDecodeLimiter({ slots: 1 });
    const lease = await limiter.tryAcquire();
    expect(await limiter.tryAcquire()).toBeNull();
    await lease?.release();
    expect(await limiter.tryAcquire()).not.toBeNull();
  });

  it("release e idempotent: a doua eliberare nu eliberează locul altcuiva", async () => {
    const limiter = new MemoryDecodeLimiter({ slots: 1 });
    const first = (await limiter.tryAcquire()) as DecodeLease;
    await first.release();
    const second = await limiter.tryAcquire();
    expect(second).not.toBeNull();
    await first.release(); // a doua oară, pe lease-ul vechi
    expect(await limiter.tryAcquire()).toBeNull(); // locul celui de-al doilea e încă ocupat
  });

  it("un lease uitat expiră singur (proces mort sau bug)", async () => {
    let now = 1_000_000;
    const limiter = new MemoryDecodeLimiter({ slots: 1, leaseSeconds: 60 }, () => now);
    expect(await limiter.tryAcquire()).not.toBeNull();
    expect(await limiter.tryAcquire()).toBeNull();
    now += 59_000;
    expect(await limiter.tryAcquire()).toBeNull();
    now += 2_000;
    expect(await limiter.tryAcquire()).not.toBeNull();
  });

  it("implicit are 2 locuri", async () => {
    const limiter = new MemoryDecodeLimiter();
    expect(await limiter.tryAcquire()).not.toBeNull();
    expect(await limiter.tryAcquire()).not.toBeNull();
    expect(await limiter.tryAcquire()).toBeNull();
  });
});

describe("ResilientDecodeLimiter", () => {
  const logs: object[] = [];
  const logger = { warn: (o: object) => void logs.push(o) };

  it("folosește principalul când răspunde", async () => {
    const primary = new MemoryDecodeLimiter({ slots: 1 });
    const fallback = new MemoryDecodeLimiter({ slots: 5 });
    const limiter = new ResilientDecodeLimiter(primary, fallback, logger);
    expect(await limiter.tryAcquire()).not.toBeNull();
    expect(await limiter.tryAcquire()).toBeNull(); // limita principalului, nu a rezervei
  });

  it("cade pe memorie când principalul aruncă, cu un singur avertisment pe minut", async () => {
    logs.length = 0;
    let now = 0;
    const broken: DecodeLimiter = {
      tryAcquire: async () => {
        throw new Error("Redis căzut");
      },
    };
    const fallback = new MemoryDecodeLimiter({ slots: 2 });
    const limiter = new ResilientDecodeLimiter(broken, fallback, logger, () => now);
    expect(await limiter.tryAcquire()).not.toBeNull();
    expect(await limiter.tryAcquire()).not.toBeNull();
    expect(await limiter.tryAcquire()).toBeNull(); // fail-closed: limita nu dispare
    expect(logs).toHaveLength(1);
    now += 61_000;
    await limiter.tryAcquire();
    expect(logs).toHaveLength(2);
  });

  it("cade pe memorie și când principalul nu răspunde (timeout)", async () => {
    const hanging: DecodeLimiter = { tryAcquire: () => new Promise(() => undefined) };
    const limiter = new ResilientDecodeLimiter(
      hanging,
      new MemoryDecodeLimiter({ slots: 1 }),
      logger,
      Date.now,
      30,
    );
    expect(await limiter.tryAcquire()).not.toBeNull();
    expect(await limiter.tryAcquire()).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { MemoryMediaLock } from "./media-lock";

describe("MemoryMediaLock", () => {
  it("un singur titular per fișier; fișiere diferite nu se blochează între ele", async () => {
    const lock = new MemoryMediaLock();
    const a = await lock.tryLock("a");
    expect(a).not.toBeNull();
    expect(await lock.tryLock("a")).toBeNull();
    expect(await lock.tryLock("b")).not.toBeNull();
    await a?.release();
    expect(await lock.tryLock("a")).not.toBeNull();
  });

  it("release e idempotent și nu eliberează lock-ul altcuiva", async () => {
    const lock = new MemoryMediaLock();
    const first = await lock.tryLock("a");
    await first?.release();
    const second = await lock.tryLock("a");
    expect(second).not.toBeNull();
    await first?.release();
    expect(await lock.tryLock("a")).toBeNull();
  });

  it("un lock uitat expiră singur", async () => {
    let now = 0;
    const lock = new MemoryMediaLock(60, () => now);
    expect(await lock.tryLock("a")).not.toBeNull();
    now = 59_000;
    expect(await lock.tryLock("a")).toBeNull();
    now = 61_000;
    expect(await lock.tryLock("a")).not.toBeNull();
  });
});

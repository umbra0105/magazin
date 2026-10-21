import { describe, expect, it, vi } from "vitest";
import {
  MemoryCounterStore,
  ResilientCounterStore,
  type CounterStore,
  type ResilientLogger,
} from "./counter-store";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("MemoryCounterStore", () => {
  it("numără pe fereastră fixă: TTL-ul nu se prelungește la fiecare creștere", async () => {
    const c = clock();
    const s = new MemoryCounterStore(c.now);
    expect((await s.increment("k", 60)).count).toBe(1);
    c.advance(40_000);
    const second = await s.increment("k", 60);
    expect(second.count).toBe(2);
    expect(second.ttlSeconds).toBe(20);
    c.advance(21_000);
    expect((await s.increment("k", 60)).count).toBe(1); // fereastra nouă
  });

  it("set/ttl/delete", async () => {
    const c = clock();
    const s = new MemoryCounterStore(c.now);
    expect(await s.ttl("lock")).toBe(0);
    await s.set("lock", 900);
    expect(await s.ttl("lock")).toBe(900);
    c.advance(901_000);
    expect(await s.ttl("lock")).toBe(0);
    await s.set("a", 10);
    await s.delete("a", "inexistent");
    expect(await s.ttl("a")).toBe(0);
  });
});

const down = () => Promise.reject(new Error("ECONNREFUSED"));
const deadPrimary = (): CounterStore => ({
  increment: down,
  set: down,
  ttl: down,
  delete: down,
  deleteByPrefix: down,
});

const logger = () => ({ warn: vi.fn() }) satisfies ResilientLogger;

describe("ResilientCounterStore", () => {
  it("cu Redis căzut numără în memorie (limita nu dispare) și avertizează cel mult o dată pe minut", async () => {
    const log = logger();
    const c = clock();
    const s = new ResilientCounterStore(
      deadPrimary(),
      new MemoryCounterStore(c.now),
      log,
      50,
      c.now,
    );
    expect((await s.increment("k", 60)).count).toBe(1);
    expect((await s.increment("k", 60)).count).toBe(2);
    expect((await s.increment("k", 60)).count).toBe(3);
    expect(log.warn).toHaveBeenCalledTimes(1);
    c.advance(61_000);
    await s.increment("k", 60);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("un Redis care nu răspunde deloc e tratat ca eroare după timeout", async () => {
    const hanging: CounterStore = {
      ...deadPrimary(),
      increment: () => new Promise(() => undefined),
    };
    const s = new ResilientCounterStore(hanging, new MemoryCounterStore(), logger(), 20);
    expect((await s.increment("k", 60)).count).toBe(1);
  });

  it("blocarea pusă cât Redis era sănătos rămâne vizibilă dacă Redis cade după aceea", async () => {
    const memory = new MemoryCounterStore();
    const healthy = new ResilientCounterStore(new MemoryCounterStore(), memory, logger(), 50);
    await healthy.set("lock:x", 900);
    const broken = new ResilientCounterStore(deadPrimary(), memory, logger(), 50);
    expect(await broken.ttl("lock:x")).toBeGreaterThan(0);
  });

  it("blocarea pusă cât Redis era căzut rămâne după ce Redis revine", async () => {
    const real = new MemoryCounterStore();
    let up = false;
    const guarded =
      <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
      (...a: A) =>
        up ? fn(...a) : down();
    const flaky: CounterStore = {
      increment: guarded((k: string, t: number) => real.increment(k, t)),
      set: guarded((k: string, t: number) => real.set(k, t)),
      ttl: guarded((k: string) => real.ttl(k)),
      delete: guarded((...k: string[]) => real.delete(...k)),
      deleteByPrefix: guarded((p: string) => real.deleteByPrefix(p)),
    };
    const s = new ResilientCounterStore(flaky, new MemoryCounterStore(), logger(), 50);
    await s.set("lock:y", 900); // Redis căzut
    up = true; // Redis revine, fără blocarea în el
    expect(await s.ttl("lock:y")).toBeGreaterThan(0);
  });

  it("delete scoate cheia din ambele locuri", async () => {
    const s = new ResilientCounterStore(
      new MemoryCounterStore(),
      new MemoryCounterStore(),
      logger(),
      50,
    );
    await s.set("lock:z", 900);
    await s.delete("lock:z");
    expect(await s.ttl("lock:z")).toBe(0);
  });
});

describe("deleteByPrefix (admin:unlock fără a cunoaște adresele IP)", () => {
  it("MemoryCounterStore șterge doar cheile cu prefixul dat", async () => {
    const s = new MemoryCounterStore();
    await s.increment("lfail:pair:abc:1.1.1.1", 60);
    await s.set("lock:pair:abc:2.2.2.2", 60);
    await s.set("lock:pair:abd:2.2.2.2", 60);
    await s.deleteByPrefix("lock:pair:abc:");
    await s.deleteByPrefix("lfail:pair:abc:");
    expect(await s.ttl("lock:pair:abc:2.2.2.2")).toBe(0);
    expect(await s.ttl("lfail:pair:abc:1.1.1.1")).toBe(0);
    expect(await s.ttl("lock:pair:abd:2.2.2.2")).toBeGreaterThan(0);
  });

  it("ResilientCounterStore o trimite și către memoria procesului, chiar dacă Redis nu răspunde", async () => {
    const memory = new MemoryCounterStore();
    await memory.set("lock:x:1", 60);
    const broken: CounterStore = {
      increment: async () => {
        throw new Error("jos");
      },
      set: async () => {
        throw new Error("jos");
      },
      ttl: async () => {
        throw new Error("jos");
      },
      delete: async () => {
        throw new Error("jos");
      },
      deleteByPrefix: async () => {
        throw new Error("jos");
      },
    };
    const resilient = new ResilientCounterStore(broken, memory, { warn: vi.fn() }, 50);
    await resilient.deleteByPrefix("lock:x:");
    expect(await memory.ttl("lock:x:1")).toBe(0);
  });
});

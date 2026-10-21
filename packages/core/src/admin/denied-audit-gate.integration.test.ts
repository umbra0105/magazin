import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { RedisCounterStore } from "../auth/counter-store";
import { DeniedAuditGate } from "./denied-audit-gate";

/**
 * Blocul C, C-08, pe Redis real: fiecare server action refuzat (inclusiv anonim, cu un cookie fals) scria un rând în
 * `audit_log`, tabelă care nu se poate șterge. Poarta lasă să intre un număr mărginit de rânduri pe fereastră, apoi
 * UN rând-sumar, apoi nimic; refuzul în sine (eroarea către apelant) nu se schimbă.
 */

const redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
afterAll(() => redis.disconnect());
const RUN = randomBytes(4).toString("hex");
const store = () => new RedisCounterStore(redis);

describe("DeniedAuditGate (Redis real)", () => {
  it("primele N refuzuri ale aceluiași actor se înregistrează, apoi un sumar, apoi nimic", async () => {
    const gate = new DeniedAuditGate(store(), {
      perActor: 3,
      perIp: 100,
      windowSeconds: 60,
      namespace: `t1-${RUN}`,
    });
    const decisions: string[] = [];
    for (let i = 0; i < 7; i++)
      decisions.push(await gate.decide({ actorId: "u1", ip: "203.0.113.5" }));
    expect(decisions).toEqual(["record", "record", "record", "summary", "skip", "skip", "skip"]);
  });

  it("alt actor de pe aceeași adresă are propriul buget, dar adresa are un plafon total", async () => {
    const gate = new DeniedAuditGate(store(), {
      perActor: 3,
      perIp: 5,
      windowSeconds: 60,
      namespace: `t2-${RUN}`,
    });
    const out: string[] = [];
    for (const actor of ["a", "b", "c"]) {
      for (let i = 0; i < 2; i++)
        out.push(await gate.decide({ actorId: actor, ip: "203.0.113.6" }));
    }
    // 6 încercări de pe aceeași adresă, plafon 5: a 6-a e sumarul adresei
    expect(out.slice(0, 5)).toEqual(["record", "record", "record", "record", "record"]);
    expect(out[5]).toBe("summary");
  });

  it("anonimii fără adresă de încredere împart un coș global cu plafon mai larg", async () => {
    const gate = new DeniedAuditGate(store(), {
      perActor: 2,
      perIp: 2,
      windowSeconds: 60,
      namespace: `t3-${RUN}`,
    });
    const out: string[] = [];
    for (let i = 0; i < 25; i++) out.push(await gate.decide({ actorId: null, ip: null }));
    expect(out.filter((d) => d === "record").length).toBe(20); // 2 × 10 (coș global)
    expect(out.filter((d) => d === "summary")).toHaveLength(1);
  });

  it("fereastra expiră: după ea se înregistrează din nou", async () => {
    const gate = new DeniedAuditGate(store(), {
      perActor: 1,
      perIp: 100,
      windowSeconds: 1,
      namespace: `t4-${RUN}`,
    });
    expect(await gate.decide({ actorId: "u", ip: "203.0.113.7" })).toBe("record");
    expect(await gate.decide({ actorId: "u", ip: "203.0.113.7" })).toBe("summary");
    await new Promise((r) => setTimeout(r, 1_300));
    expect(await gate.decide({ actorId: "u", ip: "203.0.113.7" })).toBe("record");
  });

  it("un depozit de contoare căzut nu pierde auditul: decizia e «record»", async () => {
    const broken = {
      increment: async () => {
        throw new Error("redis căzut");
      },
      set: async () => undefined,
      ttl: async () => 0,
      delete: async () => undefined,
      deleteByPrefix: async () => undefined,
    };
    const gate = new DeniedAuditGate(broken, {
      perActor: 1,
      perIp: 1,
      windowSeconds: 60,
      namespace: "x",
    });
    expect(await gate.decide({ actorId: "u", ip: "1.2.3.4" })).toBe("record");
  });
});

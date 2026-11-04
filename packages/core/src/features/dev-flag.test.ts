import { describe, expect, it } from "vitest";
import { DomainError, ValidationError } from "@ecom/shared";
import type { AuditRow, AuditStore } from "../audit/audit-service";
import type { FeatureFlagStore } from "./feature-flag-service";
import { FEATURE_FLAGS_CACHE_KEY } from "./feature-flag-service";
import {
  DEV_FLAG_ACTOR,
  assertDevFlagEnvironment,
  createQuietCache,
  formatDevFlagResult,
  parseDevFlagArgs,
  runDevFlag,
} from "./dev-flag";
import { FEATURE_KEYS } from "./registry";

const LOCAL_ENV = {
  DATABASE_URL: "postgresql://ecom:parola-secreta@localhost:5432/ecom",
  REDIS_URL: "redis://localhost:6379",
};

function expectRefused(env: Record<string, string | undefined>): DomainError {
  try {
    assertDevFlagEnvironment(env);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("DEV_FLAG_ENVIRONMENT_REFUSED");
    return error as DomainError;
  }
  throw new Error("Trebuia să refuze, dar a acceptat");
}

describe("parseDevFlagArgs", () => {
  it("fără argumente: afișează starea (status)", () => {
    expect(parseDevFlagArgs([])).toEqual({ kind: "status" });
  });

  it("«<flag> on» și «<flag> off»", () => {
    expect(parseDevFlagArgs(["multiWarehouse", "on"])).toEqual({
      kind: "set",
      key: "multiWarehouse",
      enabled: true,
    });
    expect(parseDevFlagArgs(["multiWarehouse", "off"])).toEqual({
      kind: "set",
      key: "multiWarehouse",
      enabled: false,
    });
  });

  it("acceptă on/off în orice combinație de litere mari și mici, dar nu și alte valori", () => {
    expect(parseDevFlagArgs(["blog", "ON"])).toMatchObject({ enabled: true });
    expect(parseDevFlagArgs(["blog", "Off"])).toMatchObject({ enabled: false });
    for (const value of ["true", "1", "pornit", "", "onn", "yes"]) {
      expect(() => parseDevFlagArgs(["blog", value])).toThrowError(ValidationError);
    }
  });

  it("acceptă fiecare steag din registru", () => {
    for (const key of FEATURE_KEYS) {
      expect(parseDevFlagArgs([key, "on"])).toMatchObject({ kind: "set", key });
    }
  });

  it("refuză un steag care nu e în registru și arată cele valide", () => {
    try {
      parseDevFlagArgs(["multiWarehose", "on"]);
      throw new Error("Trebuia să refuze");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const message = (error as ValidationError).message;
      expect(message).toContain("multiWarehose");
      for (const key of FEATURE_KEYS) expect(message).toContain(key);
    }
  });

  it("numele de steag e sensibil la litere și nu acceptă chei moștenite din Object", () => {
    for (const key of [
      "multiwarehouse",
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
    ]) {
      expect(() => parseDevFlagArgs([key, "on"]), key).toThrowError(ValidationError);
    }
  });

  it("refuză steagul fără valoare și argumentele în plus", () => {
    expect(() => parseDevFlagArgs(["multiWarehouse"])).toThrowError(ValidationError);
    expect(() => parseDevFlagArgs(["multiWarehouse", "on", "off"])).toThrowError(ValidationError);
    expect(() => parseDevFlagArgs(["multiWarehouse", "on", "--force"])).toThrowError(
      ValidationError,
    );
  });
});

describe("assertDevFlagEnvironment", () => {
  it("acceptă baza și Redis-ul de pe calculatorul local", () => {
    expect(() => assertDevFlagEnvironment(LOCAL_ENV)).not.toThrow();
    for (const host of ["localhost", "127.0.0.1", "[::1]", "db.localhost", "LOCALHOST"]) {
      expect(() =>
        assertDevFlagEnvironment({
          DATABASE_URL: `postgresql://u:p@${host}:5432/ecom_test`,
          REDIS_URL: `redis://${host}:6379/1`,
        }),
      ).not.toThrow();
    }
  });

  it("refuză o bază care nu e locală (inclusiv trucuri de formă)", () => {
    for (const host of [
      "db.example.com",
      "localhost.example.com",
      "notlocalhost",
      "127.0.0.1.evil.com",
      "10.0.0.5",
      "192.168.1.10",
      "ecom.internal",
    ]) {
      expectRefused({ ...LOCAL_ENV, DATABASE_URL: `postgresql://u:p@${host}:5432/ecom` });
    }
    // «localhost» în zona de utilizator nu face gazda locală
    expectRefused({ ...LOCAL_ENV, DATABASE_URL: "postgresql://localhost@evil.com:5432/ecom" });
    expectRefused({ ...LOCAL_ENV, DATABASE_URL: "postgresql://u:p@evil.com:5432/localhost" });
  });

  it("refuză o adresă locală care își schimbă gazda prin parametri (?host=…)", () => {
    for (const param of ["host=db.example.com", "hostaddr=10.0.0.5", "sslmode=require&host=x.y"]) {
      expectRefused({
        ...LOCAL_ENV,
        DATABASE_URL: `postgresql://u:p@localhost:5432/ecom?${param}`,
      });
    }
    expect(() =>
      assertDevFlagEnvironment({
        ...LOCAL_ENV,
        DATABASE_URL: "postgresql://u:p@localhost:5432/ecom?schema=public",
      }),
    ).not.toThrow();
  });

  it("refuză un Redis care nu e local (cache-ul se șterge pe el)", () => {
    expectRefused({ ...LOCAL_ENV, REDIS_URL: "redis://cache.example.com:6379" });
    expectRefused({ ...LOCAL_ENV, REDIS_URL: "redis://:parola@10.0.0.7:6379/0" });
  });

  it("refuză variabile lipsă sau care nu sunt adrese", () => {
    expectRefused({ REDIS_URL: LOCAL_ENV.REDIS_URL });
    expectRefused({ DATABASE_URL: LOCAL_ENV.DATABASE_URL });
    expectRefused({ ...LOCAL_ENV, DATABASE_URL: "" });
    expectRefused({ ...LOCAL_ENV, DATABASE_URL: "nu-e-o-adresa" });
    expectRefused({ ...LOCAL_ENV, REDIS_URL: "nu-e-o-adresa" });
  });

  it("refuză în producție, chiar și cu adrese locale", () => {
    expectRefused({ ...LOCAL_ENV, NODE_ENV: "production" });
    expectRefused({ ...LOCAL_ENV, APP_ENV: "production" });
    expect(() => assertDevFlagEnvironment({ ...LOCAL_ENV, NODE_ENV: "development" })).not.toThrow();
    expect(() => assertDevFlagEnvironment({ ...LOCAL_ENV, NODE_ENV: "test" })).not.toThrow();
  });

  it("mesajul de refuz nu conține adrese, gazde, utilizatori sau parole", () => {
    const secrets = [
      "parola-secreta",
      "topsecret",
      "db.example.com",
      "cache.example.com",
      "ecom_dev",
    ];
    const cases: Record<string, string | undefined>[] = [
      { ...LOCAL_ENV, DATABASE_URL: "postgresql://ecom:parola-secreta@db.example.com:5432/ecom" },
      { ...LOCAL_ENV, REDIS_URL: "redis://:parola-secreta@cache.example.com:6379" },
      { ...LOCAL_ENV, DATABASE_URL: "postgres://user:topsecret@:::" },
      { ...LOCAL_ENV, DATABASE_URL: "topsecret nu e o adresă" },
      { ...LOCAL_ENV, NODE_ENV: "production" },
    ];
    for (const env of cases) {
      const error = expectRefused(env);
      const text = `${error.message} ${JSON.stringify(error.details ?? null)}`;
      for (const secret of secrets) expect(text, secret).not.toContain(secret);
    }
  });
});

/** Magazin de steaguri în memorie, cu jurnal al apelurilor (ca să vedem exact ce se scrie). */
function fakeStore(initial: Record<string, boolean> = {}) {
  const rows = new Map(Object.entries(initial));
  const upserts: { key: string; enabled: boolean; description: string }[] = [];
  const store: FeatureFlagStore = {
    async loadAll() {
      return [...rows].map(([key, enabled]) => ({ key, enabled }));
    },
    async upsert(row) {
      upserts.push(row);
      rows.set(row.key, row.enabled);
    },
  };
  return { store, rows, upserts };
}

function fakeAudit() {
  const appended: Omit<AuditRow, "id" | "createdAt">[] = [];
  let failWith: Error | null = null;
  const store: AuditStore = {
    async append(row) {
      if (failWith) throw failWith;
      appended.push(row);
    },
    async list() {
      return [];
    },
  };
  return {
    store,
    appended,
    failNext(error: Error) {
      failWith = error;
    },
  };
}

function fakeRedis(options: { failDel?: boolean } = {}) {
  const data = new Map<string, string>();
  const deleted: string[] = [];
  return {
    data,
    deleted,
    redis: {
      async get(key: string) {
        return data.get(key) ?? null;
      },
      async set(key: string, value: string) {
        data.set(key, value);
        return "OK";
      },
      async del(key: string) {
        if (options.failDel) throw new Error("conexiune refuzată (parola-secreta)");
        deleted.push(key);
        data.delete(key);
        return 1;
      },
    },
  };
}

describe("runDevFlag: status", () => {
  it("arată toate steagurile din registru, oprite când nu au rând", async () => {
    const { store, upserts } = fakeStore();
    const audit = fakeAudit();
    const { redis } = fakeRedis();
    const result = await runDevFlag({
      command: { kind: "status" },
      store,
      redis,
      auditStore: audit.store,
    });
    expect(result.kind).toBe("status");
    if (result.kind !== "status") return;
    expect(result.flags.map((f) => f.key)).toEqual(FEATURE_KEYS);
    expect(result.flags.every((f) => !f.enabled)).toBe(true);
    // doar citire: nicio scriere, niciun audit
    expect(upserts).toEqual([]);
    expect(audit.appended).toEqual([]);
  });

  it("citește starea din baza de date, nu dintr-un cache vechi", async () => {
    const { store } = fakeStore({ multiWarehouse: true });
    const { redis, data } = fakeRedis();
    data.set(FEATURE_FLAGS_CACHE_KEY, JSON.stringify({ multiWarehouse: false }));
    const result = await runDevFlag({
      command: { kind: "status" },
      store,
      redis,
      auditStore: fakeAudit().store,
    });
    if (result.kind !== "status") throw new Error("status așteptat");
    expect(result.flags.find((f) => f.key === "multiWarehouse")?.enabled).toBe(true);
  });
});

describe("runDevFlag: set", () => {
  it("pornește steagul: scrie în magazin, invalidează cache-ul, scrie auditul cu actorul scriptului", async () => {
    const { store, rows, upserts } = fakeStore();
    const audit = fakeAudit();
    const { redis, deleted } = fakeRedis();
    const result = await runDevFlag({
      command: { kind: "set", key: "multiWarehouse", enabled: true },
      store,
      redis,
      auditStore: audit.store,
    });

    expect(result).toMatchObject({
      kind: "set",
      key: "multiWarehouse",
      before: false,
      after: true,
      changed: true,
      cacheCleared: true,
    });
    expect(rows.get("multiWarehouse")).toBe(true);
    expect(upserts).toEqual([
      { key: "multiWarehouse", enabled: true, description: "Multi-depozit" },
    ]);
    expect(deleted).toContain(FEATURE_FLAGS_CACHE_KEY);

    expect(audit.appended).toHaveLength(1);
    expect(audit.appended[0]).toMatchObject({
      actorId: DEV_FLAG_ACTOR.id,
      actorLabel: "script de dezvoltare",
      action: "feature_flag.update",
      entity: "feature_flag",
      entityId: "multiWarehouse",
      outcome: "success",
      before: { enabled: false },
      after: { enabled: true },
    });
  });

  it("actorul e «script de dezvoltare», fără id de utilizator", () => {
    expect(DEV_FLAG_ACTOR.label).toBe("script de dezvoltare");
    expect(DEV_FLAG_ACTOR.id).not.toMatch(/@/);
  });

  it("oprește steagul, cu audit înainte/după", async () => {
    const { store, rows } = fakeStore({ multiWarehouse: true });
    const audit = fakeAudit();
    const result = await runDevFlag({
      command: { kind: "set", key: "multiWarehouse", enabled: false },
      store,
      redis: fakeRedis().redis,
      auditStore: audit.store,
    });
    expect(result).toMatchObject({ before: true, after: false, changed: true });
    expect(rows.get("multiWarehouse")).toBe(false);
    expect(audit.appended[0]).toMatchObject({
      before: { enabled: true },
      after: { enabled: false },
    });
  });

  it("nu atinge celelalte steaguri", async () => {
    const { store, rows, upserts } = fakeStore({ blog: true, reviews: false });
    await runDevFlag({
      command: { kind: "set", key: "multiWarehouse", enabled: true },
      store,
      redis: fakeRedis().redis,
      auditStore: fakeAudit().store,
    });
    expect(upserts.map((u) => u.key)).toEqual(["multiWarehouse"]);
    expect(rows.get("blog")).toBe(true);
    expect(rows.get("reviews")).toBe(false);
  });

  it("starea deja cerută: nimic de auditat, dar cache-ul se șterge oricum (poate fi vechi)", async () => {
    const { store } = fakeStore({ multiWarehouse: true });
    const audit = fakeAudit();
    const { redis, deleted, data } = fakeRedis();
    data.set(FEATURE_FLAGS_CACHE_KEY, JSON.stringify({ multiWarehouse: false }));
    const result = await runDevFlag({
      command: { kind: "set", key: "multiWarehouse", enabled: true },
      store,
      redis,
      auditStore: audit.store,
    });
    expect(result).toMatchObject({ before: true, after: true, changed: false, cacheCleared: true });
    expect(audit.appended).toEqual([]);
    expect(deleted.length).toBeGreaterThan(0);
  });

  it("«before» vine din baza de date, chiar dacă cache-ul spune altceva", async () => {
    const { store } = fakeStore({ multiWarehouse: true });
    const audit = fakeAudit();
    const { redis, data } = fakeRedis();
    data.set(FEATURE_FLAGS_CACHE_KEY, JSON.stringify({ multiWarehouse: false }));
    const result = await runDevFlag({
      command: { kind: "set", key: "multiWarehouse", enabled: false },
      store,
      redis,
      auditStore: audit.store,
    });
    expect(result).toMatchObject({ before: true, after: false, changed: true });
    expect(audit.appended[0]).toMatchObject({ before: { enabled: true } });
  });

  it("după scriere, cache-ul nu mai conține starea veche", async () => {
    const { store } = fakeStore();
    const { redis, data } = fakeRedis();
    data.set(FEATURE_FLAGS_CACHE_KEY, JSON.stringify({ multiWarehouse: false }));
    await runDevFlag({
      command: { kind: "set", key: "multiWarehouse", enabled: true },
      store,
      redis,
      auditStore: fakeAudit().store,
    });
    const cached = data.get(FEATURE_FLAGS_CACHE_KEY);
    // fie șters, fie repopulat cu starea nouă; niciodată cu cea veche
    if (cached !== undefined) expect(JSON.parse(cached)).toMatchObject({ multiWarehouse: true });
  });

  it("Redis nu răspunde: scrie în bază, raportează că cache-ul NU a fost șters, fără să arunce și fără să scrie detalii de conexiune", async () => {
    const { store, rows } = fakeStore();
    const audit = fakeAudit();
    const { redis } = fakeRedis({ failDel: true });
    const result = await runDevFlag({
      command: { kind: "set", key: "multiWarehouse", enabled: true },
      store,
      redis,
      auditStore: audit.store,
    });
    expect(rows.get("multiWarehouse")).toBe(true);
    expect(result).toMatchObject({ kind: "set", cacheCleared: false });
    expect(audit.appended).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("parola-secreta");
    expect(formatDevFlagResult(result).join("\n")).toMatch(/cache/i);
  });

  it("un eșec la audit ajunge la apelant (AUDIT_WRITE_FAILED)", async () => {
    const { store } = fakeStore();
    const audit = fakeAudit();
    audit.failNext(new Error("baza de audit nu răspunde"));
    await expect(
      runDevFlag({
        command: { kind: "set", key: "multiWarehouse", enabled: true },
        store,
        redis: fakeRedis().redis,
        auditStore: audit.store,
      }),
    ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });
  });
});

describe("createQuietCache", () => {
  it("urmărește dacă ultima ștergere a reușit și nu aruncă niciodată", async () => {
    const ok = createQuietCache(fakeRedis().redis);
    expect(ok.lastDeleteSucceeded()).toBeNull();
    await ok.del("k");
    expect(ok.lastDeleteSucceeded()).toBe(true);

    const bad = createQuietCache(fakeRedis({ failDel: true }).redis);
    await expect(bad.del("k")).resolves.toBeUndefined();
    expect(bad.lastDeleteSucceeded()).toBe(false);
  });

  it("citirea și scrierea eșuate nu aruncă (cache-ul e opțional)", async () => {
    const broken = createQuietCache({
      async get() {
        throw new Error("x");
      },
      async set() {
        throw new Error("x");
      },
      async del() {
        throw new Error("x");
      },
    });
    await expect(broken.get("k")).resolves.toBeNull();
    await expect(broken.set("k", "v", "EX", 1)).resolves.toBeUndefined();
  });
});

describe("formatDevFlagResult", () => {
  it("raportează schimbarea, cu numele steagului și starea dinainte/după", () => {
    const text = formatDevFlagResult({
      kind: "set",
      key: "multiWarehouse",
      label: "Multi-depozit",
      before: false,
      after: true,
      changed: true,
      cacheCleared: true,
    }).join("\n");
    expect(text).toContain("multiWarehouse");
    expect(text).toContain("Multi-depozit");
    expect(text).toMatch(/oprit/);
    expect(text).toMatch(/pornit/);
    expect(text).toMatch(/cache/i);
  });

  it("spune când nu s-a schimbat nimic", () => {
    const text = formatDevFlagResult({
      kind: "set",
      key: "blog",
      label: "Blog",
      before: true,
      after: true,
      changed: false,
      cacheCleared: true,
    }).join("\n");
    expect(text).toMatch(/deja/i);
  });

  it("cache neșters: avertisment cu termenul de 5 minute", () => {
    const text = formatDevFlagResult({
      kind: "set",
      key: "blog",
      label: "Blog",
      before: false,
      after: true,
      changed: true,
      cacheCleared: false,
    }).join("\n");
    expect(text).toMatch(/5 minute/);
  });

  it("starea: câte o linie pe steag", () => {
    const lines = formatDevFlagResult({
      kind: "status",
      flags: FEATURE_KEYS.map((key, i) => ({ key, label: key, enabled: i === 0 })),
    });
    for (const key of FEATURE_KEYS) expect(lines.join("\n")).toContain(key);
  });
});

import { describe, expect, it } from "vitest";
import { REDACTED, runWithRequestContext } from "@ecom/shared";
import { AuditService, type AuditRow, type AuditStore } from "./audit-service";

function fakeStore() {
  const rows: Omit<AuditRow, "id" | "createdAt">[] = [];
  const store: AuditStore = {
    async append(row) {
      rows.push(row);
    },
    async list() {
      return [];
    },
  };
  return { rows, store };
}

const actor = { actorId: "u1", actorLabel: "admin@magazin.test" };

describe("AuditService.record", () => {
  it("scrie actorul, acțiunea, entitatea și starea înainte/după", async () => {
    const f = fakeStore();
    await new AuditService(f.store).record({
      ...actor,
      action: "settings.update",
      entity: "setting",
      entityId: "tax.standardRate",
      before: 21,
      after: 19,
    });
    expect(f.rows[0]).toMatchObject({
      actorId: "u1",
      actorLabel: "admin@magazin.test",
      action: "settings.update",
      entity: "setting",
      entityId: "tax.standardRate",
      before: 21,
      after: 19,
      requestId: null,
    });
  });

  it("maschează secretele din before/after, la orice adâncime, fără să modifice originalul", async () => {
    const f = fakeStore();
    const before = {
      provider: "netopia",
      credentials: "v1:iv:tag:ciphertext-secret",
      config: { apiKey: "sk_live_SECRET1", nested: { clientSecret: "SECRET2", keep: "vizibil" } },
    };
    const after = {
      list: [{ accessToken: "SECRET3", costPrice: 12345, sku: "A1" }],
      APP_KEY: "SECRET4",
      costPriceDate: "2026-10-01",
    };
    await new AuditService(f.store).record({
      ...actor,
      action: "integration.update",
      entity: "integration",
      before,
      after,
    });
    const written = JSON.stringify(f.rows[0]);
    for (const secret of [
      "ciphertext-secret",
      "SECRET1",
      "SECRET2",
      "SECRET3",
      "SECRET4",
      "12345",
      "2026-10-01",
    ]) {
      expect(written).not.toContain(secret);
    }
    expect(written).toContain(REDACTED);
    expect(written).toContain("vizibil");
    expect(written).toContain("A1");
    expect(before.credentials).toBe("v1:iv:tag:ciphertext-secret");
  });

  it("ia requestId din contextul cererii", async () => {
    const f = fakeStore();
    await runWithRequestContext({ requestId: "req-audit-1" }, () =>
      new AuditService(f.store).record({ ...actor, action: "a", entity: "e" }),
    );
    expect(f.rows[0]?.requestId).toBe("req-audit-1");
  });
});

describe("AuditService.recordMany", () => {
  const input = (i: number) => ({
    ...actor,
    action: "product.update",
    entity: "product",
    entityId: `p-${i}`,
    before: { costPrice: 111, title: "vechi" },
    after: { costPrice: 222, title: "nou", token: "secret-abc" },
  });

  it("scrie toate rândurile într-o singură operație de depozit (appendMany), cu aceeași mascare ca record", async () => {
    const batches: Omit<AuditRow, "id" | "createdAt">[][] = [];
    const store: AuditStore = {
      async append() {
        throw new Error("nu trebuia apelat rând cu rând");
      },
      async appendMany(rows) {
        batches.push([...rows]);
      },
      async list() {
        return [];
      },
    };
    await new AuditService(store).recordMany([input(1), input(2), input(3)]);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((r) => r.entityId)).toEqual(["p-1", "p-2", "p-3"]);
    expect(batches[0]?.[0]?.after).toEqual({ costPrice: REDACTED, title: "nou", token: REDACTED });
    expect(batches[0]?.[0]?.before).toEqual({ costPrice: REDACTED, title: "vechi" });
  });

  it("fără appendMany în depozit, scrie rând cu rând, în ordine; o listă goală nu face nimic", async () => {
    const f = fakeStore();
    const service = new AuditService(f.store);
    await service.recordMany([]);
    expect(f.rows).toHaveLength(0);
    await service.recordMany([input(1), input(2)]);
    expect(f.rows.map((r) => r.entityId)).toEqual(["p-1", "p-2"]);
  });
});

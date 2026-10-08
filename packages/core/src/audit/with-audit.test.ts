import { describe, expect, it, vi } from "vitest";
import { AuditService, type AuditRow, type AuditStore } from "./audit-service";
import { createWithAudit } from "./with-audit";

function setup(options: { actor?: boolean; failAppend?: boolean } = {}) {
  const rows: Omit<AuditRow, "id" | "createdAt">[] = [];
  const store: AuditStore = {
    async append(row) {
      if (options.failAppend) throw new Error("db picat");
      rows.push(row);
    },
    async list() {
      return [];
    },
  };
  const withAudit = createWithAudit({
    audit: new AuditService(store),
    getActor: async () =>
      options.actor === false ? null : { id: "u1", label: "admin@magazin.test" },
  });
  return { rows, withAudit };
}

describe("createWithAudit", () => {
  it("rulează acțiunea și înregistrează before/after/entityId", async () => {
    const { rows, withAudit } = setup();
    const save = withAudit<{ key: string; value: number }, { key: string; value: number }>(
      {
        action: "settings.update",
        entity: "setting",
        entityId: (input) => input.key,
        before: async () => ({ value: 21 }),
        after: (result) => ({ value: result.value }),
      },
      async (input) => input,
    );
    await expect(save({ key: "tax.standardRate", value: 19 })).resolves.toEqual({
      key: "tax.standardRate",
      value: 19,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: "u1",
      actorLabel: "admin@magazin.test",
      action: "settings.update",
      entity: "setting",
      entityId: "tax.standardRate",
      before: { value: 21 },
      after: { value: 19 },
    });
  });

  it("fără actor autentificat, acțiunea nu rulează deloc", async () => {
    const { rows, withAudit } = setup({ actor: false });
    const handler = vi.fn(async () => "ok");
    const action = withAudit({ action: "x.y", entity: "x" }, handler);
    await expect(action(undefined)).rejects.toMatchObject({ code: "AUDIT_ACTOR_REQUIRED" });
    expect(handler).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("dacă acțiunea aruncă, nu se scrie nimic în jurnal", async () => {
    const { rows, withAudit } = setup();
    const action = withAudit({ action: "x.y", entity: "x" }, async () => {
      throw new Error("validare eșuată");
    });
    await expect(action(undefined)).rejects.toThrow("validare eșuată");
    expect(rows).toHaveLength(0);
  });

  it("dacă scrierea în jurnal eșuează, apelantul primește AUDIT_WRITE_FAILED", async () => {
    const { withAudit } = setup({ failAppend: true });
    const action = withAudit({ action: "x.y", entity: "x" }, async () => "ok");
    await expect(action(undefined)).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });
  });

  it("secretele din rezultat sunt mascate și aici", async () => {
    const { rows, withAudit } = setup();
    const action = withAudit({ action: "integration.save", entity: "integration" }, async () => ({
      provider: "netopia",
      apiKey: "sk_live_SECRET",
    }));
    await action(undefined);
    expect(JSON.stringify(rows[0])).not.toContain("SECRET");
  });
});

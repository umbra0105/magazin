import { describe, expect, it } from "vitest";
import { ForbiddenError, UnauthenticatedError } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { DEFAULT_ROLES } from "../rbac/catalog";
import { MemoryAudit } from "../test-utils/memory-audit";
import {
  MAX_WAREHOUSES,
  WarehouseCodeTakenError,
  WarehouseService,
  warehouseCodeFromName,
  type WarehouseRecord,
  type WarehouseStore,
  type WarehouseWithUsage,
} from "./warehouse-service";

/**
 * Faza 5, punctul 13a: serviciul de depozite, pe un depozit în memorie. Testele pe baza reală sunt în
 * `warehouse-service.integration.test.ts`; aici sunt regulile: steagul oprit refuză TOT, drepturile, numele, codul
 * derivat, depozitul implicit protejat, dezactivarea refuzată cu stoc, auditul.
 */

function roleSubject(roleKey: string): PermissionSubject {
  const role = DEFAULT_ROLES.find((r) => r.key === roleKey);
  if (!role) throw new Error(roleKey);
  return {
    userId: `u-${roleKey}`,
    email: `${roleKey}@magazin.test`,
    roles: [roleKey],
    permissions: new Set<string>(role.permissions),
  };
}

class MemoryStore implements WarehouseStore {
  rows: WarehouseWithUsage[] = [];
  calls = 0;
  /** Cod ocupat de o cerere concurentă: prima creare cu acest cod eșuează o singură dată */
  raceOnce: string | null = null;
  private n = 0;

  seed(over: Partial<WarehouseWithUsage> & { name: string }): WarehouseWithUsage {
    const row: WarehouseWithUsage = {
      id: `w${++this.n}`,
      code: warehouseCodeFromName(over.name),
      isDefault: false,
      isActive: true,
      stockedItems: 0,
      ...over,
    };
    this.rows.push(row);
    return row;
  }

  async listAll(): Promise<WarehouseWithUsage[]> {
    this.calls++;
    return this.rows.map((r) => ({ ...r }));
  }
  async get(id: string): Promise<WarehouseWithUsage | null> {
    this.calls++;
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : null;
  }
  async create(data: { code: string; name: string }): Promise<WarehouseRecord> {
    this.calls++;
    if (this.raceOnce === data.code) {
      this.raceOnce = null;
      this.seed({ name: `Altul ${data.code}`, code: data.code });
      throw new WarehouseCodeTakenError(data.code);
    }
    if (this.rows.some((r) => r.code === data.code)) throw new WarehouseCodeTakenError(data.code);
    return this.seed({ name: data.name, code: data.code });
  }
  async update(id: string, data: { name?: string; isActive?: boolean }): Promise<WarehouseRecord> {
    this.calls++;
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error("lipsă");
    Object.assign(row, data);
    return { ...row };
  }
}

function setup(enabled = true) {
  const store = new MemoryStore();
  const audit = new MemoryAudit();
  const flag = { enabled, reads: 0 };
  const service = new WarehouseService({
    store,
    audit: new AuditService(audit),
    isEnabled: async () => {
      flag.reads++;
      return flag.enabled;
    },
  });
  const main = store.seed({ name: "Depozit principal", isDefault: true });
  return { store, audit, flag, service, main, manager: roleSubject("manager") };
}

const rejection = async (fn: () => Promise<unknown>): Promise<{ code?: string } | null> => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as { code?: string };
  }
};

describe("warehouseCodeFromName: codul stabil derivat din nume", () => {
  it.each([
    ["Depozit principal", "depozit_principal"],
    ["Magazin Cluj-Napoca", "magazin_cluj_napoca"],
    ["Șura țării Îngerilor", "sura_tarii_ingerilor"],
    ["  Depozit   2  ", "depozit_2"],
    ["Depozit_ȘI-Ă", "depozit_si_a"],
  ])("%s → %s", (name, code) => {
    expect(warehouseCodeFromName(name)).toBe(code);
  });

  it("un nume care începe cu cifră sau fără litere primește prefix și rămâne valid pentru CHECK-ul bazei", () => {
    expect(warehouseCodeFromName("2 Cluj")).toBe("depozit_2_cluj");
    expect(warehouseCodeFromName("!!!")).toBe("depozit");
    expect(warehouseCodeFromName("日本")).toBe("depozit");
    for (const name of ["2 Cluj", "!!!", "a".repeat(200), "Ünïcödé ñ"]) {
      expect(warehouseCodeFromName(name)).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("codul are cel mult 40 de caractere", () => {
    expect(warehouseCodeFromName("a".repeat(200)).length).toBeLessThanOrEqual(40);
  });
});

describe("steagul multiWarehouse oprit: orice operație e refuzată, înaintea oricărei citiri sau scrieri", () => {
  it("fiecare metodă aruncă FEATURE_DISABLED, fără să atingă baza și fără audit; steagul se citește la fiecare apel", async () => {
    const { service, store, audit, flag, main, manager } = setup(false);
    const callsBefore = store.calls;
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["list", () => service.list(manager)],
      ["listActive", () => service.listActive(manager)],
      ["create", () => service.create(manager, { name: "Depozit 2" })],
      ["rename", () => service.rename(manager, main.id, { name: "Altceva" })],
      ["deactivate", () => service.deactivate(manager, main.id)],
      ["activate", () => service.activate(manager, main.id)],
    ];
    for (const [name, call] of calls) {
      const error = await rejection(call);
      expect(error?.code, name).toBe("FEATURE_DISABLED");
    }
    expect(store.calls).toBe(callsBefore);
    expect(audit.rows).toEqual([]);
    expect(flag.reads).toBe(calls.length);
    expect(store.rows.map((r) => r.name)).toEqual(["Depozit principal"]);
  });

  it("refuză steagul înaintea drepturilor (un anonim nu află dacă funcția există)", async () => {
    const { service } = setup(false);
    expect((await rejection(() => service.list(null)))?.code).toBe("FEATURE_DISABLED");
  });

  it("pornit după oprit: funcționează imediat (nicio copie păstrată a steagului)", async () => {
    const { service, flag, manager } = setup(false);
    expect((await rejection(() => service.list(manager)))?.code).toBe("FEATURE_DISABLED");
    flag.enabled = true;
    expect(await service.list(manager)).toHaveLength(1);
    flag.enabled = false;
    expect((await rejection(() => service.list(manager)))?.code).toBe("FEATURE_DISABLED");
  });
});

describe("drepturi: inventory.read pentru citire, inventory.write pentru scriere", () => {
  it("Owner, Admin, Manager și Depozit citesc și scriu; Editor, Suport și Contabil nu", async () => {
    for (const role of ["owner", "admin", "manager", "warehouse"]) {
      const { service } = setup();
      const subject = roleSubject(role);
      expect(await service.list(subject), role).toHaveLength(1);
      const created = await service.create(subject, { name: `Din ${role}` });
      expect(created.name, role).toBe(`Din ${role}`);
    }
    for (const role of ["editor", "support", "accountant"]) {
      const { service, main, store } = setup();
      const subject = roleSubject(role);
      const attempts: Array<() => Promise<unknown>> = [
        () => service.list(subject),
        () => service.listActive(subject),
        () => service.create(subject, { name: "X" }),
        () => service.rename(subject, main.id, { name: "Y" }),
        () => service.deactivate(subject, main.id),
        () => service.activate(subject, main.id),
      ];
      for (const attempt of attempts) {
        await expect(attempt(), role).rejects.toBeInstanceOf(ForbiddenError);
      }
      expect(store.rows).toHaveLength(1);
    }
  });

  it("anonimul primește UnauthenticatedError", async () => {
    const { service } = setup();
    await expect(service.list(null)).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(service.create(null, { name: "X" })).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("un rol doar cu citire poate lista, dar nu poate scrie", async () => {
    const { service, audit } = setup();
    const reader: PermissionSubject = {
      userId: "u-r",
      email: "r@magazin.test",
      roles: ["custom"],
      permissions: new Set(["admin.access", "inventory.read"]),
    };
    expect(await service.list(reader)).toHaveLength(1);
    await expect(service.create(reader, { name: "X" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(audit.rows).toEqual([]);
  });
});

describe("listare", () => {
  it("depozitul implicit primul, apoi după nume; listActive le ascunde pe cele dezactivate", async () => {
    const { service, store, manager } = setup();
    store.seed({ name: "Zimbru" });
    store.seed({ name: "Albina" });
    store.seed({ name: "Dezactivat", isActive: false });
    const all = await service.list(manager);
    expect(all.map((r) => r.name)).toEqual(["Depozit principal", "Albina", "Dezactivat", "Zimbru"]);
    const active = await service.listActive(manager);
    expect(active.map((r) => r.name)).toEqual(["Depozit principal", "Albina", "Zimbru"]);
  });
});

describe("ordinea listei nu depinde de ordinea din depozit", () => {
  it("implicitul e primul chiar dacă depozitul îl întoarce ultimul sau în mijloc", async () => {
    for (const position of ["first", "middle", "last"] as const) {
      const { service, store, main, manager } = setup();
      store.rows.splice(0, store.rows.length);
      const others = [store.seed({ name: "Albina" }), store.seed({ name: "Zimbru" })];
      store.rows.splice(0, store.rows.length);
      const order = {
        first: [main, ...others],
        middle: [others[0]!, main, others[1]!],
        last: [...others, main],
      }[position];
      store.rows.push(...order);
      const names = (await service.list(manager)).map((w) => w.name);
      expect(names, position).toEqual(["Depozit principal", "Albina", "Zimbru"]);
    }
  });
});

describe("creare", () => {
  it("creează un depozit activ, nu implicit, cu cod derivat din nume, și scrie în audit", async () => {
    const { service, audit, manager } = setup();
    const created = await service.create(manager, { name: "  Magazin Cluj  " });
    expect(created).toMatchObject({
      name: "Magazin Cluj",
      code: "magazin_cluj",
      isActive: true,
      isDefault: false,
    });
    const rows = audit.for(created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "warehouse.create",
      entity: "warehouse",
      actorId: manager.userId,
      outcome: "success",
      after: { code: "magazin_cluj", name: "Magazin Cluj" },
    });
  });

  it("refuză numele gol, prea lung sau cu câmpuri în plus, fără să scrie nimic", async () => {
    const { service, store, audit, manager } = setup();
    const before = store.rows.length;
    for (const input of [{ name: "" }, { name: "   " }, { name: "a".repeat(101) }, {}, null]) {
      const error = await rejection(() => service.create(manager, input));
      expect(error?.code, JSON.stringify(input)).toBe("VALIDATION_ERROR");
    }
    const extra = await rejection(() => service.create(manager, { name: "X", isDefault: true }));
    expect(extra?.code).toBe("VALIDATION_ERROR");
    expect(store.rows).toHaveLength(before);
    expect(audit.rows).toEqual([]);
  });

  it("nume duplicat (fără deosebire de litere și de spații) → WAREHOUSE_NAME_CONFLICT", async () => {
    const { service, store, manager } = setup();
    for (const name of ["Depozit principal", "DEPOZIT PRINCIPAL", "  depozit principal "]) {
      expect((await rejection(() => service.create(manager, { name })))?.code, name).toBe(
        "WAREHOUSE_NAME_CONFLICT",
      );
    }
    expect(store.rows).toHaveLength(1);
  });

  it("două nume diferite cu același cod derivat primesc coduri diferite (_2, _3)", async () => {
    const { service, manager } = setup();
    const a = await service.create(manager, { name: "Șură" });
    const b = await service.create(manager, { name: "Sura" });
    const c = await service.create(manager, { name: "SURA!" });
    expect([a.code, b.code, c.code]).toEqual(["sura", "sura_2", "sura_3"]);
  });

  it("sufixul _2 nu depășește lungimea maximă a codului: baza se scurtează, nu sufixul", async () => {
    const { service, manager } = setup();
    const first = await service.create(manager, { name: "a".repeat(100) });
    const second = await service.create(manager, { name: `${"a".repeat(99)}b` });
    expect(first.code).toBe("a".repeat(40));
    expect(second.code).toBe(`${"a".repeat(38)}_2`);
    expect(second.code.length).toBe(40);
  });

  it("un cod ocupat de o cerere concurentă: reîncearcă cu următorul cod liber", async () => {
    const { service, store, manager } = setup();
    store.raceOnce = "cluj";
    const created = await service.create(manager, { name: "Cluj" });
    expect(created.code).toBe("cluj_2");
  });

  it("plafon de depozite: peste MAX_WAREHOUSES → WAREHOUSE_LIMIT", async () => {
    const { service, store, manager } = setup();
    for (let i = store.rows.length; i < MAX_WAREHOUSES; i++) store.seed({ name: `Depozit ${i}` });
    expect((await rejection(() => service.create(manager, { name: "Unul în plus" })))?.code).toBe(
      "WAREHOUSE_LIMIT",
    );
    expect(store.rows).toHaveLength(MAX_WAREHOUSES);
  });
});

describe("redenumire", () => {
  it("redenumește (și depozitul implicit), păstrează codul, scrie înainte/după în audit", async () => {
    const { service, audit, main, manager } = setup();
    const renamed = await service.rename(manager, main.id, { name: "Depozit central" });
    expect(renamed).toMatchObject({ name: "Depozit central", code: main.code, isDefault: true });
    expect(audit.for(main.id)[0]).toMatchObject({
      action: "warehouse.rename",
      before: { name: "Depozit principal" },
      after: { name: "Depozit central" },
    });
  });

  it("același nume (sau doar altă scriere a literelor lui) nu e conflict cu el însuși; fără modificare nu se scrie audit", async () => {
    const { service, audit, main, manager } = setup();
    await service.rename(manager, main.id, { name: "Depozit principal" });
    expect(audit.rows).toEqual([]);
    const recased = await service.rename(manager, main.id, { name: "DEPOZIT PRINCIPAL" });
    expect(recased.name).toBe("DEPOZIT PRINCIPAL");
    expect(audit.rows).toHaveLength(1);
  });

  it("numele altui depozit → WAREHOUSE_NAME_CONFLICT; depozit inexistent → WAREHOUSE_NOT_FOUND", async () => {
    const { service, store, main, manager } = setup();
    store.seed({ name: "Cluj" });
    expect((await rejection(() => service.rename(manager, main.id, { name: "cluj" })))?.code).toBe(
      "WAREHOUSE_NAME_CONFLICT",
    );
    expect((await rejection(() => service.rename(manager, "nu-exista", { name: "X" })))?.code).toBe(
      "WAREHOUSE_NOT_FOUND",
    );
  });

  it("nume invalid → VALIDATION_ERROR, nimic scris", async () => {
    const { service, audit, main, manager } = setup();
    expect((await rejection(() => service.rename(manager, main.id, { name: "" })))?.code).toBe(
      "VALIDATION_ERROR",
    );
    expect(audit.rows).toEqual([]);
  });
});

describe("dezactivare și reactivare", () => {
  it("dezactivează un depozit gol, apoi îl reactivează; fiecare schimbare e în audit; a doua cerere identică nu mai scrie nimic", async () => {
    const { service, store, audit, manager } = setup();
    const cluj = store.seed({ name: "Cluj" });
    const off = await service.deactivate(manager, cluj.id);
    expect(off.isActive).toBe(false);
    await service.deactivate(manager, cluj.id);
    expect(audit.rows.map((r) => r.action)).toEqual(["warehouse.deactivate"]);
    const on = await service.activate(manager, cluj.id);
    expect(on.isActive).toBe(true);
    await service.activate(manager, cluj.id);
    expect(audit.rows.map((r) => r.action)).toEqual(["warehouse.deactivate", "warehouse.activate"]);
    expect(audit.for(cluj.id, "warehouse.deactivate")[0]).toMatchObject({
      before: { isActive: true },
      after: { isActive: false },
    });
  });

  it("depozitul implicit nu se dezactivează → WAREHOUSE_DEFAULT_PROTECTED", async () => {
    const { service, main, audit, store, manager } = setup();
    expect((await rejection(() => service.deactivate(manager, main.id)))?.code).toBe(
      "WAREHOUSE_DEFAULT_PROTECTED",
    );
    expect(store.rows[0]?.isActive).toBe(true);
    expect(audit.rows).toEqual([]);
  });

  it("un depozit cu stoc, rezervări sau angajări nu se dezactivează → WAREHOUSE_HAS_STOCK, cu numărul de rânduri", async () => {
    const { service, store, audit, manager } = setup();
    const cluj = store.seed({ name: "Cluj", stockedItems: 3 });
    const error = (await rejection(() => service.deactivate(manager, cluj.id))) as {
      code?: string;
      details?: { stockedItems?: number };
    } | null;
    expect(error?.code).toBe("WAREHOUSE_HAS_STOCK");
    expect(error?.details?.stockedItems).toBe(3);
    expect(cluj.isActive).toBe(true);
    expect(audit.rows).toEqual([]);
  });

  it("depozit inexistent → WAREHOUSE_NOT_FOUND", async () => {
    const { service, manager } = setup();
    expect((await rejection(() => service.deactivate(manager, "nu-exista")))?.code).toBe(
      "WAREHOUSE_NOT_FOUND",
    );
    expect((await rejection(() => service.activate(manager, "nu-exista")))?.code).toBe(
      "WAREHOUSE_NOT_FOUND",
    );
  });
});

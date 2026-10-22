import { describe, expect, it } from "vitest";
import { AuditService, type AuditRow, type AuditStore } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { DEFAULT_ROLES } from "../rbac/catalog";
import { DEFAULT_MEASURE_UNIT_CODE, INITIAL_MEASURE_UNITS } from "./constants";
import {
  MeasureUnitService,
  type DecimalConflicts,
  type MeasureUnitRecord,
  type MeasureUnitStore,
  type MeasureUnitWithUsage,
} from "./measure-unit-service";

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

class MemoryUnits implements MeasureUnitStore {
  rows: MeasureUnitRecord[] = INITIAL_MEASURE_UNITS.map((u, index) => ({
    id: `mu-${u.code}`,
    code: u.code,
    name: u.name,
    symbol: u.symbol,
    smartbillName: null,
    decimals: u.decimals,
    isActive: true,
    isSystem: true,
    sortOrder: index,
  }));
  conflicts: DecimalConflicts = { steps: 0, stock: 0 };
  conflictCalls: Array<{ id: string; decimals: number }> = [];

  async listAll(): Promise<MeasureUnitWithUsage[]> {
    return this.rows.map((r) => ({ ...r, productCount: 0, variantCount: 0 }));
  }
  async get(id: string) {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async findByCode(code: string) {
    return this.rows.find((r) => r.code.toLowerCase() === code.toLowerCase()) ?? null;
  }
  async create(data: Omit<MeasureUnitRecord, "id" | "isSystem">) {
    const row: MeasureUnitRecord = { ...data, id: `mu-${this.rows.length + 1}`, isSystem: false };
    this.rows.push(row);
    return row;
  }
  async update(id: string, data: Partial<MeasureUnitRecord>) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error("lipsă");
    Object.assign(row, data);
    return row;
  }
  async findDecimalConflicts(id: string, decimals: number) {
    this.conflictCalls.push({ id, decimals });
    return this.conflicts;
  }
}

function setup() {
  const store = new MemoryUnits();
  const auditRows: AuditRow[] = [];
  const auditStore: AuditStore = {
    async append(row) {
      auditRows.push({ ...row, id: `a-${auditRows.length}`, createdAt: new Date() });
    },
    async list() {
      return auditRows;
    },
  };
  const service = new MeasureUnitService({ store, audit: new AuditService(auditStore) });
  return { store, service, auditRows };
}

const manager = () => roleSubject("manager");

async function code(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return (e as { code?: string }).code ?? "FĂRĂ_COD";
  }
  return "OK";
}

describe("unități de măsură: citire și drepturi", () => {
  it("lista cere products.read; Editorul o vede, scrierea cere products.write", async () => {
    const { service } = setup();
    expect((await service.list(roleSubject("editor"))).length).toBe(INITIAL_MEASURE_UNITS.length);
    expect(await code(() => service.list(null))).toBe("AUTH_UNAUTHENTICATED");
    for (const role of ["editor", "warehouse", "support", "accountant"]) {
      expect(
        await code(() =>
          service.create(roleSubject(role), { code: "palet", name: "Palet", symbol: "palet" }),
        ),
        role,
      ).toBe("AUTH_FORBIDDEN");
    }
    expect(
      await code(() =>
        service.create(manager(), { code: "palet", name: "Palet", symbol: "palet" }),
      ),
    ).toBe("OK");
  });

  it("unitățile active pentru selectoare exclud pe cele dezactivate", async () => {
    const { service, store } = setup();
    await service.update(manager(), "mu-set", { isActive: false });
    const active = await service.listActive(manager());
    expect(active.some((u) => u.code === "set")).toBe(false);
    expect(active.some((u) => u.code === "buc")).toBe(true);
    expect(store.rows).toHaveLength(INITIAL_MEASURE_UNITS.length);
  });
});

describe("unități de măsură: creare", () => {
  it("creează o unitate, o scrie în audit și o așază la sfârșit", async () => {
    const { service, auditRows } = setup();
    const created = await service.create(manager(), {
      code: "palet",
      name: "  Palet  ",
      symbol: "palet",
      smartbillName: "",
      decimals: 0,
    });
    expect(created).toMatchObject({
      code: "palet",
      name: "Palet",
      smartbillName: null,
      decimals: 0,
      isActive: true,
      isSystem: false,
    });
    expect(created.sortOrder).toBeGreaterThanOrEqual(INITIAL_MEASURE_UNITS.length);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "measureUnit.create",
      entity: "measure_unit",
      entityId: created.id,
      actorLabel: "manager@magazin.test",
    });
  });

  it("codul: formă stabilă și unic fără diferență de majuscule", async () => {
    const { service } = setup();
    for (const bad of ["Palet", "1palet", "pa let", "", "p".repeat(31), "mp-2"]) {
      expect(
        await code(() => service.create(manager(), { code: bad, name: "X", symbol: "x" })),
        bad,
      ).toBe("VALIDATION_ERROR");
    }
    expect(
      await code(() => service.create(manager(), { code: "kg", name: "Alt kg", symbol: "kg" })),
    ).toBe("MEASURE_UNIT_CODE_CONFLICT");
    expect(
      await code(() => service.create(manager(), { code: "KG", name: "Alt kg", symbol: "kg" })),
    ).toBe(
      "VALIDATION_ERROR", // majusculele nu trec de formă; conflictul se vede la «kg» exact
    );
  });

  it("zecimale 0–4, nume și simbol nevide, nicio cheie în plus (nu se poate crea o unitate de sistem)", async () => {
    const { service } = setup();
    const ok = { code: "unitate", name: "Unitate", symbol: "u" };
    for (const decimals of [-1, 5, 1.5, "2"]) {
      expect(
        await code(() => service.create(manager(), { ...ok, decimals })),
        String(decimals),
      ).toBe("VALIDATION_ERROR");
    }
    expect(await code(() => service.create(manager(), { ...ok, name: "  " }))).toBe(
      "VALIDATION_ERROR",
    );
    expect(await code(() => service.create(manager(), { ...ok, symbol: "" }))).toBe(
      "VALIDATION_ERROR",
    );
    expect(await code(() => service.create(manager(), { ...ok, isSystem: true }))).toBe(
      "VALIDATION_ERROR",
    );
    expect(await code(() => service.create(manager(), { ...ok, decimals: 4 }))).toBe("OK");
  });
});

describe("unități de măsură: editare", () => {
  it("redenumește (nume, simbol, numele din SmartBill) cu audit pe diferențe", async () => {
    const { service, auditRows } = setup();
    const updated = await service.update(manager(), "mu-mp", {
      name: "Metru pătrat (placare)",
      smartbillName: "mp.",
    });
    expect(updated).toMatchObject({ name: "Metru pătrat (placare)", smartbillName: "mp." });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "measureUnit.update",
      before: { name: "Metru pătrat", smartbillName: null },
      after: { name: "Metru pătrat (placare)", smartbillName: "mp." },
    });
    // golirea numelui din SmartBill îl pune pe nul
    const cleared = await service.update(manager(), "mu-mp", { smartbillName: "  " });
    expect(cleared.smartbillName).toBeNull();
  });

  it("nicio schimbare = nicio scriere în audit; cerere goală sau cheie necunoscută = eroare", async () => {
    const { service, auditRows } = setup();
    await service.update(manager(), "mu-mp", { name: "Metru pătrat" });
    expect(auditRows).toHaveLength(0);
    expect(await code(() => service.update(manager(), "mu-mp", {}))).toBe("VALIDATION_ERROR");
    expect(await code(() => service.update(manager(), "mu-mp", { isSystem: false }))).toBe(
      "VALIDATION_ERROR",
    );
    expect(await code(() => service.update(manager(), "inexistent", { name: "X" }))).toBe(
      "MEASURE_UNIT_NOT_FOUND",
    );
  });

  it("codul unei unități nu se schimbă niciodată", async () => {
    const { service } = setup();
    expect(await code(() => service.update(manager(), "mu-mp", { code: "metri_patrati" }))).toBe(
      "MEASURE_UNIT_CODE_IMMUTABLE",
    );
    // același cod = nimic de schimbat, fără eroare
    expect(await code(() => service.update(manager(), "mu-mp", { code: "mp", name: "Mp" }))).toBe(
      "OK",
    );
  });

  it("dezactivarea și reactivarea unei unități obișnuite", async () => {
    const { service, store } = setup();
    await service.update(manager(), "mu-set", { isActive: false });
    expect(store.rows.find((r) => r.code === "set")?.isActive).toBe(false);
    await service.update(manager(), "mu-set", { isActive: true });
    expect(store.rows.find((r) => r.code === "set")?.isActive).toBe(true);
  });
});

describe("«buc» este unitatea implicită (unitatea nulă): protejată", () => {
  const id = `mu-${DEFAULT_MEASURE_UNIT_CODE}`;

  it("nu poate fi dezactivată", async () => {
    const { service, store } = setup();
    expect(await code(() => service.update(manager(), id, { isActive: false }))).toBe(
      "MEASURE_UNIT_DEFAULT_PROTECTED",
    );
    expect(store.rows.find((r) => r.id === id)?.isActive).toBe(true);
  });

  it("nu poate fi redenumită ca cod", async () => {
    const { service, store } = setup();
    expect(await code(() => service.update(manager(), id, { code: "bucata" }))).toBe(
      "MEASURE_UNIT_DEFAULT_PROTECTED",
    );
    expect(store.rows.find((r) => r.id === id)?.code).toBe("buc");
  });

  it("nu poate primi zecimale", async () => {
    const { service, store } = setup();
    for (const decimals of [1, 2, 4]) {
      expect(await code(() => service.update(manager(), id, { decimals })), String(decimals)).toBe(
        "MEASURE_UNIT_DEFAULT_PROTECTED",
      );
    }
    expect(store.rows.find((r) => r.id === id)?.decimals).toBe(0);
  });

  it("cererea mixtă (nume corect + zecimale interzise) se respinge întreagă", async () => {
    const { service, store, auditRows } = setup();
    expect(await code(() => service.update(manager(), id, { name: "Bucăți", decimals: 2 }))).toBe(
      "MEASURE_UNIT_DEFAULT_PROTECTED",
    );
    expect(store.rows.find((r) => r.id === id)?.name).toBe("Bucată");
    expect(auditRows).toHaveLength(0);
  });

  it("numele, simbolul, numele din SmartBill și ordinea se pot schimba; «activă» rămâne adevărat", async () => {
    const { service } = setup();
    const updated = await service.update(manager(), id, {
      name: "Bucăți",
      symbol: "buc.",
      smartbillName: "Buc",
      isActive: true,
      decimals: 0,
    });
    expect(updated).toMatchObject({
      code: "buc",
      name: "Bucăți",
      symbol: "buc.",
      smartbillName: "Buc",
      isActive: true,
      decimals: 0,
    });
  });
});

describe("zecimalele unei unități folosite", () => {
  it("mărirea sau menținerea zecimalelor nu cere nicio verificare", async () => {
    const { service, store } = setup();
    await service.update(manager(), "mu-mp", { decimals: 4 });
    await service.update(manager(), "mu-mp", { decimals: 4 });
    expect(store.conflictCalls).toEqual([]);
  });

  it("scăderea e refuzată dacă pași sau cantități de stoc ar avea prea multe zecimale", async () => {
    const { service, store } = setup();
    store.conflicts = { steps: 3, stock: 2 };
    const e = await service
      .update(manager(), "mu-mp", { decimals: 1 })
      .catch((error: { code: string; message: string }) => error);
    expect(e).toMatchObject({ code: "MEASURE_UNIT_DECIMALS_IN_USE" });
    expect((e as { message: string }).message).toMatch(/3 pași/);
    expect((e as { message: string }).message).toMatch(/2 rânduri de stoc/);
    expect(store.rows.find((r) => r.code === "mp")?.decimals).toBe(4);
    expect(store.conflictCalls).toEqual([{ id: "mu-mp", decimals: 1 }]);
  });

  it("scăderea fără conflicte reușește", async () => {
    const { service, store } = setup();
    store.conflicts = { steps: 0, stock: 0 };
    await service.update(manager(), "mu-mp", { decimals: 2 });
    expect(store.rows.find((r) => r.code === "mp")?.decimals).toBe(2);
  });
});

import { describe, expect, it } from "vitest";
import { createLogger, ForbiddenError, UnauthenticatedError } from "@ecom/shared";
import { AuditService, type AuditRow, type AuditStore } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { DEFAULT_ROLES } from "../rbac/catalog";
import {
  COST_FIELDS,
  CostPriceService,
  projectVariantForAdmin,
  PUBLIC_VARIANT_FIELDS,
  toPublicVariant,
  type ApplyCostCommand,
  type CostHistoryEntry,
  type CostPriceStore,
  type VariantCost,
} from "./cost-price";

const COST = 123456;
const OLDER_COST = 654321;

function subject(permissions: string[], roles: string[] = ["custom"]): PermissionSubject {
  return {
    userId: "u-1",
    email: "operator@magazin.test",
    roles,
    permissions: new Set(["admin.access", ...permissions]),
  };
}

const viewer = subject(["products.cost.view"]);
const editorOnly = subject(["products.cost.edit"]);
const full = subject(["products.cost.view", "products.cost.edit"]);
const plain = subject(["products.read", "products.write"]);

class FakeStore implements CostPriceStore {
  variant: VariantCost | null = { costPrice: null, costPriceDate: null };
  history: CostHistoryEntry[] = [];
  applied: ApplyCostCommand[] = [];

  async getVariantCost(): Promise<VariantCost | null> {
    return this.variant;
  }

  async apply(command: ApplyCostCommand): Promise<void> {
    this.applied.push(command);
    this.history.push({
      id: `h-${this.history.length}`,
      costPrice: command.costPrice,
      effectiveDate: command.effectiveDate,
      source: command.source,
      createdAt: new Date(),
    });
    if (command.updateVariant && this.variant) {
      this.variant = { costPrice: command.costPrice, costPriceDate: command.effectiveDate };
    }
  }

  async listHistory(): Promise<CostHistoryEntry[]> {
    return [...this.history].reverse();
  }
}

function setup() {
  const store = new FakeStore();
  const auditRows: AuditRow[] = [];
  const auditStore: AuditStore = {
    async append(row) {
      auditRows.push({ ...row, id: `a-${auditRows.length}`, createdAt: new Date() });
    },
    async list() {
      return auditRows;
    },
  };
  const logLines: string[] = [];
  const logger = createLogger({
    level: "debug",
    destination: {
      write(chunk: string) {
        logLines.push(chunk);
      },
    },
  });
  const service = new CostPriceService({
    store,
    audit: new AuditService(auditStore),
    logger,
    now: () => new Date("2026-10-14T12:00:00Z"),
  });
  return { store, service, auditRows, logLines };
}

describe("proiecția pentru admin: costul apare doar cu products.cost.view", () => {
  const row = {
    id: "v1",
    sku: "A1",
    price: 19900,
    costPrice: COST,
    costPriceDate: new Date("2026-09-01"),
  };

  it("fără permisiune: cheile de cost lipsesc cu totul (nu null, nu 0)", () => {
    for (const s of [plain, editorOnly, null]) {
      const out = projectVariantForAdmin(s, row);
      for (const field of COST_FIELDS)
        expect(field in out, `${field} nu trebuie să existe`).toBe(false);
      expect(Object.keys(out).sort()).toEqual(["id", "price", "sku"]);
      expect(JSON.stringify(out)).not.toContain(String(COST));
    }
  });

  it("cu permisiune: costul apare; o variantă fără cost are null explicit", () => {
    expect(projectVariantForAdmin(viewer, row)).toMatchObject({ costPrice: COST });
    const bare: { id: string; costPrice?: number | null } = { id: "v2" };
    expect(projectVariantForAdmin(viewer, bare)).toMatchObject({
      costPrice: null,
      costPriceDate: null,
    });
  });

  it("Owner îl vede implicit; un rol fără admin.access nu îl vede nici cu permisiunea acordată", () => {
    expect(projectVariantForAdmin(subject([], ["owner"]), row)).toHaveProperty("costPrice");
    const noAccess: PermissionSubject = {
      userId: "u-2",
      email: "x@y.test",
      roles: ["custom"],
      permissions: new Set(["products.cost.view"]),
    };
    expect("costPrice" in projectVariantForAdmin(noAccess, row)).toBe(false);
  });
});

describe("proiecția publică: listă albă", () => {
  it("lista albă nu conține câmpuri de cost sau nume care sună a cost de achiziție", () => {
    for (const field of PUBLIC_VARIANT_FIELDS) {
      expect(COST_FIELDS as readonly string[]).not.toContain(field);
      expect(field.toLowerCase()).not.toMatch(/cost/);
    }
  });

  it("scoate costul chiar dacă rândul primit îl conține", () => {
    const out = toPublicVariant({
      id: "v1",
      sku: "A1",
      price: 19900,
      costPrice: COST,
      costPriceDate: new Date(),
      costHistory: [{ costPrice: OLDER_COST }],
      internalNote: "secret",
    } as Record<string, unknown>);
    expect(out).toEqual({ id: "v1", sku: "A1", price: 19900 });
    expect(JSON.stringify(out)).not.toContain(String(COST));
  });
});

describe("scrierea costului: permisiuni", () => {
  const input = { variantId: "v1", costPrice: COST, effectiveDate: new Date("2026-10-01") };

  it("products.cost.edit FĂRĂ products.cost.view e refuzat și nu modifică nimic (nu e o combinație care scurge)", async () => {
    const { service, store, auditRows } = setup();
    await expect(service.setCost(editorOnly, input)).rejects.toBeInstanceOf(ForbiddenError);
    expect(store.applied).toEqual([]);
    expect(auditRows).toEqual([]);
  });

  it("view fără edit, fără niciuna și neautentificat: refuzat", async () => {
    const { service, store } = setup();
    await expect(service.setCost(viewer, input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.setCost(plain, input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.setCost(null, input)).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(store.applied).toEqual([]);
  });

  it("cu edit + view: reușește, iar răspunsul nu conține valoarea", async () => {
    const { service } = setup();
    const result = await service.setCost(full, input);
    expect(result).toEqual({ applied: true });
    expect(JSON.stringify(result)).not.toContain(String(COST));
  });

  it("citirea valorii și a istoricului cere view; edit singur nu ajunge", async () => {
    const { service } = setup();
    await service.setCost(full, input);
    await expect(service.getCost(editorOnly, "v1")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.getHistory(plain, "v1")).rejects.toBeInstanceOf(ForbiddenError);
    expect(await service.getCost(viewer, "v1")).toEqual({
      costPrice: COST,
      costPriceDate: input.effectiveDate,
    });
    expect((await service.getHistory(viewer, "v1")).map((h) => h.costPrice)).toEqual([COST]);
  });
});

describe("scrierea costului: reguli de dată și validare", () => {
  it("aceeași zi, altă oră din zi: corecția înlocuiește (data intrării se compară pe zi)", async () => {
    const { service, store } = setup();
    await service.setCost(full, {
      variantId: "v1",
      costPrice: 1000,
      effectiveDate: new Date("2026-10-01T15:30:00Z"),
    });
    const out = await service.setCost(full, {
      variantId: "v1",
      costPrice: 1100,
      effectiveDate: new Date("2026-10-01T00:00:00Z"),
    });
    expect(out).toEqual({ applied: true });
    expect(store.variant?.costPrice).toBe(1100);
    // ziua anterioară rămâne doar în istoric
    const older = await service.setCost(full, {
      variantId: "v1",
      costPrice: 900,
      effectiveDate: new Date("2026-09-30T23:59:00Z"),
    });
    expect(older).toEqual({ applied: false });
    expect(store.variant?.costPrice).toBe(1100);
  });

  it("cel mai recent preț de intrare: una mai nouă înlocuiește, una mai veche rămâne doar în istoric", async () => {
    const { service, store } = setup();
    expect(
      await service.setCost(full, {
        variantId: "v1",
        costPrice: 1000,
        effectiveDate: new Date("2026-09-10"),
      }),
    ).toEqual({ applied: true });
    expect(
      await service.setCost(full, {
        variantId: "v1",
        costPrice: 1100,
        effectiveDate: new Date("2026-10-01"),
      }),
    ).toEqual({ applied: true });
    expect(
      await service.setCost(full, {
        variantId: "v1",
        costPrice: 900,
        effectiveDate: new Date("2026-08-01"),
      }),
    ).toEqual({ applied: false });
    expect(store.variant).toEqual({ costPrice: 1100, costPriceDate: new Date("2026-10-01") });
    expect(store.history).toHaveLength(3);
  });

  it("aceeași dată: corecția înlocuiește valoarea", async () => {
    const { service, store } = setup();
    const effectiveDate = new Date("2026-10-01");
    await service.setCost(full, { variantId: "v1", costPrice: 1000, effectiveDate });
    expect(
      await service.setCost(full, { variantId: "v1", costPrice: 1050, effectiveDate }),
    ).toEqual({
      applied: true,
    });
    expect(store.variant?.costPrice).toBe(1050);
  });

  it("refuză sume neîntregi sau negative, dată invalidă sau din viitor, variantă inexistentă", async () => {
    const { service, store } = setup();
    const base = { variantId: "v1", effectiveDate: new Date("2026-10-01") };
    for (const costPrice of [-1, 10.5, Number.NaN]) {
      await expect(service.setCost(full, { ...base, costPrice })).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    }
    await expect(
      service.setCost(full, {
        variantId: "v1",
        costPrice: 1,
        effectiveDate: new Date("nu-e-data"),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      service.setCost(full, {
        variantId: "v1",
        costPrice: 1,
        effectiveDate: new Date("2027-01-01"),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    store.variant = null;
    await expect(service.setCost(full, { ...base, costPrice: 1 })).rejects.toMatchObject({
      code: "CATALOG_VARIANT_NOT_FOUND",
    });
    expect(store.applied).toEqual([]);
  });

  it("mesajele de eroare nu repetă valoarea primită", async () => {
    const { service } = setup();
    const error = (await service
      .setCost(full, { variantId: "v1", costPrice: -987654, effectiveDate: new Date("2026-10-01") })
      .catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain("987654");
    expect(JSON.stringify(error)).not.toContain("987654");
  });
});

describe("audit și loguri: doar faptul și autorul, nicio valoare", () => {
  it("modificarea costului nu lasă nicio valoare (nici veche, nici nouă) în audit sau în loguri", async () => {
    const { service, auditRows, logLines } = setup();
    await service.setCost(full, {
      variantId: "v-77",
      costPrice: OLDER_COST,
      effectiveDate: new Date("2026-08-15"),
    });
    await service.setCost(full, {
      variantId: "v-77",
      costPrice: COST,
      effectiveDate: new Date("2026-10-02"),
    });

    expect(auditRows).toHaveLength(2);
    const audit = JSON.stringify(auditRows);
    const logs = logLines.join("\n");
    for (const blob of [audit, logs]) {
      expect(blob).not.toContain(String(COST));
      expect(blob).not.toContain(String(OLDER_COST));
      expect(blob).not.toContain("2026-08-15");
      expect(blob).not.toContain("2026-10-02");
      expect(blob).not.toMatch(/costPrice/);
    }
    // ...dar spun că s-a schimbat, cine și unde
    expect(auditRows[1]).toMatchObject({
      actorId: "u-1",
      actorLabel: "operator@magazin.test",
      action: "product.cost.update",
      entity: "product_variant",
      entityId: "v-77",
      outcome: "success",
      before: { hadCost: true },
      after: { changed: true, applied: true, source: "manual" },
    });
    expect(logs).toContain("v-77");
    expect(logs).toContain("u-1");
  });

  it("chiar dacă cineva ar pune costul într-un obiect auditat sau logat, mascarea îl scoate", async () => {
    const { auditRows, logLines } = setup();
    const audit = new AuditService({
      async append(row) {
        auditRows.push({ ...row, id: "x", createdAt: new Date() });
      },
      async list() {
        return auditRows;
      },
    });
    await audit.record({
      actorId: "u-1",
      actorLabel: null,
      action: "product.update",
      entity: "product_variant",
      before: { variant: { price: 100, costPrice: COST, newCostPrice: OLDER_COST } },
    });
    expect(JSON.stringify(auditRows)).not.toContain(String(COST));
    expect(JSON.stringify(auditRows)).not.toContain(String(OLDER_COST));
    expect(logLines).toEqual([]);
  });
});

describe("roluri: cine poate ce", () => {
  it("orice rol care poate edita costul îl poate și vedea", () => {
    for (const role of DEFAULT_ROLES) {
      const perms = new Set<string>(role.permissions);
      if (perms.has("products.cost.edit")) {
        expect(perms.has("products.cost.view"), `rolul ${role.key}`).toBe(true);
      }
    }
  });

  it("costul îl văd exact Owner, Admin, Manager și Contabil; îl editează doar Owner și Admin", () => {
    const withPerm = (permission: string) =>
      DEFAULT_ROLES.filter((r) => (r.permissions as readonly string[]).includes(permission))
        .map((r) => r.key)
        .sort();
    // Owner are implicit toate permisiunile (nu stă în lista de permisiuni explicite).
    expect(withPerm("products.cost.view")).toEqual(
      expect.not.arrayContaining(["editor", "support", "warehouse"]),
    );
    expect(withPerm("products.cost.view")).toEqual(
      expect.arrayContaining(["admin", "manager", "accountant"]),
    );
    expect(withPerm("products.cost.edit")).not.toContain("manager");
  });
});

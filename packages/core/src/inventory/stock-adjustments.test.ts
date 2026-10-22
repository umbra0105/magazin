import { describe, expect, it } from "vitest";
import { ForbiddenError, UnauthenticatedError, parseQuantity, type Quantity } from "@ecom/shared";
import { AuditService, type AuditRow, type AuditStore } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { DEFAULT_ROLES } from "../rbac/catalog";
import { StockAdjustmentService } from "./stock-adjustments";
import type { AdjustPhysicalInput, AdjustPhysicalResult } from "./stock-service";

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

const q = (text: string): Quantity => parseQuantity(text);

function setup(result: Partial<AdjustPhysicalResult> = {}) {
  const calls: AdjustPhysicalInput[] = [];
  const stock = {
    async adjustPhysical(input: AdjustPhysicalInput): Promise<AdjustPhysicalResult> {
      calls.push(input);
      return {
        variantId: input.variantId,
        warehouseId: input.warehouseId ?? "w-main",
        movementId: "mv-1",
        delta: input.delta,
        physicalBefore: q("7"),
        physicalAfter: q("4"),
        effectiveAt: input.effectiveAt ?? new Date("2026-10-22T10:00:00Z"),
        warnings: [],
        ...result,
      };
    },
  };
  const rows: AuditRow[] = [];
  const store: AuditStore = {
    async append(row) {
      rows.push({ ...row, id: `a${rows.length}`, createdAt: new Date() });
    },
    async list() {
      return rows;
    },
  };
  const service = new StockAdjustmentService({ stock, audit: new AuditService(store) });
  return { service, calls, rows };
}

const valid = {
  variantId: "var-1",
  quantity: "-3",
  reason: "sale_in_store",
  note: "Vândut la tejghea, bon 123",
};

async function failure(fn: () => Promise<unknown>) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as { code?: string; message: string; name?: string };
  }
}

describe("ajustarea de stoc din admin: permisiuni", () => {
  it("managerul poate; editorul, suportul și anonimul nu, iar în acest caz nu se atinge nimic", async () => {
    const allowed = setup();
    await allowed.service.adjust(roleSubject("manager"), valid);
    expect(allowed.calls).toHaveLength(1);

    for (const role of ["editor", "support"]) {
      const denied = setup();
      const error = await failure(() => denied.service.adjust(roleSubject(role), valid));
      expect(error, role).toBeInstanceOf(ForbiddenError);
      expect(denied.calls, role).toHaveLength(0);
      expect(denied.rows, role).toHaveLength(0);
    }
    const anonymous = setup();
    expect(await failure(() => anonymous.service.adjust(null, valid))).toBeInstanceOf(
      UnauthenticatedError,
    );
    expect(anonymous.calls).toHaveLength(0);
  });
});

describe("ajustarea de stoc din admin: intrarea", () => {
  it("cantitatea e text cu semn, cu virgulă; în serviciu ajunge ca variație exactă", async () => {
    const cases: Array<[string, bigint]> = [
      ["-3", -30000n],
      ["+3", 30000n],
      ["2,5", 25000n],
      ["-0,0001", -1n],
      ["  -41,25 ", -412500n],
    ];
    for (const [text, ticks] of cases) {
      const { service, calls } = setup();
      await service.adjust(roleSubject("manager"), {
        ...valid,
        quantity: text,
        reason: "other",
      });
      expect(calls[0]?.delta, text).toBe(ticks);
    }
  });

  it("refuză text care nu e cantitate și separatorul ambiguu (1.234 poate fi 1234 sau 1,234)", async () => {
    for (const text of ["abc", "", "--1", "1,2,3", "12 buc"]) {
      const { service, calls } = setup();
      const error = await failure(() =>
        service.adjust(roleSubject("manager"), { ...valid, quantity: text }),
      );
      expect(error, text).not.toBeNull();
      expect(calls, text).toHaveLength(0);
    }
    const { service, calls } = setup();
    const ambiguous = await failure(() =>
      service.adjust(roleSubject("manager"), { ...valid, quantity: "-1.234" }),
    );
    expect(ambiguous?.code).toBe("STOCK_ADJUSTMENT_AMBIGUOUS_QUANTITY");
    expect(calls).toHaveLength(0);
  });

  it("motivul trebuie să fie unul fix; textul liber e obligatoriu (nu doar spații) și are limită", async () => {
    const bad: Array<Record<string, unknown>> = [
      { reason: "altceva" },
      { reason: undefined },
      { note: "" },
      { note: "   " },
      { note: "x".repeat(501) },
      { variantId: "" },
      { extra: "nu e permis" },
      { effectiveAt: "nu e o dată" },
    ];
    for (const override of bad) {
      const { service, calls } = setup();
      const error = await failure(() =>
        service.adjust(roleSubject("manager"), { ...valid, ...override }),
      );
      expect(error?.name, JSON.stringify(override)).toBe("ValidationError");
      expect(calls, JSON.stringify(override)).toHaveLength(0);
    }
  });

  it("textul liber se taie la margini; ora efectivă vine ca text ISO și devine dată; depozitul e opțional", async () => {
    const { service, calls } = setup();
    await service.adjust(roleSubject("manager"), {
      ...valid,
      note: "  Vândut la tejghea  ",
      effectiveAt: "2026-10-22T09:30:00.000Z",
      warehouseId: "w-2",
    });
    expect(calls[0]).toMatchObject({
      variantId: "var-1",
      warehouseId: "w-2",
      reason: "sale_in_store",
      note: "Vândut la tejghea",
    });
    expect(calls[0]?.effectiveAt?.toISOString()).toBe("2026-10-22T09:30:00.000Z");

    const bare = setup();
    await bare.service.adjust(roleSubject("manager"), valid);
    expect(bare.calls[0]?.warehouseId).toBeUndefined();
    expect(bare.calls[0]?.effectiveAt).toBeUndefined();
  });

  it("autorul ajustării e utilizatorul autentificat (id și email), nu ceva din cerere", async () => {
    const { service, calls } = setup();
    await service.adjust(roleSubject("manager"), valid);
    expect(calls[0]?.actor).toEqual({ id: "u-manager", label: "manager@magazin.test" });
  });
});

describe("ajustarea de stoc din admin: audit și rezultat", () => {
  it("scrie un rând de audit cu stocul înainte/după, motivul și ora; întoarce rezultatul serviciului", async () => {
    const { service, rows } = setup({
      warnings: ["effective_before_snapshot"],
    });
    const result = await service.adjust(roleSubject("manager"), valid);
    expect(result.warnings).toEqual(["effective_before_snapshot"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: "u-manager",
      actorLabel: "manager@magazin.test",
      action: "stock.adjust",
      entity: "inventory_item",
      entityId: "var-1:w-main",
      outcome: "success",
      before: { physical: "7" },
      after: {
        physical: "4",
        delta: "-3",
        reason: "sale_in_store",
        note: "Vândut la tejghea, bon 123",
        effectiveAt: "2026-10-22T10:00:00.000Z",
      },
    });
  });

  it("dacă serviciul de stoc refuză (de ex. sub zero), nu se scrie niciun audit de succes", async () => {
    const { rows, calls } = setup();
    const refusing = new StockAdjustmentService({
      stock: {
        async adjustPhysical() {
          calls.push({} as AdjustPhysicalInput);
          throw Object.assign(new Error("Stocul nu poate deveni negativ"), {
            code: "STOCK_ADJUSTMENT_BELOW_ZERO",
          });
        },
      },
      audit: new AuditService({
        async append(row) {
          rows.push({ ...row, id: "x", createdAt: new Date() });
        },
        async list() {
          return rows;
        },
      }),
    });
    const error = await failure(() => refusing.adjust(roleSubject("manager"), valid));
    expect(error?.code).toBe("STOCK_ADJUSTMENT_BELOW_ZERO");
    expect(rows).toHaveLength(0);
  });
});

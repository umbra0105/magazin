import { describe, expect, it } from "vitest";
import { ForbiddenError, UnauthenticatedError } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { DEFAULT_ROLES } from "../rbac/catalog";
import { MemoryAudit } from "../test-utils/memory-audit";
import { StockTransferService } from "./stock-transfer";

/**
 * Faza 5, punctul 13b: refuzurile transferului care trebuie să vină ÎNAINTE de orice acces la baza de date (steagul
 * oprit, drepturile, forma cererii, același depozit). Baza e un obiect care aruncă la orice atingere: dacă serviciul o
 * folosește înainte de a refuza, testul pică. Regulile de stoc (disponibil, pas, unitate, depozite dezactivate,
 * atomicitate) sunt în `stock-transfer.integration.test.ts`, pe Postgres real.
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

const untouchable = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`baza atinsă înainte de refuz: ${String(property)}`);
    },
  },
) as never;

function setup(enabled = true) {
  const audit = new MemoryAudit();
  const flag = { enabled, reads: 0 };
  const service = new StockTransferService({
    db: untouchable,
    audit: new AuditService(audit),
    isEnabled: async () => {
      flag.reads++;
      return flag.enabled;
    },
  });
  return { service, audit, flag, manager: roleSubject("manager") };
}

const valid = {
  variantId: "v1",
  fromWarehouseId: "w1",
  toWarehouseId: "w2",
  quantity: "2",
};

const rejection = async (fn: () => Promise<unknown>): Promise<{ code?: string } | null> => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as { code?: string };
  }
};

describe("steagul multiWarehouse oprit: transferul e refuzat înaintea drepturilor și a bazei", () => {
  it("aruncă FEATURE_DISABLED chiar și pentru un anonim sau pentru o cerere greșită; steagul se citește la fiecare apel", async () => {
    const { service, audit, flag, manager } = setup(false);
    for (const [subject, input] of [
      [manager, valid],
      [null, valid],
      [roleSubject("editor"), valid],
      [manager, { nimic: "bun" }],
      [manager, { ...valid, toWarehouseId: "w1" }],
    ] as const) {
      expect((await rejection(() => service.transfer(subject, input)))?.code).toBe(
        "FEATURE_DISABLED",
      );
    }
    expect(flag.reads).toBe(5);
    expect(audit.rows).toEqual([]);
  });

  it("pornit apoi oprit: refuză din nou, fără nicio copie a steagului", async () => {
    const { service, flag, manager } = setup(true);
    // pornit: ajunge la bază (care aruncă), deci steagul NU a refuzat
    expect((await rejection(() => service.transfer(manager, valid)))?.code).toBeUndefined();
    flag.enabled = false;
    expect((await rejection(() => service.transfer(manager, valid)))?.code).toBe(
      "FEATURE_DISABLED",
    );
  });
});

describe("drepturi: inventory.write", () => {
  it("Editor, Suport și Contabil nu pot; un rol doar cu citire nu poate; anonimul primește UnauthenticatedError", async () => {
    const { service, audit } = setup();
    for (const role of ["editor", "support", "accountant"]) {
      await expect(service.transfer(roleSubject(role), valid), role).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    const reader: PermissionSubject = {
      userId: "u-r",
      email: "r@magazin.test",
      roles: ["custom"],
      permissions: new Set(["admin.access", "inventory.read"]),
    };
    await expect(service.transfer(reader, valid)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.transfer(null, valid)).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(audit.rows).toEqual([]);
  });
});

describe("forma cererii: refuzată înainte de bază", () => {
  it.each([
    ["fără variantă", { ...valid, variantId: "" }],
    ["fără depozit sursă", { ...valid, fromWarehouseId: "" }],
    ["fără depozit destinație", { ...valid, toWarehouseId: "  " }],
    ["fără cantitate", { ...valid, quantity: "" }],
    ["câmp în plus", { ...valid, extra: 1 }],
    ["cantitate număr, nu text", { ...valid, quantity: 2 }],
    ["notă prea lungă", { ...valid, note: "x".repeat(501) }],
    ["cerere goală", {}],
    ["cerere nulă", null],
  ])("%s → VALIDATION_ERROR", async (_name, input) => {
    const { service, manager } = setup();
    expect((await rejection(() => service.transfer(manager, input)))?.code).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("cantitate ambiguă («1.234») → refuz cu cod stabil", async () => {
    const { service, manager } = setup();
    expect(
      (await rejection(() => service.transfer(manager, { ...valid, quantity: "1.234" })))?.code,
    ).toBe("STOCK_TRANSFER_AMBIGUOUS_QUANTITY");
  });

  it.each(["0", "0,0000", "-1", "+2", "abc", "1,23456", "99999999999"])(
    "cantitate «%s» → refuz înainte de bază",
    async (quantity) => {
      const { service, manager } = setup();
      const error = await rejection(() => service.transfer(manager, { ...valid, quantity }));
      // un cod stabil = refuz de domeniu; lipsa lui ar fi eroarea «baza atinsă» a obiectului de mai sus
      expect(error?.code, quantity).toBeTypeOf("string");
    },
  );

  it("același depozit → STOCK_TRANSFER_SAME_WAREHOUSE, fără să atingă baza", async () => {
    const { service, manager } = setup();
    expect(
      (await rejection(() => service.transfer(manager, { ...valid, toWarehouseId: "w1" })))?.code,
    ).toBe("STOCK_TRANSFER_SAME_WAREHOUSE");
  });
});

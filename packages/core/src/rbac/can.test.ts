import { describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthenticatedError } from "@ecom/shared";
import { DEFAULT_ROLES, PERMISSION_KEYS, type PermissionKey } from "./catalog";
import {
  assertCan,
  can,
  createWithPermission,
  hasAdminAccess,
  type PermissionSubject,
} from "./can";

function subjectFor(roleKeys: string[]): PermissionSubject {
  const roles = DEFAULT_ROLES.filter((r) => roleKeys.includes(r.key));
  return {
    userId: `u-${roleKeys.join("-")}`,
    email: "x@test.invalid",
    roles: roleKeys,
    permissions: new Set(roles.flatMap((r) => r.permissions)),
  };
}

describe("can(): fiecare rol are acces exact la ce trebuie", () => {
  for (const role of DEFAULT_ROLES) {
    it(`${role.key}: permis doar pentru permisiunile din catalog`, () => {
      const subject = subjectFor([role.key]);
      for (const permission of PERMISSION_KEYS) {
        const expected = role.key === "owner" || role.permissions.includes(permission);
        expect(can(subject, permission), `${role.key} → ${permission}`).toBe(expected);
      }
    });
  }

  it("un Suport nu poate șterge/arhiva produse și nici modifica produse sau setări", () => {
    const support = subjectFor(["support"]);
    expect(can(support, "products.archive")).toBe(false);
    expect(can(support, "products.write")).toBe(false);
    expect(can(support, "settings.write")).toBe(false);
    expect(can(support, "orders.cancel")).toBe(true);
  });

  it("rambursarea: doar Manager, Admin și Owner; Suportul nu, până există limita de rambursare", () => {
    const allowed = DEFAULT_ROLES.filter((r) => can(subjectFor([r.key]), "orders.refund")).map(
      (r) => r.key,
    );
    expect(allowed.sort()).toEqual(["admin", "manager", "owner"]);
    expect(can(subjectFor(["support"]), "orders.refund")).toBe(false);
  });

  it("Depozit nu rambursează și nu vede prețul de achiziție; Contabil nu modifică comenzi", () => {
    expect(can(subjectFor(["warehouse"]), "orders.refund")).toBe(false);
    expect(can(subjectFor(["warehouse"]), "products.cost.view")).toBe(false);
    expect(can(subjectFor(["accountant"]), "orders.write")).toBe(false);
  });

  it("Owner are tot, inclusiv o permisiune nouă care nu e încă în baza lui de date", () => {
    const owner: PermissionSubject = { ...subjectFor(["owner"]), permissions: new Set() };
    expect(can(owner, "system.update")).toBe(true);
    expect(can(owner, "products.cost.edit")).toBe(true);
  });

  it("Admin nu poate actualiza sistemul și nu modifică integrările", () => {
    const admin = subjectFor(["admin"]);
    expect(can(admin, "system.update")).toBe(false);
    expect(can(admin, "integrations.write")).toBe(false);
    expect(can(admin, "users.manage")).toBe(true);
  });

  it("roluri multiple se adună", () => {
    const both = subjectFor(["support", "editor"]);
    expect(can(both, "orders.cancel")).toBe(true);
    expect(can(both, "content.write")).toBe(true);
    expect(can(both, "products.archive")).toBe(false);
  });

  it("fără utilizator sau fără roluri (client) nimeni nu are nicio permisiune", () => {
    const customer: PermissionSubject = {
      userId: "c",
      email: "c@test.invalid",
      roles: [],
      // chiar dacă permisiunile ar fi umplute din greșeală, fără rol nu există acces
      permissions: new Set(PERMISSION_KEYS),
    };
    for (const permission of PERMISSION_KEYS) {
      expect(can(customer, permission)).toBe(false);
      expect(can(null, permission)).toBe(false);
    }
    expect(hasAdminAccess(customer)).toBe(false);
    expect(hasAdminAccess(null)).toBe(false);
    expect(hasAdminAccess(subjectFor(["editor"]))).toBe(true);
  });
});

describe("admin.access: poarta către admin", () => {
  const custom = (permissions: string[]): PermissionSubject => ({
    userId: "custom",
    email: "custom@test.invalid",
    roles: ["rol-personalizat"],
    permissions: new Set(permissions),
  });

  it("un utilizator cu un rol FĂRĂ admin.access nu intră în admin și nu poate nimic", () => {
    const subject = custom(["orders.read", "orders.write", "products.archive", "settings.write"]);
    expect(hasAdminAccess(subject)).toBe(false);
    for (const permission of PERMISSION_KEYS.filter((p) => p !== "admin.access")) {
      expect(can(subject, permission), permission).toBe(false);
    }
  });

  it("același rol, după ce primește admin.access, intră și poate doar ce are", () => {
    const subject = custom(["admin.access", "orders.read"]);
    expect(hasAdminAccess(subject)).toBe(true);
    expect(can(subject, "admin.access")).toBe(true);
    expect(can(subject, "orders.read")).toBe(true);
    expect(can(subject, "orders.write")).toBe(false);
  });

  it("clientul fără roluri nu intră, chiar dacă i s-ar fi atașat admin.access fără rol", () => {
    const customer: PermissionSubject = {
      userId: "c",
      email: "c@test.invalid",
      roles: [],
      permissions: new Set(["admin.access"]),
    };
    expect(hasAdminAccess(customer)).toBe(false);
    expect(can(customer, "admin.access")).toBe(false);
  });

  it("withPermission refuză cu ForbiddenError un rol fără admin.access, chiar cu permisiunea cerută", async () => {
    const action = createWithPermission({ getSubject: async () => custom(["orders.read"]) })(
      "orders.read",
      async () => "ok",
    );
    await expect(action(undefined)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("assertCan()", () => {
  it("aruncă UnauthenticatedError fără utilizator și ForbiddenError cu permisiunea cerută", () => {
    expect(() => assertCan(null, "orders.read")).toThrow(UnauthenticatedError);
    try {
      assertCan(subjectFor(["support"]), "products.archive");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).code).toBe("AUTH_FORBIDDEN");
      expect((error as ForbiddenError).details).toEqual({ permission: "products.archive" });
    }
  });
});

describe("withPermission()", () => {
  const make = (subject: PermissionSubject | null) =>
    createWithPermission({ getSubject: async () => subject });

  it("rulează acțiunea cu inputul și utilizatorul când permisiunea există", async () => {
    const handler = vi.fn(
      async (input: { id: string }, s: PermissionSubject) => `${input.id}:${s.userId}`,
    );
    const subject = subjectFor(["manager"]);
    const action = make(subject)("orders.refund", handler);
    expect(await action({ id: "o1" })).toBe(`o1:${subject.userId}`);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("NU rulează acțiunea și aruncă ForbiddenError când permisiunea lipsește", async () => {
    const handler = vi.fn(async () => "șters");
    const action = make(subjectFor(["support"]))("products.archive", handler);
    await expect(action(undefined)).rejects.toBeInstanceOf(ForbiddenError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("NU rulează acțiunea și aruncă UnauthenticatedError fără sesiune", async () => {
    const handler = vi.fn(async () => "ok");
    await expect(make(null)("orders.read", handler)(undefined)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("verifică la FIECARE apel: un rol retras se aplică imediat", async () => {
    let subject: PermissionSubject | null = subjectFor(["manager"]);
    const action = createWithPermission({ getSubject: async () => subject })(
      "orders.refund" satisfies PermissionKey,
      async () => "ok",
    );
    expect(await action(undefined)).toBe("ok");
    subject = subjectFor(["warehouse"]);
    await expect(action(undefined)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

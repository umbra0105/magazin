import { describe, expect, it } from "vitest";
import { DEFAULT_ROLES, PERMISSION_KEYS, type PERMISSIONS } from "./catalog";

const rolesWith = (permission: keyof typeof PERMISSIONS) =>
  DEFAULT_ROLES.filter((role) => role.permissions.includes(permission))
    .map((role) => role.key)
    .sort();

describe("catalogul RBAC", () => {
  it("permisiunile catalogului din Faza 4: cine ce poate (decizii ale utilizatorului)", () => {
    // conținut (descriere, SEO, media, documente): Editor, Manager, Admin, Owner
    expect(rolesWith("products.content.write")).toEqual(["admin", "editor", "manager", "owner"]);
    // structură, prețuri, import: fără Editor
    expect(rolesWith("products.write")).toEqual(["admin", "manager", "owner"]);
    expect(rolesWith("products.export")).toEqual(["admin", "manager", "owner"]);
    // ID-urile din magazinul vechi: doar Admin și Owner
    expect(rolesWith("catalog.legacy.edit")).toEqual(["admin", "owner"]);
    // Editorul nu poate scrie preț, import sau export
    const editor = DEFAULT_ROLES.find((role) => role.key === "editor");
    for (const key of ["products.write", "products.export", "catalog.legacy.edit"] as const) {
      expect(editor?.permissions, key).not.toContain(key);
    }
  });

  it("prețul de achiziție (products.cost.view) îl văd Owner, Admin, Manager și Contabil", () => {
    expect(rolesWith("products.cost.view")).toEqual(["accountant", "admin", "manager", "owner"]);
  });

  it("Editor, Suport și Depozit NU văd prețul de achiziție și nu îl pot modifica", () => {
    for (const key of ["editor", "support", "warehouse"]) {
      const role = DEFAULT_ROLES.find((r) => r.key === key);
      expect(role?.permissions, key).not.toContain("products.cost.view");
      expect(role?.permissions, key).not.toContain("products.cost.edit");
    }
  });

  it("modificarea prețului de achiziție (products.cost.edit) o au doar Owner și Admin", () => {
    expect(rolesWith("products.cost.edit")).toEqual(["admin", "owner"]);
  });

  it("media.read o au rolurile care văd produse sau conținut; media.write rămâne la Owner, Admin, Editor", () => {
    expect(rolesWith("media.read")).toEqual(["admin", "editor", "manager", "owner", "warehouse"]);
    expect(rolesWith("media.write")).toEqual(["admin", "editor", "owner"]);
  });

  it("oricine poate încărca fișiere poate și să le vadă (media.write implică media.read)", () => {
    for (const role of DEFAULT_ROLES) {
      if (role.permissions.includes("media.write")) {
        expect(role.permissions, role.key).toContain("media.read");
      }
    }
  });

  it("fiecare rol folosește doar permisiuni din catalog, fără duplicate", () => {
    for (const role of DEFAULT_ROLES) {
      expect(new Set(role.permissions).size, role.key).toBe(role.permissions.length);
      for (const permission of role.permissions) {
        expect(PERMISSION_KEYS, `${role.key}: ${permission}`).toContain(permission);
      }
    }
  });

  it("rolurile implicite sunt cele 7 din docs/04 §6", () => {
    expect(DEFAULT_ROLES.map((r) => r.key)).toEqual([
      "owner",
      "admin",
      "manager",
      "editor",
      "support",
      "warehouse",
      "accountant",
    ]);
  });

  it("Owner are toate permisiunile; Admin nu are system.update și integrations.write", () => {
    expect(DEFAULT_ROLES.find((r) => r.key === "owner")?.permissions).toHaveLength(
      PERMISSION_KEYS.length,
    );
    const admin = DEFAULT_ROLES.find((r) => r.key === "admin")?.permissions ?? [];
    expect(admin).not.toContain("system.update");
    expect(admin).not.toContain("integrations.write");
  });
});

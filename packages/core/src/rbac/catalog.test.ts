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

  it("stocul (Faza 5): inventory.read și inventory.write le au Owner, Admin, Manager și Depozit; Editor, Suport și Contabil nu văd cantitățile", () => {
    expect(rolesWith("inventory.read")).toEqual(["admin", "manager", "owner", "warehouse"]);
    expect(rolesWith("inventory.write")).toEqual(["admin", "manager", "owner", "warehouse"]);
    for (const key of ["editor", "support", "accountant"]) {
      const role = DEFAULT_ROLES.find((r) => r.key === key);
      expect(role?.permissions, key).not.toContain("inventory.read");
      expect(role?.permissions, key).not.toContain("inventory.write");
    }
  });

  it("inventory.write implică inventory.read (cine poate ajusta stocul îl și vede)", () => {
    for (const role of DEFAULT_ROLES) {
      if (role.permissions.includes("inventory.write")) {
        expect(role.permissions, role.key).toContain("inventory.read");
      }
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

  it("importul prețurilor de achiziție (products.cost.import) îl au doar Owner și Admin; Manager și Contabil doar văd costul", () => {
    expect(rolesWith("products.cost.import")).toEqual(["admin", "owner"]);
    for (const key of ["manager", "accountant", "editor", "support", "warehouse"]) {
      const role = DEFAULT_ROLES.find((r) => r.key === key);
      expect(role?.permissions, key).not.toContain("products.cost.import");
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

describe("permisiunile plăților (Faza 10)", () => {
  const rolesWith = (permission: (typeof PERMISSION_KEYS)[number]) =>
    DEFAULT_ROLES.filter((r) => r.permissions.includes(permission)).map((r) => r.key);

  it("citirea plăților: Owner, Admin, Manager, Contabil", () => {
    expect(rolesWith("payments.read")).toEqual(["owner", "admin", "manager", "accountant"]);
  });

  it("rambursarea fără limită (payments.refund): doar Owner, Admin, Manager (Suport, Contabil, Depozit, Editor nu)", () => {
    expect(rolesWith("payments.refund")).toEqual(["owner", "admin", "manager"]);
  });

  it("rambursarea din comandă (orders.refund): Owner, Admin, Manager și Suport; Suport o are CU LIMITĂ (fără payments.refund), decizia 2026-11-19", () => {
    expect(rolesWith("orders.refund")).toEqual(["owner", "admin", "manager", "support"]);
    const support = DEFAULT_ROLES.find((r) => r.key === "support");
    expect(support?.permissions).toContain("orders.refund");
    expect(support?.permissions).not.toContain("payments.refund");
    expect(support?.description).toMatch(/limit/i);
  });

  it("configurarea (chei, mod test/live): DOAR Owner, ca la cheile de integrare; Adminul nu are acces la chei", () => {
    expect(rolesWith("payments.configure")).toEqual(["owner"]);
  });

  it("rambursarea și configurarea cer și citirea plăților (nimeni nu poate rambursa fără să vadă plata)", () => {
    for (const role of DEFAULT_ROLES) {
      if (role.permissions.includes("payments.refund")) {
        expect(role.permissions, role.key).toContain("payments.read");
      }
    }
  });
});

describe("permisiunile comenzilor și emailurilor (Faza 11)", () => {
  it("ofertele de plată (orders.offers): Owner, Admin, Manager; NU Suport, Depozit, Editor, Contabil", () => {
    expect(
      DEFAULT_ROLES.filter((r) => r.permissions.includes("orders.offers")).map((r) => r.key),
    ).toEqual(["owner", "admin", "manager"]);
  });

  const rolesWith = (permission: (typeof PERMISSION_KEYS)[number]) =>
    DEFAULT_ROLES.filter((r) => r.permissions.includes(permission)).map((r) => r.key);

  it("«marchează plătit» (transfer bancar): Owner, Admin, Manager; nu Suport, Depozit, Editor, Contabil", () => {
    expect(rolesWith("orders.mark_paid")).toEqual(["owner", "admin", "manager"]);
  });

  it("emailurile: citirea (șabloane, jurnal) Owner, Admin, Manager; scrierea (suprascriere, test, retrimitere) Owner, Admin", () => {
    expect(rolesWith("email.read")).toEqual(["owner", "admin", "manager"]);
    expect(rolesWith("email.write")).toEqual(["owner", "admin"]);
  });

  it("serverul SMTP: DOAR Owner, ca la cheile de integrare (Adminul nu vede parola SMTP)", () => {
    expect(rolesWith("email.configure")).toEqual(["owner"]);
  });

  it("scrierea cere citirea: nimeni nu suprascrie șabloane fără să le vadă", () => {
    for (const role of DEFAULT_ROLES) {
      if (role.permissions.includes("email.write"))
        expect(role.permissions, role.key).toContain("email.read");
      if (role.permissions.includes("email.configure"))
        expect(role.permissions, role.key).toContain("email.read");
    }
  });
});

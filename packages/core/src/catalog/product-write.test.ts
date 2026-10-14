import { describe, expect, it } from "vitest";
import { ForbiddenError, UnauthenticatedError, ValidationError } from "@ecom/shared";
import { AuditService, type AuditRow, type AuditStore } from "../audit/audit-service";
import { can, type PermissionSubject } from "../rbac/can";
import { DEFAULT_ROLES } from "../rbac/catalog";
import {
  classifyProductUpdate,
  PRODUCT_CONTENT_FIELDS,
  ProductFieldsForbiddenError,
  ProductUpdateGuard,
} from "./product-write";

/** Subiect construit din rolul implicit real, nu din permisiuni scrise de mână. */
function roleSubject(roleKey: string): PermissionSubject {
  const role = DEFAULT_ROLES.find((r) => r.key === roleKey);
  if (!role) throw new Error(`rol necunoscut: ${roleKey}`);
  return {
    userId: `u-${roleKey}`,
    email: `${roleKey}@magazin.test`,
    roles: [roleKey],
    permissions: new Set<string>(role.permissions),
  };
}

function custom(permissions: string[]): PermissionSubject {
  return {
    userId: "u-custom",
    email: "custom@magazin.test",
    roles: ["custom"],
    permissions: new Set(["admin.access", ...permissions]),
  };
}

function setup() {
  const rows: AuditRow[] = [];
  const store: AuditStore = {
    async append(row) {
      rows.push({ ...row, id: `a-${rows.length}`, createdAt: new Date() });
    },
    async list() {
      return rows;
    },
  };
  const applied: unknown[] = [];
  const guard = new ProductUpdateGuard({ audit: new AuditService(store) });
  const run = (subject: PermissionSubject | null, payload: Record<string, unknown>) =>
    guard.run(subject, { productId: "p-1" }, payload, async (p) => {
      applied.push(p);
      return { ok: true as const };
    });
  return { rows, applied, run };
}

/** Câmpurile pe care un Editor NU are voie să le trimită (deny-by-default), fiecare testat separat. */
const FORBIDDEN_FOR_EDITOR = [
  // preț
  "price",
  // preț redus și fereastra
  "salePrice",
  "saleStartsAt",
  "saleEndsAt",
  // stoc
  "manageStock",
  "stockStatus",
  "allowBackorder",
  "expectedRestockDate",
  // cost
  "costPrice",
  "costPriceDate",
  // clasă de livrare și TVA
  "shippingClass",
  "taxClassId",
  // restul modelului: tot deny-by-default
  "variants",
  "status",
  "brandId",
  "categories",
  "excludeFromGroupDiscount",
  "requiresInstallation",
  "campNouAdaugatMaiTarziu",
] as const;

describe("clasificarea cererii", () => {
  it("împarte conținutul de restul; câmpurile necunoscute sunt restricționate (deny-by-default)", () => {
    expect(
      classifyProductUpdate({
        title: "x",
        price: 1,
        costPrice: 2,
        campNou: true,
        seoTitle: undefined,
      }),
    ).toEqual({
      content: ["title"],
      restricted: ["price", "costPrice", "campNou"],
      cost: ["costPrice"],
    });
  });

  it("câmpurile de conținut nu includ nimic de preț, stoc, cost, livrare sau TVA", () => {
    for (const field of PRODUCT_CONTENT_FIELDS) {
      expect(field).not.toMatch(/price|cost|stock|shipping|tax|sale|variant|brand|status/i);
    }
  });
});

describe("Editor (doar products.content.write)", () => {
  it.each(FORBIDDEN_FOR_EDITOR)(
    "câmpul %s trimis împreună cu conținut: refuz 403 cu mesaj clar, nimic aplicat, audit denied fără valoare",
    async (field) => {
      const { rows, applied, run } = setup();
      const value =
        field.includes("At") || field.includes("Date") ? "2031-05-17T08:09:10Z" : 987123;
      const error = await run(roleSubject("editor"), { title: "Titlu nou", [field]: value }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(ProductFieldsForbiddenError);
      const forbidden = error as ProductFieldsForbiddenError;
      expect(forbidden.status).toBe(403);
      expect(forbidden.code).toBe("AUTH_FORBIDDEN");
      expect(forbidden.fields).toEqual([field]);
      expect(forbidden.message).toMatch(/Nu ai permisiunea să modifici/);
      expect(forbidden.message).toContain("products.write");

      // cererea mixtă se respinge ÎNTREAGĂ: nici titlul nu s-a aplicat
      expect(applied).toEqual([]);

      // auditul: denied, cu NUMELE câmpului, fără valoarea trimisă
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "product.update",
        entity: "product",
        entityId: "p-1",
        outcome: "denied",
        actorId: "u-editor",
      });
      const audit = JSON.stringify(rows);
      expect(audit).toContain(field);
      expect(audit).not.toContain(String(value));
      expect(audit).not.toContain("Titlu nou");
      expect(JSON.stringify(error)).not.toContain(String(value));
      expect(forbidden.message).not.toContain(String(value));
    },
  );

  it("câmp interzis singur (fără conținut): același refuz", async () => {
    const { applied, run } = setup();
    await expect(run(roleSubject("editor"), { price: 19900 })).rejects.toBeInstanceOf(
      ProductFieldsForbiddenError,
    );
    expect(applied).toEqual([]);
  });

  it("cererea cu mai multe câmpuri interzise le listează pe toate, fără valori", async () => {
    const { rows, run } = setup();
    const error = (await run(roleSubject("editor"), {
      description: "text",
      price: 111,
      stockStatus: "outofstock",
      costPrice: 222,
    }).catch((e: unknown) => e)) as ProductFieldsForbiddenError;
    expect([...error.fields].sort()).toEqual(["costPrice", "price", "stockStatus"]);
    expect(JSON.stringify(rows)).not.toMatch(/111|222|outofstock/);
  });

  it("fiecare câmp de conținut, singur sau împreună, trece și se aplică exact ca trimis", async () => {
    const { rows, applied, run } = setup();
    for (const field of PRODUCT_CONTENT_FIELDS) {
      await run(roleSubject("editor"), { [field]: `valoare-${field}` });
    }
    const all = Object.fromEntries(PRODUCT_CONTENT_FIELDS.map((f) => [f, `v-${f}`]));
    expect(await run(roleSubject("editor"), all)).toEqual({ ok: true });
    expect(applied).toHaveLength(PRODUCT_CONTENT_FIELDS.length + 1);
    expect(applied.at(-1)).toEqual(all);
    expect(rows).toEqual([]); // reușitele nu produc intrări de refuz
  });
});

describe("alte roluri", () => {
  it("un rol fără nicio permisiune de produs (Suport, Depozit, Contabil) primește refuz de permisiune, auditat", async () => {
    for (const role of ["support", "warehouse", "accountant"]) {
      const { rows, applied, run } = setup();
      await expect(run(roleSubject(role), { title: "x" })).rejects.toBeInstanceOf(ForbiddenError);
      expect(applied).toEqual([]);
      expect(rows[0]).toMatchObject({ outcome: "denied", actorId: `u-${role}` });
    }
  });

  it("neautentificat: UnauthenticatedError; cerere goală: ValidationError", async () => {
    const { run } = setup();
    await expect(run(null, { title: "x" })).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(run(roleSubject("manager"), {})).rejects.toBeInstanceOf(ValidationError);
    await expect(run(roleSubject("manager"), { title: undefined })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("Manager, Admin și Owner pot modifica și conținutul, și prețul/stocul (nu costul fără cost.edit)", async () => {
    for (const role of ["manager", "admin", "owner"]) {
      const { applied, run } = setup();
      await run(roleSubject(role), {
        title: "T",
        price: 19900,
        salePrice: 17900,
        stockStatus: "instock",
        shippingClass: "pallet",
        taxClassId: null,
      });
      expect(applied, role).toHaveLength(1);
    }
  });

  it("costul în cerere cere cost.edit ȘI cost.view: Manager (doar view) e refuzat, Admin/Owner trec", async () => {
    const manager = setup();
    const error = (await manager
      .run(roleSubject("manager"), { title: "T", costPrice: 123 })
      .catch((e: unknown) => e)) as ProductFieldsForbiddenError;
    expect(error).toBeInstanceOf(ProductFieldsForbiddenError);
    expect(error.requiredPermissions).toEqual(["products.cost.edit"]);
    expect(manager.applied).toEqual([]);

    for (const role of ["admin", "owner"]) {
      const { applied, run } = setup();
      await run(roleSubject(role), { costPrice: 123 });
      expect(applied, role).toHaveLength(1);
    }
  });

  it("products.cost.edit FĂRĂ products.cost.view (rol personalizat) nu poate trimite costul", async () => {
    const { applied, run } = setup();
    const subject = custom(["products.write", "products.cost.edit"]);
    const error = (await run(subject, { costPrice: 123 }).catch(
      (e: unknown) => e,
    )) as ProductFieldsForbiddenError;
    expect(error.requiredPermissions).toEqual(["products.cost.view"]);
    expect(applied).toEqual([]);
  });

  it("rol personalizat cu doar products.write: poate edita și conținutul (o include)", async () => {
    const { applied, run } = setup();
    await run(custom(["products.write"]), { title: "T", price: 100 });
    await run(custom(["products.write"]), { title: "T" });
    expect(applied).toHaveLength(2);
  });
});

describe("permisiunea în catalog", () => {
  it("products.write o include pe products.content.write; invers nu", () => {
    expect(can(custom(["products.write"]), "products.content.write")).toBe(true);
    expect(can(custom(["products.content.write"]), "products.write")).toBe(false);
    expect(can(custom(["products.content.write"]), "products.cost.view")).toBe(false);
  });

  it("fără admin.access nu contează nicio permisiune de produs", () => {
    const noAccess: PermissionSubject = {
      userId: "u",
      email: "e@x.test",
      roles: ["custom"],
      permissions: new Set(["products.content.write", "products.write"]),
    };
    expect(can(noAccess, "products.content.write")).toBe(false);
  });

  it("rolurile implicite: Editor, Manager, Admin și Owner au content.write; Editorul nu are write, cost sau archive", () => {
    const has = (role: string, permission: string) =>
      roleSubject(role).permissions.has(permission) || role === "owner";
    for (const role of ["editor", "manager", "admin", "owner"]) {
      expect(has(role, "products.content.write"), role).toBe(true);
    }
    for (const role of ["support", "warehouse", "accountant"]) {
      expect(has(role, "products.content.write"), role).toBe(false);
    }
    for (const permission of [
      "products.write",
      "products.archive",
      "products.cost.view",
      "products.cost.edit",
      "inventory.write",
    ]) {
      expect(roleSubject("editor").permissions.has(permission), permission).toBe(false);
    }
  });
});

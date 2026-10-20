import { describe, expect, it, vi } from "vitest";
import { ForbiddenError, ValidationError } from "@ecom/shared";
import { AuditService, type AuditRow, type AuditStore } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { DEFAULT_ROLES } from "../rbac/catalog";
import type { NodeUpdate } from "./category-tree";
import { CategoryService } from "./category-service";
import type {
  CategoryRecord,
  CategoryStore,
  CategoryWithCount,
  NewCategoryData,
} from "./category-store";
import { FieldsForbiddenError } from "./field-guard";

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

class MemoryCategoryStore implements CategoryStore {
  rows = new Map<string, CategoryRecord>();
  products = new Map<string, { active: number; deleted: number }>();
  media = new Set<string>(["media-1"]);
  private n = 0;
  updateCalls = 0;

  seed(over: Partial<CategoryRecord> & { name: string; slug: string }): CategoryRecord {
    const parent = over.parentId ? this.rows.get(over.parentId) : undefined;
    const record: CategoryRecord = {
      id: `c-${++this.n}`,
      parentId: null,
      description: null,
      path: parent ? `${parent.path}/${over.slug}` : over.slug,
      depth: parent ? parent.depth + 1 : 0,
      sortOrder: [...this.rows.values()].filter((r) => r.parentId === (over.parentId ?? null))
        .length,
      excludeFromGroupDiscount: false,
      seoTitle: null,
      seoDescription: null,
      imageMediaId: null,
      legacyId: null,
      legacyUrl: null,
      ...over,
    };
    this.rows.set(record.id, record);
    return record;
  }

  async listAll(): Promise<CategoryWithCount[]> {
    return [...this.rows.values()].map((r) => ({
      ...r,
      productCount: this.products.get(r.id)?.active ?? 0,
    }));
  }
  async get(id: string) {
    return this.rows.get(id) ?? null;
  }
  async findSiblingBySlug(parentId: string | null, slug: string, excludeId?: string) {
    for (const r of this.rows.values()) {
      if (
        r.parentId === parentId &&
        r.id !== excludeId &&
        r.slug.toLowerCase() === slug.toLowerCase()
      ) {
        return { id: r.id, name: r.name };
      }
    }
    return null;
  }
  async create(data: NewCategoryData) {
    return this.seed({ ...(data as Partial<CategoryRecord>), name: data.name, slug: data.slug });
  }
  async update(id: string, data: Partial<NewCategoryData>) {
    this.updateCalls++;
    const next = { ...(this.rows.get(id) as CategoryRecord), ...(data as Partial<CategoryRecord>) };
    this.rows.set(id, next);
    return next;
  }
  async applyUpdates(updates: readonly NodeUpdate[]) {
    for (const u of updates) {
      const current = this.rows.get(u.id) as CategoryRecord;
      this.rows.set(u.id, { ...current, ...u });
    }
  }
  serialized<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  async countChildren(id: string) {
    return [...this.rows.values()].filter((r) => r.parentId === id).length;
  }
  async countProducts(id: string) {
    return this.products.get(id) ?? { active: 0, deleted: 0 };
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
  async mediaExists(id: string) {
    return this.media.has(id);
  }
}

function setup() {
  const store = new MemoryCategoryStore();
  const auditRows: AuditRow[] = [];
  const auditStore: AuditStore = {
    async append(row) {
      auditRows.push({ ...row, id: `a-${auditRows.length}`, createdAt: new Date() });
    },
    async list() {
      return auditRows;
    },
  };
  const invalidated: string[][] = [];
  const service = new CategoryService({
    store,
    audit: new AuditService(auditStore),
    invalidate: (tags) => void invalidated.push([...tags]),
    logger: { warn: vi.fn() },
  });
  return { store, service, auditRows, invalidated };
}

describe("creare", () => {
  it("rădăcină și copil: adresa din nume, unică între frați, cale și adâncime calculate", async () => {
    const { service } = setup();
    const manager = roleSubject("manager");
    const root = await service.create(manager, { name: "Pompe de căldură" });
    expect(root).toMatchObject({ slug: "pompe-de-caldura", path: "pompe-de-caldura", depth: 0 });

    const dup = await service.create(manager, { name: "Pompe de căldură" });
    expect(dup.slug).toBe("pompe-de-caldura-2");

    const child = await service.create(manager, { name: "Filtrare", parentId: root.id });
    expect(child).toMatchObject({ path: "pompe-de-caldura/filtrare", depth: 1, sortOrder: 0 });

    // aceeași adresă sub alt părinte e permisă
    const other = await service.create(manager, { name: "Filtrare", parentId: dup.id });
    expect(other.path).toBe("pompe-de-caldura-2/filtrare");
  });

  it("adresa explicită ocupată între frați: mesaj clar cu numele categoriei", async () => {
    const { store, service } = setup();
    store.seed({ name: "Liner albastru", slug: "liner" });
    const error = (await service
      .create(roleSubject("admin"), { name: "Altceva", slug: "liner" })
      .catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({ code: "CATEGORY_SLUG_CONFLICT" });
    expect(error.message).toContain("«Liner albastru»");
  });

  it("refuză sub adâncimea maximă, cu părinte inexistent, imagine inexistentă, cheie necunoscută", async () => {
    const { store, service } = setup();
    let parent = store.seed({ name: "n0", slug: "n0" });
    for (let i = 1; i <= 4; i++)
      parent = store.seed({ name: `n${i}`, slug: `n${i}`, parentId: parent.id });
    expect(parent.depth).toBe(4);
    const owner = roleSubject("owner");
    await expect(service.create(owner, { name: "x", parentId: parent.id })).rejects.toMatchObject({
      code: "CATEGORY_TOO_DEEP",
    });
    await expect(service.create(owner, { name: "x", parentId: "nu-exista" })).rejects.toMatchObject(
      {
        code: "CATEGORY_PARENT_NOT_FOUND",
      },
    );
    await expect(service.create(owner, { name: "x", imageMediaId: "lipsa" })).rejects.toMatchObject(
      {
        code: "CATEGORY_IMAGE_NOT_FOUND",
      },
    );
    await expect(service.create(owner, { name: "x", costPrice: 1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("cere products.write; câmpurile legacy cer și catalog.legacy.edit (Manager nu, Admin da)", async () => {
    const { service } = setup();
    await expect(service.create(roleSubject("editor"), { name: "x" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      service.create(roleSubject("manager"), { name: "x", legacyId: "wc-1" }),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    const ok = await service.create(roleSubject("admin"), {
      name: "x",
      legacyId: "wc-1",
      legacyUrl: "https://vechi.example/categorie/x",
    });
    expect(ok).toMatchObject({ legacyId: "wc-1" });
  });
});

describe("modificare", () => {
  it("Editorul schimbă conținutul (nume, descriere, SEO, imagine); auditul are diferențele", async () => {
    const { store, service, auditRows } = setup();
    const c = store.seed({ name: "Pompe", slug: "pompe" });
    const after = await service.update(roleSubject("editor"), c.id, {
      name: "Pompe de căldură",
      description: "Descriere",
      seoTitle: "SEO",
      imageMediaId: "media-1",
    });
    expect(after).toMatchObject({ name: "Pompe de căldură", imageMediaId: "media-1" });
    expect(auditRows[0]).toMatchObject({
      action: "category.update",
      before: { name: "Pompe", imageMediaId: null },
      after: { name: "Pompe de căldură", imageMediaId: "media-1" },
    });
  });

  it("Editorul NU poate schimba adresa sau excluderea de la discount; cererea mixtă nu aplică nimic, audit denied fără valori", async () => {
    const { store, service, auditRows } = setup();
    const c = store.seed({ name: "Pompe", slug: "pompe" });
    for (const forbidden of [{ slug: "alta-adresa" }, { excludeFromGroupDiscount: true }]) {
      const error = await service
        .update(roleSubject("editor"), c.id, { name: "Nume nou", ...forbidden })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FieldsForbiddenError);
      expect((error as FieldsForbiddenError).status).toBe(403);
    }
    expect(store.updateCalls).toBe(0);
    expect(store.rows.get(c.id)?.name).toBe("Pompe");
    expect(auditRows.every((r) => r.outcome === "denied")).toBe(true);
    expect(JSON.stringify(auditRows)).not.toContain("alta-adresa");
    expect(JSON.stringify(auditRows)).not.toContain("Nume nou");
  });

  it("legacyId/legacyUrl: refuzate pentru Manager (are products.write, nu catalog.legacy.edit), permise pentru Admin și Owner", async () => {
    const { store, service, auditRows } = setup();
    const c = store.seed({ name: "Pompe", slug: "pompe" });
    const error = (await service
      .update(roleSubject("manager"), c.id, { legacyUrl: "https://vechi.example/p" })
      .catch((e: unknown) => e)) as FieldsForbiddenError;
    expect(error).toBeInstanceOf(FieldsForbiddenError);
    expect(error.requiredPermissions).toEqual(["catalog.legacy.edit"]);
    expect(error.fields).toEqual(["legacyUrl"]);
    expect(auditRows[0]).toMatchObject({ outcome: "denied" });

    for (const role of ["admin", "owner"]) {
      await service.update(roleSubject(role), c.id, { legacyId: `wc-${role}` });
    }
    expect(store.rows.get(c.id)?.legacyId).toBe("wc-owner");
  });

  it("redenumirea adresei recalculează calea descendenților; conflictul cu un frate e refuzat clar", async () => {
    const { store, service } = setup();
    const root = store.seed({ name: "Piscine", slug: "piscine" });
    const mid = store.seed({ name: "Pompe", slug: "pompe", parentId: root.id });
    const leaf = store.seed({ name: "Filtrare", slug: "filtrare", parentId: mid.id });
    store.seed({ name: "Chimicale", slug: "chimicale", parentId: root.id });

    await service.update(roleSubject("manager"), mid.id, { slug: "pompe-apa" });
    expect(store.rows.get(mid.id)?.path).toBe("piscine/pompe-apa");
    expect(store.rows.get(leaf.id)?.path).toBe("piscine/pompe-apa/filtrare");

    await expect(
      service.update(roleSubject("manager"), mid.id, { slug: "chimicale" }),
    ).rejects.toMatchObject({ code: "CATEGORY_SLUG_CONFLICT" });
  });

  it("mutarea nu se face prin update (parentId e cheie necunoscută); categoria inexistentă e raportată", async () => {
    const { store, service } = setup();
    const c = store.seed({ name: "Pompe", slug: "pompe" });
    await expect(
      service.update(roleSubject("owner"), c.id, { parentId: "x" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.update(roleSubject("owner"), "nu-exista", { name: "x" }),
    ).rejects.toMatchObject({
      code: "CATEGORY_NOT_FOUND",
    });
  });
});

describe("mutare în arbore", () => {
  function tree() {
    const ctx = setup();
    const piscine = ctx.store.seed({ name: "Piscine", slug: "piscine" });
    const pompe = ctx.store.seed({ name: "Pompe", slug: "pompe", parentId: piscine.id });
    const filtrare = ctx.store.seed({ name: "Filtrare", slug: "filtrare", parentId: pompe.id });
    const accesorii = ctx.store.seed({ name: "Accesorii", slug: "accesorii" });
    return { ...ctx, piscine, pompe, filtrare, accesorii };
  }

  it("mută subarborele și recalculează căile și adâncimile; audit și invalidare", async () => {
    const { store, service, auditRows, invalidated, pompe, filtrare, accesorii } = tree();
    await service.move(roleSubject("manager"), pompe.id, { parentId: accesorii.id });
    expect(store.rows.get(pompe.id)).toMatchObject({
      parentId: accesorii.id,
      path: "accesorii/pompe",
      depth: 1,
    });
    expect(store.rows.get(filtrare.id)).toMatchObject({
      path: "accesorii/pompe/filtrare",
      depth: 2,
    });
    expect(auditRows.at(-1)).toMatchObject({ action: "category.move", entityId: pompe.id });
    expect(invalidated.length).toBeGreaterThan(0);
  });

  it("refuză cicluri, propriul părinte și depășirea adâncimii, cu coduri stabile", async () => {
    const { store, service, piscine, pompe, filtrare } = tree();
    const manager = roleSubject("manager");
    await expect(service.move(manager, pompe.id, { parentId: pompe.id })).rejects.toMatchObject({
      code: "CATEGORY_SELF_PARENT",
    });
    await expect(
      service.move(manager, piscine.id, { parentId: filtrare.id }),
    ).rejects.toMatchObject({
      code: "CATEGORY_CYCLE",
    });
    // adâncime: un lanț de 4 sub „accesorii”, apoi încercarea de a muta „piscine” (înălțime 2) sub el
    let parent = store.seed({ name: "a0", slug: "a0" });
    for (let i = 1; i <= 3; i++)
      parent = store.seed({ name: `a${i}`, slug: `a${i}`, parentId: parent.id });
    await expect(service.move(manager, piscine.id, { parentId: parent.id })).rejects.toMatchObject({
      code: "CATEGORY_TOO_DEEP",
    });
    // nimic nu s-a schimbat
    expect(store.rows.get(piscine.id)?.parentId).toBeNull();
  });

  it("refuză mutarea când un frate al noului părinte are aceeași adresă", async () => {
    const { store, service, pompe, accesorii } = tree();
    store.seed({ name: "Alte pompe", slug: "pompe", parentId: accesorii.id });
    const error = (await service
      .move(roleSubject("manager"), pompe.id, { parentId: accesorii.id })
      .catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({ code: "CATEGORY_SLUG_CONFLICT" });
    expect(error.message).toContain("«Alte pompe»");
  });

  it("reordonare: poziția cerută se aplică, fără goluri", async () => {
    const { store, service, piscine, accesorii } = tree();
    await service.move(roleSubject("owner"), accesorii.id, { parentId: null, index: 0 });
    expect(store.rows.get(accesorii.id)?.sortOrder).toBe(0);
    expect(store.rows.get(piscine.id)?.sortOrder).toBe(1);
  });

  it("Editorul nu poate muta; neautentificatul nici", async () => {
    const { service, pompe } = tree();
    await expect(
      service.move(roleSubject("editor"), pompe.id, { parentId: null }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.move(null, pompe.id, { parentId: null })).rejects.toBeDefined();
  });
});

describe("ștergere", () => {
  it("cu subcategorii: refuz cu numărul lor; cu produse: refuz cu numărul de produse (nu eroare de bază)", async () => {
    const { store, service } = setup();
    const parent = store.seed({ name: "Piscine", slug: "piscine" });
    store.seed({ name: "A", slug: "a", parentId: parent.id });
    store.seed({ name: "B", slug: "b", parentId: parent.id });
    const withProducts = store.seed({ name: "Pompe", slug: "pompe" });
    store.products.set(withProducts.id, { active: 12, deleted: 3 });

    const owner = roleSubject("owner");
    const a = (await service.delete(owner, parent.id).catch((e: unknown) => e)) as Error;
    expect(a).toMatchObject({ code: "CATEGORY_HAS_CHILDREN" });
    expect(a.message).toContain("2 subcategorii");

    const b = (await service.delete(owner, withProducts.id).catch((e: unknown) => e)) as Error;
    expect(b).toMatchObject({
      code: "CATEGORY_HAS_PRODUCTS",
      details: { products: 12, deletedProducts: 3 },
    });
    expect(b.message).toContain("12 produse");
    expect(b.message).toContain("3 produse șterse");
    expect(store.rows.has(withProducts.id)).toBe(true);
  });

  it("singular corect (1 produs, 1 subcategorie) și produse doar șterse", async () => {
    const { store, service } = setup();
    const one = store.seed({ name: "Una", slug: "una" });
    store.products.set(one.id, { active: 1, deleted: 0 });
    const onlyDeleted = store.seed({ name: "Veche", slug: "veche" });
    store.products.set(onlyDeleted.id, { active: 0, deleted: 2 });
    const owner = roleSubject("owner");
    expect(((await service.delete(owner, one.id).catch((e) => e)) as Error).message).toContain(
      "1 produs.",
    );
    expect(
      ((await service.delete(owner, onlyDeleted.id).catch((e) => e)) as Error).message,
    ).toContain("2 produse șterse");
  });

  it("categoria goală se șterge, cu audit; Editorul nu poate șterge", async () => {
    const { store, service, auditRows } = setup();
    const c = store.seed({ name: "Goală", slug: "goala" });
    await expect(service.delete(roleSubject("editor"), c.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await service.delete(roleSubject("manager"), c.id);
    expect(store.rows.has(c.id)).toBe(false);
    expect(auditRows.at(-1)).toMatchObject({ action: "category.delete", entityId: c.id });
    await expect(service.delete(roleSubject("manager"), c.id)).rejects.toMatchObject({
      code: "CATEGORY_NOT_FOUND",
    });
  });
});

describe("caracterele «>» și «|» în numele categoriilor", () => {
  it("la creare: refuzate (sunt separatoarele din import și export), cu cod stabil și mesaj clar", async () => {
    const { service, store } = setup();
    const manager = roleSubject("manager");
    for (const name of ["Pompe > Circulație", "Filtre | Nisip", "A>B", ">"]) {
      await expect(service.create(manager, { name }), name).rejects.toMatchObject({
        code: "CATEGORY_NAME_INVALID",
        message: expect.stringContaining("«>» și «|»"),
      });
    }
    expect(store.rows.size).toBe(0);
    // virgula și alte caractere sunt în regulă
    await expect(service.create(manager, { name: "Accesorii, diverse" })).resolves.toMatchObject({
      name: "Accesorii, diverse",
    });
  });

  it("la redenumire: o redenumire spre un nume interzis se refuză, dar o categorie veche cu «>» se poate edita în rest și redenumi curat", async () => {
    const { service, store } = setup();
    const manager = roleSubject("manager");
    const clean = store.seed({ name: "Pompe", slug: "pompe" });
    await expect(
      service.update(manager, clean.id, { name: "Pompe | Piscine" }),
    ).rejects.toMatchObject({
      code: "CATEGORY_NAME_INVALID",
    });
    expect(store.rows.get(clean.id)?.name).toBe("Pompe");

    // o categorie existentă dinainte cu nume interzis: numele trimis neschimbat nu blochează editarea
    const legacy = store.seed({ name: "Veche > cu bară", slug: "veche" });
    const edited = await service.update(manager, legacy.id, {
      name: "Veche > cu bară",
      description: "Descriere nouă",
    });
    expect(edited.description).toBe("Descriere nouă");
    // iar redenumirea curată merge
    await expect(
      service.update(manager, legacy.id, { name: "Veche, cu virgulă" }),
    ).resolves.toMatchObject({
      name: "Veche, cu virgulă",
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthenticatedError } from "@ecom/shared";
import { AuditService, type AuditRow, type AuditStore } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { DEFAULT_ROLES } from "../rbac/catalog";
import { ProductLifecycleService } from "./product-lifecycle";
import type {
  DuplicateCommand,
  DuplicateOutcome,
  LifecycleProductRow,
  ProductLifecycleStore,
  PurgeImpact,
  TransitionCommand,
} from "./product-lifecycle-store";
import type { ProductRecord } from "./product-store";

function subjectFor(roleKey: string): PermissionSubject {
  const role = DEFAULT_ROLES.find((r) => r.key === roleKey);
  if (!role) throw new Error(roleKey);
  return {
    userId: `u-${roleKey}`,
    email: `${roleKey}@magazin.test`,
    roles: [roleKey],
    permissions: new Set<string>(role.permissions),
  };
}

const NOW = new Date("2026-10-16T09:00:00Z");

interface Row extends LifecycleProductRow {
  skus: { id: string; sku: string }[];
}

/** Magazin în memorie cu aceleași garanții „tot sau nimic” ca varianta Prisma. */
class MemoryLifecycleStore implements ProductLifecycleStore {
  rows = new Map<string, Row>();
  impacts = new Map<string, PurgeImpact>();
  duplicates: DuplicateCommand[] = [];
  purged: string[] = [];
  failPurge: unknown = null;
  documentKeys: string[] = [];
  /** Simulează o schimbare de stare între verificare și scriere. */
  racing = false;

  add(over: Partial<Row> & { id: string }): Row {
    const row: Row = {
      slug: over.id,
      title: over.id,
      status: "draft",
      deletedAt: null,
      skus: [{ id: `${over.id}-v1`, sku: `${over.id.toUpperCase()}-1` }],
      ...over,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async getMany(ids: readonly string[]) {
    return ids.map((id) => this.rows.get(id)).filter((r): r is Row => r !== undefined);
  }

  async listVariantSkus(productId: string) {
    return this.rows.get(productId)?.skus ?? [];
  }

  async duplicate(command: DuplicateCommand): Promise<DuplicateOutcome | null> {
    this.duplicates.push(command);
    const source = this.rows.get(command.sourceId);
    if (!source) return null;
    const created = this.add({
      id: `copy-${this.duplicates.length}`,
      slug: command.slug,
      title: command.title,
    });
    return {
      product: { id: created.id, slug: command.slug, title: command.title },
      variants: source.skus.map((v) => ({
        id: `${created.id}-${v.id}`,
        sku: command.skuByVariantId.get(v.id) as string,
      })),
      copied: {
        variants: source.skus.length,
        options: 0,
        attributes: 0,
        categories: 0,
        media: 0,
        relations: 0,
      },
      skipped: { documents: 2, collections: 0, diagrams: 1, channelListings: 0 },
    };
  }

  async transition(command: TransitionCommand) {
    const matching = command.ids.filter((id) => {
      const row = this.rows.get(id);
      if (!row || this.racing) return false;
      if ((row.deletedAt !== null) !== command.eligible.deleted) return false;
      return command.eligible.statuses ? command.eligible.statuses.includes(row.status) : true;
    });
    if (matching.length !== command.ids.length) return matching.length;
    for (const id of matching) Object.assign(this.rows.get(id) as Row, command.data);
    return matching.length;
  }

  async purgeImpact(id: string) {
    return this.impacts.get(id) ?? null;
  }

  async purge(id: string) {
    if (this.failPurge) throw this.failPurge;
    this.purged.push(id);
    return { deleted: true, documentKeys: this.documentKeys };
  }
}

function impact(over: Partial<PurgeImpact> = {}): PurgeImpact {
  return {
    id: "p1",
    slug: "pompa-1",
    title: "Pompa 1",
    deleted: true,
    counts: {
      variants: 1,
      media: 0,
      documents: 0,
      categories: 0,
      attributes: 0,
      relations: 0,
      relatedBy: 0,
      collections: 0,
      channelListings: 0,
    },
    diagrams: [],
    hotspots: [],
    blockingListings: 0,
    ...over,
  };
}

function setup() {
  const store = new MemoryLifecycleStore();
  const takenSlugs = new Set<string>();
  const takenSkus = new Set<string>();
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
  const deleteFiles = vi.fn<(keys: readonly string[]) => Promise<void>>(async () => {});
  const warn = vi.fn();
  const service = new ProductLifecycleService({
    store,
    products: {
      async findSlugOwner(slug) {
        return takenSlugs.has(slug.toLowerCase())
          ? { id: "x", title: "Altul", deletedAt: null }
          : null;
      },
      async findExistingSkus(skus) {
        return skus.filter((s) => takenSkus.has(s.toLowerCase()));
      },
      async getProduct(id) {
        const row = store.rows.get(id);
        return row
          ? ({
              id: row.id,
              slug: row.slug,
              title: row.title,
              status: row.status,
              deletedAt: row.deletedAt,
            } as ProductRecord)
          : null;
      },
    },
    audit: new AuditService(auditStore),
    deleteFiles,
    invalidate: async (tags) => {
      invalidated.push([...tags]);
    },
    logger: { warn },
    now: () => NOW,
  });
  return { store, service, auditRows, invalidated, takenSlugs, takenSkus, deleteFiles, warn };
}

const manager = subjectFor("manager");
const selection = (ids: string[], expectedCount = ids.length) => ({
  ids,
  confirm: true,
  expectedCount,
});

describe("permisiuni", () => {
  it("Editorul, Depozitul și un anonim sunt refuzați la fiecare operație, fără nicio scriere", async () => {
    const { store, service, auditRows } = setup();
    store.add({ id: "p1", status: "active" });
    for (const subject of [subjectFor("editor"), subjectFor("warehouse")]) {
      await expect(service.duplicate(subject, "p1")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(service.archive(subject, selection(["p1"]))).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(service.unarchive(subject, selection(["p1"]))).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(service.softDelete(subject, selection(["p1"]))).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(service.restore(subject, selection(["p1"]))).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(service.describePurge(subject, "p1")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        service.purge(subject, { id: "p1", confirm: true, confirmSlug: "p1" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(service.duplicate(null, "p1")).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(store.rows.get("p1")?.status).toBe("active");
    expect(store.duplicates).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });
});

describe("duplicare", () => {
  it("creează ciorna cu titlu de copie, adresă nouă și coduri generate; un singur eveniment de audit", async () => {
    const { store, service, auditRows, invalidated } = setup();
    store.add({ id: "p1", slug: "pompa-1", title: "Pompa 1", status: "active" });

    const result = await service.duplicate(manager, "p1");

    expect(result.product.title).toBe("Pompa 1 (copie)");
    expect(result.product.slug).toBe("pompa-1-copie");
    expect(result.variants).toEqual([{ id: "copy-1-p1-v1", sku: "P1-1-COPIE" }]);
    expect(result.skipped.documents).toBe(2);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "product.duplicate",
      entity: "product",
      entityId: "copy-1",
    });
    expect(JSON.stringify(auditRows[0]).toLowerCase()).not.toContain("cost");
    expect(invalidated[0]).toContain("catalog");
  });

  it("adresa și codurile se verifică și față de produsele existente (inclusiv șterse): -2 / -COPIE-2", async () => {
    const { store, service, takenSlugs, takenSkus } = setup();
    store.add({ id: "p1", slug: "pompa-1", title: "Pompa 1" });
    takenSlugs.add("pompa-1-copie");
    takenSkus.add("p1-1-copie");
    const result = await service.duplicate(manager, "p1");
    expect(result.product.slug).toBe("pompa-1-copie-2");
    expect(result.variants[0]?.sku).toBe("P1-1-COPIE-2");
  });

  it("refuză produsul inexistent și pe cel din coșul de gunoi", async () => {
    const { store, service } = setup();
    store.add({ id: "gone", deletedAt: new Date() });
    await expect(service.duplicate(manager, "nu-exista")).rejects.toMatchObject({
      code: "CATALOG_PRODUCT_NOT_FOUND",
    });
    await expect(service.duplicate(manager, "gone")).rejects.toMatchObject({
      code: "CATALOG_PRODUCT_DELETED",
    });
    expect(store.duplicates).toHaveLength(0);
  });

  it("o coliziune între verificare și scriere devine un mesaj clar, nu o eroare brută", async () => {
    const { store, service, auditRows } = setup();
    store.add({ id: "p1" });
    store.duplicate = async () => {
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    };
    await expect(service.duplicate(manager, "p1")).rejects.toMatchObject({
      code: "CATALOG_SLUG_CONFLICT",
    });
    expect(auditRows).toHaveLength(0);
  });
});

describe("arhivare, dezarhivare, ștergere soft, restaurare", () => {
  it("arhivează o selecție: toate odată, un singur eveniment agregat cu id-urile", async () => {
    const { store, service, auditRows, invalidated } = setup();
    store.add({ id: "a", status: "active" });
    store.add({ id: "b", status: "draft" });

    const out = await service.archive(manager, selection(["a", "b"]));

    expect(out.count).toBe(2);
    expect(store.rows.get("a")?.status).toBe("archived");
    expect(store.rows.get("b")?.status).toBe("archived");
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "product.archive",
      entityId: null,
      after: { count: 2, ids: ["a", "b"], status: "archived" },
    });
    expect(invalidated).toHaveLength(1);
  });

  it("tot sau nimic: un produs neeligibil în selecție oprește întreaga operație", async () => {
    const { store, service, auditRows } = setup();
    store.add({ id: "a", status: "active" });
    store.add({ id: "b", status: "archived" });
    await expect(service.archive(manager, selection(["a", "b"]))).rejects.toMatchObject({
      code: "CATALOG_LIFECYCLE_INVALID",
      details: { selected: 2, eligible: 1 },
    });
    expect(store.rows.get("a")?.status).toBe("active");
    expect(auditRows).toHaveLength(0);
  });

  it("dezarhivarea duce în ciornă (nu republică), iar ștergerea soft nu atinge starea", async () => {
    const { store, service } = setup();
    store.add({ id: "a", status: "archived" });
    store.add({ id: "b", status: "active" });

    await service.unarchive(manager, selection(["a"]));
    expect(store.rows.get("a")?.status).toBe("draft");

    await service.softDelete(manager, selection(["b"]));
    expect(store.rows.get("b")).toMatchObject({ status: "active", deletedAt: NOW });
    // restaurarea revine exact cu starea de dinainte
    await service.restore(manager, selection(["b"]));
    expect(store.rows.get("b")).toMatchObject({ status: "active", deletedAt: null });
  });

  it("nu poți arhiva, șterge sau dezarhiva un produs din coșul de gunoi; nici restaura unul activ", async () => {
    const { store, service } = setup();
    store.add({ id: "d", status: "active", deletedAt: new Date() });
    store.add({ id: "n", status: "active" });
    await expect(service.archive(manager, selection(["d"]))).rejects.toMatchObject({
      code: "CATALOG_LIFECYCLE_INVALID",
    });
    await expect(service.softDelete(manager, selection(["d"]))).rejects.toMatchObject({
      code: "CATALOG_LIFECYCLE_INVALID",
    });
    await expect(service.restore(manager, selection(["n"]))).rejects.toMatchObject({
      code: "CATALOG_LIFECYCLE_INVALID",
    });
  });

  it("cere confirmare explicită, numărul exact și cel mult 50 de produse", async () => {
    const { store, service } = setup();
    store.add({ id: "a", status: "active" });
    await expect(service.archive(manager, { ids: ["a"], expectedCount: 1 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(service.archive(manager, selection(["a"], 2))).rejects.toMatchObject({
      code: "CATALOG_BULK_COUNT_MISMATCH",
    });
    await expect(service.archive(manager, selection(["a", "a"], 2))).rejects.toMatchObject({
      code: "CATALOG_BULK_COUNT_MISMATCH",
    });
    const many = Array.from({ length: 51 }, (_, i) => `p${i}`);
    await expect(service.archive(manager, selection(many))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(store.rows.get("a")?.status).toBe("active");
  });

  it("o schimbare de stare între verificare și scriere anulează tot", async () => {
    const { store, service, auditRows } = setup();
    store.add({ id: "a", status: "active" });
    store.racing = true;
    await expect(service.archive(manager, selection(["a"]))).rejects.toMatchObject({
      code: "CATALOG_LIFECYCLE_INVALID",
    });
    expect(store.rows.get("a")?.status).toBe("active");
    expect(auditRows).toHaveLength(0);
  });

  it("o cheie necunoscută în cerere (inclusiv una de cost) e refuzată de schema strictă", async () => {
    const { store, service } = setup();
    store.add({ id: "a", status: "active" });
    await expect(
      service.archive(manager, { ...selection(["a"]), costPrice: 1 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("ștergere definitivă", () => {
  const request = { id: "p1", confirm: true, confirmSlug: "pompa-1" };

  it("șterge produsul din coșul de gunoi, apoi fișierele documentelor; un singur eveniment, fără valori", async () => {
    const { store, service, auditRows, deleteFiles } = setup();
    store.impacts.set(
      "p1",
      impact({ hotspots: [{ diagramId: "d1", diagramTitle: "Fișa", number: 3 }] }),
    );
    store.documentKeys = ["private/product-documents/a.pdf", "private/product-documents/b.pdf"];

    const out = await service.purge(manager, request);

    expect(out).toEqual({ id: "p1", slug: "pompa-1", filesDeleted: 2 });
    expect(store.purged).toEqual(["p1"]);
    expect(deleteFiles).toHaveBeenCalledWith(store.documentKeys);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "product.purge",
      after: { hotspotsWithoutProduct: 1 },
    });
  });

  it("hotspot-urile și fișele NU blochează ștergerea (rămân, fără produs)", async () => {
    const { store, service } = setup();
    store.impacts.set(
      "p1",
      impact({
        diagrams: [{ id: "d1", title: "Fișa" }],
        hotspots: [{ diagramId: "d1", diagramTitle: "Fișa", number: 1 }],
      }),
    );
    await expect(service.purge(manager, request)).resolves.toMatchObject({ id: "p1" });
  });

  it("refuză produsul care nu e în coșul de gunoi", async () => {
    const { store, service } = setup();
    store.impacts.set("p1", impact({ deleted: false }));
    await expect(service.purge(manager, request)).rejects.toMatchObject({
      code: "CATALOG_PRODUCT_NOT_DELETED",
    });
    expect(store.purged).toHaveLength(0);
  });

  it("refuză o adresă confirmată greșit", async () => {
    const { store, service } = setup();
    store.impacts.set("p1", impact());
    await expect(
      service.purge(manager, { ...request, confirmSlug: "alt-produs" }),
    ).rejects.toMatchObject({ code: "CATALOG_PURGE_CONFIRM_MISMATCH" });
    expect(store.purged).toHaveLength(0);
  });

  it("refuză produsul cu oferte active pe canale și îl lasă neatins", async () => {
    const { store, service, auditRows } = setup();
    store.impacts.set("p1", impact({ blockingListings: 2 }));
    await expect(service.purge(manager, request)).rejects.toMatchObject({
      code: "CATALOG_PRODUCT_REFERENCED",
      details: { channelListings: 2 },
    });
    expect(store.purged).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });

  it("o referință RESTRICT din baza de date (comenzi) devine un refuz clar", async () => {
    const { store, service, deleteFiles } = setup();
    store.impacts.set("p1", impact());
    store.failPurge = Object.assign(new Error("Foreign key constraint violated"), {
      code: "P2003",
    });
    await expect(service.purge(manager, request)).rejects.toMatchObject({
      code: "CATALOG_PRODUCT_REFERENCED",
    });
    expect(deleteFiles).not.toHaveBeenCalled();
  });

  it("un eșec la ștergerea fișierelor nu anulează ștergerea (orfanii îi prinde sweep-ul)", async () => {
    const { store, service, deleteFiles, warn } = setup();
    store.impacts.set("p1", impact());
    store.documentKeys = ["private/product-documents/a.pdf"];
    deleteFiles.mockRejectedValueOnce(new Error("storage jos"));
    await expect(service.purge(manager, request)).resolves.toMatchObject({ filesDeleted: 0 });
    expect(warn).toHaveBeenCalled();
  });

  it("produsul inexistent", async () => {
    const { service } = setup();
    await expect(service.purge(manager, request)).rejects.toMatchObject({
      code: "CATALOG_PRODUCT_NOT_FOUND",
    });
    await expect(service.describePurge(manager, "nu")).rejects.toMatchObject({
      code: "CATALOG_PRODUCT_NOT_FOUND",
    });
  });
});

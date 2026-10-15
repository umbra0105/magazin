import { describe, expect, it, vi } from "vitest";
import { AuditService, type AuditRow, type AuditStore } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { DEFAULT_ROLES } from "../rbac/catalog";
import type { ProductRelationType } from "./constants";
import {
  MAX_RELATIONS_PER_TYPE,
  ProductRelationsService,
  type ProductRelationStore,
  type RelationRecord,
} from "./product-relations";

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

interface Row {
  id: string;
  productId: string;
  relatedProductId: string;
  type: ProductRelationType;
  position: number;
}

class MemoryStore implements ProductRelationStore {
  products = new Map<string, { id: string; slug: string; deletedAt: Date | null; title: string }>();
  rows: Row[] = [];
  private n = 0;

  addProduct(id: string, deleted = false) {
    this.products.set(id, {
      id,
      slug: `s-${id}`,
      title: `Produs ${id}`,
      deletedAt: deleted ? new Date() : null,
    });
  }
  async getProduct(id: string) {
    return this.products.get(id) ?? null;
  }
  private summary(id: string) {
    const p = this.products.get(id);
    return {
      id,
      title: p?.title ?? id,
      sku: `SKU-${id}`,
      status: "active",
      deleted: p?.deletedAt != null,
    };
  }
  async list(productId: string): Promise<RelationRecord[]> {
    return [
      ...this.rows
        .filter((r) => r.productId === productId)
        .map((r) => ({
          id: r.id,
          type: r.type,
          position: r.position,
          direction: "outgoing" as const,
          product: this.summary(r.relatedProductId),
        })),
      ...this.rows
        .filter((r) => r.relatedProductId === productId)
        .map((r) => ({
          id: r.id,
          type: r.type,
          position: r.position,
          direction: "incoming" as const,
          product: this.summary(r.productId),
        })),
    ];
  }
  async countOutgoing(productId: string, type: ProductRelationType) {
    return this.rows.filter((r) => r.productId === productId && r.type === type).length;
  }
  async exists(productId: string, relatedProductId: string, type: ProductRelationType) {
    return this.rows.some(
      (r) =>
        r.productId === productId && r.relatedProductId === relatedProductId && r.type === type,
    );
  }
  async create(
    productId: string,
    relatedProductId: string,
    type: ProductRelationType,
    position: number,
  ) {
    const row = { id: `r-${++this.n}`, productId, relatedProductId, type, position };
    this.rows.push(row);
    return { id: row.id };
  }
  async find(id: string) {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async delete(id: string) {
    this.rows = this.rows.filter((r) => r.id !== id);
  }
  async reorder(productId: string, type: ProductRelationType, orderedIds: readonly string[]) {
    orderedIds.forEach((id, position) => {
      const row = this.rows.find(
        (r) => r.id === id && r.productId === productId && r.type === type,
      );
      if (row) row.position = position;
    });
  }
}

function setup() {
  const store = new MemoryStore();
  for (const id of ["a", "b", "c"]) store.addProduct(id);
  const auditRows: AuditRow[] = [];
  const auditStore: AuditStore = {
    async append(row) {
      auditRows.push({ ...row, id: `x-${auditRows.length}`, createdAt: new Date() });
    },
    async list() {
      return auditRows;
    },
  };
  const invalidated: string[][] = [];
  const service = new ProductRelationsService({
    store,
    audit: new AuditService(auditStore),
    invalidate: (tags) => void invalidated.push([...tags]),
    logger: { warn: vi.fn() },
  });
  return { store, service, auditRows, invalidated };
}

const manager = () => roleSubject("manager");

describe("relații între produse", () => {
  it("se adaugă principal → asociat și apare din ambele părți (ieșire / intrare)", async () => {
    const { service, auditRows, invalidated } = setup();
    await service.add(manager(), "a", { relatedProductId: "b", type: "accessory" });

    const fromA = await service.list(manager(), "a");
    expect(fromA).toEqual([
      expect.objectContaining({
        direction: "outgoing",
        type: "accessory",
        product: expect.objectContaining({ id: "b" }),
      }),
    ]);
    const fromB = await service.list(manager(), "b");
    expect(fromB).toEqual([
      expect.objectContaining({
        direction: "incoming",
        type: "accessory",
        product: expect.objectContaining({ id: "a" }),
      }),
    ]);
    // nesimetric: B nu are relație de ieșire către A
    expect(fromB.some((r) => r.direction === "outgoing")).toBe(false);

    expect(auditRows.at(-1)).toMatchObject({
      action: "product.relation.add",
      entityId: "a",
      after: { relatedProductId: "b", type: "accessory" },
    });
    // cache-ul ambelor produse e invalidat
    expect(invalidated[0]).toEqual(expect.arrayContaining(["product:a", "product:b", "catalog"]));
  });

  it("aceeași pereche poate avea tipuri diferite; același tip de două ori e refuzat", async () => {
    const { service } = setup();
    await service.add(manager(), "a", { relatedProductId: "b", type: "accessory" });
    await service.add(manager(), "a", { relatedProductId: "b", type: "spare_part" });
    await expect(
      service.add(manager(), "a", { relatedProductId: "b", type: "accessory" }),
    ).rejects.toMatchObject({ code: "CATALOG_RELATION_DUPLICATE" });
    // sensul invers e o relație diferită, permisă
    await service.add(manager(), "b", { relatedProductId: "a", type: "accessory" });
  });

  it("fără auto-relație, fără produs șters sau inexistent, fără tip necunoscut", async () => {
    const { store, service } = setup();
    store.addProduct("gone", true);
    await expect(
      service.add(manager(), "a", { relatedProductId: "a", type: "similar" }),
    ).rejects.toMatchObject({ code: "CATALOG_RELATION_SELF" });
    await expect(
      service.add(manager(), "a", { relatedProductId: "gone", type: "similar" }),
    ).rejects.toMatchObject({ code: "CATALOG_PRODUCT_DELETED" });
    await expect(
      service.add(manager(), "a", { relatedProductId: "lipsa", type: "similar" }),
    ).rejects.toMatchObject({ code: "CATALOG_PRODUCT_NOT_FOUND" });
    await expect(
      service.add(manager(), "a", { relatedProductId: "b", type: "prieten" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      service.add(manager(), "gone", { relatedProductId: "b", type: "similar" }),
    ).rejects.toMatchObject({ code: "CATALOG_PRODUCT_DELETED" });
    expect(store.rows).toEqual([]);
  });

  it("toate cele 6 tipuri sunt acceptate", async () => {
    const { service } = setup();
    for (const type of [
      "similar",
      "accessory",
      "upsell",
      "crosssell",
      "spare_part",
      "compatible_with",
    ]) {
      await service.add(manager(), "a", { relatedProductId: "b", type });
    }
    expect(await service.list(manager(), "a")).toHaveLength(6);
  });

  it("limita pe tip; ștergerea se poate face din ambele părți, dar nu dintr-un produs străin", async () => {
    const { store, service } = setup();
    for (let i = 0; i < MAX_RELATIONS_PER_TYPE; i++) {
      store.addProduct(`x${i}`);
      await service.add(manager(), "a", { relatedProductId: `x${i}`, type: "similar" });
    }
    await expect(
      service.add(manager(), "a", { relatedProductId: "b", type: "similar" }),
    ).rejects.toMatchObject({ code: "CATALOG_RELATION_LIMIT" });
    // alt tip nu e afectat
    await service.add(manager(), "a", { relatedProductId: "b", type: "upsell" });

    const rel = store.rows.find((r) => r.type === "upsell") as Row;
    await expect(service.remove(manager(), "c", rel.id)).rejects.toMatchObject({
      code: "CATALOG_RELATION_NOT_FOUND",
    });
    // din partea produsului asociat (b) se poate șterge
    await service.remove(manager(), "b", rel.id);
    expect(store.rows.some((r) => r.id === rel.id)).toBe(false);
    await expect(service.remove(manager(), "a", rel.id)).rejects.toMatchObject({
      code: "CATALOG_RELATION_NOT_FOUND",
    });
  });

  it("reordonarea cere exact relațiile tipului și păstrează ordinea dată", async () => {
    const { store, service } = setup();
    await service.add(manager(), "a", { relatedProductId: "b", type: "crosssell" });
    await service.add(manager(), "a", { relatedProductId: "c", type: "crosssell" });
    const ids = store.rows.map((r) => r.id);

    await service.reorder(manager(), "a", { type: "crosssell", orderedIds: [...ids].reverse() });
    const out = (await service.list(manager(), "a")).filter((r) => r.direction === "outgoing");
    expect(out.sort((x, y) => x.position - y.position).map((r) => r.id)).toEqual(
      [...ids].reverse(),
    );

    await expect(
      service.reorder(manager(), "a", { type: "crosssell", orderedIds: [ids[0] as string] }),
    ).rejects.toMatchObject({ code: "CATALOG_RELATION_MISMATCH" });
  });

  it("Editorul (doar conținut) e refuzat cu audit denied; citirea cere products.read", async () => {
    const { store, service, auditRows } = setup();
    await expect(
      service.add(roleSubject("editor"), "a", { relatedProductId: "b", type: "similar" }),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    expect(store.rows).toEqual([]);
    expect(auditRows.at(-1)).toMatchObject({
      outcome: "denied",
      after: { deniedFields: ["relations"] },
    });
    expect(await service.list(roleSubject("editor"), "a")).toEqual([]);
    await expect(service.list(roleSubject("support"), "a")).rejects.toMatchObject({
      code: "AUTH_FORBIDDEN",
    });
  });
});

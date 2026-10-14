import { describe, expect, it, vi } from "vitest";
import type { StorageDriver } from "@ecom/integrations";
import { AuditService, type AuditRow, type AuditStore } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { DEFAULT_ROLES } from "../rbac/catalog";
import {
  ProductAssignmentsService,
  type AssignedCategory,
  type ProductAssignmentStore,
} from "./product-assignments";

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

type MediaRow = Awaited<ReturnType<ProductAssignmentStore["listMedia"]>>[number];

class MemoryStore implements ProductAssignmentStore {
  products = new Map<string, { id: string; slug: string; deletedAt: Date | null }>();
  categories = new Map<string, AssignedCategory[]>();
  knownCategories = new Set(["c1", "c2", "c3"]);
  media = new Map<string, MediaRow[]>();
  library = new Map<string, string>(); // mediaId -> status
  writes = { categories: 0, media: 0 };

  async getProduct(id: string) {
    return this.products.get(id) ?? null;
  }
  async listCategories(productId: string) {
    return this.categories.get(productId) ?? [];
  }
  async existingCategoryIds(ids: readonly string[]) {
    return ids.filter((id) => this.knownCategories.has(id));
  }
  async replaceCategories(productId: string, rows: readonly AssignedCategory[]) {
    this.writes.categories++;
    this.categories.set(productId, [...rows]);
  }
  async listMedia(productId: string) {
    return this.media.get(productId) ?? [];
  }
  async readyMediaIds(ids: readonly string[]) {
    return ids.filter((id) => this.library.get(id) === "ready");
  }
  async replaceMedia(productId: string, mediaIds: readonly string[]) {
    this.writes.media++;
    this.media.set(
      productId,
      mediaIds.map((mediaId, position) => ({
        id: `pm-${productId}-${position}`,
        mediaId,
        position,
        media: {
          originalName: `${mediaId}.jpg`,
          alt: null,
          status: "ready",
          storageKey: `public/media/${mediaId}/original.jpg`,
          width: 100,
          height: 100,
          blurhash: null,
          variants: [
            {
              name: "thumb",
              format: "webp",
              mime: "image/webp",
              width: 320,
              height: 320,
              key: `public/media/${mediaId}/thumb.webp`,
            },
          ],
        },
      })),
    );
  }
}

const storage = {
  publicUrl: (key: string) => `/media/${key}`,
} as unknown as StorageDriver;

function setup() {
  const store = new MemoryStore();
  store.products.set("p1", { id: "p1", slug: "p-1", deletedAt: null });
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
  const service = new ProductAssignmentsService({
    store,
    audit: new AuditService(auditStore),
    storage,
    invalidate: (tags) => void invalidated.push([...tags]),
    logger: { warn: vi.fn() },
  });
  return { store, service, auditRows, invalidated };
}

describe("categoriile produsului", () => {
  it("Managerul le înlocuiește; prima e principală; audit cu id-uri și invalidare de cache", async () => {
    const { store, service, auditRows, invalidated } = setup();
    const out = await service.setCategories(roleSubject("manager"), "p1", {
      categoryIds: ["c2", "c1"],
    });
    expect(out).toEqual([
      { categoryId: "c2", isPrimary: true },
      { categoryId: "c1", isPrimary: false },
    ]);
    expect(store.categories.get("p1")).toEqual(out);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "product.categories.update",
      after: { categoryIds: ["c2", "c1"], primaryId: "c2" },
    });
    expect(invalidated[0]).toEqual(expect.arrayContaining(["catalog", "product:p1"]));
  });

  it("categoria principală aleasă explicit; principala care nu e în listă se refuză", async () => {
    const { service } = setup();
    const out = await service.setCategories(roleSubject("admin"), "p1", {
      categoryIds: ["c1", "c3"],
      primaryId: "c3",
    });
    expect(out.find((c) => c.isPrimary)?.categoryId).toBe("c3");
    await expect(
      service.setCategories(roleSubject("admin"), "p1", { categoryIds: ["c1"], primaryId: "c2" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      service.setCategories(roleSubject("admin"), "p1", { categoryIds: ["c1", "c1"] }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("Editorul e refuzat (403, audit denied cu numele câmpului, nicio scriere)", async () => {
    const { store, service, auditRows } = setup();
    await expect(
      service.setCategories(roleSubject("editor"), "p1", { categoryIds: ["c1"] }),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    expect(store.writes.categories).toBe(0);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      outcome: "denied",
      after: { deniedFields: ["categories"] },
    });
  });

  it("categorie inexistentă și produs șters/inexistent refuză, fără scriere", async () => {
    const { store, service } = setup();
    await expect(
      service.setCategories(roleSubject("admin"), "p1", { categoryIds: ["lipsa"] }),
    ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });
    store.products.set("p2", { id: "p2", slug: "p-2", deletedAt: new Date() });
    await expect(
      service.setCategories(roleSubject("admin"), "p2", { categoryIds: ["c1"] }),
    ).rejects.toMatchObject({ code: "CATALOG_PRODUCT_DELETED" });
    await expect(
      service.setCategories(roleSubject("admin"), "nu-exista", { categoryIds: [] }),
    ).rejects.toMatchObject({ code: "CATALOG_PRODUCT_NOT_FOUND" });
    expect(store.writes.categories).toBe(0);
  });

  it("aceeași listă nu scrie și nu scrie în audit; la fel citirea cere products.read", async () => {
    const { store, service, auditRows } = setup();
    await service.setCategories(roleSubject("admin"), "p1", { categoryIds: ["c1"] });
    await service.setCategories(roleSubject("admin"), "p1", { categoryIds: ["c1"] });
    expect(store.writes.categories).toBe(1);
    expect(auditRows).toHaveLength(1);
    expect(await service.getCategories(roleSubject("editor"), "p1")).toHaveLength(1);
    await expect(service.getCategories(roleSubject("support"), "p1")).rejects.toMatchObject({
      code: "AUTH_FORBIDDEN",
    });
  });

  it("cheie necunoscută în cerere (ex. cost) e respinsă ca validare", async () => {
    const { service } = setup();
    await expect(
      service.setCategories(roleSubject("owner"), "p1", { categoryIds: [], purchase: 1 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("imaginile produsului", () => {
  it("Editorul (doar conținut) le poate seta; ordinea se păstrează; thumb, niciodată originalul", async () => {
    const { store, service, auditRows } = setup();
    store.library.set("m1", "ready");
    store.library.set("m2", "ready");
    const out = await service.setMedia(roleSubject("editor"), "p1", { mediaIds: ["m2", "m1"] });
    expect(out.mediaIds).toEqual(["m2", "m1"]);
    expect(auditRows[0]).toMatchObject({
      action: "product.media.update",
      after: { mediaIds: ["m2", "m1"] },
    });

    const items = await service.listMedia(roleSubject("editor"), "p1");
    expect(items.map((i) => i.mediaId)).toEqual(["m2", "m1"]);
    expect(items[0]?.thumb).toBe("/media/public/media/m2/thumb.webp");
    expect(JSON.stringify(items)).not.toContain("original");
  });

  it("un fișier care nu e gata sau nu există se refuză, fără scriere", async () => {
    const { store, service } = setup();
    store.library.set("m1", "ready");
    store.library.set("m3", "processing");
    await expect(
      service.setMedia(roleSubject("manager"), "p1", { mediaIds: ["m1", "m3", "lipsa"] }),
    ).rejects.toMatchObject({ code: "CATALOG_MEDIA_INVALID" });
    expect(store.writes.media).toBe(0);
  });

  it("peste limită sau cu fișier repetat se refuză; lista goală scoate toate imaginile", async () => {
    const { store, service } = setup();
    store.library.set("m1", "ready");
    await expect(
      service.setMedia(roleSubject("admin"), "p1", { mediaIds: ["m1", "m1"] }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      service.setMedia(roleSubject("admin"), "p1", {
        mediaIds: Array.from({ length: 31 }, (_, i) => `x${i}`),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await service.setMedia(roleSubject("admin"), "p1", { mediaIds: ["m1"] });
    const out = await service.setMedia(roleSubject("admin"), "p1", { mediaIds: [] });
    expect(out.mediaIds).toEqual([]);
    expect(store.media.get("p1")).toEqual([]);
  });

  it("fără permisiune de conținut (Depozit, Suport) e refuzat; citirea cere products.read", async () => {
    const { store, service } = setup();
    store.library.set("m1", "ready");
    await expect(
      service.setMedia(roleSubject("warehouse"), "p1", { mediaIds: ["m1"] }),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    await expect(
      service.setMedia(roleSubject("support"), "p1", { mediaIds: ["m1"] }),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    expect(store.writes.media).toBe(0);
    expect(await service.listMedia(roleSubject("warehouse"), "p1")).toEqual([]);
  });
});

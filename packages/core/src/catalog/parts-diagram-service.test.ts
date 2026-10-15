import { describe, expect, it, vi } from "vitest";
import type { StorageDriver } from "@ecom/integrations";
import { AuditService, type AuditRow, type AuditStore } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { DEFAULT_ROLES } from "../rbac/catalog";
import { PartsDiagramService, type PartsDiagramStore } from "./parts-diagram-service";

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

type Product = {
  id: string;
  title: string;
  status: string;
  deletedAt: Date | null;
  sku: string | null;
};
type Hotspot = {
  id: string;
  diagramId: string;
  number: number;
  xBp: number | null;
  yBp: number | null;
  label: string | null;
  productId: string | null;
};

class MemoryStore implements PartsDiagramStore {
  diagrams = new Map<string, { id: string; title: string; mediaId: string }>();
  hotspots = new Map<string, Hotspot>();
  links = new Set<string>(); // `${diagramId}|${productId}`
  products = new Map<string, Product>();
  media = new Map<string, string>(); // id -> status
  private n = 0;
  private id(p: string) {
    return `${p}${++this.n}`;
  }

  seedProduct(id: string, over: Partial<Product> = {}) {
    this.products.set(id, {
      id,
      title: `Piesa ${id}`,
      status: "active",
      deletedAt: null,
      sku: `SKU-${id}`,
      ...over,
    });
  }

  private rawMedia(mediaId: string) {
    return {
      id: mediaId,
      status: this.media.get(mediaId) ?? "ready",
      originalName: `${mediaId}.png`,
      alt: null,
      storageKey: `public/media/${mediaId}/original.png`,
      width: 1000,
      height: 800,
      blurhash: null,
      variants: [
        {
          name: "medium",
          format: "webp",
          mime: "image/webp",
          width: 800,
          height: 640,
          key: `public/media/${mediaId}/medium.webp`,
        },
      ],
    };
  }
  async list() {
    return [...this.diagrams.values()].map((d) => ({
      id: d.id,
      title: d.title,
      updatedAt: new Date(),
      hotspotCount: [...this.hotspots.values()].filter((h) => h.diagramId === d.id).length,
      productCount: [...this.links].filter((l) => l.startsWith(`${d.id}|`)).length,
      media: this.rawMedia(d.mediaId),
    }));
  }
  async get(id: string) {
    const d = this.diagrams.get(id);
    if (!d) return null;
    return {
      id: d.id,
      title: d.title,
      media: this.rawMedia(d.mediaId),
      hotspots: [...this.hotspots.values()]
        .filter((h) => h.diagramId === id)
        .sort((a, b) => a.number - b.number)
        .map((h) => ({
          id: h.id,
          number: h.number,
          xBp: h.xBp,
          yBp: h.yBp,
          label: h.label,
          product: h.productId ? (this.products.get(h.productId) ?? null) : null,
        })),
      products: [...this.links]
        .filter((l) => l.startsWith(`${id}|`))
        .map((l) => this.products.get(l.split("|")[1] as string) as Product),
    };
  }
  async create(data: { title: string; mediaId: string }) {
    const id = this.id("d");
    this.diagrams.set(id, { id, ...data });
    return { id };
  }
  async update(id: string, data: { title?: string; mediaId?: string }) {
    this.diagrams.set(id, {
      ...(this.diagrams.get(id) as { id: string; title: string; mediaId: string }),
      ...data,
    });
  }
  async delete(id: string) {
    this.diagrams.delete(id);
    for (const [hid, h] of this.hotspots) if (h.diagramId === id) this.hotspots.delete(hid);
    for (const l of [...this.links]) if (l.startsWith(`${id}|`)) this.links.delete(l);
  }
  async isMediaReady(mediaId: string) {
    return (this.media.get(mediaId) ?? "ready") === "ready" && mediaId !== "lipsa";
  }
  async getProduct(id: string) {
    return this.products.get(id) ?? null;
  }
  async attach(diagramId: string, productId: string) {
    this.links.add(`${diagramId}|${productId}`);
  }
  async detach(diagramId: string, productId: string) {
    this.links.delete(`${diagramId}|${productId}`);
  }
  async attachedProductIds(diagramId: string) {
    return [...this.links]
      .filter((l) => l.startsWith(`${diagramId}|`))
      .map((l) => l.split("|")[1] as string);
  }
  async forProduct(productId: string) {
    return (await this.list()).filter((d) => this.links.has(`${d.id}|${productId}`));
  }
  async getHotspot(id: string) {
    const h = this.hotspots.get(id);
    return h ? { id: h.id, diagramId: h.diagramId, number: h.number } : null;
  }
  async numberTaken(diagramId: string, number: number, exclude?: string) {
    return [...this.hotspots.values()].some(
      (h) => h.diagramId === diagramId && h.number === number && h.id !== exclude,
    );
  }
  async countHotspots(diagramId: string) {
    return [...this.hotspots.values()].filter((h) => h.diagramId === diagramId).length;
  }
  async nextNumber(diagramId: string) {
    const nums = [...this.hotspots.values()]
      .filter((h) => h.diagramId === diagramId)
      .map((h) => h.number);
    return (nums.length ? Math.max(...nums) : 0) + 1;
  }
  async saveHotspot(
    diagramId: string,
    hotspotId: string | null,
    data: {
      number: number;
      xBp: number | null;
      yBp: number | null;
      productId: string | null;
      label: string | null;
    },
  ) {
    const id = hotspotId ?? this.id("h");
    this.hotspots.set(id, { id, diagramId, ...data });
    return { id };
  }
  async deleteHotspot(id: string) {
    this.hotspots.delete(id);
  }
}

function setup(enabled = true) {
  const store = new MemoryStore();
  store.seedProduct("p1");
  store.seedProduct("p2");
  const auditRows: AuditRow[] = [];
  const auditStore: AuditStore = {
    async append(row) {
      auditRows.push({ ...row, id: `a-${auditRows.length}`, createdAt: new Date() });
    },
    async list() {
      return auditRows;
    },
  };
  const flag = { on: enabled };
  const invalidated: string[][] = [];
  const service = new PartsDiagramService({
    store,
    storage: {
      publicUrl: (key: string) => `/media/${key.slice("public/".length)}`,
    } as unknown as StorageDriver,
    audit: new AuditService(auditStore),
    isEnabled: async () => flag.on,
    invalidate: (tags) => void invalidated.push([...tags]),
    logger: { warn: vi.fn() },
  });
  return { store, service, auditRows, flag, invalidated };
}

const manager = () => roleSubject("manager");

async function withDiagram() {
  const ctx = setup();
  const { id } = await ctx.service.create(manager(), { title: "Pompă XYZ", mediaId: "m1" });
  return { ...ctx, id };
}

describe("flag-ul partsDiagrams", () => {
  it("oprit: orice operație e refuzată cu FEATURE_DISABLED, înaintea oricărei scrieri sau citiri", async () => {
    const { service, store, flag } = setup(false);
    const calls: (() => Promise<unknown>)[] = [
      () => service.list(manager()),
      () => service.get(manager(), "d1"),
      () => service.forProduct(manager(), "p1"),
      () => service.create(manager(), { title: "X", mediaId: "m1" }),
      () => service.update(manager(), "d1", { title: "Y" }),
      () => service.delete(manager(), "d1", { confirm: true, expectedHotspots: 0 }),
      () => service.attachProduct(manager(), "d1", "p1"),
      () => service.detachProduct(manager(), "d1", "p1"),
      () => service.saveHotspot(manager(), "d1", { label: "x" }),
      () => service.deleteHotspot(manager(), "d1", "h1"),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: "FEATURE_DISABLED" });
    }
    expect(store.diagrams.size).toBe(0);

    flag.on = true;
    expect(await service.list(manager())).toEqual([]);
  });
});

describe("fișe și imagine", () => {
  it("creare cu imagine „gata”; imaginea nepregătită sau inexistentă se refuză", async () => {
    const { service, store } = setup();
    store.media.set("pending", "pending");
    await expect(
      service.create(manager(), { title: "F", mediaId: "pending" }),
    ).rejects.toMatchObject({ code: "DIAGRAM_MEDIA_INVALID" });
    await expect(service.create(manager(), { title: "F", mediaId: "lipsa" })).rejects.toMatchObject(
      { code: "DIAGRAM_MEDIA_INVALID" },
    );
    await expect(service.create(manager(), { title: " ", mediaId: "m1" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    const { id } = await service.create(manager(), { title: "Pompă XYZ", mediaId: "m1" });
    const detail = await service.get(manager(), id);
    expect(detail).toMatchObject({ title: "Pompă XYZ", hotspots: [], products: [] });
    expect(detail.image.url).toBe("/media/media/m1/medium.webp");
    expect(JSON.stringify(detail)).not.toContain("storageKey");
  });

  it("schimbarea titlului și a imaginii; neschimbat nu scrie și nu auditează", async () => {
    const { service, auditRows, id } = await withDiagram();
    const before = auditRows.length;
    await service.update(manager(), id, { title: "Pompă XYZ" });
    expect(auditRows.length).toBe(before);
    await service.update(manager(), id, { title: "Pompă XYZ (nou)", mediaId: "m2" });
    const detail = await service.get(manager(), id);
    expect(detail.title).toBe("Pompă XYZ (nou)");
    expect(detail.image.mediaId).toBe("m2");
    expect(auditRows.at(-1)).toMatchObject({
      action: "parts_diagram.update",
      entity: "parts_diagram",
    });
  });
});

describe("hotspot-uri", () => {
  it("numere unice pe fișă; fără număr se alege următorul; același număr în altă fișă e permis", async () => {
    const { service, id } = await withDiagram();
    const a = await service.saveHotspot(manager(), id, { productId: "p1", xBp: 1000, yBp: 2000 });
    const b = await service.saveHotspot(manager(), id, { productId: "p2" });
    expect([a.number, b.number]).toEqual([1, 2]);
    await expect(
      service.saveHotspot(manager(), id, { number: 1, label: "dublură" }),
    ).rejects.toMatchObject({ code: "DIAGRAM_HOTSPOT_NUMBER_TAKEN" });

    const other = await service.create(manager(), { title: "Altă fișă", mediaId: "m1" });
    const c = await service.saveHotspot(manager(), other.id, { number: 1, label: "ok" });
    expect(c.number).toBe(1);
  });

  it("poziția: puncte de bază 0–10000, ambele coordonate sau niciuna", async () => {
    const { service, id } = await withDiagram();
    for (const [xBp, yBp] of [
      [-1, 0],
      [0, 10001],
      [10001, 5],
      [1.5, 2],
    ]) {
      await expect(
        service.saveHotspot(manager(), id, { label: "x", xBp, yBp }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    await expect(
      service.saveHotspot(manager(), id, { label: "x", xBp: 100 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // marginile sunt permise
    await service.saveHotspot(manager(), id, { label: "colț", xBp: 0, yBp: 10000 });
    await service.saveHotspot(manager(), id, { label: "fără poziție" });
  });

  it("are nevoie de produs SAU etichetă; produsul trebuie să existe și să nu fie șters", async () => {
    const { service, store, id } = await withDiagram();
    await expect(service.saveHotspot(manager(), id, {})).rejects.toMatchObject({
      code: "DIAGRAM_HOTSPOT_INVALID",
    });
    await expect(service.saveHotspot(manager(), id, { label: "   " })).rejects.toMatchObject({
      code: "DIAGRAM_HOTSPOT_INVALID",
    });
    await expect(service.saveHotspot(manager(), id, { productId: "lipsa" })).rejects.toMatchObject({
      code: "CATALOG_PRODUCT_NOT_FOUND",
    });
    store.seedProduct("gone", { deletedAt: new Date() });
    await expect(service.saveHotspot(manager(), id, { productId: "gone" })).rejects.toMatchObject({
      code: "CATALOG_PRODUCT_DELETED",
    });
    // doar etichetă: permis
    expect((await service.saveHotspot(manager(), id, { label: "Garnitură" })).number).toBe(1);
  });

  it("mutarea unui hotspot (poziție nouă) păstrează numărul și produsul; un id din altă fișă e refuzat", async () => {
    const { service, id } = await withDiagram();
    const h = await service.saveHotspot(manager(), id, {
      productId: "p1",
      number: 3,
      xBp: 100,
      yBp: 100,
    });
    const moved = await service.saveHotspot(manager(), id, {
      id: h.id,
      productId: "p1",
      xBp: 5050,
      yBp: 2575,
    });
    expect(moved).toEqual({ id: h.id, number: 3 });
    const detail = await service.get(manager(), id);
    expect(detail.hotspots[0]).toMatchObject({ number: 3, xBp: 5050, yBp: 2575 });
    expect(detail.hotspots[0]?.product?.id).toBe("p1");

    const other = await service.create(manager(), { title: "Altă fișă", mediaId: "m1" });
    await expect(
      service.saveHotspot(manager(), other.id, { id: h.id, label: "furat" }),
    ).rejects.toMatchObject({ code: "DIAGRAM_HOTSPOT_NOT_FOUND" });
    await expect(service.deleteHotspot(manager(), other.id, h.id)).rejects.toMatchObject({
      code: "DIAGRAM_HOTSPOT_NOT_FOUND",
    });
    await service.deleteHotspot(manager(), id, h.id);
    expect((await service.get(manager(), id)).hotspots).toEqual([]);
  });

  it("un produs șters se vede în hotspot ca atare (nu rupe fișa)", async () => {
    const { service, store, id } = await withDiagram();
    await service.saveHotspot(manager(), id, { productId: "p1" });
    store.products.set("p1", { ...(store.products.get("p1") as Product), deletedAt: new Date() });
    const detail = await service.get(manager(), id);
    expect(detail.hotspots[0]?.product).toMatchObject({ id: "p1", deleted: true });
  });
});

describe("asociere cu produse", () => {
  it("o fișă la mai multe produse; idempotent; produs șters refuzat; apare în forProduct", async () => {
    const { service, store, id, invalidated } = await withDiagram();
    await service.attachProduct(manager(), id, "p1");
    await service.attachProduct(manager(), id, "p1");
    await service.attachProduct(manager(), id, "p2");
    const detail = await service.get(manager(), id);
    expect(detail.products.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
    expect(invalidated.at(-1)).toEqual(expect.arrayContaining(["catalog", "product:p2"]));

    store.seedProduct("gone", { deletedAt: new Date() });
    await expect(service.attachProduct(manager(), id, "gone")).rejects.toMatchObject({
      code: "CATALOG_PRODUCT_DELETED",
    });
    expect((await service.forProduct(manager(), "p1")).map((d) => d.id)).toEqual([id]);
    await service.detachProduct(manager(), id, "p1");
    expect(await service.forProduct(manager(), "p1")).toEqual([]);
  });
});

describe("ștergerea fișei", () => {
  it("cere confirmare cu numărul exact de hotspot-uri; numărul greșit sau lipsa confirmării refuză", async () => {
    const { service, store, id } = await withDiagram();
    await service.saveHotspot(manager(), id, { label: "a" });
    await service.saveHotspot(manager(), id, { label: "b" });
    await service.saveHotspot(manager(), id, { label: "c" });

    await expect(
      service.delete(manager(), id, { confirm: true, expectedHotspots: 2 }),
    ).rejects.toMatchObject({ code: "DIAGRAM_DELETE_MISMATCH" });
    await expect(service.delete(manager(), id, { expectedHotspots: 3 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(store.diagrams.has(id)).toBe(true);

    const out = await service.delete(manager(), id, { confirm: true, expectedHotspots: 3 });
    expect(out).toEqual({ deletedHotspots: 3 });
    expect(store.diagrams.has(id)).toBe(false);
    expect(store.hotspots.size).toBe(0);
  });
});

describe("permisiuni", () => {
  it("scrierile cer products.write (Editorul de conținut și Suportul sunt refuzați); citirea cere products.read", async () => {
    const { service, id, store } = await withDiagram();
    const editor = roleSubject("editor");
    for (const call of [
      () => service.create(editor, { title: "X", mediaId: "m1" }),
      () => service.update(editor, id, { title: "Y" }),
      () => service.delete(editor, id, { confirm: true, expectedHotspots: 0 }),
      () => service.attachProduct(editor, id, "p1"),
      () => service.detachProduct(editor, id, "p1"),
      () => service.saveHotspot(editor, id, { label: "x" }),
      () => service.deleteHotspot(editor, id, "h1"),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    }
    expect(store.hotspots.size).toBe(0);
    // Editorul citește
    expect((await service.list(editor)).map((d) => d.id)).toEqual([id]);
    await expect(service.list(roleSubject("support"))).rejects.toMatchObject({
      code: "AUTH_FORBIDDEN",
    });
  });
});

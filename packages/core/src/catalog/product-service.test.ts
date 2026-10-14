import { describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthenticatedError, ValidationError } from "@ecom/shared";
import { AuditService, type AuditRow, type AuditStore } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { DEFAULT_ROLES } from "../rbac/catalog";
import { ProductFieldsForbiddenError } from "./product-write";
import { MAX_MONEY } from "./product-schemas";
import { ProductService } from "./product-service";
import type {
  BulkApplyCommand,
  GeneratedVariantRow,
  NewVariantRow,
  ProductFieldsData,
  ProductRecord,
  ProductStore,
  SlugOwner,
  VariantFieldsData,
  VariantRecord,
} from "./product-store";
import { combinationKey, type OptionInput } from "./variant-generator";

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

const NOW = new Date("2026-10-14T12:00:00Z");

/** Magazin în memorie, cu aceleași reguli de bază ca Postgres (adresă unică, SKU unic). */
class MemoryStore implements ProductStore {
  products = new Map<string, ProductRecord>();
  variants = new Map<string, VariantRecord>();
  combos = new Map<string, string[]>(); // productId -> chei de combinație
  priceHistory: { variantId: string; price: number; at: Date }[] = [];
  categories = new Set<string>(["cat-1"]);
  brands = new Set<string>(["brand-1"]);
  bulkCalls: BulkApplyCommand[] = [];
  addedToCategory = new Map<string, string[]>();
  calls = { createProduct: 0, updateProduct: 0, updateVariant: 0 };
  private n = 0;

  private id(prefix: string): string {
    return `${prefix}-${++this.n}`;
  }

  seedProduct(over: Partial<ProductRecord> & { slug: string; title: string }): ProductRecord {
    const record: ProductRecord = {
      id: this.id("p"),
      subtitle: null,
      description: null,
      status: "draft",
      type: "physical",
      brandId: null,
      shippingClass: "standard",
      requiresInstallation: false,
      manageStock: true,
      stockStatus: "instock",
      allowBackorder: false,
      expectedRestockDate: null,
      excludeFromGroupDiscount: false,
      energyClass: null,
      eprelUrl: null,
      gpsrManufacturerName: null,
      gpsrManufacturerContact: null,
      gpsrResponsibleName: null,
      gpsrResponsibleContact: null,
      safetyWarnings: null,
      seoTitle: null,
      seoDescription: null,
      deletedAt: null,
      ...over,
    };
    this.products.set(record.id, record);
    return record;
  }

  seedVariant(productId: string, over: Partial<VariantRecord> & { sku: string }): VariantRecord {
    const record: VariantRecord = {
      id: this.id("v"),
      productId,
      ean: null,
      warrantyMonths: null,
      price: 10000,
      salePrice: null,
      saleStartsAt: null,
      saleEndsAt: null,
      weightGrams: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
      manufacturerPartNumber: null,
      manufacturerName: null,
      manageStock: null,
      stockStatus: null,
      position: 0,
      isDefault: false,
      ...over,
    };
    this.variants.set(record.id, record);
    return record;
  }

  async findSlugOwner(slug: string, excludeProductId?: string): Promise<SlugOwner | null> {
    for (const p of this.products.values()) {
      if (p.id !== excludeProductId && p.slug.toLowerCase() === slug.toLowerCase()) {
        return { id: p.id, title: p.title, deletedAt: p.deletedAt };
      }
    }
    return null;
  }

  async getProduct(id: string): Promise<ProductRecord | null> {
    return this.products.get(id) ?? null;
  }

  async getVariant(id: string): Promise<VariantRecord | null> {
    return this.variants.get(id) ?? null;
  }

  async findExistingSkus(skus: readonly string[], excludeVariantId?: string): Promise<string[]> {
    const wanted = new Set(skus.map((s) => s.toLowerCase()));
    return [...this.variants.values()]
      .filter((v) => v.id !== excludeVariantId && wanted.has(v.sku.toLowerCase()))
      .map((v) => v.sku);
  }

  async createProduct(data: ProductFieldsData, rows: readonly NewVariantRow[], at: Date) {
    this.calls.createProduct++;
    const product = this.seedProduct({
      slug: data.slug,
      title: data.title,
      ...(data as Partial<ProductRecord>),
    });
    const variants = rows.map((row, i) => {
      const v = this.seedVariant(product.id, {
        ...(row.data as Partial<VariantRecord>),
        sku: row.data.sku,
        position: i,
      });
      this.priceHistory.push({ variantId: v.id, price: row.effectivePrice, at });
      return v;
    });
    return { product, variants };
  }

  async updateProduct(id: string, data: Partial<ProductFieldsData>): Promise<ProductRecord> {
    this.calls.updateProduct++;
    const current = this.products.get(id) as ProductRecord;
    const next = { ...current, ...(data as Partial<ProductRecord>) };
    this.products.set(id, next);
    return next;
  }

  async updateVariant(
    id: string,
    data: Partial<VariantFieldsData>,
    priceRecord: { price: number; at: Date } | null,
  ): Promise<VariantRecord> {
    this.calls.updateVariant++;
    const current = this.variants.get(id) as VariantRecord;
    const next = { ...current, ...(data as Partial<VariantRecord>) };
    this.variants.set(id, next);
    if (priceRecord) this.priceHistory.push({ variantId: id, ...priceRecord });
    return next;
  }

  async listVariantsOf(productId: string): Promise<VariantRecord[]> {
    return [...this.variants.values()]
      .filter((v) => v.productId === productId)
      .sort((a, b) => a.position - b.position);
  }

  async getManyWithVariants(ids: readonly string[]) {
    return ids.flatMap((id) => {
      const p = this.products.get(id);
      return p
        ? [
            {
              id,
              slug: p.slug,
              deletedAt: p.deletedAt,
              variants: [...this.variants.values()].filter((v) => v.productId === id),
            },
          ]
        : [];
    });
  }

  async categoryExists(id: string): Promise<boolean> {
    return this.categories.has(id);
  }

  async brandExists(id: string): Promise<boolean> {
    return this.brands.has(id);
  }

  async bulkApply(command: BulkApplyCommand): Promise<void> {
    this.bulkCalls.push(command);
    for (const id of command.productIds) {
      const current = this.products.get(id) as ProductRecord;
      this.products.set(id, { ...current, ...command.productData });
      if (command.addCategoryId) {
        this.addedToCategory.set(command.addCategoryId, [
          ...(this.addedToCategory.get(command.addCategoryId) ?? []),
          id,
        ]);
      }
    }
    for (const u of command.variantUpdates) {
      const current = this.variants.get(u.variantId) as VariantRecord;
      this.variants.set(u.variantId, { ...current, price: u.price, salePrice: u.salePrice });
      if (u.priceRecord) this.priceHistory.push({ variantId: u.variantId, ...u.priceRecord });
    }
  }

  async listVariantCombinationKeys(productId: string): Promise<string[]> {
    return this.combos.get(productId) ?? [];
  }

  async getDefaultSku(productId: string): Promise<string | null> {
    const own = [...this.variants.values()].filter((v) => v.productId === productId);
    return (own.find((v) => v.isDefault) ?? own[0])?.sku ?? null;
  }

  async addGeneratedVariants(
    productId: string,
    _options: readonly OptionInput[],
    rows: readonly GeneratedVariantRow[],
    at: Date,
  ): Promise<VariantRecord[]> {
    const keys = this.combos.get(productId) ?? [];
    this.combos.set(productId, keys);
    return rows.map((row) => {
      const v = this.seedVariant(productId, { sku: row.sku, price: row.price });
      keys.push(combinationKey(row.selections));
      this.priceHistory.push({ variantId: v.id, price: row.price, at });
      return v;
    });
  }
}

function setup(opts: { invalidate?: (tags: readonly string[]) => void | Promise<void> } = {}) {
  const store = new MemoryStore();
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
  const warn = vi.fn();
  const service = new ProductService({
    store,
    audit: new AuditService(auditStore),
    defaultManageStock: async () => false,
    invalidate:
      opts.invalidate ??
      (async (tags) => {
        invalidated.push([...tags]);
      }),
    logger: { warn },
    now: () => NOW,
  });
  return { store, service, auditRows, invalidated, warn };
}

const variant = (sku: string, price = 19900) => ({ sku, price });

describe("creare: adresa (slug)", () => {
  it("generează adresa din titlu și o face unică, ținând cont și de produsele ȘTERSE", async () => {
    const { store, service } = setup();
    store.seedProduct({ slug: "pompa-x", title: "Pompă veche" });
    store.seedProduct({ slug: "pompa-x-2", title: "Pompă ștearsă", deletedAt: new Date() });

    const { product } = await service.create(roleSubject("manager"), {
      title: "Pompă X",
      variants: [variant("PX-1")],
    });
    expect(product.slug).toBe("pompa-x-3");
  });

  it("adresa explicită ocupată de un produs șters: refuz clar, cu numele produsului șters", async () => {
    const { store, service } = setup();
    store.seedProduct({ slug: "filtru-nisip", title: "Filtru vechi", deletedAt: new Date() });

    const error = await service
      .create(roleSubject("manager"), {
        title: "Filtru nou",
        slug: "Filtru-Nisip".toLowerCase(),
        variants: [variant("F-1")],
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "CATALOG_SLUG_CONFLICT" });
    const message = (error as Error).message;
    expect(message).toContain("filtru-nisip");
    expect(message).toContain("produsul șters");
    expect(message).toContain("Filtru vechi");
    expect(store.calls.createProduct).toBe(0);
  });

  it("adresa explicită ocupată de un produs activ: mesaj clar, fără «șters»", async () => {
    const { store, service } = setup();
    store.seedProduct({ slug: "liner", title: "Liner albastru" });
    const error = (await service
      .create(roleSubject("admin"), { title: "X", slug: "liner", variants: [variant("L-1")] })
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toContain("«Liner albastru»");
    expect(error.message).not.toContain("șters");
  });
});

describe("creare: validare și permisiuni", () => {
  it("manageStock implicit vine din setare; prima variantă e cea implicită; istoricul de preț pornește", async () => {
    const { store, service, auditRows, invalidated } = setup();
    const { product, variants } = await service.create(roleSubject("owner"), {
      title: "Produs nou",
      variants: [{ ...variant("A-1", 20000), salePrice: 15000 }, variant("A-2")],
    });
    expect(product.manageStock).toBe(false); // din setarea globală (aici: oprită)
    expect(variants.map((v) => v.isDefault)).toEqual([true, false]);
    // promoția fără fereastră e activă: prețul efectiv e cel redus
    expect(store.priceHistory.find((h) => h.variantId === variants[0]?.id)).toMatchObject({
      price: 15000,
      at: NOW,
    });
    expect(auditRows[0]).toMatchObject({
      action: "product.create",
      after: { slug: "produs-nou", variants: ["A-1", "A-2"] },
    });
    expect(invalidated[0]).toEqual(
      expect.arrayContaining(["catalog", `product:${product.id}`, "product-slug:produs-nou"]),
    );
  });

  it("costul nu e acceptat: o cerere cu costPrice (pe produs sau pe variantă) e o eroare de validare", async () => {
    const { store, service } = setup();
    for (const input of [
      { title: "X", costPrice: 123456, variants: [variant("C-1")] },
      { title: "X", variants: [{ ...variant("C-1"), costPrice: 123456 }] },
      { title: "X", variants: [{ ...variant("C-1"), costPriceDate: "2026-10-01" }] },
    ]) {
      const error = (await service
        .create(roleSubject("owner"), input)
        .catch((e: unknown) => e)) as ValidationError;
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.message).not.toContain("123456");
      expect(JSON.stringify(error)).not.toContain("123456");
    }
    expect(store.calls.createProduct).toBe(0);
  });

  it("validează: titlu, fără variante, EAN, promoție peste preț, sume neîntregi, câmpuri necunoscute", async () => {
    const { service } = setup();
    const owner = roleSubject("owner");
    const bad: unknown[] = [
      { title: "  ", variants: [variant("A")] },
      { title: "X", variants: [] },
      { title: "X", variants: [{ ...variant("A"), ean: "123" }] },
      { title: "X", variants: [{ ...variant("A"), salePrice: 30000 }] },
      { title: "X", variants: [{ sku: "A", price: 10.5 }] },
      { title: "X", variants: [variant("A")], campNecunoscut: true },
      { title: "X", slug: "Adresă Cu Spații", variants: [variant("A")] },
    ];
    for (const input of bad) {
      await expect(service.create(owner, input)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("cere products.write; Editorul și neautentificatul sunt refuzați", async () => {
    const { store, service } = setup();
    const input = { title: "X", variants: [variant("A")] };
    await expect(service.create(roleSubject("editor"), input)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(service.create(null, input)).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(store.calls.createProduct).toBe(0);
  });

  it("SKU deja folosit: refuz cu codul și mesaj clar", async () => {
    const { store, service } = setup();
    const p = store.seedProduct({ slug: "alt", title: "Alt" });
    store.seedVariant(p.id, { sku: "DUP-1" });
    await expect(
      service.create(roleSubject("owner"), { title: "X", variants: [variant("dup-1")] }),
    ).rejects.toMatchObject({ code: "CATALOG_SKU_CONFLICT" });
    await expect(
      service.create(roleSubject("owner"), {
        title: "X",
        variants: [variant("N-1"), variant("n-1")],
      }),
    ).rejects.toMatchObject({ code: "CATALOG_SKU_CONFLICT" });
  });
});

describe("modificare produs", () => {
  it("Editorul modifică descrierea și SEO: audit cu diferențe, textul lung rezumat; cache invalidat", async () => {
    const { store, service, auditRows, invalidated } = setup();
    const p = store.seedProduct({ slug: "pompa", title: "Pompă", description: "vechi" });
    const longText = "x".repeat(500);
    const after = await service.update(roleSubject("editor"), p.id, {
      description: longText,
      seoTitle: "Pompă de căldură",
    });
    expect(after.description).toBe(longText);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "product.update",
      entityId: p.id,
      before: { description: "vechi", seoTitle: null },
      after: { description: "[text de 500 caractere]", seoTitle: "Pompă de căldură" },
    });
    expect(JSON.stringify(auditRows)).not.toContain("x".repeat(100));
    expect(invalidated).toHaveLength(1);
  });

  it("Editorul nu poate schimba starea, clasa de livrare sau brandul; cererea mixtă nu aplică nimic", async () => {
    const { store, service, auditRows } = setup();
    const p = store.seedProduct({ slug: "pompa", title: "Pompă" });
    for (const forbidden of [
      { status: "active" },
      { shippingClass: "pallet" },
      { brandId: "b-1" },
    ]) {
      await expect(
        service.update(roleSubject("editor"), p.id, { title: "Titlu nou", ...forbidden }),
      ).rejects.toBeInstanceOf(ProductFieldsForbiddenError);
    }
    expect(store.calls.updateProduct).toBe(0);
    expect(store.products.get(p.id)?.title).toBe("Pompă");
    expect(auditRows.every((r) => r.outcome === "denied")).toBe(true);
  });

  it("prețul și costul nu sunt câmpuri ale produsului: cerere de validare, nu ajung la servicii", async () => {
    const { store, service } = setup();
    const p = store.seedProduct({ slug: "pompa", title: "Pompă" });
    for (const input of [{ price: 100 }, { costPrice: 987654 }, { variants: [] }]) {
      await expect(service.update(roleSubject("owner"), p.id, input)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(store.calls.updateProduct).toBe(0);
  });

  it("schimbarea adresei: conflict cu un produs șters e refuzat clar; schimbarea doar de majuscule e ok", async () => {
    const { store, service } = setup();
    store.seedProduct({ slug: "ocupat", title: "Produs șters", deletedAt: new Date() });
    const p = store.seedProduct({ slug: "pompa", title: "Pompă" });
    await expect(
      service.update(roleSubject("editor"), p.id, { slug: "ocupat" }),
    ).rejects.toMatchObject({ code: "CATALOG_SLUG_CONFLICT" });
    const ok = await service.update(roleSubject("editor"), p.id, { slug: "pompa" });
    expect(ok.slug).toBe("pompa");
  });

  it("produs șters: nu se modifică; produs inexistent: eroare clară; cerere fără schimbări: nimic scris", async () => {
    const { store, service, auditRows } = setup();
    const gone = store.seedProduct({ slug: "g", title: "G", deletedAt: new Date() });
    await expect(
      service.update(roleSubject("owner"), gone.id, { title: "x" }),
    ).rejects.toMatchObject({
      code: "CATALOG_PRODUCT_DELETED",
    });
    await expect(
      service.update(roleSubject("owner"), "nu-exista", { title: "x" }),
    ).rejects.toMatchObject({
      code: "CATALOG_PRODUCT_NOT_FOUND",
    });
    const p = store.seedProduct({ slug: "p", title: "P" });
    await service.update(roleSubject("owner"), p.id, { title: "P" });
    expect(store.calls.updateProduct).toBe(0);
    expect(auditRows).toEqual([]);
  });

  it("un eșec al invalidării cache-ului nu anulează scrierea (se loghează)", async () => {
    const { store, service, warn } = setup({
      invalidate: () => {
        throw new Error("cache indisponibil");
      },
    });
    const p = store.seedProduct({ slug: "p", title: "P" });
    const after = await service.update(roleSubject("owner"), p.id, { title: "Nou" });
    expect(after.title).toBe("Nou");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("modificare variantă și istoric de preț", () => {
  it("schimbarea prețului scrie în istoric prețul EFECTIV; o schimbare fără efect pe preț nu scrie", async () => {
    const { store, service } = setup();
    const p = store.seedProduct({ slug: "p", title: "P" });
    const v = store.seedVariant(p.id, { sku: "V-1", price: 20000 });

    await service.updateVariant(roleSubject("manager"), v.id, { price: 18000 });
    expect(store.priceHistory).toEqual([{ variantId: v.id, price: 18000, at: NOW }]);

    await service.updateVariant(roleSubject("manager"), v.id, { weightGrams: 5000 });
    expect(store.priceHistory).toHaveLength(1);

    // o promoție activă schimbă prețul efectiv
    await service.updateVariant(roleSubject("manager"), v.id, { salePrice: 15000 });
    expect(store.priceHistory.at(-1)).toMatchObject({ price: 15000 });
    // înlocuirea ei cu una care începe în viitor readuce prețul efectiv la cel întreg (se înregistrează)
    await service.updateVariant(roleSubject("manager"), v.id, {
      salePrice: 9000,
      saleStartsAt: "2027-01-01",
    });
    expect(store.priceHistory).toHaveLength(3);
    expect(store.priceHistory.at(-1)).toMatchObject({ price: 18000 });
  });

  it("o promoție programată în viitor, pe o variantă fără promoție, nu schimbă prețul efectiv: nu scrie în istoric", async () => {
    const { store, service } = setup();
    const p = store.seedProduct({ slug: "p", title: "P" });
    const v = store.seedVariant(p.id, { sku: "V-1", price: 20000 });
    await service.updateVariant(roleSubject("manager"), v.id, {
      salePrice: 9000,
      saleStartsAt: "2027-01-01",
      saleEndsAt: "2027-02-01",
    });
    expect(store.priceHistory).toEqual([]);
    expect(store.variants.get(v.id)?.salePrice).toBe(9000);
  });

  it("validează promoția față de valorile existente și SKU-ul față de celelalte variante", async () => {
    const { store, service } = setup();
    const p = store.seedProduct({ slug: "p", title: "P" });
    const v = store.seedVariant(p.id, { sku: "V-1", price: 10000 });
    store.seedVariant(p.id, { sku: "V-2" });
    await expect(
      service.updateVariant(roleSubject("owner"), v.id, { salePrice: 12000 }),
    ).rejects.toMatchObject({ code: "CATALOG_SALE_PRICE_INVALID" });
    await expect(
      service.updateVariant(roleSubject("owner"), v.id, { price: 5000 }),
    ).resolves.toMatchObject({ price: 5000 });
    await expect(
      service.updateVariant(roleSubject("owner"), v.id, { sku: "v-2" }),
    ).rejects.toMatchObject({ code: "CATALOG_SKU_CONFLICT" });
  });

  it("cere products.write; costul nu se acceptă; varianta inexistentă e raportată clar", async () => {
    const { store, service } = setup();
    const p = store.seedProduct({ slug: "p", title: "P" });
    const v = store.seedVariant(p.id, { sku: "V-1" });
    await expect(
      service.updateVariant(roleSubject("editor"), v.id, { price: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.updateVariant(roleSubject("owner"), v.id, { costPrice: 777777 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.updateVariant(roleSubject("owner"), "nu-exista", { price: 1 }),
    ).rejects.toMatchObject({ code: "CATALOG_VARIANT_NOT_FOUND" });
    expect(store.calls.updateVariant).toBe(0);
  });
});

describe("generarea variantelor", () => {
  const options: OptionInput[] = [
    { name: "Mărime", values: ["S", "M"] },
    { name: "Culoare", values: ["Roșu", "Albastru"] },
  ];

  it("creează toate combinațiile, cu SKU derivat din varianta implicită; a doua rulare nu adaugă nimic", async () => {
    const { store, service, auditRows } = setup();
    const p = store.seedProduct({ slug: "tricou", title: "Tricou" });
    store.seedVariant(p.id, { sku: "TRI", isDefault: true });

    const first = await service.generateVariants(roleSubject("manager"), p.id, {
      options,
      price: 5000,
    });
    expect(first.created.map((v) => v.sku)).toEqual([
      "TRI-S-ROSU",
      "TRI-S-ALBASTRU",
      "TRI-M-ROSU",
      "TRI-M-ALBASTRU",
    ]);
    expect(first.created.every((v) => v.price === 5000)).toBe(true);

    const second = await service.generateVariants(roleSubject("manager"), p.id, {
      options,
      price: 5000,
    });
    expect(second.created).toEqual([]);
    expect(second.existing).toBe(4);
    expect(auditRows.map((r) => r.action)).toEqual([
      "product.variants.generate",
      "product.variants.generate",
    ]);
  });

  it("o valoare nouă adaugă doar combinațiile noi; variantele rămase fără combinație sunt raportate, nu șterse", async () => {
    const { store, service } = setup();
    const p = store.seedProduct({ slug: "tricou", title: "Tricou" });
    await service.generateVariants(roleSubject("owner"), p.id, {
      options: [{ name: "Mărime", values: ["S", "M"] }],
      price: 1000,
      baseSku: "tri",
    });
    const next = await service.generateVariants(roleSubject("owner"), p.id, {
      options: [{ name: "Mărime", values: ["M", "L"] }],
      price: 1000,
      baseSku: "tri",
    });
    expect(next.created.map((v) => v.sku)).toEqual(["TRI-L"]);
    expect(next.existing).toBe(1);
    expect(next.orphaned).toBe(1); // „S” nu mai e în set, dar varianta rămâne
    expect([...store.variants.values()].filter((v) => v.productId === p.id)).toHaveLength(3);
  });

  it("SKU-urile deja existente în magazin se evită cu sufix; limita și permisiunile se respectă", async () => {
    const { store, service } = setup();
    const other = store.seedProduct({ slug: "alt", title: "Alt" });
    store.seedVariant(other.id, { sku: "TRI-S" });
    const p = store.seedProduct({ slug: "tricou", title: "Tricou" });
    const out = await service.generateVariants(roleSubject("owner"), p.id, {
      options: [{ name: "Mărime", values: ["S", "M"] }],
      price: 1000,
      baseSku: "TRI",
    });
    expect(out.created.map((v) => v.sku)).toEqual(["TRI-S-2", "TRI-M"]);

    await expect(
      service.generateVariants(roleSubject("editor"), p.id, { options, price: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.generateVariants(roleSubject("owner"), p.id, {
        options: [
          { name: "A", values: Array.from({ length: 11 }, (_, i) => `a${i}`) },
          { name: "B", values: Array.from({ length: 10 }, (_, i) => `b${i}`) },
        ],
        price: 1,
      }),
    ).rejects.toMatchObject({ code: "CATALOG_VARIANT_LIMIT" });
    await expect(
      service.generateVariants(roleSubject("owner"), p.id, { options, price: 10.5 }),
    ).rejects.toMatchObject({ code: "CATALOG_PRICE_INVALID" });
  });
});

describe("verificarea adresei pentru formular", () => {
  it("liberă, ocupată de activ, ocupată de șters, invalidă; produsul își poate păstra adresa", async () => {
    const { store, service } = setup();
    const own = store.seedProduct({ slug: "al-meu", title: "Al meu" });
    store.seedProduct({ slug: "activ", title: "Activ" });
    store.seedProduct({ slug: "sters", title: "Șters", deletedAt: new Date() });
    const editor = roleSubject("editor");
    expect(await service.checkSlug(editor, "libera")).toEqual({ available: true, message: null });
    expect((await service.checkSlug(editor, "activ")).available).toBe(false);
    expect((await service.checkSlug(editor, "sters")).message).toContain("produsul șters");
    expect((await service.checkSlug(editor, "Nu Valid")).available).toBe(false);
    expect((await service.checkSlug(editor, "al-meu", own.id)).available).toBe(true);
    await expect(service.checkSlug(roleSubject("support"), "x")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe("editare în masă", () => {
  function seedProducts(store: MemoryStore, n: number) {
    return Array.from({ length: n }, (_, i) => {
      const p = store.seedProduct({ slug: `p${i}`, title: `Produs ${i}`, status: "draft" });
      const v = store.seedVariant(p.id, { sku: `S-${i}`, price: 10000 });
      return { p, v };
    });
  }
  const confirmed = (ids: string[], changes: Record<string, unknown>) => ({
    ids,
    confirm: true,
    expectedCount: ids.length,
    changes,
  });

  it("Managerul schimbă starea mai multor produse: tranzacție unică, audit agregat cu lista de id-uri", async () => {
    const { store, service, auditRows, invalidated } = setup();
    const items = seedProducts(store, 3);
    const ids = items.map((i) => i.p.id);
    const result = await service.bulkUpdate(
      roleSubject("manager"),
      confirmed(ids, { status: "active", shippingClass: "oversized" }),
    );
    expect(result).toEqual({ updatedProducts: 3, updatedVariants: 0 });
    expect(store.bulkCalls).toHaveLength(1);
    for (const id of ids) {
      expect(store.products.get(id)).toMatchObject({
        status: "active",
        shippingClass: "oversized",
      });
    }
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "product.bulk_update",
      entityId: null,
      outcome: "success",
      after: { count: 3, ids, changes: { status: "active", shippingClass: "oversized" } },
    });
    expect(invalidated[0]).toEqual(expect.arrayContaining(["catalog", `product:${ids[0]}`]));
  });

  it("Editorul nu poate schimba nimic prin editare în masă (nici starea, nici prețul, nici stocul); audit denied fără valori", async () => {
    const { store, service, auditRows } = setup();
    const ids = seedProducts(store, 2).map((i) => i.p.id);
    for (const changes of [
      { status: "active" },
      { priceAdjustBps: 500 },
      { stockStatus: "outofstock" },
      { shippingClass: "pallet", addCategoryId: "cat-1" },
    ]) {
      await expect(
        service.bulkUpdate(roleSubject("editor"), confirmed(ids, changes)),
      ).rejects.toBeInstanceOf(ProductFieldsForbiddenError);
    }
    expect(store.bulkCalls).toEqual([]);
    expect(auditRows.every((r) => r.outcome === "denied")).toBe(true);
    expect(JSON.stringify(auditRows)).not.toContain(ids[0]);
    expect(JSON.stringify(auditRows)).not.toContain("500");
  });

  it("prețul ±%: rotunjit pe variantă, promoția păstrează proporția, istoricul primește prețul efectiv", async () => {
    const { store, service } = setup();
    const a = store.seedProduct({ slug: "a", title: "A" });
    const va = store.seedVariant(a.id, { sku: "A-1", price: 10001, salePrice: 8000 });
    const b = store.seedProduct({ slug: "b", title: "B" });
    const vb = store.seedVariant(b.id, { sku: "B-1", price: 5000 });

    await service.bulkUpdate(
      roleSubject("admin"),
      confirmed([a.id, b.id], { priceAdjustBps: 1000 }),
    );
    // +10%: 10001 → 11001 (rotunjit), promoția 8000 → 8800, prețul efectiv = promoția
    expect(store.variants.get(va.id)).toMatchObject({ price: 11001, salePrice: 8800 });
    expect(store.variants.get(vb.id)).toMatchObject({ price: 5500, salePrice: null });
    expect(store.priceHistory).toEqual(
      expect.arrayContaining([
        { variantId: va.id, price: 8800, at: NOW },
        { variantId: vb.id, price: 5500, at: NOW },
      ]),
    );

    await service.bulkUpdate(roleSubject("admin"), confirmed([b.id], { priceAdjustBps: -5000 }));
    expect(store.variants.get(vb.id)?.price).toBe(2750);
  });

  it("limita de produse, confirmarea explicită și numărul confirmat se impun; nimic nu se aplică la refuz", async () => {
    const { store, service } = setup();
    const items = seedProducts(store, 3);
    const ids = items.map((i) => i.p.id);
    const owner = roleSubject("owner");

    const tooMany = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    await expect(
      service.bulkUpdate(owner, confirmed(tooMany, { status: "active" })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.bulkUpdate(owner, { ids, expectedCount: 3, changes: { status: "active" } }),
    ).rejects.toBeInstanceOf(ValidationError); // fără confirm
    await expect(
      service.bulkUpdate(owner, { ...confirmed(ids, { status: "active" }), confirm: false }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.bulkUpdate(owner, { ...confirmed(ids, { status: "active" }), expectedCount: 2 }),
    ).rejects.toMatchObject({ code: "CATALOG_BULK_COUNT_MISMATCH" });
    await expect(
      service.bulkUpdate(
        owner,
        confirmed([ids[0] as string, ids[0] as string], { status: "active" }),
      ),
    ).rejects.toMatchObject({ code: "CATALOG_BULK_COUNT_MISMATCH" });
    await expect(service.bulkUpdate(owner, confirmed(ids, {}))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(store.bulkCalls).toEqual([]);
  });

  it("costul nu poate fi trimis prin editare în masă (cheie necunoscută, schema e strictă)", async () => {
    const { store, service } = setup();
    const ids = seedProducts(store, 1).map((i) => i.p.id);
    for (const changes of [
      { costPrice: 123456 },
      { status: "active", costPriceDate: "2026-10-01" },
    ]) {
      const error = (await service
        .bulkUpdate(roleSubject("owner"), confirmed(ids, changes))
        .catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(ValidationError);
      expect(JSON.stringify(error)).not.toContain("123456");
    }
    await expect(
      service.bulkUpdate(roleSubject("owner"), {
        ...confirmed(ids, { status: "active" }),
        costPrice: 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(store.bulkCalls).toEqual([]);
  });

  it("produs inexistent sau șters în selecție: tot sau nimic; categorie și brand inexistente refuzate", async () => {
    const { store, service } = setup();
    const items = seedProducts(store, 2);
    const gone = store.seedProduct({ slug: "g", title: "G", deletedAt: new Date() });
    const owner = roleSubject("owner");

    await expect(
      service.bulkUpdate(
        owner,
        confirmed([items[0]?.p.id as string, gone.id], { status: "active" }),
      ),
    ).rejects.toMatchObject({ code: "CATALOG_BULK_INVALID" });
    await expect(
      service.bulkUpdate(
        owner,
        confirmed([items[0]?.p.id as string, "nu-exista"], { status: "active" }),
      ),
    ).rejects.toMatchObject({ code: "CATALOG_BULK_INVALID" });
    const ids = items.map((i) => i.p.id);
    await expect(
      service.bulkUpdate(owner, confirmed(ids, { addCategoryId: "lipsa" })),
    ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });
    await expect(
      service.bulkUpdate(owner, confirmed(ids, { brandId: "lipsa" })),
    ).rejects.toMatchObject({ code: "BRAND_NOT_FOUND" });
    expect(store.bulkCalls).toEqual([]);

    await service.bulkUpdate(owner, confirmed(ids, { addCategoryId: "cat-1", brandId: "brand-1" }));
    expect(store.addedToCategory.get("cat-1")).toEqual(ids);
    expect(store.products.get(ids[0] as string)?.brandId).toBe("brand-1");
  });

  it("ajustarea care scoate o variantă din interval refuză tot, fără aplicare parțială", async () => {
    const { store, service } = setup();
    const p = store.seedProduct({ slug: "s", title: "S" });
    store.seedVariant(p.id, { sku: "S-1", price: 900_000_000 });
    await expect(
      service.bulkUpdate(roleSubject("owner"), confirmed([p.id], { priceAdjustBps: 30000 })),
    ).rejects.toMatchObject({ code: "CATALOG_BULK_PRICE_OUT_OF_RANGE" });
    expect(store.bulkCalls).toEqual([]);
  });

  describe("prețul ±%: niciun preț la zero sau sub zero, nimic peste plafon", () => {
    const owner = () => roleSubject("owner");

    it.each([-10000, -10001, -15000, -20000, -9001, -1_000_000])(
      "%i puncte de bază (−100% sau mai puțin, sau sub minim) se refuză fără nicio modificare",
      async (bps) => {
        const { store, service, auditRows } = setup();
        const p = store.seedProduct({ slug: "z", title: "Z" });
        const v = store.seedVariant(p.id, { sku: "Z-1", price: 10000, salePrice: 8000 });
        await expect(
          service.bulkUpdate(owner(), confirmed([p.id], { priceAdjustBps: bps })),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(store.bulkCalls).toEqual([]);
        expect(store.variants.get(v.id)).toMatchObject({ price: 10000, salePrice: 8000 });
        expect(auditRows.filter((r) => r.outcome === "success")).toEqual([]);
      },
    );

    it.each([0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 30001, 1e12])(
      "procent neîntreg, nenumeric sau peste maxim (%s) se refuză",
      async (bps) => {
        const { store, service } = setup();
        const p = store.seedProduct({ slug: "w", title: "W" });
        store.seedVariant(p.id, { sku: "W-1", price: 10000 });
        await expect(
          service.bulkUpdate(owner(), confirmed([p.id], { priceAdjustBps: bps })),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(store.bulkCalls).toEqual([]);
      },
    );

    it("minimul permis (−90%) trece când rezultatul rămâne ≥ 1 ban", async () => {
      const { store, service } = setup();
      const p = store.seedProduct({ slug: "m", title: "M" });
      const v = store.seedVariant(p.id, { sku: "M-1", price: 10 });
      await service.bulkUpdate(owner(), confirmed([p.id], { priceAdjustBps: -9000 }));
      expect(store.variants.get(v.id)?.price).toBe(1);
    });

    it("rotunjirea care ar duce prețul la zero (4 bani −90% = 0,4 → 0) refuză tot, fără aplicare parțială", async () => {
      const { store, service } = setup();
      const ok = store.seedProduct({ slug: "ok", title: "Ok" });
      const okV = store.seedVariant(ok.id, { sku: "OK-1", price: 10000 });
      const tiny = store.seedProduct({ slug: "tiny", title: "Tiny" });
      store.seedVariant(tiny.id, { sku: "T-1", price: 4 });
      await expect(
        service.bulkUpdate(owner(), confirmed([ok.id, tiny.id], { priceAdjustBps: -9000 })),
      ).rejects.toMatchObject({ code: "CATALOG_BULK_PRICE_OUT_OF_RANGE" });
      expect(store.bulkCalls).toEqual([]);
      expect(store.variants.get(okV.id)?.price).toBe(10000);
    });

    it("prețul redus care ar ajunge la zero prin rotunjire refuză tot", async () => {
      const { store, service } = setup();
      const p = store.seedProduct({ slug: "s0", title: "S0" });
      store.seedVariant(p.id, { sku: "S0-1", price: 10000, salePrice: 4 });
      await expect(
        service.bulkUpdate(owner(), confirmed([p.id], { priceAdjustBps: -9000 })),
      ).rejects.toMatchObject({ code: "CATALOG_BULK_PRICE_OUT_OF_RANGE" });
      expect(store.bulkCalls).toEqual([]);
    });

    it("o variantă care are deja prețul 0 nu e „reparată” în tăcere: cererea se refuză întreagă", async () => {
      const { store, service } = setup();
      const p = store.seedProduct({ slug: "free", title: "Free" });
      store.seedVariant(p.id, { sku: "F-1", price: 0 });
      await expect(
        service.bulkUpdate(owner(), confirmed([p.id], { priceAdjustBps: 1000 })),
      ).rejects.toMatchObject({ code: "CATALOG_BULK_PRICE_OUT_OF_RANGE" });
      expect(store.bulkCalls).toEqual([]);
    });

    it("plafonul de sume: exact MAX_MONEY trece, cu un ban peste se refuză (+300% și +0,01%)", async () => {
      const at = async (price: number, bps: number) => {
        const { store, service } = setup();
        const p = store.seedProduct({ slug: `c${price}`, title: "C" });
        const v = store.seedVariant(p.id, { sku: `C-${price}`, price });
        const run = service.bulkUpdate(owner(), confirmed([p.id], { priceAdjustBps: bps }));
        return { run, store, variantId: v.id };
      };
      // 250.000.000 × 4 = 1.000.000.000 = plafonul
      const edge = await at(MAX_MONEY / 4, 30000);
      await edge.run;
      expect(edge.store.variants.get(edge.variantId)?.price).toBe(MAX_MONEY);

      for (const [price, bps] of [
        [MAX_MONEY / 4 + 1, 30000],
        [MAX_MONEY, 1],
        [MAX_MONEY, 30000],
      ] as const) {
        const over = await at(price, bps);
        await expect(over.run).rejects.toMatchObject({ code: "CATALOG_BULK_PRICE_OUT_OF_RANGE" });
        expect(over.store.bulkCalls).toEqual([]);
        expect(over.store.variants.get(over.variantId)?.price).toBe(price);
      }
    });

    it("niciun preț rezultat din ajustare nu iese din [1, MAX_MONEY] pe o grilă de valori și procente", async () => {
      const prices = [1, 2, 3, 4, 7, 9, 10, 99, 100, 101, 999, 12345, 2_000_000, MAX_MONEY / 4];
      const percents = [-9000, -8999, -5000, -3333, -1, 1, 3333, 9999, 15000, 30000];
      for (const price of prices) {
        for (const bps of percents) {
          const { store, service } = setup();
          const p = store.seedProduct({ slug: "g", title: "G" });
          const v = store.seedVariant(p.id, { sku: "G-1", price });
          try {
            await service.bulkUpdate(owner(), confirmed([p.id], { priceAdjustBps: bps }));
          } catch (error) {
            expect(error).toMatchObject({ code: "CATALOG_BULK_PRICE_OUT_OF_RANGE" });
          }
          const after = store.variants.get(v.id)?.price as number;
          expect(Number.isInteger(after)).toBe(true);
          expect(after).toBeGreaterThanOrEqual(1);
          expect(after).toBeLessThanOrEqual(MAX_MONEY);
        }
      }
    });
  });

  it("prețul inline pentru un produs cu o singură variantă; cu mai multe variante e refuzat", async () => {
    const { store, service } = setup();
    const single = store.seedProduct({ slug: "u", title: "U" });
    const v = store.seedVariant(single.id, { sku: "U-1", price: 1000 });
    const multi = store.seedProduct({ slug: "m", title: "M" });
    store.seedVariant(multi.id, { sku: "M-1" });
    store.seedVariant(multi.id, { sku: "M-2", position: 1 });

    const out = await service.updateSingleVariantPrice(roleSubject("manager"), single.id, 2500);
    expect(out).toMatchObject({ id: v.id, price: 2500 });
    await expect(
      service.updateSingleVariantPrice(roleSubject("manager"), multi.id, 100),
    ).rejects.toMatchObject({ code: "CATALOG_NOT_SINGLE_VARIANT" });
    await expect(
      service.updateSingleVariantPrice(roleSubject("editor"), single.id, 100),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

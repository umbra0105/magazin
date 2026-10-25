import { z } from "zod";
import type { Prisma, PrismaClient } from "@ecom/db";
import { UnauthenticatedError, type getLogger } from "@ecom/shared";
import type { AuditService } from "../audit/audit-service";
import { assertCan, can, type PermissionSubject } from "../rbac/can";
import { CATALOG_TAG, CatalogError, changedFields } from "./catalog-support";
import { FieldAccessGuard } from "./field-guard";
import { parseInput } from "./product-schemas";
import { generateUniqueSlug, isValidSlug, SLUG_MAX_LENGTH, SLUG_PATTERN } from "./slug";

/**
 * Brandurile: nume, adresă unică (fără diferență de majuscule), descriere, SEO, logo din bibliotecă.
 * Același model de permisiuni ca la categorii: conținutul (nume, descriere, SEO, logo) cere
 * `products.content.write`, structura (creare, adresă, ștergere) `products.write`, `legacyId` /
 * `legacyUrl` în plus `catalog.legacy.edit`. Un brand cu produse nu se șterge (mesaj cu numărul).
 */

export const BRAND_CONTENT_FIELDS = [
  "name",
  "description",
  "seoTitle",
  "seoDescription",
  "logoMediaId",
] as const;
export const BRAND_LEGACY_FIELDS = ["legacyId", "legacyUrl"] as const;

const text = (max: number) => z.string().trim().max(max).nullable().optional();
const fields = {
  name: z.string().trim().min(1, "Numele e obligatoriu").max(150),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(SLUG_MAX_LENGTH)
    .regex(SLUG_PATTERN, "Adresa poate conține doar litere mici, cifre și cratime")
    .optional(),
  description: z.string().max(20_000).nullable().optional(),
  seoTitle: text(255),
  seoDescription: text(500),
  logoMediaId: z.string().min(1).max(40).nullable().optional(),
  /** Termenul implicit «La comandă» (zile) al produselor brandului fără termen propriu; gol = setarea globală. */
  defaultLeadTimeDays: z
    .number({ error: "Termenul de livrare trebuie să fie un număr de zile" })
    .int("Termenul de livrare trebuie să fie un număr întreg de zile")
    .min(0, "Termenul de livrare nu poate fi negativ")
    .max(365, "Termenul de livrare are cel mult 365 de zile")
    .nullable()
    .optional(),
  legacyId: text(100),
  legacyUrl: z
    .string()
    .trim()
    .regex(/^https?:\/\/\S+$/, "Adresa veche trebuie să înceapă cu http:// sau https://")
    .max(1000)
    .nullable()
    .optional(),
};
export const brandCreateSchema = z.strictObject(fields);
export const brandUpdateSchema = z
  .strictObject(fields)
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nu a fost trimis niciun câmp de modificat",
  });

export interface BrandRecord {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  logoMediaId: string | null;
  defaultLeadTimeDays: number | null;
  legacyId: string | null;
  legacyUrl: string | null;
}

export interface BrandWithCount extends BrandRecord {
  /** Produse neșterse ale brandului. */
  productCount: number;
}

export interface BrandStore {
  listAll(): Promise<BrandWithCount[]>;
  get(id: string): Promise<BrandRecord | null>;
  findBySlug(slug: string, excludeId?: string): Promise<{ id: string; name: string } | null>;
  create(data: Partial<BrandRecord> & { slug: string; name: string }): Promise<BrandRecord>;
  update(id: string, data: Partial<BrandRecord>): Promise<BrandRecord>;
  countProducts(id: string): Promise<{ active: number; deleted: number }>;
  delete(id: string): Promise<void>;
  mediaExists(mediaId: string): Promise<boolean>;
}

const select = {
  id: true,
  slug: true,
  name: true,
  description: true,
  seoTitle: true,
  seoDescription: true,
  logoMediaId: true,
  defaultLeadTimeDays: true,
  legacyId: true,
  legacyUrl: true,
} satisfies Prisma.BrandSelect;

export function createPrismaBrandStore(db: PrismaClient | Prisma.TransactionClient): BrandStore {
  return {
    async listAll() {
      const [rows, counts] = await Promise.all([
        db.brand.findMany({ select, orderBy: { name: "asc" } }),
        db.product.groupBy({
          by: ["brandId"],
          where: { deletedAt: null, brandId: { not: null } },
          _count: { _all: true },
        }),
      ]);
      const byBrand = new Map(counts.map((c) => [c.brandId, c._count._all]));
      return rows.map((r) => ({ ...r, productCount: byBrand.get(r.id) ?? 0 }));
    },
    get: (id) => db.brand.findUnique({ where: { id }, select }),
    findBySlug: (slug, excludeId) =>
      db.brand.findFirst({
        where: {
          slug: { equals: slug, mode: "insensitive" },
          ...(excludeId ? { id: { not: excludeId } } : {}),
        },
        select: { id: true, name: true },
      }),
    create: (data) => db.brand.create({ data, select }),
    update: (id, data) => db.brand.update({ where: { id }, data, select }),
    async countProducts(id) {
      const [active, deleted] = await Promise.all([
        db.product.count({ where: { brandId: id, deletedAt: null } }),
        db.product.count({ where: { brandId: id, deletedAt: { not: null } } }),
      ]);
      return { active, deleted };
    },
    async delete(id) {
      await db.brand.delete({ where: { id } });
    },
    async mediaExists(mediaId) {
      return (await db.media.count({ where: { id: mediaId } })) > 0;
    },
  };
}

export interface BrandServiceDeps {
  store: BrandStore;
  audit: AuditService;
  invalidate?: (tags: readonly string[]) => Promise<void> | void;
  logger: Pick<ReturnType<typeof getLogger>, "warn">;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export class BrandService {
  private readonly guard: FieldAccessGuard;

  constructor(private readonly deps: BrandServiceDeps) {
    this.guard = new FieldAccessGuard(
      { audit: deps.audit },
      {
        entity: "brand",
        action: "brand.update",
        contentFields: BRAND_CONTENT_FIELDS,
        legacyFields: BRAND_LEGACY_FIELDS,
        labels: {
          slug: "adresa",
          defaultLeadTimeDays: "termenul implicit de livrare",
          legacyId: "identificatorul din magazinul vechi",
          legacyUrl: "adresa din magazinul vechi",
        },
      },
    );
  }

  private async invalidate(id: string): Promise<void> {
    const tags = [CATALOG_TAG, `brand:${id}`];
    try {
      await this.deps.invalidate?.(tags);
    } catch (error) {
      this.deps.logger.warn(
        { tags, reason: error instanceof Error ? error.message : "necunoscut" },
        "catalog: invalidarea cache-ului a eșuat",
      );
    }
  }

  private conflict(slug: string, owner: { name: string }): CatalogError {
    return new CatalogError(
      "BRAND_SLUG_CONFLICT",
      `Adresa «${slug}» e deja folosită de brandul «${owner.name}». Alege altă adresă.`,
      { slug },
    );
  }

  private async assertLogo(logoMediaId: string | null | undefined): Promise<void> {
    if (logoMediaId && !(await this.deps.store.mediaExists(logoMediaId))) {
      throw new CatalogError("BRAND_LOGO_NOT_FOUND", "Logoul ales nu mai există în bibliotecă");
    }
  }

  async list(subject: PermissionSubject | null): Promise<BrandWithCount[]> {
    assertCan(subject, "products.read");
    return this.deps.store.listAll();
  }

  async create(subject: PermissionSubject | null, input: unknown): Promise<BrandRecord> {
    assertCan(subject, "products.write");
    const data = parseInput(brandCreateSchema, input);
    if (
      (data.legacyId !== undefined || data.legacyUrl !== undefined) &&
      !can(subject, "catalog.legacy.edit")
    ) {
      assertCan(subject, "catalog.legacy.edit");
    }
    await this.assertLogo(data.logoMediaId);

    let slug: string;
    if (data.slug) {
      const owner = await this.deps.store.findBySlug(data.slug);
      if (owner) throw this.conflict(data.slug, owner);
      slug = data.slug;
    } else {
      slug = await generateUniqueSlug(
        data.name,
        async (s) => (await this.deps.store.findBySlug(s)) !== null,
      );
    }
    const fieldsOnly: Record<string, unknown> = { ...data };
    delete fieldsOnly["slug"];
    const created = await this.deps.store.create({
      ...(fieldsOnly as Partial<BrandRecord>),
      name: data.name,
      slug,
    });
    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "brand.create",
      entity: "brand",
      entityId: created.id,
      after: { name: created.name, slug: created.slug },
    });
    await this.invalidate(created.id);
    return created;
  }

  async update(
    subject: PermissionSubject | null,
    id: string,
    input: unknown,
  ): Promise<BrandRecord> {
    if (!subject) throw new UnauthenticatedError();
    const patch = parseInput(brandUpdateSchema, input);
    return this.guard.run(subject, { id }, patch, async () => {
      const before = await this.deps.store.get(id);
      if (!before) throw new CatalogError("BRAND_NOT_FOUND", "Brandul nu există");
      await this.assertLogo(patch.logoMediaId);
      if (patch.slug !== undefined && patch.slug.toLowerCase() !== before.slug.toLowerCase()) {
        const owner = await this.deps.store.findBySlug(patch.slug, id);
        if (owner) throw this.conflict(patch.slug, owner);
      }
      const diff = changedFields(before as unknown as Record<string, unknown>, patch);
      if (Object.keys(diff.after).length === 0) return before;
      const after = await this.deps.store.update(id, patch as Partial<BrandRecord>);
      await this.deps.audit.record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "brand.update",
        entity: "brand",
        entityId: id,
        before: diff.before,
        after: diff.after,
      });
      await this.invalidate(id);
      return after;
    });
  }

  /** Șterge un brand fără produse; altfel refuz cu numărul de produse (nu eroare de bază). */
  async delete(subject: PermissionSubject | null, id: string): Promise<void> {
    assertCan(subject, "products.write");
    const brand = await this.deps.store.get(id);
    if (!brand) throw new CatalogError("BRAND_NOT_FOUND", "Brandul nu există");
    const products = await this.deps.store.countProducts(id);
    if (products.active + products.deleted > 0) {
      const parts = [plural(products.active, "produs", "produse")];
      if (products.deleted > 0)
        parts.push(plural(products.deleted, "produs șters", "produse șterse"));
      throw new CatalogError(
        "BRAND_HAS_PRODUCTS",
        `Brandul «${brand.name}» nu poate fi șters: este folosit de ${parts.join(" și ")}. Schimbă brandul acestor produse sau scoate-l din ele.`,
        { products: products.active, deletedProducts: products.deleted },
      );
    }
    await this.deps.store.delete(id);
    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "brand.delete",
      entity: "brand",
      entityId: id,
      before: { name: brand.name, slug: brand.slug },
    });
    await this.invalidate(id);
  }

  async checkSlug(
    subject: PermissionSubject | null,
    slug: string,
    excludeId?: string,
  ): Promise<{ available: boolean; message: string | null }> {
    assertCan(subject, "products.read");
    if (!isValidSlug(slug)) {
      return {
        available: false,
        message: "Adresa poate conține doar litere mici, cifre și cratime",
      };
    }
    const owner = await this.deps.store.findBySlug(slug, excludeId);
    return owner
      ? { available: false, message: this.conflict(slug, owner).message }
      : { available: true, message: null };
  }
}

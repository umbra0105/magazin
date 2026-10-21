import { z } from "zod";
import type { Prisma, PrismaClient } from "@ecom/db";
import type { StorageDriver } from "@ecom/integrations";
import { DomainError, type getLogger } from "@ecom/shared";
import type { AuditService } from "../audit/audit-service";
import { buildMediaUrls } from "../media/urls";
import { assertCan, type PermissionSubject } from "../rbac/can";
import { CATALOG_TAG, CatalogError } from "./catalog-support";
import { parseInput } from "./product-schemas";

/**
 * Fișa explodată (piese de schimb): o imagine din biblioteca media cu hotspot-uri numerotate, fiecare
 * legat de un produs (piesa) și/sau de o etichetă. O fișă aparține MAI MULTOR produse (o familie de
 * pompe are aceeași fișă pentru 6 modele): \`PartsDiagramProduct\`.
 *
 * Reguli (verificate de teste):
 * - **flag \`partsDiagrams\`**: oprit = serviciul refuză orice operație (\`FEATURE_DISABLED\`), indiferent
 *   de apelant; meniul, rutele (404) și tabul din produs se ascund separat, în aplicație;
 * - **permisiuni:** scrierile cer \`products.write\` (structură de catalog: și titlul, schema fișei nu
 *   are descriere), citirea \`products.read\`;
 * - **hotspot:** număr întreg 1–9999 UNIC pe fișă; poziția în puncte de bază 0–10000, ambele coordonate
 *   sau niciuna (varianta A: tabel fără poziții); cel puțin un produs SAU o etichetă; produsul legat
 *   trebuie să existe și să nu fie șters;
 * - **imaginea:** doar fișiere \`ready\` din bibliotecă (FK \`Restrict\`: ștergerea unei imagini folosite e
 *   refuzată, cu fișa ca loc de folosire — providerul din \`media-usage.ts\`);
 * - **ștergerea unei fișe** cere confirmare cu numărul EXACT de hotspot-uri (serverul o verifică);
 * - ștergerea definitivă a unui produs lasă hotspot-ul fără produs (\`ON DELETE SET NULL\`).
 */

export const MAX_HOTSPOTS_PER_DIAGRAM = 200;
export const MAX_HOTSPOT_NUMBER = 9999;
export const BASIS_POINTS_MAX = 10_000;

export interface DiagramProductSummary {
  id: string;
  title: string;
  sku: string | null;
  status: string;
  deleted: boolean;
}

export interface DiagramHotspot {
  id: string;
  number: number;
  xBp: number | null;
  yBp: number | null;
  label: string | null;
  /** `null` = fără produs (nelegat sau produsul a fost șters definitiv). */
  product: DiagramProductSummary | null;
}

export interface DiagramImage {
  mediaId: string;
  status: string;
  name: string;
  alt: string;
  width: number | null;
  height: number | null;
  /** Varianta potrivită pentru ecran (medie), niciodată cheia de storage. */
  url: string | null;
}

export interface DiagramListItem {
  id: string;
  title: string;
  hotspotCount: number;
  productCount: number;
  image: DiagramImage;
  updatedAt: Date;
}

export interface DiagramDetail {
  id: string;
  title: string;
  image: DiagramImage;
  hotspots: DiagramHotspot[];
  products: DiagramProductSummary[];
}

interface RawMedia {
  id: string;
  status: string;
  originalName: string;
  alt: string | null;
  storageKey: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  variants: unknown;
}

interface RawProduct {
  id: string;
  title: string;
  status: string;
  deletedAt: Date | null;
  sku: string | null;
}

export interface PartsDiagramStore {
  list(): Promise<
    {
      id: string;
      title: string;
      updatedAt: Date;
      hotspotCount: number;
      productCount: number;
      media: RawMedia;
    }[]
  >;
  get(id: string): Promise<{
    id: string;
    title: string;
    media: RawMedia;
    hotspots: {
      id: string;
      number: number;
      xBp: number | null;
      yBp: number | null;
      label: string | null;
      product: RawProduct | null;
    }[];
    products: RawProduct[];
  } | null>;
  create(data: { title: string; mediaId: string }): Promise<{ id: string }>;
  update(id: string, data: { title?: string; mediaId?: string }): Promise<void>;
  /** Șterge fișa (hotspot-urile și asocierile se șterg în cascadă). */
  delete(id: string): Promise<void>;
  isMediaReady(mediaId: string): Promise<boolean>;
  getProduct(id: string): Promise<RawProduct | null>;
  attach(diagramId: string, productId: string): Promise<void>;
  detach(diagramId: string, productId: string): Promise<void>;
  attachedProductIds(diagramId: string): Promise<string[]>;
  /** Fișele asociate unui produs. */
  forProduct(productId: string): Promise<
    {
      id: string;
      title: string;
      hotspotCount: number;
      media: RawMedia;
      updatedAt: Date;
      productCount: number;
    }[]
  >;
  getHotspot(id: string): Promise<{ id: string; diagramId: string; number: number } | null>;
  numberTaken(diagramId: string, number: number, excludeHotspotId?: string): Promise<boolean>;
  countHotspots(diagramId: string): Promise<number>;
  nextNumber(diagramId: string): Promise<number>;
  saveHotspot(
    diagramId: string,
    hotspotId: string | null,
    data: {
      number: number;
      xBp: number | null;
      yBp: number | null;
      productId: string | null;
      label: string | null;
    },
  ): Promise<{ id: string }>;
  deleteHotspot(id: string): Promise<void>;
}

export interface PartsDiagramServiceDeps {
  store: PartsDiagramStore;
  storage: StorageDriver;
  audit: AuditService;
  /** Flag-ul `partsDiagrams` (în aplicație: `getFeatureFlags().isEnabled("partsDiagrams")`). */
  isEnabled: () => Promise<boolean>;
  invalidate?: (tags: readonly string[]) => Promise<void> | void;
  logger: Pick<ReturnType<typeof getLogger>, "warn">;
}

const id = z.string().min(1).max(40);
const title = z.string().trim().min(1, "Titlul e obligatoriu").max(200);

const createSchema = z.strictObject({ title, mediaId: id });
const updateSchema = z
  .strictObject({ title: title.optional(), mediaId: id.optional() })
  .refine((v) => v.title !== undefined || v.mediaId !== undefined, {
    message: "Nu a fost trimis niciun câmp de modificat",
  });

const bp = z.number().int().min(0).max(BASIS_POINTS_MAX);
const hotspotSchema = z
  .strictObject({
    id: id.optional(),
    number: z.number().int().min(1).max(MAX_HOTSPOT_NUMBER).optional(),
    xBp: bp.nullable().optional(),
    yBp: bp.nullable().optional(),
    productId: id.nullable().optional(),
    label: z.string().trim().max(200).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const x = value.xBp ?? null;
    const y = value.yBp ?? null;
    if ((x === null) !== (y === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["xBp"],
        message: "Poziția are nevoie de ambele coordonate (orizontală și verticală) sau de niciuna",
      });
    }
  });

const NOT_FOUND = () => new CatalogError("DIAGRAM_NOT_FOUND", "Fișa explodată nu mai există");

const hotspots = (n: number): string => (n === 1 ? "1 hotspot" : `${n} hotspot-uri`);

export class FeatureDisabledError extends DomainError {
  constructor() {
    super("FEATURE_DISABLED", "Funcționalitatea „Fișe explodate” este oprită");
  }
}

export class PartsDiagramService {
  constructor(private readonly deps: PartsDiagramServiceDeps) {}

  private async gate(): Promise<void> {
    if (!(await this.deps.isEnabled())) throw new FeatureDisabledError();
  }

  private async invalidate(productIds: readonly string[]): Promise<void> {
    try {
      const tags = new Set<string>([CATALOG_TAG]);
      for (const productId of productIds) tags.add(`product:${productId}`);
      await this.deps.invalidate?.([...tags]);
    } catch (error) {
      this.deps.logger.warn(
        { reason: error instanceof Error ? error.message : "necunoscut" },
        "fișe explodate: invalidarea cache-ului a eșuat",
      );
    }
  }

  private async audit(
    subject: PermissionSubject,
    action: string,
    diagramId: string | null,
    before?: Record<string, unknown>,
    after?: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action,
      entity: "parts_diagram",
      entityId: diagramId,
      ...(before && { before }),
      ...(after && { after }),
    });
  }

  private image(media: RawMedia): DiagramImage {
    let url: string | null = null;
    if (media.status === "ready") {
      const urls = buildMediaUrls(media, this.deps.storage);
      const pick = (name: string, format: string) =>
        urls.variants.find((v) => v.name === name && v.format === format)?.url;
      url =
        pick("medium", "webp") ??
        pick("medium", "jpeg") ??
        pick("large", "webp") ??
        pick("large", "jpeg") ??
        urls.original;
    }
    return {
      mediaId: media.id,
      status: media.status,
      name: media.originalName,
      alt: media.alt ?? "",
      width: media.width,
      height: media.height,
      url,
    };
  }

  private summary(product: RawProduct): DiagramProductSummary {
    return {
      id: product.id,
      title: product.title,
      sku: product.sku,
      status: product.status,
      deleted: product.deletedAt !== null,
    };
  }

  /** Toate fișele (cere `products.read`). */
  async list(subject: PermissionSubject | null): Promise<DiagramListItem[]> {
    await this.gate();
    assertCan(subject, "products.read");
    const rows = await this.deps.store.list();
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      hotspotCount: r.hotspotCount,
      productCount: r.productCount,
      image: this.image(r.media),
      updatedAt: r.updatedAt,
    }));
  }

  /** O fișă cu hotspot-urile și produsele asociate (cere `products.read`). */
  async get(subject: PermissionSubject | null, diagramId: string): Promise<DiagramDetail> {
    await this.gate();
    assertCan(subject, "products.read");
    const row = await this.deps.store.get(diagramId);
    if (!row) throw NOT_FOUND();
    return {
      id: row.id,
      title: row.title,
      image: this.image(row.media),
      hotspots: row.hotspots.map((h) => ({
        id: h.id,
        number: h.number,
        xBp: h.xBp,
        yBp: h.yBp,
        label: h.label,
        product: h.product ? this.summary(h.product) : null,
      })),
      products: row.products.map((p) => this.summary(p)),
    };
  }

  /** Fișele asociate unui produs (tabul „Piese de schimb”). Cere `products.read`. */
  async forProduct(
    subject: PermissionSubject | null,
    productId: string,
  ): Promise<DiagramListItem[]> {
    await this.gate();
    assertCan(subject, "products.read");
    const rows = await this.deps.store.forProduct(productId);
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      hotspotCount: r.hotspotCount,
      productCount: r.productCount,
      image: this.image(r.media),
      updatedAt: r.updatedAt,
    }));
  }

  async create(subject: PermissionSubject | null, input: unknown): Promise<{ id: string }> {
    await this.gate();
    assertCan(subject, "products.write");
    const data = parseInput(createSchema, input);
    await this.assertMediaReady(data.mediaId);
    const created = await this.deps.store.create(data);
    await this.audit(subject, "parts_diagram.create", created.id, undefined, {
      title: data.title,
      mediaId: data.mediaId,
    });
    await this.invalidate([]);
    return created;
  }

  async update(
    subject: PermissionSubject | null,
    diagramId: string,
    input: unknown,
  ): Promise<void> {
    await this.gate();
    assertCan(subject, "products.write");
    const patch = parseInput(updateSchema, input);
    const before = await this.deps.store.get(diagramId);
    if (!before) throw NOT_FOUND();
    const data: { title?: string; mediaId?: string } = {};
    if (patch.title !== undefined && patch.title !== before.title) data.title = patch.title;
    if (patch.mediaId !== undefined && patch.mediaId !== before.media.id) {
      await this.assertMediaReady(patch.mediaId);
      data.mediaId = patch.mediaId;
    }
    if (Object.keys(data).length === 0) return;
    await this.deps.store.update(diagramId, data);
    await this.audit(
      subject,
      "parts_diagram.update",
      diagramId,
      { title: before.title, mediaId: before.media.id },
      data,
    );
    await this.invalidate(await this.deps.store.attachedProductIds(diagramId));
  }

  /**
   * Șterge fișa. `input`: `{ confirm: true, expectedHotspots: <numărul afișat> }`; serverul refuză dacă
   * numărul nu corespunde celui real (fișa s-a schimbat între timp sau confirmarea e un clic orb).
   */
  async delete(
    subject: PermissionSubject | null,
    diagramId: string,
    input: unknown,
  ): Promise<{ deletedHotspots: number }> {
    await this.gate();
    assertCan(subject, "products.write");
    const data = parseInput(
      z.strictObject({
        confirm: z.literal(true, { error: "Confirmarea explicită lipsește" }),
        expectedHotspots: z.number().int().min(0).max(100_000),
      }),
      input,
    );
    const row = await this.deps.store.get(diagramId);
    if (!row) throw NOT_FOUND();
    if (row.hotspots.length !== data.expectedHotspots) {
      throw new CatalogError(
        "DIAGRAM_DELETE_MISMATCH",
        `Fișa are acum ${hotspots(row.hotspots.length)}, nu ${hotspots(data.expectedHotspots)}: reîncarcă pagina și confirmă din nou`,
        { actual: row.hotspots.length },
      );
    }
    const productIds = await this.deps.store.attachedProductIds(diagramId);
    await this.deps.store.delete(diagramId);
    await this.audit(subject, "parts_diagram.delete", diagramId, {
      title: row.title,
      hotspots: row.hotspots.length,
      products: productIds.length,
    });
    await this.invalidate(productIds);
    return { deletedHotspots: row.hotspots.length };
  }

  /** Asociază fișa unui produs (idempotent). */
  async attachProduct(
    subject: PermissionSubject | null,
    diagramId: string,
    productId: string,
  ): Promise<void> {
    await this.gate();
    assertCan(subject, "products.write");
    if (!(await this.deps.store.get(diagramId))) throw NOT_FOUND();
    const product = await this.deps.store.getProduct(productId);
    if (!product) throw new CatalogError("CATALOG_PRODUCT_NOT_FOUND", "Produsul nu există");
    if (product.deletedAt) {
      throw new CatalogError("CATALOG_PRODUCT_DELETED", "Produsul e șters și nu poate fi asociat");
    }
    await this.deps.store.attach(diagramId, productId);
    await this.audit(subject, "parts_diagram.attach", diagramId, undefined, { productId });
    await this.invalidate([productId]);
  }

  async detachProduct(
    subject: PermissionSubject | null,
    diagramId: string,
    productId: string,
  ): Promise<void> {
    await this.gate();
    assertCan(subject, "products.write");
    if (!(await this.deps.store.get(diagramId))) throw NOT_FOUND();
    await this.deps.store.detach(diagramId, productId);
    await this.audit(subject, "parts_diagram.detach", diagramId, { productId });
    await this.invalidate([productId]);
  }

  /**
   * Creează (fără `id`) sau modifică (cu `id`) un hotspot. Fără `number` la creare se alege următorul
   * liber. `xBp`/`yBp`: puncte de bază 0–10000, ambele sau niciuna. Cere `products.write`.
   */
  async saveHotspot(
    subject: PermissionSubject | null,
    diagramId: string,
    input: unknown,
  ): Promise<{ id: string; number: number }> {
    await this.gate();
    assertCan(subject, "products.write");
    const data = parseInput(hotspotSchema, input);
    if (!(await this.deps.store.get(diagramId))) throw NOT_FOUND();

    const label = data.label?.trim() ? data.label.trim() : null;
    const productId = data.productId ?? null;
    if (productId === null && label === null) {
      throw new CatalogError(
        "DIAGRAM_HOTSPOT_INVALID",
        "Hotspot-ul are nevoie de un produs (piesa) sau de o etichetă",
      );
    }
    if (productId !== null) {
      const product = await this.deps.store.getProduct(productId);
      if (!product) throw new CatalogError("CATALOG_PRODUCT_NOT_FOUND", "Produsul nu există");
      if (product.deletedAt) {
        throw new CatalogError("CATALOG_PRODUCT_DELETED", "Produsul e șters și nu poate fi legat");
      }
    }

    let existing: { id: string; diagramId: string; number: number } | null = null;
    if (data.id) {
      existing = await this.deps.store.getHotspot(data.id);
      if (!existing || existing.diagramId !== diagramId) {
        throw new CatalogError("DIAGRAM_HOTSPOT_NOT_FOUND", "Hotspot-ul nu mai există");
      }
    } else if ((await this.deps.store.countHotspots(diagramId)) >= MAX_HOTSPOTS_PER_DIAGRAM) {
      throw new CatalogError(
        "DIAGRAM_HOTSPOT_LIMIT",
        `O fișă poate avea cel mult ${MAX_HOTSPOTS_PER_DIAGRAM} de hotspot-uri`,
      );
    }

    const number = data.number ?? existing?.number ?? (await this.deps.store.nextNumber(diagramId));
    if (number > MAX_HOTSPOT_NUMBER) {
      throw new CatalogError("DIAGRAM_HOTSPOT_INVALID", "Numărul hotspot-ului e prea mare");
    }
    if (await this.deps.store.numberTaken(diagramId, number, existing?.id)) {
      throw new CatalogError(
        "DIAGRAM_HOTSPOT_NUMBER_TAKEN",
        `Numărul ${number} e deja folosit de alt hotspot al fișei. Alege alt număr`,
        { number },
      );
    }

    const saved = await this.deps.store.saveHotspot(diagramId, existing?.id ?? null, {
      number,
      xBp: data.xBp ?? null,
      yBp: data.yBp ?? null,
      productId,
      label,
    });
    await this.audit(subject, "parts_diagram.hotspot.save", diagramId, undefined, {
      hotspotId: saved.id,
      number,
      productId,
      xBp: data.xBp ?? null,
      yBp: data.yBp ?? null,
    });
    await this.invalidate(await this.deps.store.attachedProductIds(diagramId));
    return { id: saved.id, number };
  }

  async deleteHotspot(
    subject: PermissionSubject | null,
    diagramId: string,
    hotspotId: string,
  ): Promise<void> {
    await this.gate();
    assertCan(subject, "products.write");
    const hotspot = await this.deps.store.getHotspot(hotspotId);
    if (!hotspot || hotspot.diagramId !== diagramId) {
      throw new CatalogError("DIAGRAM_HOTSPOT_NOT_FOUND", "Hotspot-ul nu mai există");
    }
    await this.deps.store.deleteHotspot(hotspotId);
    await this.audit(subject, "parts_diagram.hotspot.delete", diagramId, {
      hotspotId,
      number: hotspot.number,
    });
    await this.invalidate(await this.deps.store.attachedProductIds(diagramId));
  }

  private async assertMediaReady(mediaId: string): Promise<void> {
    if (!(await this.deps.store.isMediaReady(mediaId))) {
      throw new CatalogError(
        "DIAGRAM_MEDIA_INVALID",
        "Imaginea aleasă nu există sau nu e încă gata de folosit. Alege o imagine din bibliotecă",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Prisma
// ---------------------------------------------------------------------------

type Db = PrismaClient | Prisma.TransactionClient;

const mediaSelect = {
  id: true,
  status: true,
  originalName: true,
  alt: true,
  storageKey: true,
  width: true,
  height: true,
  blurhash: true,
  variants: true,
} satisfies Prisma.MediaSelect;

const productSelect = {
  id: true,
  title: true,
  status: true,
  deletedAt: true,
  variants: {
    orderBy: [{ isDefault: "desc" }, { position: "asc" }],
    take: 1,
    select: { sku: true },
  },
} satisfies Prisma.ProductSelect;

type RawProductRow = Prisma.ProductGetPayload<{ select: typeof productSelect }>;

const toProduct = (row: RawProductRow): RawProduct => ({
  id: row.id,
  title: row.title,
  status: row.status,
  deletedAt: row.deletedAt,
  sku: row.variants[0]?.sku ?? null,
});

export function createPrismaPartsDiagramStore(db: Db): PartsDiagramStore {
  return {
    async list() {
      const rows = await db.partsDiagram.findMany({
        orderBy: { title: "asc" },
        select: {
          id: true,
          title: true,
          updatedAt: true,
          media: { select: mediaSelect },
          _count: { select: { hotspots: true, products: true } },
        },
      });
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        updatedAt: r.updatedAt,
        hotspotCount: r._count.hotspots,
        productCount: r._count.products,
        media: r.media,
      }));
    },

    async get(id) {
      const row = await db.partsDiagram.findUnique({
        where: { id },
        select: {
          id: true,
          title: true,
          media: { select: mediaSelect },
          hotspots: {
            orderBy: { number: "asc" },
            select: {
              id: true,
              number: true,
              xBp: true,
              yBp: true,
              label: true,
              product: { select: productSelect },
            },
          },
          products: {
            select: { product: { select: productSelect } },
          },
        },
      });
      if (!row) return null;
      return {
        id: row.id,
        title: row.title,
        media: row.media,
        hotspots: row.hotspots.map((h) => ({
          id: h.id,
          number: h.number,
          xBp: h.xBp,
          yBp: h.yBp,
          label: h.label,
          product: h.product ? toProduct(h.product) : null,
        })),
        // un produs șters definitiv între citiri vine cu relația `null` (Prisma le citește separat): se omite (C-34)
        products: row.products
          .flatMap((p) => (p.product ? [toProduct(p.product)] : []))
          .sort((a, b) => a.title.localeCompare(b.title, "ro")),
      };
    },

    create: (data) => db.partsDiagram.create({ data, select: { id: true } }),

    async update(id, data) {
      await db.partsDiagram.update({ where: { id }, data });
    },

    async delete(id) {
      await db.partsDiagram.delete({ where: { id } });
    },

    async isMediaReady(mediaId) {
      return (await db.media.count({ where: { id: mediaId, status: "ready" } })) > 0;
    },

    async getProduct(id) {
      const row = await db.product.findUnique({ where: { id }, select: productSelect });
      return row ? toProduct(row) : null;
    },

    async attach(diagramId, productId) {
      await db.partsDiagramProduct.upsert({
        where: { diagramId_productId: { diagramId, productId } },
        create: { diagramId, productId },
        update: {},
      });
    },

    async detach(diagramId, productId) {
      await db.partsDiagramProduct.deleteMany({ where: { diagramId, productId } });
    },

    async attachedProductIds(diagramId) {
      const rows = await db.partsDiagramProduct.findMany({
        where: { diagramId },
        select: { productId: true },
      });
      return rows.map((r) => r.productId);
    },

    async forProduct(productId) {
      const rows = await db.partsDiagram.findMany({
        where: { products: { some: { productId } } },
        orderBy: { title: "asc" },
        select: {
          id: true,
          title: true,
          updatedAt: true,
          media: { select: mediaSelect },
          _count: { select: { hotspots: true, products: true } },
        },
      });
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        updatedAt: r.updatedAt,
        hotspotCount: r._count.hotspots,
        productCount: r._count.products,
        media: r.media,
      }));
    },

    getHotspot: (id) =>
      db.partsDiagramHotspot.findUnique({
        where: { id },
        select: { id: true, diagramId: true, number: true },
      }),

    async numberTaken(diagramId, number, excludeHotspotId) {
      const count = await db.partsDiagramHotspot.count({
        where: { diagramId, number, ...(excludeHotspotId && { id: { not: excludeHotspotId } }) },
      });
      return count > 0;
    },

    countHotspots: (diagramId) => db.partsDiagramHotspot.count({ where: { diagramId } }),

    async nextNumber(diagramId) {
      const last = await db.partsDiagramHotspot.findFirst({
        where: { diagramId },
        orderBy: { number: "desc" },
        select: { number: true },
      });
      return (last?.number ?? 0) + 1;
    },

    async saveHotspot(diagramId, hotspotId, data) {
      if (hotspotId) {
        return db.partsDiagramHotspot.update({
          where: { id: hotspotId },
          data,
          select: { id: true },
        });
      }
      return db.partsDiagramHotspot.create({
        data: { diagramId, ...data },
        select: { id: true },
      });
    },

    async deleteHotspot(id) {
      await db.partsDiagramHotspot.delete({ where: { id } });
    },
  };
}

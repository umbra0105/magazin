import { Prisma, type PrismaClient } from "@ecom/db";
import type { StorageDriver } from "@ecom/integrations";
import { findRedirectTarget, type RedirectKind } from "../catalog/slug-redirect";
import { buildStockOverviewRow } from "../inventory/stock-overview";
import {
  createPrismaStockOverviewStore,
  type StockOverviewStore,
} from "../inventory/stock-overview-store";
import { pickBestVariantImage } from "../media/urls";
import { isSearchable, likePrefix } from "./search-query";
import {
  listingPrice,
  displayedPrice,
  type DisplayedPrice,
  type ListingPrice,
} from "./listing-price";
import type { ListingSort } from "./listing-query";
import { joinAnd, scopeConditions, searchRank, type ListingScope } from "./listing-sql";
import type { ListingFilters, NumericRange } from "./listing-filters";
import {
  publicAvailabilityOfRow,
  summarizeProductAvailability,
  type PublicAvailability,
} from "./public-availability";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Citirea catalogului pentru vitrină (Faza 7): produse ACTIVE și nesterse, doar câmpuri PUBLICE. ⚠️ Câmpurile de achiziție
 * (prețul de intrare, data lui, istoricul) nu sunt selectate nicăieri aici (testul de arhitectură al costului și un test al
 * acestui modul o verifică); cantitățile de stoc nu ies, doar starea vizibilă (`PublicAvailability`). Prețul vine din
 * câmpurile existente (`listing-price.ts`), nu dintr-un motor de prețuri (Faza 8).
 */

export interface StorefrontImage {
  src: string;
  width: number;
  height: number;
  alt: string;
}

export interface CatalogSettings {
  showSalePricing: boolean;
  productsPerPage: number;
  /** `inventory.lowStockSteps` și `inventory.defaultLeadTimeDays`: intră în starea vizibilă a stocului. */
  lowStockSteps: number;
  defaultLeadTimeDays: number;
}

export interface ListedProduct {
  id: string;
  slug: string;
  title: string;
  brandName: string | null;
  image: StorefrontImage | null;
  price: ListingPrice | null;
  availability: PublicAvailability;
  energyClass: string | null;
}

export type { ListingScope } from "./listing-sql";

export interface FacetRange {
  code: string;
  name: string;
  unit: string | null;
  /** Limitele reale ale valorilor din listă (fără propriul filtru). */
  min: number;
  max: number;
  /** Câte produse din listă au o valoare pentru acest atribut. */
  count: number;
  selected: NumericRange | null;
}

export interface FacetOptions {
  code: string;
  name: string;
  options: { id: string; value: string; count: number; selected: boolean }[];
}

export interface ListingFacets {
  brands: { slug: string; name: string; count: number; selected: boolean }[];
  ranges: FacetRange[];
  options: FacetOptions[];
}

export interface BrandPageData {
  name: string;
  slug: string;
  description: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  logo: StorefrontImage | null;
}

export interface CollectionPageData {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
}

export interface ListingResult {
  items: ListedProduct[];
  total: number;
}

export interface ResolvedKey {
  kind: "ok" | "redirect" | "missing";
  /** Adresa canonică curentă (la `ok` și `redirect`). */
  canonical: string | null;
}

export interface PageDocument {
  id: string;
  title: string;
  /** energy_label | product_sheet | manual | ce_declaration | datasheet | warranty | other */
  type: string;
  mime: string;
  sizeBytes: number;
  language: string;
}

export interface PageDiagram {
  title: string;
  image: StorefrontImage | null;
  /** Rândurile numerotate ale fișei: punctul de pe imagine (sutimi de procent) e opțional, tabelul le are mereu. */
  parts: {
    number: number;
    xBp: number | null;
    yBp: number | null;
    label: string | null;
    product: {
      slug: string;
      title: string;
      price: ListingPrice | null;
      availability: PublicAvailability;
    } | null;
  }[];
}

export interface PageVariant {
  id: string;
  sku: string;
  ean: string | null;
  warrantyMonths: number | null;
  /** Valorile opțiunilor («1,8 ml · Stejar»); gol la produsul simplu. */
  label: string;
  /** `optionId → valueId`, pentru selectorul de variante. */
  optionValues: Record<string, string>;
  price: DisplayedPrice;
  availability: PublicAvailability;
  isDefault: boolean;
  unitSymbol: string | null;
  manufacturerPartNumber: string | null;
}

export interface GalleryImage {
  thumb: StorefrontImage;
  large: StorefrontImage;
  /** Imaginea aparține unei variante anume (selectorul o poate arăta); `null` = a produsului. */
  variantId: string | null;
}

export interface SpecRow {
  code: string;
  name: string;
  type: "text" | "number" | "select" | "bool";
  unit: string | null;
  /** Valoarea ca text; la numere, șirul exact din bază (formatarea în română o face interfața). */
  value: string;
}

export interface ProductPageData {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  /** HTML-ul descrierii așa cum e în bază: interfața îl trece prin `renderRichText` (re-sanitizare) înainte de afișare. */
  descriptionHtml: string | null;
  brand: { name: string; slug: string } | null;
  /** Calea de la rădăcină la categoria primară (pentru firimituri), din adrese reale. */
  trail: { name: string; path: string }[];
  seoTitle: string | null;
  seoDescription: string | null;
  isDigital: boolean;
  shippingClass: string;
  energyClass: string | null;
  eprelUrl: string | null;
  gpsr: {
    manufacturerName: string | null;
    manufacturerContact: string | null;
    responsibleName: string | null;
    responsibleContact: string | null;
    safetyWarnings: string | null;
  };
  options: { id: string; name: string; values: { id: string; value: string }[] }[];
  variants: PageVariant[];
  gallery: GalleryImage[];
  specs: SpecRow[];
  related: ListedProduct[];
  /** Documentele din tabul «Descărcări» (doar cele marcate să apară acolo). */
  documents: PageDocument[];
  /** Piesele de schimb (relația `spare_part`) și produsele cu care se montează (`compatible_with`). */
  spareParts: ListedProduct[];
  compatible: ListedProduct[];
  /** Prima fișă explodată atașată, doar când funcționalitatea e pornită (`options.includeDiagram`). */
  diagram: PageDiagram | null;
  /** ISO 8601 (șir, nu `Date`: datele trec prin cache-ul serializat al vitrinei). */
  updatedAt: string;
}

export interface CategoryPageData {
  id: string;
  name: string;
  path: string;
  description: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  image: StorefrontImage | null;
  /** De la rădăcină până la categoria curentă inclusiv. */
  trail: { name: string; path: string }[];
}

export interface CatalogReaderDeps {
  db: Db;
  storage: StorageDriver;
  now?: () => Date;
  stockStore?: StockOverviewStore;
}

const productListSelect = {
  id: true,
  slug: true,
  title: true,
  energyClass: true,
  brand: { select: { name: true } },
  variants: {
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: {
      id: true,
      price: true,
      salePrice: true,
      saleStartsAt: true,
      saleEndsAt: true,
    },
  },
  media: {
    where: { variantId: null },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    take: 1,
    select: {
      media: {
        select: {
          status: true,
          alt: true,
          storageKey: true,
          width: true,
          height: true,
          blurhash: true,
          variants: true,
        },
      },
    },
  },
} satisfies Prisma.ProductSelect;

/** O comparație fără diferență de majuscule; adresele sunt litere mici, deci o altă scriere duce la adresa canonică (301). */
const normalizeKey = (key: string): string => key.trim().toLowerCase();

export class CatalogReader {
  private readonly db: Db;
  private readonly storage: StorageDriver;
  private readonly now: () => Date;
  private readonly stock: StockOverviewStore;

  constructor(deps: CatalogReaderDeps) {
    this.db = deps.db;
    this.storage = deps.storage;
    this.now = deps.now ?? (() => new Date());
    this.stock = deps.stockStore ?? createPrismaStockOverviewStore(deps.db);
  }

  // ---------------------------------------------------------------- adrese și redirecționări

  /** Adresa produsului: existentă și activă (`ok`), altă scriere sau adresă veche (`redirect`), sau `missing` (404). */
  async resolveProduct(slug: string): Promise<ResolvedKey> {
    return this.resolve(
      "product",
      slug,
      async (key) => {
        const row = await this.db.product.findFirst({
          where: { slug: { equals: key, mode: "insensitive" } },
          select: { slug: true, status: true, deletedAt: true },
        });
        return row
          ? { key: row.slug, live: row.status === "active" && row.deletedAt === null }
          : null;
      },
      async (id) => {
        const row = await this.db.product.findFirst({
          where: { id, status: "active", deletedAt: null },
          select: { slug: true },
        });
        return row?.slug ?? null;
      },
    );
  }

  async resolveCategory(path: string): Promise<ResolvedKey> {
    return this.resolve(
      "category",
      path,
      async (key) => {
        const row = await this.db.category.findFirst({
          where: { path: { equals: key, mode: "insensitive" } },
          select: { path: true },
        });
        return row ? { key: row.path, live: true } : null;
      },
      async (id) => {
        const row = await this.db.category.findUnique({ where: { id }, select: { path: true } });
        return row?.path ?? null;
      },
    );
  }

  private async resolve(
    kind: RedirectKind,
    given: string,
    findLive: (key: string) => Promise<{ key: string; live: boolean } | null>,
    currentKeyOf: (id: string) => Promise<string | null>,
  ): Promise<ResolvedKey> {
    const key = normalizeKey(given);
    const live = await findLive(key);
    if (live) {
      if (!live.live) return { kind: "missing", canonical: null };
      return { kind: live.key === given ? "ok" : "redirect", canonical: live.key };
    }
    const targetId = await findRedirectTarget(this.db, kind, key);
    const current = targetId ? await currentKeyOf(targetId) : null;
    return current
      ? { kind: "redirect", canonical: current }
      : { kind: "missing", canonical: null };
  }

  // ---------------------------------------------------------------- liste

  /** Produsele unei liste, sortate și paginate în SQL (sortarea după preț nu se poate exprima prin Prisma). */
  async listProducts(
    scope: ListingScope,
    options: { sort: ListingSort | "relevance"; offset: number; limit: number },
    settings: CatalogSettings,
  ): Promise<ListingResult> {
    const at = this.now();
    const where = this.scopeSql(scope);
    const priceSql = this.priceSql(at, settings.showSalePricing);
    const order =
      options.sort === "relevance" && scope.search !== undefined
        ? Prisma.sql`${searchRank(scope.search)} DESC, p.id`
        : this.orderSql(options.sort === "relevance" ? "recommended" : options.sort, priceSql);
    const [countRows, idRows] = await Promise.all([
      this.db.$queryRaw<{ count: bigint }[]>(
        Prisma.sql`SELECT count(*) AS count FROM product p WHERE ${where}`,
      ),
      this.db.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT p.id FROM product p WHERE ${where} ORDER BY ${order} LIMIT ${options.limit} OFFSET ${options.offset}`,
      ),
    ]);
    const total = Number(countRows[0]?.count ?? 0n);
    const items = await this.listedByIds(
      idRows.map((row) => row.id),
      settings,
    );
    return { items, total };
  }

  private scopeSql(scope: ListingScope): Prisma.Sql {
    return joinAnd(scopeConditions(scope));
  }

  /** Prețul minim al produsului pentru sortare: același preț ca pe card (întreg, sau efectiv când reducerile sunt afișate). */
  private priceSql(at: Date, showSale: boolean): Prisma.Sql {
    if (!showSale)
      return Prisma.sql`(SELECT MIN(v.price) FROM product_variant v WHERE v."productId" = p.id)`;
    return Prisma.sql`(SELECT MIN(CASE
        WHEN v."salePrice" IS NOT NULL
         AND (v."saleStartsAt" IS NULL OR v."saleStartsAt" <= ${at})
         AND (v."saleEndsAt" IS NULL OR ${at} < v."saleEndsAt")
        THEN LEAST(v.price, v."salePrice") ELSE v.price END)
      FROM product_variant v WHERE v."productId" = p.id)`;
  }

  private orderSql(sort: ListingSort, price: Prisma.Sql): Prisma.Sql {
    switch (sort) {
      case "new":
        return Prisma.sql`p."publishedAt" DESC NULLS LAST, p.id`;
      case "price_asc":
        return Prisma.sql`${price} ASC NULLS LAST, p.id`;
      case "price_desc":
        return Prisma.sql`${price} DESC NULLS LAST, p.id`;
      case "name_asc":
        return Prisma.sql`lower(p.title) ASC, p.id`;
      default:
        return Prisma.sql`p."sortOrder" ASC, p."publishedAt" DESC NULLS LAST, p.id`;
    }
  }

  /** Produsele cerute, în ordinea `ids`; cele care nu sunt (sau nu mai sunt) active lipsesc. */
  async listedByIds(ids: readonly string[], settings: CatalogSettings): Promise<ListedProduct[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.product.findMany({
      where: { id: { in: [...ids] }, status: "active", deletedAt: null },
      select: productListSelect,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const at = this.now();
    const ordered = ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
    return Promise.all(
      ordered.map(async (row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        brandName: row.brand?.name ?? null,
        image: this.imageOf(row.media[0]?.media ?? null, "medium", row.title),
        price: listingPrice(row.variants, at, settings.showSalePricing),
        availability: summarizeProductAvailability(
          await this.availabilityOfVariants(
            row.variants.map((v) => v.id),
            settings,
          ),
        ),
        energyClass: row.energyClass,
      })),
    );
  }

  private async availabilityOfVariants(
    variantIds: readonly string[],
    settings: CatalogSettings,
  ): Promise<PublicAvailability[]> {
    const warehouse = await this.stock.defaultWarehouse();
    if (!warehouse) return [];
    const rows = await Promise.all(
      variantIds.map(async (variantId) => {
        const source = await this.stock.getSource(variantId, warehouse.id);
        return source
          ? publicAvailabilityOfRow(
              buildStockOverviewRow(source, {
                defaultLowStockSteps: settings.lowStockSteps,
                defaultLeadTimeDays: settings.defaultLeadTimeDays,
              }),
            )
          : null;
      }),
    );
    return rows.filter((row): row is PublicAvailability => row !== null);
  }

  private imageOf(
    media: {
      status: string;
      alt: string;
      storageKey: string;
      width: number | null;
      height: number | null;
      blurhash: string | null;
      variants: unknown;
    } | null,
    name: "thumb" | "medium" | "large",
    fallbackAlt: string,
  ): StorefrontImage | null {
    if (!media || media.status !== "ready") return null;
    const picked = pickBestVariantImage(media, this.storage, name);
    return picked
      ? {
          src: picked.url,
          width: picked.width,
          height: picked.height,
          alt: media.alt || fallbackAlt,
        }
      : null;
  }

  // ---------------------------------------------------------------- filtre (faceted)

  /**
   * Grupele de filtre ale unei liste, cu contorizări. Fiecare grupă se numără cu TOATE celelalte filtre aplicate, dar fără propriul
   * ei filtru (altfel alegerea unei mărci ar face să dispară celelalte mărci): numărul de lângă o opțiune e câte produse ar rămâne
   * dacă ai alege-o. Atributele numerice dau limitele reale (minim și maxim) ale valorilor din listă, pentru slider.
   */
  async getFacets(scope: ListingScope): Promise<ListingFacets> {
    const filters = scope.filters;
    const ownScope = (exclude: Parameters<typeof scopeConditions>[1]) =>
      joinAnd(scopeConditions(scope, exclude));

    const brandRows = await this.db.$queryRaw<
      { slug: string; name: string; count: bigint }[]
    >(Prisma.sql`
      SELECT b.slug, b.name, count(*) AS count FROM product p JOIN brand b ON b.id = p."brandId"
      WHERE ${ownScope({ brands: true })} GROUP BY b.slug, b.name ORDER BY count(*) DESC, b.name ASC`);
    const brands = brandRows.map((row) => ({
      slug: row.slug,
      name: row.name,
      count: Number(row.count),
      selected: filters?.brands.includes(row.slug) ?? false,
    }));

    // atributele filtrabile prezente în listă, fără filtrele (ca un atribut ales să nu dispară din panou)
    const attributes = await this.db.$queryRaw<
      { id: string; code: string; name: string; type: string; unit: string | null }[]
    >(Prisma.sql`
      SELECT DISTINCT a.id, a.code, a.name, a.type, a.unit, a."sortOrder"
      FROM attribute a JOIN attribute_value av ON av."attributeId" = a.id JOIN product p ON p.id = av."productId"
      WHERE a."isFilterable" AND a.type IN ('number', 'select')
        AND ${joinAnd(scopeConditions({ ...scope, filters: undefined }))}
      ORDER BY a."sortOrder" ASC, a.name ASC`);

    const ranges: FacetRange[] = [];
    const options: FacetOptions[] = [];
    for (const attribute of attributes) {
      if (attribute.type === "number") {
        const [row] = await this.db.$queryRaw<
          { min: string | null; max: string | null; count: bigint }[]
        >(Prisma.sql`
          SELECT min(av."numberValue")::text AS min, max(av."numberValue")::text AS max, count(*) AS count
          FROM attribute_value av JOIN product p ON p.id = av."productId"
          WHERE av."attributeId" = ${attribute.id} AND av."numberValue" IS NOT NULL
            AND ${ownScope({ rangeCode: attribute.code })}`);
        if (!row || row.min === null || row.max === null || Number(row.count) === 0) continue;
        ranges.push({
          code: attribute.code,
          name: attribute.name,
          unit: attribute.unit,
          min: Number(row.min),
          max: Number(row.max),
          count: Number(row.count),
          selected: filters?.ranges[attribute.code] ?? null,
        });
      } else {
        const rows = await this.db.$queryRaw<
          { id: string; value: string; count: bigint }[]
        >(Prisma.sql`
          SELECT o.id, o.value, count(*) AS count
          FROM attribute_value av JOIN attribute_option o ON o.id = av."optionId" JOIN product p ON p.id = av."productId"
          WHERE av."attributeId" = ${attribute.id} AND ${ownScope({ optionCode: attribute.code })}
          GROUP BY o.id, o.value, o.position ORDER BY o.position ASC, o.value ASC`);
        if (rows.length === 0) continue;
        const chosen = filters?.options[attribute.code] ?? [];
        options.push({
          code: attribute.code,
          name: attribute.name,
          options: rows.map((row) => ({
            id: row.id,
            value: row.value,
            count: Number(row.count),
            selected: chosen.includes(row.id),
          })),
        });
      }
    }
    return { brands, ranges, options };
  }

  /**
   * Păstrează doar filtrele care există: un cod de atribut necunoscut, nefiltrabil sau de alt tip (interval pe un atribut de tip listă)
   * se ignoră, ca o adresă cu un parametru învechit să nu producă o listă goală.
   */
  async sanitizeFilters(filters: ListingFilters): Promise<ListingFilters> {
    const codes = [...Object.keys(filters.ranges), ...Object.keys(filters.options)];
    if (codes.length === 0) return filters;
    const known = await this.db.attribute.findMany({
      where: { code: { in: codes }, isFilterable: true },
      select: { code: true, type: true },
    });
    const type = new Map(known.map((a) => [a.code, a.type]));
    return {
      brands: filters.brands,
      ranges: Object.fromEntries(
        Object.entries(filters.ranges).filter(([code]) => type.get(code) === "number"),
      ),
      options: Object.fromEntries(
        Object.entries(filters.options).filter(([code]) => type.get(code) === "select"),
      ),
    };
  }

  /** Numele filtrelor alese (pentru chip-uri): mărci după slug, opțiuni după identificator. */
  async describeFilters(filters: ListingScope["filters"]): Promise<{
    brands: Record<string, string>;
    options: Record<string, Record<string, string>>;
  }> {
    const brandSlugs = filters?.brands ?? [];
    const brandRows = brandSlugs.length
      ? await this.db.brand.findMany({
          where: { slug: { in: brandSlugs } },
          select: { slug: true, name: true },
        })
      : [];
    const optionIds = Object.values(filters?.options ?? {}).flat();
    const optionRows = optionIds.length
      ? await this.db.attributeOption.findMany({
          where: { id: { in: optionIds } },
          select: { id: true, value: true, attribute: { select: { code: true } } },
        })
      : [];
    const options: Record<string, Record<string, string>> = {};
    for (const row of optionRows) (options[row.attribute.code] ??= {})[row.id] = row.value;
    return { brands: Object.fromEntries(brandRows.map((b) => [b.slug, b.name])), options };
  }

  // ---------------------------------------------------------------- căutare (autocomplete)

  /** Sugestii pentru bara de căutare: produse (cele mai relevante), categorii și mărci al căror nume începe cu textul. */
  async suggest(
    text: string,
    limit: number,
    settings: CatalogSettings,
  ): Promise<{
    products: ListedProduct[];
    categories: { name: string; path: string }[];
    brands: { name: string; slug: string }[];
  }> {
    if (!isSearchable(text)) return { products: [], categories: [], brands: [] };
    const result = await this.listProducts(
      { search: text },
      { sort: "relevance", offset: 0, limit },
      settings,
    );
    const like = `${likePrefix(text)}%`;
    const [categories, brands] = await Promise.all([
      this.db.$queryRaw<{ name: string; path: string }[]>(Prisma.sql`
        SELECT c.name, c.path FROM category c
        WHERE f_unaccent(lower(c.name)) LIKE ${like}
          AND EXISTS (SELECT 1 FROM product_category pc JOIN product p ON p.id = pc."productId"
                      JOIN category d ON d.id = pc."categoryId"
                      WHERE p.status = 'active' AND p."deletedAt" IS NULL
                        AND (d.path = c.path OR starts_with(d.path, c.path || '/')))
        ORDER BY c.depth ASC, c.name ASC LIMIT 3`),
      this.db.$queryRaw<{ name: string; slug: string }[]>(Prisma.sql`
        SELECT b.name, b.slug FROM brand b
        WHERE f_unaccent(lower(b.name)) LIKE ${like}
          AND EXISTS (SELECT 1 FROM product p WHERE p."brandId" = b.id AND p.status = 'active' AND p."deletedAt" IS NULL)
        ORDER BY b.name ASC LIMIT 3`),
    ]);
    return { products: result.items, categories, brands };
  }

  // ---------------------------------------------------------------- mărci

  async resolveBrand(slug: string): Promise<ResolvedKey> {
    return this.resolve(
      "brand",
      slug,
      async (key) => {
        const row = await this.db.brand.findFirst({
          where: { slug: { equals: key, mode: "insensitive" } },
          select: { slug: true },
        });
        return row ? { key: row.slug, live: true } : null;
      },
      async (id) => {
        const row = await this.db.brand.findUnique({ where: { id }, select: { slug: true } });
        return row?.slug ?? null;
      },
    );
  }

  async getBrand(slug: string): Promise<BrandPageData | null> {
    const row = await this.db.brand.findFirst({
      where: { slug: normalizeKey(slug) },
      select: {
        name: true,
        slug: true,
        description: true,
        seoTitle: true,
        seoDescription: true,
        logoMedia: {
          select: {
            status: true,
            alt: true,
            storageKey: true,
            width: true,
            height: true,
            blurhash: true,
            variants: true,
          },
        },
      },
    });
    if (!row) return null;
    return {
      name: row.name,
      slug: row.slug,
      description: row.description,
      seoTitle: row.seoTitle,
      seoDescription: row.seoDescription,
      logo: this.imageOf(row.logoMedia, "medium", row.name),
    };
  }

  /** Colecția după adresă. Colecțiile automate (reguli) nu au încă motor de reguli: arată doar produsele atașate explicit. */
  async getCollection(slug: string): Promise<CollectionPageData | null> {
    const row = await this.db.collection.findFirst({
      where: { slug: normalizeKey(slug) },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        seoTitle: true,
        seoDescription: true,
      },
    });
    return row ?? null;
  }

  /** Mărcile cu cel puțin un produs ACTIV, cele cu mai multe produse întâi (apoi alfabetic). */
  async listBrands(limit: number): Promise<{ name: string; slug: string; productCount: number }[]> {
    const rows = await this.db.brand.findMany({
      where: { products: { some: { status: "active", deletedAt: null } } },
      select: {
        name: true,
        slug: true,
        _count: { select: { products: { where: { status: "active", deletedAt: null } } } },
      },
    });
    return rows
      .map((row) => ({ name: row.name, slug: row.slug, productCount: row._count.products }))
      .sort((a, b) => b.productCount - a.productCount || a.name.localeCompare(b.name, "ro"))
      .slice(0, limit);
  }

  // ---------------------------------------------------------------- categorie

  async getCategory(path: string): Promise<CategoryPageData | null> {
    const key = normalizeKey(path);
    const row = await this.db.category.findFirst({
      where: { path: key },
      select: {
        id: true,
        name: true,
        path: true,
        description: true,
        seoTitle: true,
        seoDescription: true,
        imageMedia: {
          select: {
            status: true,
            alt: true,
            storageKey: true,
            width: true,
            height: true,
            blurhash: true,
            variants: true,
          },
        },
      },
    });
    if (!row) return null;
    const segments = row.path.split("/");
    const paths = segments.map((_, i) => segments.slice(0, i + 1).join("/"));
    const ancestors = await this.db.category.findMany({
      where: { path: { in: paths } },
      select: { name: true, path: true, depth: true },
      orderBy: { depth: "asc" },
    });
    return {
      id: row.id,
      name: row.name,
      path: row.path,
      description: row.description,
      seoTitle: row.seoTitle,
      seoDescription: row.seoDescription,
      image: this.imageOf(row.imageMedia, "large", row.name),
      trail: ancestors.map((a) => ({ name: a.name, path: a.path })),
    };
  }

  // ---------------------------------------------------------------- produs

  async getProduct(
    slug: string,
    settings: CatalogSettings,
    options: { includeDiagram?: boolean } = {},
  ): Promise<ProductPageData | null> {
    const row = await this.db.product.findFirst({
      where: { slug: normalizeKey(slug), status: "active", deletedAt: null },
      select: {
        id: true,
        slug: true,
        title: true,
        subtitle: true,
        description: true,
        type: true,
        shippingClass: true,
        energyClass: true,
        eprelUrl: true,
        seoTitle: true,
        seoDescription: true,
        gpsrManufacturerName: true,
        gpsrManufacturerContact: true,
        gpsrResponsibleName: true,
        gpsrResponsibleContact: true,
        safetyWarnings: true,
        updatedAt: true,
        brand: { select: { name: true, slug: true } },
        categories: {
          where: { isPrimary: true },
          take: 1,
          select: { category: { select: { path: true } } },
        },
        options: {
          orderBy: { position: "asc" },
          select: {
            id: true,
            name: true,
            values: { orderBy: { position: "asc" }, select: { id: true, value: true } },
          },
        },
        variants: {
          orderBy: [{ position: "asc" }, { id: "asc" }],
          select: {
            id: true,
            sku: true,
            ean: true,
            warrantyMonths: true,
            price: true,
            salePrice: true,
            saleStartsAt: true,
            saleEndsAt: true,
            isDefault: true,
            manufacturerPartNumber: true,
            measureUnit: { select: { symbol: true } },
            optionValues: { select: { optionId: true, optionValueId: true } },
          },
        },
        media: {
          orderBy: [{ position: "asc" }, { id: "asc" }],
          select: {
            variantId: true,
            media: {
              select: {
                status: true,
                alt: true,
                storageKey: true,
                width: true,
                height: true,
                blurhash: true,
                variants: true,
              },
            },
          },
        },
        attributes: {
          select: {
            textValue: true,
            numberValue: true,
            boolValue: true,
            option: { select: { value: true } },
            attribute: {
              select: { code: true, name: true, type: true, unit: true, sortOrder: true },
            },
          },
        },
        measureUnit: { select: { symbol: true } },
      },
    });
    if (!row) return null;

    const at = this.now();
    const valueText = new Map(
      row.options.flatMap((o) => o.values.map((v) => [v.id, v.value] as const)),
    );
    const availabilityByVariant = new Map<string, PublicAvailability>();
    const warehouse = await this.stock.defaultWarehouse();
    if (warehouse) {
      await Promise.all(
        row.variants.map(async (variant) => {
          const source = await this.stock.getSource(variant.id, warehouse.id);
          if (!source) return;
          availabilityByVariant.set(
            variant.id,
            publicAvailabilityOfRow(
              buildStockOverviewRow(source, {
                defaultLowStockSteps: settings.lowStockSteps,
                defaultLeadTimeDays: settings.defaultLeadTimeDays,
              }),
            ),
          );
        }),
      );
    }
    const unavailable = summarizeProductAvailability([]);

    const variants: PageVariant[] = row.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      ean: variant.ean,
      warrantyMonths: variant.warrantyMonths,
      label: row.options
        .map((o) => variant.optionValues.find((ov) => ov.optionId === o.id))
        .flatMap((ov) => (ov ? [valueText.get(ov.optionValueId) ?? ""] : []))
        .filter((text) => text !== "")
        .join(" · "),
      optionValues: Object.fromEntries(
        variant.optionValues.map((ov) => [ov.optionId, ov.optionValueId]),
      ),
      price: displayedPrice(variant, at, settings.showSalePricing),
      availability: availabilityByVariant.get(variant.id) ?? unavailable,
      isDefault: variant.isDefault,
      unitSymbol: variant.measureUnit?.symbol ?? row.measureUnit?.symbol ?? null,
      manufacturerPartNumber: variant.manufacturerPartNumber,
    }));

    const gallery: GalleryImage[] = row.media.flatMap((entry) => {
      const thumb = this.imageOf(entry.media, "thumb", row.title);
      const large = this.imageOf(entry.media, "large", row.title);
      return thumb && large ? [{ thumb, large, variantId: entry.variantId }] : [];
    });

    const primaryPath = row.categories[0]?.category.path ?? null;
    const trail = primaryPath ? await this.trailOf(primaryPath) : [];

    const specs: SpecRow[] = row.attributes
      .slice()
      .sort(
        (a, b) =>
          a.attribute.sortOrder - b.attribute.sortOrder ||
          a.attribute.name.localeCompare(b.attribute.name, "ro"),
      )
      .flatMap((value) => {
        const text =
          value.attribute.type === "number" && value.numberValue !== null
            ? value.numberValue.toString()
            : value.attribute.type === "bool" && value.boolValue !== null
              ? String(value.boolValue)
              : value.attribute.type === "select"
                ? (value.option?.value ?? null)
                : value.textValue;
        return text === null || text === ""
          ? []
          : [
              {
                code: value.attribute.code,
                name: value.attribute.name,
                type: value.attribute.type as SpecRow["type"],
                unit: value.attribute.unit,
                value: text,
              },
            ];
      });

    const relatedRows = await this.db.productRelation.findMany({
      where: { productId: row.id, type: { in: ["accessory", "similar", "upsell"] } },
      orderBy: [{ type: "asc" }, { position: "asc" }, { id: "asc" }],
      select: { relatedProductId: true },
      take: 24,
    });
    const relatedIds = [...new Set(relatedRows.map((r) => r.relatedProductId))].slice(0, 8);

    const [documents, partRelations, compatibleRelations] = await Promise.all([
      this.db.productDocument.findMany({
        where: { productId: row.id, showInTab: true },
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: { id: true, title: true, type: true, mime: true, sizeBytes: true, language: true },
      }),
      this.db.productRelation.findMany({
        where: { productId: row.id, type: "spare_part" },
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: { relatedProductId: true },
        take: 50,
      }),
      this.db.productRelation.findMany({
        where: { productId: row.id, type: "compatible_with" },
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: { relatedProductId: true },
        take: 12,
      }),
    ]);
    const diagram = options.includeDiagram ? await this.diagramOf(row.id, settings) : null;

    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      subtitle: row.subtitle,
      descriptionHtml: row.description,
      brand: row.brand,
      trail,
      seoTitle: row.seoTitle,
      seoDescription: row.seoDescription,
      isDigital: row.type === "digital",
      shippingClass: row.shippingClass,
      energyClass: row.energyClass,
      eprelUrl: row.eprelUrl,
      gpsr: {
        manufacturerName: row.gpsrManufacturerName,
        manufacturerContact: row.gpsrManufacturerContact,
        responsibleName: row.gpsrResponsibleName,
        responsibleContact: row.gpsrResponsibleContact,
        safetyWarnings: row.safetyWarnings,
      },
      options: row.options,
      variants,
      gallery,
      specs,
      related: await this.listedByIds(relatedIds, settings),
      documents,
      spareParts: await this.listedByIds(
        [...new Set(partRelations.map((r) => r.relatedProductId))],
        settings,
      ),
      compatible: await this.listedByIds(
        [...new Set(compatibleRelations.map((r) => r.relatedProductId))],
        settings,
      ),
      diagram,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async diagramOf(
    productId: string,
    settings: CatalogSettings,
  ): Promise<PageDiagram | null> {
    const link = await this.db.partsDiagramProduct.findFirst({
      where: { productId },
      orderBy: { diagramId: "asc" },
      select: {
        diagram: {
          select: {
            title: true,
            media: {
              select: {
                status: true,
                alt: true,
                storageKey: true,
                width: true,
                height: true,
                blurhash: true,
                variants: true,
              },
            },
            hotspots: {
              orderBy: { number: "asc" },
              select: { number: true, xBp: true, yBp: true, label: true, productId: true },
            },
          },
        },
      },
    });
    if (!link) return null;
    const partIds = link.diagram.hotspots.flatMap((h) => (h.productId ? [h.productId] : []));
    const listed = new Map(
      (await this.listedByIds([...new Set(partIds)], settings)).map((p) => [p.id, p]),
    );
    return {
      title: link.diagram.title,
      image: this.imageOf(link.diagram.media, "large", link.diagram.title),
      parts: link.diagram.hotspots.map((h) => {
        const part = h.productId ? listed.get(h.productId) : undefined;
        return {
          number: h.number,
          xBp: h.xBp,
          yBp: h.yBp,
          label: h.label,
          product: part
            ? {
                slug: part.slug,
                title: part.title,
                price: part.price,
                availability: part.availability,
              }
            : null,
        };
      }),
    };
  }

  private async trailOf(path: string): Promise<{ name: string; path: string }[]> {
    const segments = path.split("/");
    const paths = segments.map((_, i) => segments.slice(0, i + 1).join("/"));
    const rows = await this.db.category.findMany({
      where: { path: { in: paths } },
      select: { name: true, path: true, depth: true },
      orderBy: { depth: "asc" },
    });
    return rows.map((r) => ({ name: r.name, path: r.path }));
  }
}

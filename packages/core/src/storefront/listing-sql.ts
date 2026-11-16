import { Prisma } from "@ecom/db";
import type { ListingFilters } from "./listing-filters";
import { isSearchable, likePrefix, toPrefixTsQuery } from "./search-query";

/**
 * Condițiile SQL ale listelor din vitrină: produse ACTIVE și nesterse, categoria (cu subcategoriile), marca, colecția, căutarea și
 * filtrele (marcă, intervale numerice, opțiuni). Toate valorile sunt parametri legați, niciodată text lipit în interogare;
 * numele atributelor și ale mărcilor intră doar ca parametri. Un fragment e pentru tabela `product p`.
 */

export interface ListingScope {
  /** Calea categoriei: intră și produsele din toate subcategoriile ei. */
  categoryPath?: string;
  /** Marca paginii de marcă. */
  brandSlug?: string;
  /** Colecția paginii de colecție (doar produsele ei). */
  collectionId?: string;
  /** Textul căutat (`/cautare?q=`), după normalizare; lipsa lui înseamnă fără căutare. */
  search?: string;
  /**
   * `exact`: doar cuvinte (cu prefix) și coduri; `fuzzy`: și greșeli de scriere (trigrame). Se alege o singură dată pe interogare
   * (`CatalogReader` încearcă întâi `exact`): trigramele aduc produse fără legătură când textul se potrivește deja exact.
   */
  searchMode?: "exact" | "fuzzy";
  filters?: ListingFilters;
}

/** Ce filtru se lasă deoparte (pentru contorizările unei grupe de filtre: ea nu se restrânge singură). */
export interface FilterExclusion {
  brands?: boolean;
  rangeCode?: string;
  optionCode?: string;
}

/** Cât de asemănător trebuie să fie titlul cu textul căutat ca să conteze o greșeală de scriere (0–1); sub 0,3 intră produse fără legătură. */
export const SIMILARITY_MIN = 0.45;

const normalizeKey = (key: string): string => key.trim().toLowerCase();

export function searchCondition(search: string, fuzzy: boolean): Prisma.Sql | null {
  if (!isSearchable(search)) return null;
  const tsquery = toPrefixTsQuery(search);
  const like = likePrefix(search);
  const typo = fuzzy
    ? Prisma.sql`OR similarity(f_unaccent(lower(p.title)), ${like}) >= ${SIMILARITY_MIN}`
    : Prisma.empty;
  return Prisma.sql`(
    to_tsvector('simple', f_unaccent(lower(p.title || ' ' || coalesce(p.subtitle, '')))) @@ to_tsquery('simple', ${tsquery})
    ${typo}
    OR EXISTS (
      SELECT 1 FROM product_variant v WHERE v."productId" = p.id AND (
        f_unaccent(lower(v.sku)) LIKE ${`${like}%`}
        OR f_unaccent(lower(v."manufacturerPartNumber")) LIKE ${`${like}%`}))
  )`;
}

/** Scorul de potrivire (mai mare = mai bun), pentru sortarea după relevanță. */
export function searchRank(search: string): Prisma.Sql {
  const tsquery = toPrefixTsQuery(search);
  const like = likePrefix(search);
  return Prisma.sql`(
    ts_rank(to_tsvector('simple', f_unaccent(lower(p.title || ' ' || coalesce(p.subtitle, '')))), to_tsquery('simple', ${tsquery}))
    + similarity(f_unaccent(lower(p.title)), ${like})
    + CASE WHEN EXISTS (
        SELECT 1 FROM product_variant v WHERE v."productId" = p.id AND (
          f_unaccent(lower(v.sku)) = ${like} OR f_unaccent(lower(v."manufacturerPartNumber")) = ${like})) THEN 2 ELSE 0 END
  )`;
}

export function filterConditions(
  filters: ListingFilters | undefined,
  exclude: FilterExclusion = {},
): Prisma.Sql[] {
  if (!filters) return [];
  const parts: Prisma.Sql[] = [];
  if (!exclude.brands && filters.brands.length > 0) {
    parts.push(
      Prisma.sql`p."brandId" IN (SELECT id FROM brand WHERE slug IN (${Prisma.join(filters.brands)}))`,
    );
  }
  for (const [code, range] of Object.entries(filters.ranges)) {
    if (exclude.rangeCode === code) continue;
    const bounds: Prisma.Sql[] = [];
    if (range.min !== null) bounds.push(Prisma.sql`av."numberValue" >= ${range.min}::numeric`);
    if (range.max !== null) bounds.push(Prisma.sql`av."numberValue" <= ${range.max}::numeric`);
    if (bounds.length === 0) continue;
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM attribute_value av JOIN attribute a ON a.id = av."attributeId"
      WHERE av."productId" = p.id AND a.code = ${code} AND a."isFilterable" AND a.type = 'number'
        AND ${Prisma.join(bounds, " AND ")})`);
  }
  for (const [code, ids] of Object.entries(filters.options)) {
    if (exclude.optionCode === code || ids.length === 0) continue;
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM attribute_value av JOIN attribute a ON a.id = av."attributeId"
      WHERE av."productId" = p.id AND a.code = ${code} AND a."isFilterable" AND a.type = 'select'
        AND av."optionId" IN (${Prisma.join(ids)}))`);
  }
  return parts;
}

export function scopeConditions(scope: ListingScope, exclude: FilterExclusion = {}): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [Prisma.sql`p.status = 'active'`, Prisma.sql`p."deletedAt" IS NULL`];
  if (scope.categoryPath !== undefined) {
    const path = normalizeKey(scope.categoryPath);
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM product_category pc JOIN category c ON c.id = pc."categoryId"
      WHERE pc."productId" = p.id AND (c.path = ${path} OR starts_with(c.path, ${`${path}/`})))`);
  }
  if (scope.brandSlug !== undefined) {
    parts.push(
      Prisma.sql`p."brandId" IN (SELECT id FROM brand WHERE lower(slug) = ${normalizeKey(scope.brandSlug)})`,
    );
  }
  if (scope.collectionId !== undefined) {
    parts.push(
      Prisma.sql`EXISTS (SELECT 1 FROM collection_product cp WHERE cp."productId" = p.id AND cp."collectionId" = ${scope.collectionId})`,
    );
  }
  if (scope.search !== undefined) {
    const condition = searchCondition(scope.search, scope.searchMode === "fuzzy");
    // o căutare prea scurtă nu găsește nimic (nu «toate produsele»)
    parts.push(condition ?? Prisma.sql`false`);
  }
  parts.push(...filterConditions(scope.filters, exclude));
  return parts;
}

export const joinAnd = (parts: Prisma.Sql[]): Prisma.Sql => Prisma.join(parts, " AND ");

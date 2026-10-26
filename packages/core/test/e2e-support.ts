import { Client } from "pg";
import { Redis } from "ioredis";
import { assertTestDatabase, assertTestRedis } from "../../../test/support/test-env";

/**
 * Ajutoare pentru testele E2E, care pregătesc starea direct în baza de TEST (după ce conturile se
 * creează prin API-ul real): rol, email verificat, vârsta sesiunii, flag-uri. Fiecare funcție
 * refuză să ruleze fără baza/Redis-ul de test (aceeași gardă ca la integrare). Fără `import.meta`,
 * ca să poată fi încărcat și de Playwright (CommonJS).
 */

const dbUrl = (): string => {
  const url = process.env["TEST_DATABASE_URL"];
  assertTestDatabase(url);
  return url;
};

const redisUrl = (): string => {
  const url = process.env["TEST_REDIS_URL"];
  assertTestRedis(url);
  return url;
};

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: dbUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function withRedis<T>(fn: (redis: Redis) => Promise<T>): Promise<T> {
  const redis = new Redis(redisUrl());
  try {
    return await fn(redis);
  } finally {
    redis.disconnect();
  }
}

/** Marchează emailul ca verificat și (opțional) atribuie un rol de sistem (`owner`, `support`, …). */
export async function promoteE2eUser(email: string, roleKey: string | null): Promise<void> {
  await withClient(async (db) => {
    const user = await db.query(
      `update "user" set "emailVerified" = true where email = $1 returning id`,
      [email],
    );
    const userId = user.rows[0]?.id as string | undefined;
    if (!userId) throw new Error(`Utilizatorul de test ${email} nu există`);
    if (roleKey) {
      const role = await db.query(`select id from role where key = $1`, [roleKey]);
      const roleId = role.rows[0]?.id as string | undefined;
      if (!roleId) throw new Error(`Rolul ${roleKey} nu există în baza de test (seed lipsă?)`);
      await db.query(
        `insert into user_role ("userId", "roleId") values ($1, $2) on conflict do nothing`,
        [userId, roleId],
      );
    }
  });
}

/**
 * „Îmbătrânește” sesiunile unui utilizator cu `hours` ore (createdAt în DB) și șterge copiile din
 * cache-ul Redis al sesiunilor, ca următoarea cerere să citească vârsta nouă din DB.
 */
export async function ageE2eSessions(email: string, hours: number): Promise<number> {
  const tokens = await withClient(async (db) => {
    const result = await db.query(
      `update session set "createdAt" = now() - ($2 || ' hours')::interval
       where "userId" = (select id from "user" where email = $1) returning token, "userId"`,
      [email, String(hours)],
    );
    return result.rows as { token: string; userId: string }[];
  });
  await withRedis(async (redis) => {
    for (const { token, userId } of tokens) {
      await redis.del(`ecom:auth:${token}`, `ecom:auth:active-sessions-${userId}`);
    }
  });
  return tokens.length;
}

/** Face expirat tokenul de verificare al emailului unui utilizator (expiresAt în trecut). */
export async function expireE2eVerificationToken(email: string): Promise<number> {
  return withClient(async (db) => {
    const result = await db.query(
      `update verification set "expiresAt" = now() - interval '1 minute'
       where identifier = 'ecom:verify-email:' || (select id from "user" where email = $1)`,
      [email],
    );
    return result.rowCount ?? 0;
  });
}

/** Emailul utilizatorului e verificat? (pentru aserțiuni în teste). */
export async function isE2eUserVerified(email: string): Promise<boolean> {
  return withClient(async (db) => {
    const result = await db.query(`select "emailVerified" as v from "user" where email = $1`, [
      email,
    ]);
    return result.rows[0]?.v === true;
  });
}

/** Pornește/oprește un flag de funcționalitate și invalidează cache-ul lui. */
export async function setE2eFeatureFlag(key: string, enabled: boolean): Promise<void> {
  await withClient(async (db) => {
    await db.query(
      `insert into feature_flag (key, enabled, "updatedAt") values ($1, $2, now())
       on conflict (key) do update set enabled = excluded.enabled, "updatedAt" = now()`,
      [key, enabled],
    );
  });
  await withRedis((redis) => redis.del("ecom:feature-flags:v1"));
}

/** Șterge contoarele de limitare (`ecom:rl:*`) din Redis-ul de TEST, ca o rulare să nu o moștenească pe alta. */
export async function clearE2eRateLimits(): Promise<number> {
  return withRedis(async (redis) => {
    let removed = 0;
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "ecom:rl:*", "COUNT", 200);
      cursor = next;
      if (keys.length > 0) removed += await redis.del(...keys);
    } while (cursor !== "0");
    return removed;
  });
}

/**
 * Inserează un rând `Media` fără fișiere reale, cu starea dată (`pending`, `failed`…), încărcat de
 * contul de test `email`: pentru testele care verifică ce NU trebuie să apară (ex. în selector).
 * Rândul se șterge la teardown (după `uploadedById`). Întoarce id-ul.
 */
export async function insertE2eMedia(
  email: string,
  options: { name: string; status: "pending" | "processing" | "failed" | "ready" },
): Promise<string> {
  return withClient(async (db) => {
    const user = await db.query(`select id from "user" where email = $1`, [email]);
    const userId = user.rows[0]?.id as string | undefined;
    if (!userId) throw new Error(`Utilizatorul de test ${email} nu există`);
    const id = `e2e${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
    await db.query(
      `insert into media (id, status, mime, "sizeBytes", width, height, checksum, "originalName",
         "storageKey", variants, alt, tags, "uploadedById", "createdAt", "updatedAt")
       values ($1, $2, 'image/png', 100, 10, 10, $3, $4, $5, '[]'::jsonb, '', '{}', $6, now(), now())`,
      [
        id,
        options.status,
        "e".repeat(64),
        options.name,
        `public/media/e2e-fake-${id}/original.png`,
        userId,
      ],
    );
    return id;
  });
}

/**
 * Creează un produs de test (slug `e2e-<sufix>`) care referă fișierul media cu numele original dat
 * (cel încărcat în test), ca ștergerea lui din bibliotecă să fie refuzată. Returnează slug-ul.
 */
export async function attachMediaToE2eProduct(
  originalName: string,
  title: string,
  slugSuffix: string,
): Promise<string> {
  const slug = `e2e-${slugSuffix}`;
  trackedProducts.add(slug);
  await withClient(async (db) => {
    const media = await db.query(
      `select id from media where "originalName" = $1 order by "createdAt" desc limit 1`,
      [originalName],
    );
    const mediaId = media.rows[0]?.id as string | undefined;
    if (!mediaId) throw new Error(`Fișierul media „${originalName}” nu există în baza de test`);
    const product = await db.query(
      `insert into product (id, slug, title, "updatedAt") values (gen_random_uuid()::text, $1, $2, now()) returning id`,
      [slug, title],
    );
    await db.query(
      `insert into product_media (id, "productId", "mediaId", position) values (gen_random_uuid()::text, $1, $2, 0)`,
      [product.rows[0]?.id as string, mediaId],
    );
  });
  return slug;
}

/**
 * Produsele, categoriile și brandurile de test create de ACEST worker. Playwright rulează fișierele în
 * workeri paraleli, pe aceeași bază: o curățare „toate `e2e-%`” ar șterge datele unui test care încă
 * rulează în alt worker. Fiecare ajutor care creează date le înregistrează aici; curățarea șterge
 * doar ce a creat workerul propriu.
 */
const trackedProducts = new Set<string>();
const trackedCategories = new Set<string>();
const trackedBrands = new Set<string>();

/** Înregistrează un produs creat prin interfață (nu printr-un ajutor), ca să fie curățat la final. */
export function trackE2eProduct(slug: string): void {
  trackedProducts.add(slug);
}

/**
 * Șterge produsele de test create de acest worker (slug `e2e-…`); legăturile lor media dispar în
 * cascadă. Nu atinge produsele altor workeri.
 */
export async function removeE2eProducts(): Promise<number> {
  const slugs = [...trackedProducts];
  trackedProducts.clear();
  if (slugs.length === 0) return 0;
  return withClient(async (db) => {
    const result = await db.query(`delete from product where slug = any($1::text[])`, [slugs]);
    return result.rowCount ?? 0;
  });
}

/**
 * Leagă un produs de test (slug `e2e-<sufix>`) de categoria cu adresa dată (creată în test, cu slug
 * `e2e-…`), ca ștergerea categoriei să fie refuzată cu numărul de produse.
 */
export async function attachProductToE2eCategory(
  categorySlug: string,
  title: string,
  slugSuffix: string,
): Promise<void> {
  trackedProducts.add(`e2e-${slugSuffix}`);
  await withClient(async (db) => {
    const category = await db.query(`select id from category where slug = $1 limit 1`, [
      categorySlug,
    ]);
    const categoryId = category.rows[0]?.id as string | undefined;
    if (!categoryId) throw new Error(`Categoria „${categorySlug}” nu există în baza de test`);
    const product = await db.query(
      `insert into product (id, slug, title, "updatedAt") values (gen_random_uuid()::text, $1, $2, now()) returning id`,
      [`e2e-${slugSuffix}`, title],
    );
    await db.query(
      `insert into product_category ("productId", "categoryId", "isPrimary") values ($1, $2, false)`,
      [product.rows[0]?.id as string, categoryId],
    );
  });
}

/** Leagă un produs de test (slug `e2e-<sufix>`) de brandul cu adresa dată (creat în test). */
export async function attachProductToE2eBrand(
  brandSlug: string,
  title: string,
  slugSuffix: string,
): Promise<void> {
  trackedProducts.add(`e2e-${slugSuffix}`);
  await withClient(async (db) => {
    const brand = await db.query(`select id from brand where slug = $1 limit 1`, [brandSlug]);
    const brandId = brand.rows[0]?.id as string | undefined;
    if (!brandId) throw new Error(`Brandul „${brandSlug}” nu există în baza de test`);
    await db.query(
      `insert into product (id, slug, title, "brandId", "updatedAt") values (gen_random_uuid()::text, $1, $2, $3, now())`,
      [`e2e-${slugSuffix}`, title, brandId],
    );
  });
}

/** Prețul de achiziție pus pe produsele de probă: valoare-santinelă, căutată în paginile randate. */
export const E2E_COST_SENTINEL = 777777;

/**
 * Creează `count` produse de probă (slug `e2e-<tag>-NN`, titlu „E2E <tag> Produs NN”, SKU
 * `E2E-<TAG>-NN`), fiecare cu o variantă care are preț de achiziție `E2E_COST_SENTINEL`. Starea:
 * `active` din 3 în 3, altfel `draft`. Se șterg la teardown (slug `e2e-…`). Întoarce titlurile.
 */
export async function seedE2eProducts(tag: string, count: number): Promise<string[]> {
  const titles: string[] = [];
  await withClient(async (db) => {
    for (let n = 1; n <= count; n++) {
      const nn = String(n).padStart(2, "0");
      trackedProducts.add(`e2e-${tag}-${nn}`);
      const title = `E2E ${tag} Produs ${nn}`;
      titles.push(title);
      const product = await db.query(
        `insert into product (id, slug, title, status, "updatedAt")
         values (gen_random_uuid()::text, $1, $2, $3, now() - ($4 || ' minutes')::interval) returning id`,
        [`e2e-${tag}-${nn}`, title, n % 3 === 0 ? "active" : "draft", String(n)],
      );
      await db.query(
        `insert into product_variant (id, "productId", sku, price, "costPrice", "costPriceDate", position, "isDefault", "updatedAt")
         values (gen_random_uuid()::text, $1, $2, $3, $4, now(), 0, true, now())`,
        [
          product.rows[0]?.id as string,
          `E2E-${tag.toUpperCase()}-${nn}`,
          10000 + n * 100,
          E2E_COST_SENTINEL,
        ],
      );
    }
  });
  return titles;
}

/**
 * Creează o categorie și un brand de probă (adresa `e2e-…`), pentru testele editorului de produs.
 * Se șterg cu `removeE2eCatalogRefs` (după produse). Întoarce numele afișate.
 */
export async function seedE2eCatalogRefs(
  tag: string,
): Promise<{ categoryName: string; brandName: string }> {
  const categoryName = `E2E Categorie ${tag}`;
  const brandName = `E2E Brand ${tag}`;
  trackedCategories.add(`e2e-cat-${tag}`);
  trackedBrands.add(`e2e-brand-${tag}`);
  await withClient(async (db) => {
    await db.query(
      `insert into category (id, name, slug, path, depth, "sortOrder", "updatedAt")
       values (gen_random_uuid()::text, $1, $2, $2, 0, 0, now())`,
      [categoryName, `e2e-cat-${tag}`],
    );
    await db.query(
      `insert into brand (id, name, slug, "updatedAt")
       values (gen_random_uuid()::text, $1, $2, now())`,
      [brandName, `e2e-brand-${tag}`],
    );
  });
  return { categoryName, brandName };
}

/** Șterge categoriile și brandurile de probă create de acest worker (după produse, ca FK-urile să nu blocheze). */
export async function removeE2eCatalogRefs(): Promise<void> {
  const categories = [...trackedCategories];
  const brands = [...trackedBrands];
  trackedCategories.clear();
  trackedBrands.clear();
  await withClient(async (db) => {
    if (categories.length > 0) {
      await db.query(
        `delete from product_category where "categoryId" in (select id from category where slug = any($1::text[]))`,
        [categories],
      );
      await db.query(`delete from category where slug = any($1::text[])`, [categories]);
    }
    if (brands.length > 0) {
      await db.query(`delete from brand where slug = any($1::text[])`, [brands]);
    }
  });
}

/** Rânduri din jurnalul de audit pentru un produs (acțiune + rezultat), cele mai vechi primele. */
export async function readE2eProductAudit(
  productSlug: string,
): Promise<{ action: string; outcome: string }[]> {
  return withClient(async (db) => {
    const result = await db.query(
      `select a.action, a.outcome from audit_log a
       where a."entityId" in (select id from product where slug = $1)
          or a."entityId" in (select v.id from product_variant v join product p on p.id = v."productId" where p.slug = $1)
       order by a."createdAt" asc`,
      [productSlug],
    );
    return result.rows as { action: string; outcome: string }[];
  });
}

/** Valorile de bază ale unui produs de probă, citite direct din bază (pentru aserțiuni). */
export async function readE2eProduct(slug: string): Promise<{
  title: string;
  status: string;
  price: number | null;
  salePrice: number | null;
  warrantyMonths: number | null;
  categoryNames: string[];
  mediaNames: string[];
} | null> {
  return withClient(async (db) => {
    const product = await db.query(`select id, title, status from product where slug = $1`, [slug]);
    const row = product.rows[0] as { id: string; title: string; status: string } | undefined;
    if (!row) return null;
    const variant = await db.query(
      `select price, "salePrice", "warrantyMonths" from product_variant where "productId" = $1 order by position limit 1`,
      [row.id],
    );
    const categories = await db.query(
      `select c.name from product_category pc join category c on c.id = pc."categoryId" where pc."productId" = $1 order by c.name`,
      [row.id],
    );
    const media = await db.query(
      `select m."originalName" as name from product_media pm join media m on m.id = pm."mediaId"
       where pm."productId" = $1 and pm."variantId" is null order by pm.position`,
      [row.id],
    );
    const v = variant.rows[0] as
      { price: number; salePrice: number | null; warrantyMonths: number | null } | undefined;
    return {
      title: row.title,
      status: row.status,
      price: v?.price ?? null,
      salePrice: v?.salePrice ?? null,
      warrantyMonths: v?.warrantyMonths ?? null,
      categoryNames: categories.rows.map((r: { name: string }) => r.name),
      mediaNames: media.rows.map((r: { name: string }) => r.name),
    };
  });
}

const trackedAttributes = new Set<string>();

/** Înregistrează un atribut creat prin interfață (cod `e2e_…`), ca să fie curățat la final. */
export function trackE2eAttribute(code: string): void {
  trackedAttributes.add(code);
}

/**
 * Șterge atributele de test ale acestui worker, cu valorile lor (după ștergerea produselor). Valorile
 * au FK `Restrict` spre atribut, deci se șterg întâi.
 */
export async function removeE2eAttributes(): Promise<void> {
  const codes = [...trackedAttributes];
  trackedAttributes.clear();
  if (codes.length === 0) return;
  await withClient(async (db) => {
    await db.query(
      `delete from attribute_value where "attributeId" in (select id from attribute where code = any($1::text[]))`,
      [codes],
    );
    await db.query(`delete from attribute where code = any($1::text[])`, [codes]);
  });
}

/** Valorile atributelor unui produs (cod → text/număr exact/da-nu/opțiune), citite direct din bază. */
export async function readE2eAttributeValues(
  productSlug: string,
): Promise<Record<string, string | boolean | null>> {
  return withClient(async (db) => {
    const result = await db.query(
      `select a.code, v."textValue" as text, v."numberValue"::text as number, v."boolValue" as bool, o.value as option
       from attribute_value v
       join attribute a on a.id = v."attributeId"
       left join attribute_option o on o.id = v."optionId"
       where v."productId" = (select id from product where slug = $1)`,
      [productSlug],
    );
    const out: Record<string, string | boolean | null> = {};
    for (const row of result.rows as {
      code: string;
      text: string | null;
      number: string | null;
      bool: boolean | null;
      option: string | null;
    }[]) {
      out[row.code] = row.text ?? row.number ?? row.bool ?? row.option;
    }
    return out;
  });
}

/** Relațiile unui produs ca principal: „tip→titlul asociatului”, în ordinea pozițiilor. */
export async function readE2eRelations(productSlug: string): Promise<string[]> {
  return withClient(async (db) => {
    const result = await db.query(
      `select r.type, p.title from product_relation r
       join product p on p.id = r."relatedProductId"
       where r."productId" = (select id from product where slug = $1)
       order by r.type, r.position`,
      [productSlug],
    );
    return (result.rows as { type: string; title: string }[]).map((r) => `${r.type}→${r.title}`);
  });
}

/** SKU-urile variantelor unui produs de probă, în ordinea afișării. */
export async function readE2eVariantSkus(productSlug: string): Promise<string[]> {
  return withClient(async (db) => {
    const result = await db.query(
      `select sku from product_variant
       where "productId" = (select id from product where slug = $1)
       order by "isDefault" desc, position`,
      [productSlug],
    );
    return (result.rows as { sku: string }[]).map((r) => r.sku);
  });
}

/** Documentele unui produs de probă, citite direct din bază (inclusiv cheia de stocare). */
export async function readE2eDocuments(productSlug: string): Promise<
  {
    id: string;
    title: string;
    type: string;
    mime: string;
    sizeBytes: number;
    storageKey: string;
  }[]
> {
  return withClient(async (db) => {
    const result = await db.query(
      `select d.id, d.title, d.type, d.mime, d."sizeBytes", d."storageKey"
       from product_document d
       where d."productId" = (select id from product where slug = $1)
       order by d.position`,
      [productSlug],
    );
    return result.rows as {
      id: string;
      title: string;
      type: string;
      mime: string;
      sizeBytes: number;
      storageKey: string;
    }[];
  });
}

/** Cheia există în stocarea locală a serverului E2E? (`E2E_STORAGE_DIR`, setat de configul Playwright.) */
export async function e2eStorageFileExists(key: string): Promise<boolean> {
  const { access } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = process.env["E2E_STORAGE_DIR"];
  if (!dir) throw new Error("E2E_STORAGE_DIR lipsește");
  try {
    await access(join(dir, ...key.split("/")));
    return true;
  } catch {
    return false;
  }
}

/** Câte rânduri din `media` au această cheie (documentele NU trebuie să apară în biblioteca media). */
export async function countE2eMediaWithKey(key: string): Promise<number> {
  return withClient(async (db) => {
    const result = await db.query(`select count(*)::int as n from media where "storageKey" = $1`, [
      key,
    ]);
    return (result.rows[0] as { n: number }).n;
  });
}

/** Câmpurile de conformitate ale unui produs de probă. */
export async function readE2eConformity(productSlug: string): Promise<{
  energyClass: string | null;
  eprelUrl: string | null;
  gpsrManufacturerName: string | null;
  gpsrResponsibleName: string | null;
  safetyWarnings: string | null;
} | null> {
  return withClient(async (db) => {
    const result = await db.query(
      `select "energyClass", "eprelUrl", "gpsrManufacturerName", "gpsrResponsibleName", "safetyWarnings"
       from product where slug = $1`,
      [productSlug],
    );
    return (
      (result.rows[0] as {
        energyClass: string | null;
        eprelUrl: string | null;
        gpsrManufacturerName: string | null;
        gpsrResponsibleName: string | null;
        safetyWarnings: string | null;
      }) ?? null
    );
  });
}

/** Rândul media încărcat sub un nume dat (cel mai recent): mărimea originalului curățat și dimensiunile. */
export async function readE2eMediaByName(originalName: string): Promise<{
  status: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  storageKey: string;
} | null> {
  return withClient(async (db) => {
    const result = await db.query(
      `select status, "sizeBytes", width, height, "storageKey" from media
       where "originalName" = $1 order by "createdAt" desc limit 1`,
      [originalName],
    );
    return (
      (result.rows[0] as {
        status: string;
        sizeBytes: number;
        width: number | null;
        height: number | null;
        storageKey: string;
      }) ?? null
    );
  });
}

const trackedDiagrams = new Set<string>();

/** Înregistrează o fișă explodată creată prin interfață (după titlu), ca să fie curățată la final. */
export function trackE2eDiagram(title: string): void {
  trackedDiagrams.add(title);
}

/** Șterge fișele de test ale acestui worker (hotspot-urile și asocierile se șterg în cascadă). */
export async function removeE2eDiagrams(): Promise<void> {
  const titles = [...trackedDiagrams];
  trackedDiagrams.clear();
  if (titles.length === 0) return;
  await withClient(async (db) => {
    await db.query(`delete from parts_diagram where title = any($1::text[])`, [titles]);
  });
}

/** O fișă explodată: hotspot-urile (cu produsul ca adresă) și produsele asociate, citite din bază. */
export async function readE2eDiagram(title: string): Promise<{
  id: string;
  hotspots: {
    number: number;
    xBp: number | null;
    yBp: number | null;
    label: string | null;
    productSlug: string | null;
  }[];
  productSlugs: string[];
} | null> {
  return withClient(async (db) => {
    const diagram = await db.query(`select id from parts_diagram where title = $1 limit 1`, [
      title,
    ]);
    const row = diagram.rows[0] as { id: string } | undefined;
    if (!row) return null;
    const hotspots = await db.query(
      `select h.number, h."xBp", h."yBp", h.label, p.slug as "productSlug"
       from parts_diagram_hotspot h left join product p on p.id = h."productId"
       where h."diagramId" = $1 order by h.number`,
      [row.id],
    );
    const products = await db.query(
      `select p.slug from parts_diagram_product l join product p on p.id = l."productId"
       where l."diagramId" = $1 order by p.slug`,
      [row.id],
    );
    return {
      id: row.id,
      hotspots: hotspots.rows as {
        number: number;
        xBp: number | null;
        yBp: number | null;
        label: string | null;
        productSlug: string | null;
      }[],
      productSlugs: (products.rows as { slug: string }[]).map((r) => r.slug),
    };
  });
}

/** Șterge DEFINITIV un produs de probă (nu soft delete), ca să verifice `ON DELETE SET NULL` pe hotspot. */
export async function hardDeleteE2eProduct(slug: string): Promise<void> {
  await withClient(async (db) => {
    await db.query(`delete from product where slug = $1`, [slug]);
  });
}

/**
 * Starea de ciclu de viață a unui produs de probă (după adresă), din bază: stare, coș de gunoi,
 * variantele (cod, EAN, dacă au preț de achiziție), istoricele și identificatorii din magazinul vechi.
 */
export async function readE2eLifecycle(slug: string): Promise<{
  id: string;
  title: string;
  status: string;
  deleted: boolean;
  legacyId: string | null;
  energyClass: string | null;
  variants: { sku: string; ean: string | null; hasCost: boolean; hasCostDate: boolean }[];
  priceHistoryRows: number;
  costHistoryRows: number;
  documentCount: number;
} | null> {
  return withClient(async (db) => {
    const product = await db.query(
      `select id, title, status, "deletedAt", "legacyId", "energyClass" from product where slug = $1`,
      [slug],
    );
    const row = product.rows[0] as
      | {
          id: string;
          title: string;
          status: string;
          deletedAt: Date | null;
          legacyId: string | null;
          energyClass: string | null;
        }
      | undefined;
    if (!row) return null;
    const variants = await db.query(
      `select sku, ean, "costPrice" is not null as "hasCost", "costPriceDate" is not null as "hasCostDate"
       from product_variant where "productId" = $1 order by position`,
      [row.id],
    );
    const price = await db.query(
      `select count(*)::int as n from price_history h join product_variant v on v.id = h."variantId" where v."productId" = $1`,
      [row.id],
    );
    const cost = await db.query(
      `select count(*)::int as n from cost_price_history h join product_variant v on v.id = h."variantId" where v."productId" = $1`,
      [row.id],
    );
    const documents = await db.query(
      `select count(*)::int as n from product_document where "productId" = $1`,
      [row.id],
    );
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      deleted: row.deletedAt !== null,
      legacyId: row.legacyId,
      energyClass: row.energyClass,
      variants: variants.rows as {
        sku: string;
        ean: string | null;
        hasCost: boolean;
        hasCostDate: boolean;
      }[],
      priceHistoryRows: price.rows[0]?.n as number,
      costHistoryRows: cost.rows[0]?.n as number,
      documentCount: documents.rows[0]?.n as number,
    };
  });
}

/** Adaugă ceva de „specific modelului” unui produs de probă, ca duplicarea să probeze că NU se copiază. */
export async function setE2eModelSpecifics(
  slug: string,
  data: { ean: string; energyClass: string; legacyId: string; documentTitle: string },
): Promise<void> {
  await withClient(async (db) => {
    const product = await db.query(
      `update product set "energyClass" = $2, "legacyId" = $3, "eprelUrl" = 'https://eprel.ec.europa.eu/qr/987654'
       where slug = $1 returning id`,
      [slug, data.energyClass, data.legacyId],
    );
    const id = product.rows[0]?.id as string;
    await db.query(`update product_variant set ean = $2 where "productId" = $1`, [id, data.ean]);
    await db.query(
      `insert into product_document (id, "productId", type, title, "storageKey", "originalName", mime, "sizeBytes", language, position, "showInTab", "createdAt", "updatedAt")
       values (gen_random_uuid()::text, $1, 'manual', $2, $3, 'manual.pdf', 'application/pdf', 10, 'ro', 0, true, now(), now())`,
      [
        id,
        data.documentTitle,
        `private/product-documents/e2e-${Math.random().toString(36).slice(2)}.pdf`,
      ],
    );
  });
}

/**
 * Câte evenimente de audit cu acțiunea dată îi privesc pe produsele cu adresele date: pe entitate
 * (operațiile pe un produs) sau în lista de id-uri a evenimentului agregat (operațiile pe selecție).
 */
export async function countE2eProductAuditEvents(
  action: string,
  productSlugs: readonly string[],
): Promise<number> {
  return withClient(async (db) => {
    const ids = await db.query(`select id from product where slug = any($1::text[])`, [
      [...productSlugs],
    ]);
    const list = ids.rows.map((r: { id: string }) => r.id);
    if (list.length === 0) return 0;
    const result = await db.query(
      `select count(*)::int as n from audit_log a
       where a.action = $1 and a.outcome = 'success'
         and (a."entityId" = any($2::text[])
              or exists (select 1 from unnest($2::text[]) as x(id) where a.after::text like '%"' || x.id || '"%'))`,
      [action, list],
    );
    return result.rows[0]?.n as number;
  });
}

/**
 * Creează o fișă explodată (titlul urmărit pentru curățare) cu un hotspot legat de produsul dat,
 * pe o imagine falsă `ready` încărcată de contul de test. Întoarce id-ul fișei.
 */
export async function seedE2eDiagramWithHotspot(
  ownerEmail: string,
  productSlug: string,
  diagramTitle: string,
): Promise<string> {
  const mediaId = await insertE2eMedia(ownerEmail, {
    name: `e2e-${diagramTitle}.png`,
    status: "ready",
  });
  trackedDiagrams.add(diagramTitle);
  return withClient(async (db) => {
    const product = await db.query(`select id from product where slug = $1`, [productSlug]);
    const productId = product.rows[0]?.id as string;
    const diagram = await db.query(
      `insert into parts_diagram (id, title, "mediaId", "createdAt", "updatedAt")
       values (gen_random_uuid()::text, $1, $2, now(), now()) returning id`,
      [diagramTitle, mediaId],
    );
    const diagramId = diagram.rows[0]?.id as string;
    await db.query(`insert into parts_diagram_product ("diagramId", "productId") values ($1, $2)`, [
      diagramId,
      productId,
    ]);
    await db.query(
      `insert into parts_diagram_hotspot (id, "diagramId", number, "xBp", "yBp", "productId", label)
       values (gen_random_uuid()::text, $1, 7, 2500, 4000, $2, null)`,
      [diagramId, productId],
    );
    return diagramId;
  });
}

/** O variantă de probă după SKU: produsul ei, prețul, categoriile, brandul și dacă are preț de achiziție. */
export async function readE2eVariantBySku(sku: string): Promise<{
  productSlug: string;
  title: string;
  status: string;
  price: number;
  salePrice: number | null;
  ean: string | null;
  categoryNames: string[];
  brandName: string | null;
  hasCost: boolean;
  priceHistoryRows: number;
} | null> {
  return withClient(async (db) => {
    const found = await db.query(
      `select v.id, v.price, v."salePrice", v.ean, v."costPrice" is not null as "hasCost",
              p.id as "productId", p.slug, p.title, p.status, b.name as "brandName"
       from product_variant v
       join product p on p.id = v."productId"
       left join brand b on b.id = p."brandId"
       where lower(v.sku) = lower($1)`,
      [sku],
    );
    const row = found.rows[0] as
      | {
          id: string;
          price: number;
          salePrice: number | null;
          ean: string | null;
          hasCost: boolean;
          productId: string;
          slug: string;
          title: string;
          status: string;
          brandName: string | null;
        }
      | undefined;
    if (!row) return null;
    const categories = await db.query(
      `select c.name from product_category pc join category c on c.id = pc."categoryId"
       where pc."productId" = $1 order by pc."isPrimary" desc, c.name`,
      [row.productId],
    );
    const history = await db.query(
      `select count(*)::int as n from price_history where "variantId" = $1`,
      [row.id],
    );
    return {
      productSlug: row.slug,
      title: row.title,
      status: row.status,
      price: row.price,
      salePrice: row.salePrice,
      ean: row.ean,
      categoryNames: categories.rows.map((r: { name: string }) => r.name),
      brandName: row.brandName,
      hasCost: row.hasCost,
      priceHistoryRows: history.rows[0]?.n as number,
    };
  });
}

/** Evenimentele de audit cu acțiunea dată pe o entitate anume (ex. un import), cele mai vechi primele. */
export async function readE2eAuditByEntity(
  action: string,
  entityId: string,
): Promise<{ outcome: string; after: Record<string, unknown> | null }[]> {
  return withClient(async (db) => {
    const result = await db.query(
      `select outcome, after from audit_log where action = $1 and "entityId" = $2 order by "createdAt" asc`,
      [action, entityId],
    );
    return result.rows as { outcome: string; after: Record<string, unknown> | null }[];
  });
}

/** Starea unui import de produse, citită direct din bază (fără conținutul raportului). */
export async function readE2eImport(importId: string): Promise<{
  status: string;
  storageKey: string | null;
  processedRows: number;
  rowCount: number;
} | null> {
  return withClient(async (db) => {
    const result = await db.query(
      `select status, "storageKey", "processedRows", "rowCount" from product_import where id = $1`,
      [importId],
    );
    return (
      (result.rows[0] as
        | {
            status: string;
            storageKey: string | null;
            processedRows: number;
            rowCount: number;
          }
        | undefined) ?? null
    );
  });
}

const trackedImportFiles = new Set<string>();

/** Înregistrează numele unui fișier de import încărcat în test, ca importul rămas să fie curățat. */
export function trackE2eImportFile(fileName: string): void {
  trackedImportFiles.add(fileName);
}

/** Șterge importurile (rândurile) acestui worker, după numele fișierelor urmărite. */
export async function removeE2eImports(): Promise<void> {
  const names = [...trackedImportFiles];
  trackedImportFiles.clear();
  if (names.length === 0) return;
  await withClient(async (db) => {
    await db.query(`delete from product_import where "fileName" = any($1::text[])`, [names]);
  });
}

/** Evenimentele de audit `product.export` ale unui cont de test (după email), în ordine cronologică. */
export async function readE2eExportAudit(
  actorEmail: string,
): Promise<{ outcome: string; after: Record<string, unknown> | null }[]> {
  return withClient(async (db) => {
    const result = await db.query(
      `select outcome, after from audit_log where action = 'product.export' and "actorLabel" = $1 order by "createdAt" asc`,
      [actorEmail],
    );
    return result.rows as { outcome: string; after: Record<string, unknown> | null }[];
  });
}

/**
 * Șterge TOT ce creează fixture-ul WooCommerce sintetic (`woo-fixture.ts`): produsele după SKU, apoi
 * categoriile (copiii înaintea părinților), brandurile și atributul «material». Rulat înainte și după
 * testele de import WooCommerce, ca un test picat să nu lase resturi.
 */
export async function removeE2eWooFixtureData(): Promise<void> {
  await withClient(async (db) => {
    await db.query(
      `delete from product where id in (
         select "productId" from product_variant
         where sku = any($1::text[]) or "legacyId" = any($2::text[])
       ) or "legacyId" = any($2::text[])`,
      [
        ["FIX-101", "00123", "WC-103", "FIX-104", "FIX-VAR-05", "FIX-VAR-075"],
        ["101", "102", "103", "104", "200", "201", "202"],
      ],
    );
    await db.query(`delete from attribute where code = 'material'`);
    await db.query(
      `delete from category where name = any($1::text[]) and not exists (select 1 from category c where c."parentId" = category.id)`,
      [["Pompe de circulație", "Filtre cu nisip", "Accesorii, diverse"]],
    );
    await db.query(
      `delete from category where name = any($1::text[]) and not exists (select 1 from category c where c."parentId" = category.id)`,
      [["Pompe", "Filtrare", "Accesorii"]],
    );
    await db.query(`delete from brand where name = any($1::text[])`, [
      ["Marca Fixture A", "Marca Fixture B"],
    ]);
  });
}

/** Starea produselor create de fixture-ul WooCommerce, citită direct din bază (fără costul). */
export async function readE2eWooFixtureState(): Promise<{
  products: number;
  categories: string[];
  brands: string[];
  firstStatus: string | null;
  firstLegacyId: string | null;
  firstDescription: string | null;
  attribute: { type: string } | null;
  variableOptions: number;
}> {
  return withClient(async (db) => {
    const first = await db.query(
      `select p.status, p."legacyId", p.description from product p
       join product_variant v on v."productId" = p.id where v.sku = 'FIX-101'`,
    );
    const products = await db.query(
      `select count(distinct "productId")::int as n from product_variant
       where sku = any($1::text[])`,
      [["FIX-101", "00123", "WC-103", "FIX-104", "FIX-VAR-05", "FIX-VAR-075"]],
    );
    const categories = await db.query(
      `select name from category where name = any($1::text[]) order by name`,
      [
        [
          "Pompe",
          "Pompe de circulație",
          "Filtrare",
          "Filtre cu nisip",
          "Accesorii",
          "Accesorii, diverse",
        ],
      ],
    );
    const brands = await db.query(
      `select name from brand where name = any($1::text[]) order by name`,
      [["Marca Fixture A", "Marca Fixture B"]],
    );
    const attribute = await db.query(`select type from attribute where code = 'material'`);
    const options = await db.query(
      `select count(*)::int as n from product_option o
       join product_variant v on v."productId" = o."productId" where v.sku = 'FIX-VAR-05'`,
    );
    return {
      products: (products.rows[0]?.n as number) ?? 0,
      categories: categories.rows.map((r) => r.name as string),
      brands: brands.rows.map((r) => r.name as string),
      firstStatus: (first.rows[0]?.status as string | undefined) ?? null,
      firstLegacyId: (first.rows[0]?.legacyId as string | null | undefined) ?? null,
      firstDescription: (first.rows[0]?.description as string | null | undefined) ?? null,
      attribute: attribute.rows[0] ? { type: attribute.rows[0].type as string } : null,
      variableOptions: (options.rows[0]?.n as number) ?? 0,
    };
  });
}

/**
 * Inserează un import rămas «în rulare» de ore întregi (un job căzut la mijloc), al contului dat, ca istoricul
 * să-l arate ca întrerupt. Numele fișierului trebuie urmărit cu `trackE2eImportFile` pentru curățare.
 */
export async function insertE2eInterruptedImport(
  userEmail: string,
  fileName: string,
  processedRows: number,
  rowCount: number,
): Promise<string> {
  trackE2eImportFile(fileName);
  return withClient(async (db) => {
    const result = await db.query(
      `insert into product_import (id, "createdById", status, "fileName", format, "sizeBytes", "fileHash",
         "rowCount", "processedRows", "expiresAt", "startedAt", "createdAt", "updatedAt")
       select gen_random_uuid()::text, u.id, 'running', $2, 'csv', 100, repeat('a', 64), $4, $3,
              now() + interval '1 day', now() - interval '3 hours', now() - interval '3 hours',
              now() - interval '2 hours'
       from "user" u where u.email = $1
       returning id`,
      [userEmail, fileName, processedRows, rowCount],
    );
    return result.rows[0]?.id as string;
  });
}

/**
 * Lista de domenii permise pentru importul de imagini (setarea `imageImport.allowedHosts`), scrisă direct în
 * bază, ca din Prisma Studio. `null` o șterge (lista goală = nicio imagine descărcată). Se citește FĂRĂ cache.
 */
export async function setE2eImageHosts(hosts: readonly string[] | null): Promise<void> {
  await withClient(async (db) => {
    if (hosts === null) {
      await db.query(`delete from setting where key = 'imageImport.allowedHosts'`);
      return;
    }
    await db.query(
      `insert into setting (key, "group", value, "updatedAt") values ('imageImport.allowedHosts', 'imageImport', $1::jsonb, now())
       on conflict (key) do update set value = excluded.value, "updatedAt" = now()`,
      [JSON.stringify(hosts)],
    );
  });
}

/** Sarcinile de imagini ale unui import (stare, motiv, gazdă), fără adresele complete. */
export async function readE2eImageTasks(
  importId: string,
): Promise<{ status: string; reason: string | null; host: string }[]> {
  return withClient(async (db) => {
    const result = await db.query(
      `select status, reason, host from product_import_image where "importId" = $1 order by row, position`,
      [importId],
    );
    return result.rows as {
      status: string;
      reason: string | null;
      host: string;
    }[];
  });
}

/** Produsele create de testele de imagini (SKU `IMG-E2E-…`) și fișierele aduse de la adresele lor. */
export async function removeE2eImageData(): Promise<void> {
  await withClient(async (db) => {
    await db.query(
      `delete from product where id in (select "productId" from product_variant where sku like 'IMG-E2E-%')`,
    );
    await db.query(
      `delete from media where "sourceHash" is not null and "originalName" like 'e2e-img-%'`,
    );
  });
}

/** Câte produse cu SKU-urile date există. */
export async function countE2eProductsBySku(skus: readonly string[]): Promise<number> {
  return withClient(async (db) => {
    const result = await db.query(
      `select count(distinct "productId")::int as n from product_variant where sku = any($1::text[])`,
      [skus],
    );
    return (result.rows[0]?.n as number) ?? 0;
  });
}

const trackedUnits = new Set<string>();

/** Înregistrează o unitate de măsură creată prin interfață (cod `e2e_…`), ca să fie ștearsă la final. */
export function trackE2eUnit(code: string): void {
  trackedUnits.add(code);
}

/**
 * Șterge unitățile de test create de acest worker. Produsele de test se șterg ÎNAINTE (o unitate folosită nu se șterge);
 * unitățile de sistem nu se ating niciodată.
 */
export async function removeE2eUnits(): Promise<number> {
  const codes = [...trackedUnits];
  trackedUnits.clear();
  if (codes.length === 0) return 0;
  return withClient(async (db) => {
    const result = await db.query(
      `delete from measure_unit where code = any($1::text[]) and "isSystem" = false and code like 'e2e%'`,
      [codes],
    );
    return result.rowCount ?? 0;
  });
}

/** Unitatea de măsură cu codul dat, așa cum e în bază. */
export async function readE2eUnit(code: string): Promise<{
  name: string;
  symbol: string;
  decimals: number;
  smartbillName: string | null;
  isActive: boolean;
  isSystem: boolean;
} | null> {
  return withClient(async (db) => {
    const found = await db.query(
      `select name, symbol, decimals, "smartbillName", "isActive", "isSystem" from measure_unit where code = $1`,
      [code],
    );
    return (found.rows[0] as never) ?? null;
  });
}

/** Configurarea de vânzare a unui produs și a variantelor lui, din bază (unitatea ca COD). */
export async function readE2eProductSale(slug: string): Promise<{
  unit: string | null;
  priceBasis: string;
  saleStep: number | null;
  minSteps: number | null;
  showStepPrice: boolean;
  variants: Array<{
    sku: string;
    saleStep: number | null;
    minSteps: number | null;
    smartbillMode: string | null;
    smartbillUnitName: string | null;
    smartbillRatio: number | null;
  }>;
} | null> {
  return withClient(async (db) => {
    const found = await db.query(
      `select p.id, u.code as unit, p."priceBasis", p."saleStep", p."minSteps", p."showStepPrice"
       from product p left join measure_unit u on u.id = p."measureUnitId" where p.slug = $1`,
      [slug],
    );
    const row = found.rows[0] as
      | {
          id: string;
          unit: string | null;
          priceBasis: string;
          saleStep: number | null;
          minSteps: number | null;
          showStepPrice: boolean;
        }
      | undefined;
    if (!row) return null;
    const variants = await db.query(
      `select sku, "saleStep", "minSteps", "smartbillMode", "smartbillUnitName", "smartbillRatio"
       from product_variant where "productId" = $1 order by position, sku`,
      [row.id],
    );
    return {
      unit: row.unit,
      priceBasis: row.priceBasis,
      saleStep: row.saleStep,
      minSteps: row.minSteps,
      showStepPrice: row.showStepPrice,
      variants: variants.rows as never,
    };
  });
}

/** Creează direct în bază o unitate de măsură de probă (cod `e2e_…`), ștearsă de `removeE2eUnits`. */
export async function seedE2eUnit(input: {
  code: string;
  name: string;
  symbol: string;
  decimals: number;
}): Promise<void> {
  trackedUnits.add(input.code);
  await withClient(async (db) => {
    await db.query(
      `insert into measure_unit (id, code, name, symbol, decimals, "sortOrder", "updatedAt")
       values (gen_random_uuid()::text, $1, $2, $3, $4, 900, now())`,
      [input.code, input.name, input.symbol, input.decimals],
    );
  });
}

/** Adaugă variante (SKU-uri date) unui produs de test, cu prețul primei variante. */
export async function seedE2eVariants(slug: string, skus: readonly string[]): Promise<void> {
  await withClient(async (db) => {
    const found = await db.query(`select id from product where slug = $1`, [slug]);
    const productId = found.rows[0]?.id as string | undefined;
    if (!productId) throw new Error(`Produsul de probă ${slug} nu există`);
    let position = 1;
    for (const sku of skus) {
      await db.query(
        `insert into product_variant (id, "productId", sku, price, position, "isDefault", "updatedAt")
         values (gen_random_uuid()::text, $1, $2, 10000, $3, false, now())`,
        [productId, sku, position++],
      );
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Stoc (Faza 5, punctul 8): produse, poze și roluri pentru testele ecranului `/admin/produse/stoc`
// ---------------------------------------------------------------------------------------------------------------------

export interface E2eStockVariant {
  /** SKU-ul variantei (primește prefixul `E2ESTOC` pentru curățare) */
  sku: string;
  /** Stocul fizic, ca text cu virgulă («100», «17,5»); `null` = fără rând de stoc */
  physical: string | null;
  /** Pragul «stoc mic» propriu al variantei, în pași (lipsă = setarea globală); doar dacă are rând de stoc */
  lowStockSteps?: number;
  /** Pasul variantei (suprascrie produsul) */
  step?: string;
  /** Prețul variantei, în bani (implicit prețul produsului, apoi 1000) */
  price?: number;
}

export interface E2eStockProduct {
  title: string;
  /** Unitatea produsului (creată pentru test, cod `e2e…`); lipsă = «buc» (unitate nulă) */
  unit?: { symbol: string; decimals: number };
  step?: string;
  manageStock?: boolean;
  stockStatus?: "instock" | "outofstock" | "onbackorder";
  allowBackorder?: boolean;
  type?: "physical" | "digital";
  /** Termenul «La comandă» propriu (zile) */
  leadTimeDays?: number;
  /** Denumirea pasului («sac», «rolă») */
  saleStepLabel?: string;
  /** Prețul variantelor, în bani (implicit 1000) */
  price?: number;
  /** La ce se referă prețul: pe unitate (implicit) sau pe pas */
  priceBasis?: "unit" | "step";
  /** «Arată prețul pasului» */
  showStepPrice?: boolean;
  /** Un brand de test (adresa `e2e-stoc-…`, se șterge odată cu produsele), cu termenul lui implicit */
  brand?: { name: string; defaultLeadTimeDays: number | null };
  variants: E2eStockVariant[];
}

const E2E_STOCK_SKU_PREFIX = "E2ESTOC";
const E2E_STOCK_SNAPSHOT = "e2e-stoc";

/** Text cu virgulă → zecimi de miime (ca șir pentru `bigint` din Postgres), fără `float`. */
function e2eTicks(text: string): string {
  const [whole = "0", fraction = ""] = text.trim().split(/[.,]/);
  return BigInt(`${whole}${fraction.padEnd(4, "0").slice(0, 4)}`).toString();
}

/**
 * Creează în baza de test produse cu stoc în depozitul implicit (creat de seed-ul din global-setup). `physicalAsOf` al
 * rândurilor de stoc = `asOfHoursAgo` ore în urmă (null = fără poză aplicată). Întoarce SKU-urile complete, în ordine.
 */
export async function seedE2eStock(
  tag: string,
  products: readonly E2eStockProduct[],
  options: { asOfHoursAgo?: number | null } = {},
): Promise<string[]> {
  const skus: string[] = [];
  await withClient(async (db) => {
    const warehouse = await db.query(`select id from warehouse where "isDefault" limit 1`);
    const warehouseId = warehouse.rows[0]?.id as string | undefined;
    if (!warehouseId) throw new Error("Nu există depozitul implicit în baza de test (seed lipsă?)");
    // orele se trimit ca șiruri ISO (UTC): `pg` ar serializa un `Date` în ora locală a procesului, iar coloanele `timestamp`
    // (fără fus) se citesc ca UTC de Prisma
    const asOf =
      options.asOfHoursAgo === null || options.asOfHoursAgo === undefined
        ? null
        : new Date(Date.now() - options.asOfHoursAgo * 3_600_000);
    for (const [index, product] of products.entries()) {
      let unitId: string | null = null;
      if (product.unit) {
        const unit = await db.query(
          `insert into measure_unit (id, code, name, symbol, decimals, "sortOrder", "updatedAt")
           values (gen_random_uuid()::text, $1, $2, $3, $4, 900, now())
           on conflict (code) do update set code = excluded.code returning id`,
          [
            `e2e${tag}${index}`,
            `Unitate E2E ${tag}${index}`,
            product.unit.symbol,
            product.unit.decimals,
          ],
        );
        unitId = unit.rows[0]?.id as string;
      }
      let brandId: string | null = null;
      if (product.brand) {
        const brand = await db.query(
          `insert into brand (id, slug, name, "defaultLeadTimeDays", "updatedAt")
           values (gen_random_uuid()::text, $1, $2, $3, now()) returning id`,
          [`e2e-stoc-${tag}-b${index}`, product.brand.name, product.brand.defaultLeadTimeDays],
        );
        brandId = brand.rows[0]?.id as string;
      }
      const created = await db.query(
        `insert into product (id, slug, title, type, "manageStock", "stockStatus", "allowBackorder",
                              "measureUnitId", "saleStep", "leadTimeDays", "saleStepLabel", "brandId",
                              "priceBasis", "showStepPrice", "updatedAt")
         values (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now()) returning id`,
        [
          `e2e-stoc-${tag}-${index}`,
          product.title,
          product.type ?? "physical",
          product.manageStock ?? true,
          product.stockStatus ?? "instock",
          product.allowBackorder ?? false,
          unitId,
          product.step ? Number.parseInt(e2eTicks(product.step), 10) : null,
          product.leadTimeDays ?? null,
          product.saleStepLabel ?? null,
          brandId,
          product.priceBasis ?? "unit",
          product.showStepPrice ?? false,
        ],
      );
      const productId = created.rows[0]?.id as string;
      for (const [position, variant] of product.variants.entries()) {
        const sku = `${E2E_STOCK_SKU_PREFIX}${tag}${index}${position}${variant.sku}`.toUpperCase();
        skus.push(sku);
        const row = await db.query(
          `insert into product_variant (id, "productId", sku, price, position, "isDefault", "saleStep", "updatedAt")
           values (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, now()) returning id`,
          [
            productId,
            sku,
            variant.price ?? product.price ?? 1000,
            position,
            position === 0,
            variant.step ? Number.parseInt(e2eTicks(variant.step), 10) : null,
          ],
        );
        if (variant.physical !== null) {
          await db.query(
            `insert into inventory_item (id, "variantId", "warehouseId", physical, "physicalAsOf", "lowStockSteps", "updatedAt")
             values (gen_random_uuid()::text, $1, $2, $3::bigint, $4, $5, now())`,
            [
              row.rows[0]?.id as string,
              warehouseId,
              e2eTicks(variant.physical),
              asOf?.toISOString() ?? null,
              variant.lowStockSteps ?? null,
            ],
          );
        }
      }
    }
  });
  return skus;
}

/**
 * Pune (sau scoate) poza SmartBill a depozitului implicit, `hoursAgo` ore în urmă; `null` = nicio poză. Doar pozele create de
 * test (`fileName = e2e-stoc`) se ating.
 */
export async function setE2eStockSnapshot(hoursAgo: number | null): Promise<void> {
  await withClient(async (db) => {
    await db.query(`delete from stock_snapshot where "fileName" = $1`, [E2E_STOCK_SNAPSHOT]);
    if (hoursAgo === null) return;
    const warehouse = await db.query(`select id from warehouse where "isDefault" limit 1`);
    const warehouseId = warehouse.rows[0]?.id as string | undefined;
    if (!warehouseId) throw new Error("Nu există depozitul implicit în baza de test (seed lipsă?)");
    await db.query(
      `insert into stock_snapshot (id, "warehouseId", "takenAt", source, "fileName")
       values (gen_random_uuid()::text, $1, $2, 'import', $3)`,
      [warehouseId, new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), E2E_STOCK_SNAPSHOT],
    );
  });
}

/** Stocul unei variante (după SKU) și mișcările ei, citite din bază; cantitățile ca text în zecimi de miime. */
export async function readE2eStock(sku: string): Promise<{
  variantId: string;
  physical: string | null;
  /** Pragul «stoc mic» propriu (în pași); nul = setarea globală sau fără rând de stoc */
  lowStockSteps: number | null;
  movements: Array<{
    kind: string;
    reason: string | null;
    note: string | null;
    deltaPhysical: string;
    physicalAfter: string;
    effectiveAt: Date;
    actorLabel: string | null;
  }>;
} | null> {
  return withClient(async (db) => {
    const variant = await db.query(`select id from product_variant where sku = $1`, [sku]);
    const variantId = variant.rows[0]?.id as string | undefined;
    if (!variantId) return null;
    const item = await db.query(
      `select physical::text as physical, "lowStockSteps" from inventory_item where "variantId" = $1`,
      [variantId],
    );
    const movements = await db.query(
      `select kind, reason, note, "deltaPhysical"::text as "deltaPhysical", "physicalAfter"::text as "physicalAfter",
              "effectiveAt", "actorLabel"
       from stock_movement where "variantId" = $1 order by "effectiveAt" asc, "createdAt" asc`,
      [variantId],
    );
    return {
      variantId,
      physical: (item.rows[0]?.physical as string | undefined) ?? null,
      lowStockSteps: (item.rows[0]?.lowStockSteps as number | null | undefined) ?? null,
      movements: movements.rows as never,
    };
  });
}

/** Configurarea de vânzare a unui SKU (a produsului și a variantei), citită din bază, pentru verificarea importurilor. */
export async function readE2eSale(sku: string): Promise<{
  product: Record<string, unknown>;
  variant: Record<string, unknown>;
} | null> {
  return withClient(async (db) => {
    const row = await db.query(
      `select v."productId" as pid, v."measureUnitId" as v_unit, v."priceBasis" as v_basis, v."saleStep" as v_step,
              v."minSteps" as v_min, v."stockStatus" as v_status, v."smartbillMode" as v_mode,
              v."smartbillRatio" as v_ratio, v."smartbillUnitName" as v_sbname,
              p."measureUnitId" as p_unit, p."priceBasis" as p_basis, p."saleStep" as p_step, p."minSteps" as p_min,
              p."saleStepLabel" as p_label, p."leadTimeDays" as p_lead, p."manageStock" as p_manage,
              p."stockStatus" as p_status
       from product_variant v join product p on p.id = v."productId" where v.sku = $1`,
      [sku],
    );
    const r = row.rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      product: {
        unit: r["p_unit"],
        priceBasis: r["p_basis"],
        saleStep: r["p_step"],
        minSteps: r["p_min"],
        saleStepLabel: r["p_label"],
        leadTimeDays: r["p_lead"],
        manageStock: r["p_manage"],
        stockStatus: r["p_status"],
      },
      variant: {
        unit: r["v_unit"],
        priceBasis: r["v_basis"],
        saleStep: r["v_step"],
        minSteps: r["v_min"],
        stockStatus: r["v_status"],
        smartbillMode: r["v_mode"],
        smartbillRatio: r["v_ratio"],
        smartbillUnitName: r["v_sbname"],
      },
    };
  });
}

/** Creează un rol de test (cheia începe cu `e2e-`) cu permisiunile date, existente în baza de test. */
export async function createE2eRole(key: string, permissionKeys: readonly string[]): Promise<void> {
  if (!key.startsWith("e2e-")) throw new Error("Rolurile de test au cheia care începe cu «e2e-»");
  await withClient(async (db) => {
    const role = await db.query(
      `insert into role (id, key, name, "isSystem") values (gen_random_uuid()::text, $1, $2, false)
       on conflict (key) do update set name = excluded.name returning id`,
      [key, `Rol de test ${key}`],
    );
    const roleId = role.rows[0]?.id as string;
    await db.query(`delete from role_permission where "roleId" = $1`, [roleId]);
    for (const permission of permissionKeys) {
      const found = await db.query(`select id from permission where key = $1`, [permission]);
      const permissionId = found.rows[0]?.id as string | undefined;
      if (!permissionId) throw new Error(`Permisiunea ${permission} nu există în baza de test`);
      await db.query(`insert into role_permission ("roleId", "permissionId") values ($1, $2)`, [
        roleId,
        permissionId,
      ]);
    }
  });
}

/**
 * Șterge TOT ce au creat testele de stoc: mișcările (registrul e imuabil: triggerul se oprește TEMPORAR, în aceeași
 * tranzacție, doar pentru variantele `E2ESTOC…` ale bazei de test), rândurile de stoc, produsele, unitățile, pozele și
 * rolurile `e2e-…`. Întoarce câte produse s-au șters.
 */
export async function removeE2eStock(options: { tag?: string } = {}): Promise<number> {
  const { tag } = options;
  if (tag !== undefined && !/^[0-9a-f]{3,12}$/.test(tag)) {
    throw new Error("Tag-ul curățării trebuie să fie hexazecimal (3–12 caractere), nu un tipar");
  }
  // fără tag: tot ce are prefixul testelor de stoc; cu tag: DOAR produsele acelui fișier de teste (rulate în paralel,
  // fișierele nu își șterg produsele între ele)
  const skuLike =
    tag === undefined ? `${E2E_STOCK_SKU_PREFIX}%` : `${E2E_STOCK_SKU_PREFIX}${tag.toUpperCase()}%`;
  const slugLike = tag === undefined ? "e2e-stoc-%" : `e2e-stoc-${tag}-%`;
  const unitLike = tag === undefined ? "e2e%" : `e2e${tag}%`;
  return withClient(async (db) => {
    await db.query("BEGIN");
    try {
      await db.query(
        'ALTER TABLE "stock_movement" DISABLE TRIGGER "stock_movement_no_update_delete"',
      );
      await db.query(
        `delete from stock_movement where "variantId" in (select id from product_variant where sku like $1)`,
        [skuLike],
      );
      await db.query(
        'ALTER TABLE "stock_movement" ENABLE TRIGGER "stock_movement_no_update_delete"',
      );
      await db.query(
        `delete from inventory_item where "variantId" in (select id from product_variant where sku like $1)`,
        [skuLike],
      );
      const products = await db.query(`delete from product where slug like $1`, [slugLike]);
      await db.query(`delete from brand where slug like $1`, [slugLike]);
      await db.query(
        `delete from measure_unit where code like $1 and "isSystem" = false
           and not exists (select 1 from product p where p."measureUnitId" = measure_unit.id)`,
        [unitLike],
      );
      if (tag === undefined) await removeSharedStockRows(db);
      await db.query("COMMIT");
      return products.rowCount ?? 0;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  });
}

/** Rolurile `e2e-…` și poza SmartBill de test: comune tuturor fișierelor, deci se șterg separat de produsele unui tag. */
async function removeSharedStockRows(db: {
  query: (sql: string, values?: unknown[]) => Promise<unknown>;
}): Promise<void> {
  await db.query(`delete from stock_snapshot where "fileName" = $1`, [E2E_STOCK_SNAPSHOT]);
  await db.query(
    `delete from user_role where "roleId" in (select id from role where key like 'e2e-%')`,
  );
  await db.query(`delete from role where key like 'e2e-%' and "isSystem" = false`);
}

/** Șterge rolurile `e2e-…` și poza de test (comune); folosită de fișierul care le creează, după curățarea pe tag. */
export async function removeE2eStockShared(): Promise<void> {
  await withClient(async (db) => {
    await removeSharedStockRows(db);
  });
}

/** Rândurile de audit `stock.adjust` ale unei variante (entityId = `<varianta>:<depozitul>`). */
export async function readE2eStockAudit(
  variantId: string,
  action = "stock.adjust",
): Promise<
  {
    outcome: string;
    actorLabel: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }[]
> {
  return withClient(async (db) => {
    const result = await db.query(
      `select outcome, "actorLabel", before, after from audit_log
       where action = $2 and "entityId" like $1 order by "createdAt" asc`,
      [`${variantId}:%`, action],
    );
    return result.rows as never;
  });
}

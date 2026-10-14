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

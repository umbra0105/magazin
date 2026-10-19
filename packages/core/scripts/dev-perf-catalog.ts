/**
 * Utilitar DOAR pentru dezvoltare (nu face parte din pachetul distribuit): proba de performanță a catalogului pe un
 * catalog mare SINTETIC, ca să cunoaștem limitele reale (timp și memorie) înainte de lansare.
 *
 *   npm.cmd run dev:perf-catalog                       # generează, măsoară tot, curăță
 *   npm.cmd run dev:perf-catalog -- --only=list,export # doar anumite faze: list, bulk, lifecycle, export, import
 *   npm.cmd run dev:perf-catalog -- --keep             # nu șterge datele la final
 *   npm.cmd run dev:perf-catalog -- --out=raport.json  # scrie și rezultatele ca JSON
 *   npm.cmd run dev:perf-catalog -- --remove           # doar șterge datele de probă rămase
 *   --products=N        # produse generate (implicit 5000; ~4 variante fiecare)
 *   --skip-generate     # folosește datele generate la o rulare anterioară cu --keep (fiecare fază poate rula
 *                       # astfel într-un proces nou, cu memorie curată)
 *   --only=none         # doar generează (cu --keep)
 *
 * RULEAZĂ EXCLUSIV PE BAZA DE TEST (`<nume>_test`, derivată ca la testele de integrare, cu aceeași gardă): refuză
 * orice bază fără «test» în nume. NU atinge baza de dezvoltare. Tot ce creează are prefixul `perf-` / `PERF` (slug,
 * SKU, cod de atribut, tag media), deci curățarea nu atinge altceva. Auditul real e înlocuit cu unul gol (jurnalul
 * `audit_log` nu se poate șterge), deci timpii nu includ scrierea auditului (un rând pe operație).
 * Memoria raportată e RSS-ul acestui proces, eșantionat din 25 în 25 ms, pe fiecare fază (include ~200–300 MB de
 * bază: Node + Prisma + sharp). Nu afișează chei, parole sau adrese de conexiune.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Client } from "pg";
import { PrismaClient } from "@ecom/db";
import { LocalStorageDriver, deriveSigningKey } from "@ecom/integrations";
import { createLogger } from "@ecom/shared";
import { assertTestDatabase, deriveTestDatabaseUrl } from "../../../test/support/test-env";
import { AuditService } from "../src/audit/audit-service";
import { createPrismaProductExportStore } from "../src/catalog/export/export-store";
import { cellToCsvText, type ExportRow } from "../src/catalog/export/export-rows";
import { buildExportXlsx } from "../src/catalog/export/export-xlsx";
import { createProductExportService } from "../src/catalog/export/export-runtime";
import { csvStreamResponse } from "../src/catalog/import/import-csv";
import { createProductImportService } from "../src/catalog/import/import-runtime";
import { ProductLifecycleService } from "../src/catalog/product-lifecycle";
import { createPrismaProductLifecycleStore } from "../src/catalog/product-lifecycle-store";
import { ProductListService, createPrismaProductListStore } from "../src/catalog/product-list";
import { ProductService } from "../src/catalog/product-service";
import { createPrismaProductStore } from "../src/catalog/product-store";
import { PermissionService } from "../src/rbac/permission-service";
import { runBaseSeed } from "../src/seed/base-seed";
import { settingGroups } from "../src/settings/registry";
import { loadRootEnv } from "./_runtime";

void createPrismaProductExportStore;
void createHash;

loadRootEnv();

if (process.env["NODE_ENV"] === "production" || process.env["APP_ENV"] === "production") {
  console.error("Refuz: proba de performanță nu rulează în producție.");
  process.exit(1);
}

// ---------------------------------------------------------------- baza de TEST, cu gardă
const devUrl = process.env["DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"] ?? "";
const testUrl = deriveTestDatabaseUrl(devUrl, process.env["TEST_DATABASE_URL"]);
assertTestDatabase(testUrl);
process.env["DATABASE_URL"] = testUrl;

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
};
const only = flag("only")?.split(",").filter(Boolean) ?? null;
const keep = flag("keep") !== null;
const outFile = flag("out");
const wants = (phase: string): boolean => only === null || only.includes(phase);

const PRODUCTS = Number(flag("products") ?? 5000);
const skipGenerate = flag("skip-generate") !== null;
const SLUG = "perf-";

// Prisma cu jurnal de interogări (pentru EXPLAIN), pe aceeași bază de test
const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const dbRequire = createRequire(join(root, "packages/db/package.json"));
const { PrismaPg } = dbRequire("@prisma/adapter-pg") as {
  PrismaPg: new (config: { connectionString: string }) => never;
};
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: testUrl }),
  log: [{ emit: "event", level: "query" }],
});
interface Captured {
  query: string;
  params: string;
  ms: number;
}
let capturing: Captured[] | null = null;
(
  db as unknown as {
    $on: (e: string, cb: (x: { query: string; params: string; duration: number }) => void) => void;
  }
).$on("query", (event) => {
  if (capturing) capturing.push({ query: event.query, params: event.params, ms: event.duration });
});

// ---------------------------------------------------------------- măsurare timp + memorie
const MB = 1024 * 1024;
interface Measure {
  name: string;
  ms: number;
  rssStartMB: number;
  rssPeakMB: number;
  extra?: Record<string, unknown>;
}
const results: Measure[] = [];

async function measure<T>(
  name: string,
  fn: () => Promise<T>,
  extra?: () => Record<string, unknown>,
): Promise<T> {
  const rssStart = process.memoryUsage().rss;
  let peak = rssStart;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 25);
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    const ms = performance.now() - t0;
    clearInterval(timer);
    peak = Math.max(peak, process.memoryUsage().rss);
    const row: Measure = {
      name,
      ms: Math.round(ms),
      rssStartMB: Math.round(rssStart / MB),
      rssPeakMB: Math.round(peak / MB),
      ...(extra ? { extra: extra() } : {}),
    };
    results.push(row);
    console.log(
      `  ${name.padEnd(46)} ${String(row.ms).padStart(8)} ms   RSS ${String(row.rssStartMB).padStart(5)} → vârf ${String(row.rssPeakMB).padStart(5)} MB${row.extra ? "   " + JSON.stringify(row.extra) : ""}`,
    );
  }
}

const logger = createLogger({ destination: { write() {} } });
const noAudit = new AuditService({
  async append() {},
  async list() {
    return [];
  },
});
async function settingGroup(group: string): Promise<unknown> {
  const schema = (settingGroups as Record<string, Record<string, z.ZodType>>)[group];
  if (!schema) throw new Error(`grup necunoscut: ${group}`);
  return z.object(schema).parse({});
}
const settings = { getGroup: settingGroup, getGroupUncached: settingGroup } as never;

const id = (): string => randomBytes(12).toString("hex");
const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};
const pick = <T>(items: readonly T[], n: number): T => items[n % items.length] as T;

// ---------------------------------------------------------------- curățare
async function removeAll(): Promise<void> {
  await db.productImport.deleteMany({ where: { fileName: { startsWith: "perf-" } } });
  await db.product.deleteMany({ where: { slug: { startsWith: SLUG } } });
  for (let i = 0; i < 5; i++) {
    const gone = await db.category.deleteMany({
      where: { slug: { startsWith: SLUG }, children: { none: {} }, products: { none: {} } },
    });
    if (gone.count === 0) break;
  }
  await db.brand.deleteMany({ where: { slug: { startsWith: SLUG }, products: { none: {} } } });
  await db.attribute.deleteMany({ where: { code: { startsWith: "perf_" } } });
  await db.media.deleteMany({ where: { tags: { has: "perf-seed" } } });
  await db.user.deleteMany({ where: { email: "perf@example.test" } });
}

// ---------------------------------------------------------------- date sintetice
interface Dataset {
  categoryIds: string[];
  rootCategoryId: string;
  brandIds: string[];
  productIds: string[];
  activeIds: string[];
  variantCount: number;
}

async function generate(): Promise<Dataset> {
  // categorii: 5 rădăcini × 4 copii × 2 nepoți = 65
  const categories: {
    id: string;
    parentId: string | null;
    slug: string;
    name: string;
    path: string;
    depth: number;
  }[] = [];
  for (let r = 0; r < 5; r++) {
    const rid = id();
    categories.push({
      id: rid,
      parentId: null,
      slug: `${SLUG}r${r}`,
      name: `Perf rădăcină ${r}`,
      path: `${SLUG}r${r}`,
      depth: 0,
    });
    for (let c = 0; c < 4; c++) {
      const cid = id();
      categories.push({
        id: cid,
        parentId: rid,
        slug: `${SLUG}r${r}c${c}`,
        name: `Perf copil ${r}.${c}`,
        path: `${SLUG}r${r}/${SLUG}r${r}c${c}`,
        depth: 1,
      });
      for (let g = 0; g < 2; g++) {
        categories.push({
          id: id(),
          parentId: cid,
          slug: `${SLUG}r${r}c${c}g${g}`,
          name: `Perf nepot ${r}.${c}.${g}`,
          path: `${SLUG}r${r}/${SLUG}r${r}c${c}/${SLUG}r${r}c${c}g${g}`,
          depth: 2,
        });
      }
    }
  }
  await db.category.createMany({ data: categories });
  const leafIds = categories.filter((c) => c.depth === 2).map((c) => c.id);

  const brands = Array.from({ length: 40 }, (_, i) => ({
    id: id(),
    slug: `${SLUG}brand-${i}`,
    name: `Perf Brand ${i}`,
  }));
  await db.brand.createMany({ data: brands });

  // atribute: 2 numerice (filtrabile), 2 select, 1 text, 1 bool
  const attrs = [
    {
      id: id(),
      code: "perf_putere",
      name: "Putere",
      type: "number",
      unit: "kW",
      isFilterable: true,
    },
    {
      id: id(),
      code: "perf_debit",
      name: "Debit",
      type: "number",
      unit: "m3/h",
      isFilterable: true,
    },
    {
      id: id(),
      code: "perf_material",
      name: "Material",
      type: "select",
      unit: null,
      isFilterable: true,
    },
    {
      id: id(),
      code: "perf_culoare",
      name: "Culoare",
      type: "select",
      unit: null,
      isFilterable: true,
    },
    { id: id(), code: "perf_nota", name: "Notă", type: "text", unit: null, isFilterable: false },
    {
      id: id(),
      code: "perf_certificat",
      name: "Certificat",
      type: "bool",
      unit: null,
      isFilterable: false,
    },
  ];
  await db.attribute.createMany({ data: attrs });
  const options: { id: string; attributeId: string; value: string; position: number }[] = [];
  for (const a of attrs.filter((x) => x.type === "select")) {
    for (let i = 0; i < 6; i++)
      options.push({ id: id(), attributeId: a.id, value: `${a.name} ${i}`, position: i });
  }
  await db.attributeOption.createMany({ data: options });

  // media fictivă (60 de fișiere «gata», cu variantă thumb)
  const mediaIds: string[] = [];
  const media = Array.from({ length: 60 }, (_, i) => {
    const mid = id();
    mediaIds.push(mid);
    return {
      id: mid,
      status: "ready",
      mime: "image/jpeg",
      sizeBytes: 100_000,
      width: 800,
      height: 600,
      checksum: createHash("sha256").update(`perf-${i}`).digest("hex"),
      originalName: `perf-${i}.jpg`,
      storageKey: `public/media/perf-${i}/original.jpg`,
      tags: ["perf-seed"],
      variants: [
        {
          name: "thumb",
          format: "webp",
          mime: "image/webp",
          key: `public/media/perf-${i}/thumb.webp`,
          width: 320,
          height: 240,
          sizeBytes: 8000,
        },
        {
          name: "thumb",
          format: "jpeg",
          mime: "image/jpeg",
          key: `public/media/perf-${i}/thumb.jpg`,
          width: 320,
          height: 240,
          sizeBytes: 12000,
        },
      ],
    };
  });
  await db.media.createMany({ data: media });

  // produse: i%10 în 0..4 → 1 variantă; 5..7 → 3; 8..9 → 13 (medie 4,0 → exact 20.000 de variante)
  const products: Record<string, unknown>[] = [];
  const variants: Record<string, unknown>[] = [];
  const productCategories: { productId: string; categoryId: string; isPrimary: boolean }[] = [];
  const productMedia: { id: string; productId: string; mediaId: string; position: number }[] = [];
  const attributeValues: Record<string, unknown>[] = [];
  const productIds: string[] = [];
  const activeIds: string[] = [];
  const statuses = [
    "active",
    "active",
    "active",
    "active",
    "active",
    "active",
    "active",
    "draft",
    "draft",
    "archived",
  ];
  const shipping = ["standard", "standard", "standard", "oversized", "pallet"];
  const stocks = ["instock", "instock", "instock", "outofstock", "onbackorder"];
  const now = Date.now();
  const selectAttrs = attrs.filter((a) => a.type === "select");
  for (let i = 0; i < PRODUCTS; i++) {
    const pid = id();
    productIds.push(pid);
    const status = pick(statuses, i);
    const deleted = i % 50 === 7; // 2% în coșul de gunoi
    if (status === "active" && !deleted) activeIds.push(pid);
    products.push({
      id: pid,
      slug: `${SLUG}produs-${i}`,
      title: `Perf produs ${i} ${pick(["pompă", "filtru", "robot", "cartuș", "dozator", "încălzitor"], i)}`,
      subtitle: i % 3 === 0 ? `Subtitlu ${i}` : null,
      description: `Descriere sintetică a produsului ${i}. `.repeat(8),
      status,
      brandId: i % 7 === 0 ? null : pick(brands, i).id,
      shippingClass: pick(shipping, i),
      stockStatus: pick(stocks, i),
      manageStock: false,
      deletedAt: deleted ? new Date(now - i * 1000) : null,
      createdAt: new Date(now - i * 60_000),
      updatedAt: new Date(now - i * 30_000),
    });
    const count = i % 10 < 5 ? 1 : i % 10 < 8 ? 3 : 13;
    for (let k = 0; k < count; k++) {
      const price = 1000 + ((i * 7919 + k * 104729) % 2_000_000);
      variants.push({
        id: id(),
        productId: pid,
        sku: `PERF-${i}-${k}`,
        ean: k === 0 ? String(5900000000000 + i).padStart(13, "0") : null,
        warrantyMonths: 24,
        price,
        salePrice: i % 10 === 0 ? Math.floor(price * 0.9) : null,
        costPrice: Math.floor(price * 0.6),
        manufacturerPartNumber: i % 4 === 0 ? `MPN-${i}-${k}` : null,
        position: k,
        isDefault: k === 0,
        stockStatus: "instock",
      });
    }
    const first = pick(leafIds, i);
    productCategories.push({ productId: pid, categoryId: first, isPrimary: true });
    if (i % 3 === 0)
      productCategories.push({
        productId: pid,
        categoryId: pick(leafIds, i + 11),
        isPrimary: false,
      });
    if (i % 3 !== 0) {
      for (let m = 0; m < 1 + (i % 3); m++) {
        productMedia.push({
          id: id(),
          productId: pid,
          mediaId: pick(mediaIds, i + m),
          position: m,
        });
      }
    }
    attributeValues.push({
      id: id(),
      productId: pid,
      attributeId: attrs[0]?.id,
      numberValue: String(1 + (i % 40) / 4),
    });
    attributeValues.push({
      id: id(),
      productId: pid,
      attributeId: attrs[1]?.id,
      numberValue: String(5 + (i % 200)),
    });
    const sel = pick(selectAttrs, i);
    const opt = options.filter((o) => o.attributeId === sel.id)[i % 6];
    if (opt)
      attributeValues.push({ id: id(), productId: pid, attributeId: sel.id, optionId: opt.id });
  }
  for (const part of chunk(products, 1000)) await db.product.createMany({ data: part as never });
  for (const part of chunk(variants, 2000))
    await db.productVariant.createMany({ data: part as never });
  for (const part of chunk(productCategories, 2000))
    await db.productCategory.createMany({ data: part });
  for (const part of chunk(productMedia, 2000)) await db.productMedia.createMany({ data: part });
  for (const part of chunk(attributeValues, 2000))
    await db.attributeValue.createMany({ data: part as never });
  await db.$executeRawUnsafe(
    "ANALYZE product, product_variant, product_category, product_media, attribute_value, category, brand, media",
  );
  return {
    categoryIds: categories.map((c) => c.id),
    rootCategoryId: categories[0]?.id as string,
    brandIds: brands.map((b) => b.id),
    productIds,
    activeIds,
    variantCount: variants.length,
  };
}

async function loadDataset(): Promise<Dataset> {
  const categories = await db.category.findMany({
    where: { slug: { startsWith: SLUG } },
    select: { id: true, slug: true },
  });
  const brands = await db.brand.findMany({
    where: { slug: { startsWith: SLUG } },
    select: { id: true },
  });
  const active = await db.product.findMany({
    where: { slug: { startsWith: `${SLUG}produs-` }, status: "active", deletedAt: null },
    select: { id: true },
    take: 1000,
  });
  const variantCount = await db.productVariant.count({ where: { sku: { startsWith: "PERF-" } } });
  console.log(
    `  set de date existent: ${categories.length} categorii, ${active.length}+ produse active, ${variantCount} variante`,
  );
  return {
    categoryIds: categories.map((c) => c.id),
    rootCategoryId: categories.find((c) => c.slug === `${SLUG}r0`)?.id as string,
    brandIds: brands.map((b) => b.id),
    productIds: [],
    activeIds: active.map((p) => p.id),
    variantCount,
  };
}

// ---------------------------------------------------------------- EXPLAIN
interface PlanSummary {
  label: string;
  execMs: number | null;
  planningMs: number | null;
  seqScans: string[];
  sorts: number;
  text: string;
}

async function explain(pg: Client, label: string, captured: Captured[]): Promise<PlanSummary[]> {
  const out: PlanSummary[] = [];
  const seen = new Set<string>();
  for (const q of captured) {
    if (!/^\s*SELECT/i.test(q.query) || seen.has(q.query)) continue;
    seen.add(q.query);
    let params: unknown[];
    try {
      params = JSON.parse(q.params) as unknown[];
    } catch {
      continue;
    }
    try {
      const res = await pg.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${q.query}`, params);
      const text = res.rows.map((r) => r["QUERY PLAN"] as string).join("\n");
      const exec = /Execution Time: ([\d.]+) ms/.exec(text);
      const plan = /Planning Time: ([\d.]+) ms/.exec(text);
      out.push({
        label,
        execMs: exec ? Number(exec[1]) : null,
        planningMs: plan ? Number(plan[1]) : null,
        seqScans: [...text.matchAll(/Seq Scan on (\w+)[^\n]*rows=(\d+)/g)].map(
          (m) => `${m[1]} (rows=${m[2]})`,
        ),
        sorts: (text.match(/\bSort\b/g) ?? []).length,
        text,
      });
    } catch (error) {
      out.push({
        label,
        execMs: null,
        planningMs: null,
        seqScans: [],
        sorts: 0,
        text: `EXPLAIN a eșuat: ${(error as Error).name}`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- faze
async function main(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "ecom-perf-"));
  const storage = new LocalStorageDriver({
    rootDir: join(base, "storage"),
    appUrl: "https://magazin.test",
    signingKey: deriveSigningKey(Buffer.alloc(32, 9).toString("base64")),
  });
  const pg = new Client({ connectionString: testUrl });
  await pg.connect();
  try {
    console.log(`Baza de TEST: ${new URL(testUrl).pathname.slice(1)} (nu cea de dezvoltare)`);
    if (flag("remove") !== null) {
      await removeAll();
      console.log("Datele de probă au fost șterse.");
      return;
    }
    if (!skipGenerate) await removeAll();
    await runBaseSeed(db);
    // utilizatorul sintetic, cu rolul Owner (păstrat între rulările cu --skip-generate)
    const existing = skipGenerate
      ? await db.user.findUnique({ where: { email: "perf@example.test" } })
      : null;
    const user =
      existing ??
      (await db.user.create({
        data: { id: id(), name: "Probă performanță", email: "perf@example.test" },
      }));
    const ownerRole = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    if (!existing) await db.userRole.create({ data: { userId: user.id, roleId: ownerRole.id } });
    const subject = (await new PermissionService(db).loadSubject(user.id)) as NonNullable<
      Awaited<ReturnType<PermissionService["loadSubject"]>>
    >;

    console.log(
      `\n== Generare: ${PRODUCTS} de produse, ~20.000 de variante, 65 categorii, 40 branduri, 6 atribute, 60 fișiere media`,
    );
    const data = skipGenerate
      ? await loadDataset()
      : await measure(
          "generare set de date",
          () => generate(),
          () => ({}),
        );
    console.log(`  variante generate: ${data.variantCount}`);

    const products = new ProductService({
      store: createPrismaProductStore(db),
      audit: noAudit,
      defaultManageStock: async () => false,
      defaultWarrantyMonths: async () => 24,
      logger,
    });
    const lifecycle = new ProductLifecycleService({
      store: createPrismaProductLifecycleStore(db),
      products: createPrismaProductStore(db),
      audit: noAudit,
      logger,
    });
    const listService = new ProductListService({
      store: createPrismaProductListStore(db),
      storage,
    });
    const plans: PlanSummary[] = [];

    // ------------------------------------------------------------ listă
    if (wants("list")) {
      console.log("\n== Lista de produse (25 pe pagină, cu EXPLAIN ANALYZE pe interogările ei)");
      const firstWord = "pompă";
      const scenarios: [string, Record<string, string>][] = [
        ["lista implicită (pagina 1, 25)", {}],
        ["100 pe pagină", { size: "100" }],
        ["pagina 40 din 200 (adâncă)", { page: "40" }],
        ["căutare titlu «perf produs 4321»", { q: "perf produs 4321" }],
        [`căutare cuvânt «${firstWord}» (multe rezultate)`, { q: firstWord }],
        ["căutare SKU «PERF-1234»", { q: "PERF-1234" }],
        ["căutare EAN prefix «59000000012»", { q: "59000000012" }],
        ["căutare cod producător «MPN-400»", { q: "MPN-400" }],
        ["filtru categorie rădăcină (cu subcategorii)", { category: data.rootCategoryId }],
        ["filtru brand", { brand: data.brandIds[3] as string }],
        [
          "filtru stare+livrare+stoc",
          { status: "active", shipping: "oversized", stock: "instock" },
        ],
        ["coșul de gunoi", { view: "deleted" }],
        ...(["updated_desc", "title_asc", "price_asc", "price_desc", "created_desc"] as const).map(
          (s): [string, Record<string, string>] => [`sortare ${s}`, { sort: s }],
        ),
      ];
      for (const [label, params] of scenarios) {
        const times: number[] = [];
        let first: Captured[] = [];
        for (let run = 0; run < 6; run++) {
          capturing = run === 0 ? [] : null;
          const t0 = performance.now();
          await listService.list(subject, params);
          times.push(performance.now() - t0);
          if (run === 0) first = capturing ?? [];
          capturing = null;
        }
        times.shift(); // prima rulare = încălzire
        times.sort((a, b) => a - b);
        const median = times[Math.floor(times.length / 2)] as number;
        results.push({
          name: `listă: ${label}`,
          ms: Math.round(median),
          rssStartMB: 0,
          rssPeakMB: 0,
          extra: { maxMs: Math.round(times[times.length - 1] as number) },
        });
        console.log(
          `  ${label.padEnd(52)} median ${median.toFixed(1).padStart(7)} ms   max ${(times[times.length - 1] as number).toFixed(1)} ms`,
        );
        plans.push(...(await explain(pg, label, first)));
      }
    }

    // ------------------------------------------------------------ editare în masă și ciclu de viață (50)
    if (wants("bulk")) {
      console.log("\n== Editare în masă pe 50 de produse");
      const ids = data.activeIds.slice(100, 150);
      await measure("editare în masă: preț +5% + categorie", () =>
        products.bulkUpdate(subject, {
          ids,
          confirm: true,
          expectedCount: 50,
          changes: { priceAdjustBps: 500, addCategoryId: data.categoryIds[10] as string },
        }),
      );
      await measure("editare în masă: stare + clasă de livrare", () =>
        products.bulkUpdate(subject, {
          ids,
          confirm: true,
          expectedCount: 50,
          changes: { status: "active", shippingClass: "pallet" },
        }),
      );
    }
    if (wants("lifecycle")) {
      console.log("\n== Ciclul de viață pe selecție de 50");
      const ids = data.activeIds.slice(300, 350);
      const sel = { ids, confirm: true, expectedCount: 50 };
      await measure("arhivare 50", () => lifecycle.archive(subject, sel));
      await measure("dezarhivare 50", () => lifecycle.unarchive(subject, sel));
      await measure("coș de gunoi 50", () => lifecycle.softDelete(subject, sel));
      await measure("restaurare 50", () => lifecycle.restore(subject, sel));
    }

    // ------------------------------------------------------------ export
    if (wants("export")) {
      console.log("\n== Export al catalogului întreg (limita implicită: 20.000 de rânduri)");
      const exporter = createProductExportService({ db, settings, audit: noAudit, logger });
      let rows = 0;
      let bytes = 0;
      await measure(
        "export CSV în flux (tot catalogul)",
        async () => {
          const prepared = await exporter.prepare(subject, {
            format: "csv",
            scope: "all",
            includeTrash: false,
          });
          async function* csv(): AsyncGenerator<string[]> {
            yield prepared.headers;
            for await (const row of prepared.rows as AsyncIterable<ExportRow>) {
              rows += 1;
              yield row.map(cellToCsvText);
            }
          }
          const response = csvStreamResponse(csv(), prepared.fileName);
          const reader = (response.body as ReadableStream<Uint8Array>).getReader();
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
          }
        },
        () => ({ rânduri: rows, octeți: bytes }),
      );
      let xlsxBytes = 0;
      await measure(
        "export XLSX (tot catalogul, construit în memorie)",
        async () => {
          const prepared = await exporter.prepare(subject, {
            format: "xlsx",
            scope: "all",
            includeTrash: false,
          });
          xlsxBytes = (await buildExportXlsx(prepared)).byteLength;
        },
        () => ({ octeți: xlsxBytes }),
      );
    }

    // ------------------------------------------------------------ import de 5.000 de rânduri
    if (wants("import")) {
      console.log("\n== Import generic de 5.000 de rânduri (produse noi), pe etape");
      const importer = createProductImportService({
        db,
        storage,
        settings,
        audit: noAudit,
        logger,
      });
      const queued: string[] = [];
      const queuedImporter = createProductImportService({
        db,
        storage,
        settings,
        audit: noAudit,
        logger,
        queue: { enqueue: async (importId) => void queued.push(importId) },
      });
      const brandName = "Perf Brand 5";
      const categoryPath = "Perf rădăcină 1 > Perf copil 1.1 > Perf nepot 1.1.0";
      void categoryPath;
      const csvFor = (tag: string): Buffer => {
        const lines = ["SKU;Titlu;Descriere;Preț (lei, cu TVA);Brand;EAN"];
        for (let i = 0; i < 5000; i++) {
          lines.push(
            `PERF${tag}-${i};Perf import ${tag} ${i};Descriere sintetică a produsului importat ${i}.;${(10 + (i % 900) + 0.99).toFixed(2).replace(".", ",")};${brandName};${String(5901000000000 + i)}`,
          );
        }
        return Buffer.from(lines.join("\r\n"), "utf8");
      };
      const columns = ["sku", "title", "description", "price", "brand", "ean"];

      for (const mode of ["sincron", "în fundal"] as const) {
        const tag = mode === "sincron" ? "S" : "B";
        const service = mode === "sincron" ? importer : queuedImporter;
        console.log(`  -- ${mode}`);
        const bytes = csvFor(tag);
        const fileName = `perf-import-${tag}.csv`;
        const analysis = await measure(`[${mode}] încărcare + analiză (5.000 rânduri)`, () =>
          service.register(subject, { bytes, fileName }),
        );
        const validation = await measure(`[${mode}] verificare (dry-run)`, () =>
          service.validate(subject, { importId: analysis.importId, columns, delimiter: ";" }),
        );
        console.log(
          `     raport: ${validation.report.counts.new} noi, ${validation.report.counts.errors} erori`,
        );
        if (mode === "sincron") {
          await measure(`[${mode}] aplicare`, () =>
            service.apply(subject, {
              importId: analysis.importId,
              confirm: true,
              expectedPlanHash: validation.planHash,
            }),
          );
        } else {
          await measure(`[${mode}] punere în coadă (apply)`, () =>
            service.apply(subject, {
              importId: analysis.importId,
              confirm: true,
              expectedPlanHash: validation.planHash,
            }),
          );
          await measure(`[${mode}] rulare în worker (runQueued)`, () =>
            service.runQueued(analysis.importId),
          );
        }
        await measure(`[${mode}] istoric: listă (pagina 1)`, () => service.listHistory(subject, 1));
        const detail = await measure(`[${mode}] istoric: detalii (raport pe rânduri)`, () =>
          service.getHistory(subject, analysis.importId),
        );
        console.log(`     detalii: ${detail.report?.entries.length ?? 0} rânduri în raport`);
        await measure(`[${mode}] raport CSV al importului`, () =>
          service.reportRows(subject, analysis.importId),
        );
      }

      // al treilea pas: același fișier din nou = tot «neschimbat» (dry-run pe 5.000 de rânduri existente)
      const again = await importer.register(subject, {
        bytes: csvFor("S"),
        fileName: "perf-import-S2.csv",
      });
      await measure("[repetat] verificare (5.000 deja existente)", () =>
        importer.validate(subject, { importId: again.importId, columns, delimiter: ";" }),
      );
    }

    // ------------------------------------------------------------ planuri
    if (plans.length > 0) {
      console.log("\n== EXPLAIN ANALYZE: rezumat pe interogările listei");
      for (const p of plans) {
        const flagged = p.seqScans.length > 0 ? `   Seq Scan: ${p.seqScans.join(", ")}` : "";
        console.log(
          `  ${p.label.padEnd(52)} execuție ${String(p.execMs).padStart(8)} ms  sortări ${p.sorts}${flagged}`,
        );
      }
      await writeFile(
        join(base, "planuri.txt"),
        plans.map((p) => `### ${p.label}\n${p.text}\n`).join("\n"),
      );
      console.log(`  planurile complete: ${join(base, "planuri.txt")}`);
    }

    if (outFile) {
      await writeFile(
        outFile,
        JSON.stringify(
          { results, plans: plans.map(({ text, ...rest }) => ({ ...rest, text })) },
          null,
          2,
        ),
      );
      console.log(`\nRezultate scrise în ${outFile}`);
    }
    if (!keep) {
      console.log("\n== Curățare");
      await removeAll();
      console.log("  datele de probă au fost șterse.");
    }
  } finally {
    await pg.end();
    await db.$disconnect();
    if (!keep) await rm(base, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error("Proba a eșuat:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});

/**
 * Utilitar DOAR pentru dezvoltare (nu face parte din pachetul distribuit; se mută odată cu celelalte
 * scripturi dev-only la Faza 21): creează ~30 de produse FICTIVE, cu variante, branduri, categorii,
 * prețuri de achiziție și imagini generate local, ca să poți încerca lista de produse din admin.
 *
 *   npm run dev:seed-products             # creează (idempotent: dacă există deja, nu face nimic)
 *   npm run dev:seed-products -- --remove # șterge tot ce a creat (slug `demo-…`, fișiere cu tag `demo-seed`)
 *
 * Tot ce creează are adresa (slug) cu prefixul `demo-` și fișierele media tag-ul `demo-seed`, deci
 * `--remove` nu atinge altceva. Imaginile sunt generate cu `sharp` (fără rețea) și procesate cu
 * același procesor ca workerul (variante AVIF/WebP/JPEG, blurhash). Refuză să ruleze în producție.
 * Nu afișează chei, parole sau adrese de conexiune.
 */
import sharp from "sharp";
import { loadEnv } from "@ecom/config";
import { createStorage } from "@ecom/integrations";
import { getLogger } from "@ecom/shared";
import { AuditService } from "../src/audit/audit-service";
import { createPrismaAuditStore } from "../src/audit/prisma-store";
import { CostPriceService } from "../src/catalog/cost-price";
import { createPrismaCostPriceStore } from "../src/catalog/cost-price-store";
import { ProductService } from "../src/catalog/product-service";
import { createPrismaProductStore } from "../src/catalog/product-store";
import { slugify } from "../src/catalog/slug";
import { createPrismaMediaStore } from "../src/media/media-store";
import { MediaService } from "../src/media/media-service";
import { MediaProcessor, defaultMediaSettings } from "../src/media/processing";
import { MemoryDecodeLimiter } from "../src/media/decode-limiter";
import { createPrismaProcessingStore } from "../src/media/processing-store";
import type { PermissionSubject } from "../src/rbac/can";
import { getDb, loadRootEnv } from "./_runtime";

loadRootEnv();

if (process.env["NODE_ENV"] === "production" || process.env["APP_ENV"] === "production") {
  console.error("Refuz: scriptul de produse fictive nu rulează în producție.");
  process.exit(1);
}

const db = getDb();
const SEED_TAG = "demo-seed";
const SLUG_PREFIX = "demo-";

/** Subiect sintetic cu rol Owner (implicit toate permisiunile); apare în audit ca „seed de dezvoltare”. */
const subject: PermissionSubject = {
  userId: "dev-seed",
  email: "seed-de-dezvoltare@local.invalid",
  roles: ["owner"],
  permissions: new Set(),
};

async function remove(): Promise<void> {
  const products = await db.product.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  // categoriile: frunzele întâi (părintele e Restrict)
  let categories = 0;
  for (let i = 0; i < 6; i++) {
    const gone = await db.category.deleteMany({
      where: { slug: { startsWith: SLUG_PREFIX }, children: { none: {} }, products: { none: {} } },
    });
    categories += gone.count;
    if (gone.count === 0) break;
  }
  const brands = await db.brand.deleteMany({
    where: { slug: { startsWith: SLUG_PREFIX }, products: { none: {} } },
  });
  const media = await db.media.deleteMany({ where: { tags: { has: SEED_TAG } } });
  console.log(
    `Șterse: ${products.count} produse, ${categories} categorii, ${brands.count} branduri, ${media.count} fișiere media.`,
  );
}

/** Imagine generată: fundal de culoare + eticheta produsului (SVG), JPEG. */
async function makeImage(label: string, hue: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
    <rect width="800" height="600" fill="hsl(${hue}, 55%, 55%)"/>
    <rect x="40" y="40" width="720" height="520" rx="24" fill="none" stroke="white" stroke-width="8"/>
    <text x="400" y="320" font-family="sans-serif" font-size="56" font-weight="700" fill="white"
          text-anchor="middle">${label}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

async function main(): Promise<void> {
  if (process.argv.includes("--remove")) {
    await remove();
    return;
  }
  if ((await db.product.count({ where: { slug: { startsWith: SLUG_PREFIX } } })) > 0) {
    console.log("Produsele fictive există deja. Folosește `-- --remove` ca să le ștergi întâi.");
    return;
  }

  const env = loadEnv();
  const storage = createStorage(env);
  const audit = new AuditService(createPrismaAuditStore(db));
  const logger = getLogger();
  const products = new ProductService({
    store: createPrismaProductStore(db),
    audit,
    defaultManageStock: async () => true,
    logger,
  });
  const costs = new CostPriceService({
    store: createPrismaCostPriceStore(db),
    audit,
    logger,
  });
  const settings = defaultMediaSettings();
  const mediaService = new MediaService({ store: createPrismaMediaStore(db), storage });
  const processor = new MediaProcessor({
    store: createPrismaProcessingStore(db),
    storage,
    limiter: new MemoryDecodeLimiter(),
    getSettings: async () => settings,
    logger,
  });

  // --- branduri și categorii
  const brandNames = ["Demo Hayward", "Demo Astral", "Demo Intex"];
  const brandIds: string[] = [];
  for (const name of brandNames) {
    const slug = name.toLowerCase().replace(/\s+/g, "-");
    const brand = await db.brand.create({ data: { name, slug } });
    brandIds.push(brand.id);
  }
  const root = await db.category.create({
    data: {
      name: "Demo Piscine",
      slug: "demo-piscine",
      path: "demo-piscine",
      depth: 0,
      sortOrder: 90,
    },
  });
  const leaves = await Promise.all(
    [
      ["Demo Pompe", "demo-pompe"],
      ["Demo Filtrare", "demo-filtrare"],
      ["Demo Chimicale", "demo-chimicale"],
    ].map(async ([name, slug], i) =>
      db.category.create({
        data: {
          name: name as string,
          slug: slug as string,
          path: `demo-piscine/${slug}`,
          parentId: root.id,
          depth: 1,
          sortOrder: i,
        },
      }),
    ),
  );

  // --- imagini (6), procesate ca în worker
  const mediaIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const bytes = await makeImage(`Demo ${i + 1}`, i * 55);
    const uploaded = await mediaService.upload({
      bytes,
      originalName: `demo-${i + 1}.jpg`,
      uploadedById: null,
      limits: {
        allowedMimeTypes: settings.allowedMimeTypes,
        maxInputPixels: settings.maxInputPixels,
      },
    });
    await processor.process(uploaded.id, { finalAttempt: true });
    await db.media.update({
      where: { id: uploaded.id },
      data: { tags: [SEED_TAG], alt: `Demo ${i + 1}` },
    });
    mediaIds.push(uploaded.id);
  }

  // --- produse
  const kinds = [
    "Pompă de căldură",
    "Pompă de recirculare",
    "Filtru cu nisip",
    "Cartuș filtrant",
    "Liner albastru",
    "Robot de curățare",
    "Clor granulat",
    "Dezumidificator",
    "Scară inox",
    "Proiector LED",
  ];
  const statuses = ["active", "active", "active", "draft", "archived"] as const;
  const shipping = ["standard", "standard", "oversized", "pallet"] as const;
  const stock = ["instock", "instock", "instock", "outofstock", "onbackorder"] as const;

  let created = 0;
  for (let i = 1; i <= 30; i++) {
    const kind = kinds[(i - 1) % kinds.length] as string;
    const title = `${kind} Demo ${String(i).padStart(2, "0")}`;
    const price = (4900 + i * 1750) * 1; // bani, brut
    const sku = `DEMO-${String(i).padStart(3, "0")}`;
    const withSale = i % 4 === 0;
    const { product, variants } = await products.create(subject, {
      title,
      slug: `demo-${slugify(kind)}-${String(i).padStart(2, "0")}`,
      description: `Produs fictiv pentru probe. ${kind}, modelul ${i}.`,
      status: statuses[i % statuses.length],
      shippingClass: shipping[i % shipping.length],
      stockStatus: stock[i % stock.length],
      brandId: i % 7 === 0 ? null : (brandIds[i % brandIds.length] as string),
      variants: [
        {
          sku,
          price,
          ...(withSale && { salePrice: Math.round(price * 0.85) }),
          ean: `59012341${String(10000 + i).padStart(5, "0")}`.slice(0, 13),
          weightGrams: 1000 + i * 500,
          manufacturerPartNumber: `SP-${1000 + i}-X${i % 5}`,
        },
      ],
    });
    // o parte au variante (mărimi), generate din opțiuni
    if (i % 5 === 0) {
      await products.generateVariants(subject, product.id, {
        options: [{ name: "Mărime", values: ["S", "M", "L"] }],
        price,
        baseSku: sku,
      });
    }
    // categorie (frunză), imagine și cost de achiziție
    await db.productCategory.create({
      data: {
        productId: product.id,
        categoryId: (leaves[i % leaves.length] as { id: string }).id,
        isPrimary: true,
      },
    });
    if (i % 6 !== 0) {
      await db.productMedia.create({
        data: { productId: product.id, mediaId: mediaIds[i % mediaIds.length] as string },
      });
    }
    for (const variant of variants) {
      await costs.setCost(subject, {
        variantId: variant.id,
        costPrice: Math.round(price / 1.21 / 1.3),
        effectiveDate: new Date(),
        source: "manual",
      });
    }
    created++;
  }
  console.log(
    `Create: ${created} produse fictive, ${brandNames.length} branduri, ${leaves.length + 1} categorii, ${mediaIds.length} imagini.`,
  );
  console.log("Le ștergi cu: npm run dev:seed-products -- --remove");
}

try {
  await main();
} finally {
  await db.$disconnect();
}

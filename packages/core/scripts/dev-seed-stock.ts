/**
 * Utilitar DOAR pentru dezvoltare (nu face parte din pachetul distribuit; se mută odată cu celelalte scripturi dev-only la
 * Faza 21): creează produse FICTIVE de stoc, ca să încerci ecranul `/admin/stoc`: cele 6 produse-model din plan (țeavă,
 * liner, bisulfat, furtun, mozaic, abachi cu 4 variante) plus cazurile speciale (stoc mic, «La comandă», negestionat,
 * digital) și o poză SmartBill pentru banner.
 *
 *   npm.cmd run dev:seed-stock                  # creează (idempotent: dacă există, nu face nimic); poza e de acum 3 ore
 *   npm.cmd run dev:seed-stock -- --poza=veche  # poza e de acum 30 de ore (banner roșu)
 *   npm.cmd run dev:seed-stock -- --poza=nicio  # fără nicio poză (banner roșu)
 *   npm.cmd run dev:seed-stock -- --remove      # șterge ce a creat (doar produsele fără mișcări de stoc)
 *
 * Tot ce creează are adresa (slug) cu prefixul `demo-stoc-`, SKU-ul `DEMO-STOC-…` și poza `fileName = demo-stoc`, deci
 * `--remove` nu atinge altceva. Stocul se scrie direct (fără mișcări), așa că istoricul e gol până faci prima ajustare; un
 * produs cu mișcări nu se mai șterge (registrul e imuabil): scriptul îl lasă și îți spune. Refuză să ruleze în producție.
 * Nu afișează chei, parole sau adrese de conexiune.
 */
import { parseQuantity, saleStepToInt, type Quantity } from "@ecom/shared";
import { getDb, loadRootEnv } from "./_runtime";

loadRootEnv();

if (process.env["NODE_ENV"] === "production" || process.env["APP_ENV"] === "production") {
  console.error("Refuz: scriptul de stoc fictiv nu rulează în producție.");
  process.exit(1);
}

const db = getDb();
const SLUG_PREFIX = "demo-stoc-";
const SKU_PREFIX = "DEMO-STOC-";
const SNAPSHOT_MARK = "demo-stoc";
const q = (text: string): Quantity => parseQuantity(text);

interface UnitSpec {
  code: string;
  name: string;
  symbol: string;
  decimals: number;
}
const UNITS: Record<string, UnitSpec> = {
  ml: { code: "ml", name: "Metru liniar", symbol: "ml", decimals: 2 },
  mp: { code: "mp", name: "Metru pătrat", symbol: "mp", decimals: 2 },
  kg: { code: "kg", name: "Kilogram", symbol: "kg", decimals: 3 },
};

interface VariantSpec {
  sku: string;
  /** Pasul variantei (suprascrie produsul), ex. abachi */
  step?: string;
  physical: string | null;
  /** Valoarea opțiunii «Lungime» (doar abachi) */
  length?: string;
}
interface ProductSpec {
  slug: string;
  title: string;
  unit?: keyof typeof UNITS;
  step?: string;
  manageStock?: boolean;
  stockStatus?: "instock" | "outofstock" | "onbackorder";
  allowBackorder?: boolean;
  type?: "physical" | "digital";
  variants: VariantSpec[];
}

const PRODUCTS: ProductSpec[] = [
  {
    slug: "teava-pvc-u",
    title: "Țeavă PVC-U (demo stoc)",
    unit: "ml",
    step: "2,5",
    variants: [{ sku: "TEAVA", physical: "100" }],
  },
  {
    slug: "liner-placare",
    title: "Liner placare (demo stoc)",
    unit: "mp",
    step: "41,25",
    variants: [{ sku: "LINER", physical: "100" }],
  },
  {
    slug: "bisulfat-sodiu",
    title: "Bisulfat de sodiu (demo stoc)",
    unit: "kg",
    step: "25",
    variants: [{ sku: "BISULFAT", physical: "80" }],
  },
  {
    slug: "furtun-dozare",
    title: "Furtun de dozare (demo stoc)",
    unit: "ml",
    step: "1",
    variants: [{ sku: "FURTUN", physical: "300" }],
  },
  {
    slug: "mozaic-placare",
    title: "Mozaic placare (demo stoc)",
    unit: "mp",
    step: "2,03",
    variants: [{ sku: "MOZAIC", physical: "10" }],
  },
  {
    slug: "lemn-abachi",
    title: "Lemn de abachi pentru saună (demo stoc)",
    unit: "ml",
    variants: [
      { sku: "ABACHI-15", step: "1,5", physical: "10", length: "1,5 ml" },
      { sku: "ABACHI-18", step: "1,8", physical: "10", length: "1,8 ml" },
      { sku: "ABACHI-21", step: "2,1", physical: "10", length: "2,1 ml" },
      { sku: "ABACHI-26", step: "2,6", physical: "10", length: "2,6 ml" },
    ],
  },
  {
    slug: "clor-tablete",
    title: "Clor tablete (demo stoc: stoc limitat)",
    variants: [{ sku: "CLOR", physical: "2" }],
  },
  {
    slug: "pompa-caldura",
    title: "Pompă de căldură (demo stoc: La comandă)",
    allowBackorder: true,
    variants: [{ sku: "POMPA", physical: "0" }],
  },
  {
    slug: "cartus-filtru",
    title: "Cartuș filtru (demo stoc: negestionat, epuizat)",
    manageStock: false,
    stockStatus: "outofstock",
    variants: [{ sku: "CARTUS", physical: null }],
  },
  {
    slug: "ghid-intretinere",
    title: "Ghid de întreținere (demo stoc: digital)",
    type: "digital",
    manageStock: false,
    variants: [{ sku: "GHID", physical: null }],
  },
];

async function remove(): Promise<void> {
  const products = await db.product.findMany({
    where: { slug: { startsWith: SLUG_PREFIX } },
    select: { id: true, slug: true, variants: { select: { id: true } } },
  });
  let removed = 0;
  const kept: string[] = [];
  for (const product of products) {
    const variantIds = product.variants.map((v) => v.id);
    const movements = await db.stockMovement.count({ where: { variantId: { in: variantIds } } });
    if (movements > 0) {
      kept.push(product.slug);
      continue;
    }
    await db.$transaction(async (tx) => {
      await tx.inventoryItem.deleteMany({ where: { variantId: { in: variantIds } } });
      await tx.product.delete({ where: { id: product.id } });
    });
    removed++;
  }
  const snapshots = await db.stockSnapshot.deleteMany({
    where: { fileName: SNAPSHOT_MARK, movements: { none: {} } },
  });
  console.log(`Șterse: ${removed} produse, ${snapshots.count} poze.`);
  if (kept.length > 0) {
    console.log(
      `Rămase (au mișcări de stoc, iar registrul e imuabil): ${kept.join(", ")}. Le poți arhiva din admin.`,
    );
  }
}

async function seed(): Promise<void> {
  if ((await db.product.count({ where: { slug: { startsWith: SLUG_PREFIX } } })) > 0) {
    console.log(
      "Produsele de stoc fictive există deja. Folosește `-- --remove` ca să le ștergi întâi.",
    );
    return;
  }
  const warehouse = await db.warehouse.findFirst({ where: { isDefault: true } });
  if (!warehouse) {
    console.error("Nu există depozitul implicit. Rulează întâi `npm.cmd run db:seed`.");
    process.exit(1);
  }

  const unitIds = new Map<string, string>();
  for (const spec of Object.values(UNITS)) {
    const unit = await db.measureUnit.upsert({
      where: { code: spec.code },
      update: {},
      create: spec,
    });
    unitIds.set(spec.code, unit.id);
  }

  const argument = process.argv.find((a) => a.startsWith("--poza="))?.slice("--poza=".length) ?? "";
  const snapshotAgeHours = argument === "veche" ? 30 : argument === "nicio" ? null : 3;
  const takenAt =
    snapshotAgeHours === null ? null : new Date(Date.now() - snapshotAgeHours * 3_600_000);
  if (takenAt) {
    await db.stockSnapshot.create({
      data: { warehouseId: warehouse.id, takenAt, source: "import", fileName: SNAPSHOT_MARK },
    });
  }

  for (const [index, spec] of PRODUCTS.entries()) {
    const unitId = spec.unit ? (unitIds.get(spec.unit) ?? null) : null;
    const product = await db.product.create({
      data: {
        slug: `${SLUG_PREFIX}${spec.slug}`,
        title: spec.title,
        type: spec.type ?? "physical",
        manageStock: spec.manageStock ?? true,
        stockStatus: spec.stockStatus ?? "instock",
        allowBackorder: spec.allowBackorder ?? false,
        ...(unitId && { measureUnitId: unitId }),
        ...(spec.step && { saleStep: saleStepToInt(q(spec.step)) }),
      },
    });
    const lengthOption =
      spec.variants.some((v) => v.length) &&
      (await db.productOption.create({
        data: { productId: product.id, name: "Lungime", position: 0 },
      }));
    for (const [position, variantSpec] of spec.variants.entries()) {
      const variant = await db.productVariant.create({
        data: {
          productId: product.id,
          sku: `${SKU_PREFIX}${variantSpec.sku}`,
          price: 1000 + index * 100,
          position,
          isDefault: position === 0,
          ...(variantSpec.step && { saleStep: saleStepToInt(q(variantSpec.step)) }),
        },
      });
      if (lengthOption && variantSpec.length) {
        const value = await db.optionValue.create({
          data: { optionId: lengthOption.id, value: variantSpec.length, position },
        });
        await db.variantOptionValue.create({
          data: {
            variantId: variant.id,
            productId: product.id,
            optionId: lengthOption.id,
            optionValueId: value.id,
          },
        });
      }
      if (variantSpec.physical !== null) {
        await db.inventoryItem.create({
          data: {
            variantId: variant.id,
            warehouseId: warehouse.id,
            physical: q(variantSpec.physical),
            ...(takenAt && { physicalAsOf: takenAt }),
          },
        });
      }
    }
  }

  console.log(`Au fost create ${PRODUCTS.length} produse de stoc fictive (adresa demo-stoc-…).`);
  console.log(
    takenAt
      ? `Poza SmartBill: acum ${snapshotAgeHours} ore (${takenAt.toISOString()}).`
      : "Fără nicio poză SmartBill.",
  );
  console.log("Deschide /admin/stoc. Șterge-le cu `npm.cmd run dev:seed-stock -- --remove`.");
}

try {
  if (process.argv.includes("--remove")) await remove();
  else await seed();
} finally {
  await db.$disconnect();
}

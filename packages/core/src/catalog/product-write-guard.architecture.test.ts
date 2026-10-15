import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură: orice server action sau endpoint care MODIFICĂ produse trece prin
 * `withPermission("products.…", …)`. Pică dacă un fișier de acțiuni/rute scrie produse (prin Prisma
 * sau prin serviciile catalogului) fără acest înveliș pe fiecare export.
 *
 * Citește sursa ca text; `findUnguardedProductWrites` e pură și testată pe fișiere sintetice, ca testul
 * să nu poată trece „în gol”.
 */

const root = fileURLToPath(new URL("../../../../", import.meta.url));

export interface SourceFile {
  path: string;
  content: string;
}

/** Tabelele atinse de modificările de catalog (delegate Prisma) și acțiunile lor de scriere. */
const MODELS = [
  "product",
  "productVariant",
  "productMedia",
  "productDocument",
  "productOption",
  "optionValue",
  "variantOptionValue",
  "productCategory",
  "attributeValue",
  "productRelation",
  "priceHistory",
  "costPriceHistory",
  "collectionProduct",
  "partsDiagram",
  "channelListing",
  // categorii și branduri (același regim de permisiuni products.*)
  "category",
  "brand",
  // atribute (definiții și opțiuni)
  "attribute",
  "attributeOption",
];
const PRISMA_WRITE = new RegExp(
  `\\.(?:${MODELS.join("|")})\\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\\b`,
);
/** Serviciile catalogului care scriu (numele lor sunt o convenție: testul le caută). */
const SERVICE_WRITE =
  /\b(?:ProductService|ProductUpdateGuard|CostPriceService|CategoryService|BrandService|getProductService|getCostPriceService|getProductUpdateGuard|getCategoryService|getBrandService|productService|costPriceService|productUpdateGuard|categoryService|brandService|ProductAssignmentsService|getProductAssignmentsService|productAssignmentsService|getPurchasePriceService|purchasePriceService|AttributeService|getAttributeService|attributeService|ProductAttributesService|getProductAttributesService|productAttributesService|ProductDocumentsService|getProductDocumentsService|productDocumentsService|ProductRelationsService|getProductRelationsService|productRelationsService)\b/;

const WRITES_PRODUCTS = (content: string): boolean =>
  PRISMA_WRITE.test(content) || SERVICE_WRITE.test(content);

/** Fișiere de acțiuni (`"use server"`) sau rute API. */
const isEntrypoint = (file: SourceFile): boolean =>
  /\/route\.tsx?$/.test(file.path) ||
  /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*["']use server["']/.test(file.content);

const PRODUCT_PERMISSION = /^products\.[a-z]+(?:\.[a-z]+)?$/;

interface Export {
  name: string;
  /** Permisiunea din `withPermission("…")`, dacă exportul e învelit. */
  permission: string | null;
}

/** Exporturile unui fișier de acțiuni/rute, cu permisiunea din `withPermission` unde există. */
function exportsOf(content: string): Export[] {
  const out: Export[] = [];
  // Între `withPermission(` și literalul permisiunii pot sta spații, linii noi și comentarii
  // (forma din `categorii/actions.ts`): se recunosc, ca să nu devină „neprotejat” din întâmplare.
  const gap = String.raw`(?:\s|//[^\n]*\n|/\*[\s\S]*?\*/)*`;
  const guarded = new RegExp(
    String.raw`export\s+const\s+(\w+)\s*=\s*withPermission\(${gap}["']([\w.]+)["']`,
    "g",
  );
  for (const m of content.matchAll(guarded)) {
    out.push({ name: m[1] as string, permission: m[2] as string });
  }
  const guardedNames = new Set(out.map((e) => e.name));
  const any =
    /export\s+(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=|default\s+(?:async\s+)?function\s*(\w*))/g;
  for (const m of content.matchAll(any)) {
    const name = (m[1] ?? m[2] ?? m[3] ?? "default") as string;
    if (!guardedNames.has(name)) out.push({ name, permission: null });
  }
  return out;
}

export function findUnguardedProductWrites(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (!isEntrypoint(file) || !WRITES_PRODUCTS(file.content)) continue;
    const exported = exportsOf(file.content);
    if (exported.length === 0) {
      problems.push(`${file.path}: modifică produse, dar nu exportă nicio acțiune învelită`);
    }
    for (const e of exported) {
      if (e.permission === null) {
        problems.push(`${file.path}: «${e.name}» modifică produse fără withPermission`);
      } else if (!PRODUCT_PERMISSION.test(e.permission)) {
        problems.push(
          `${file.path}: «${e.name}» modifică produse cu permisiunea «${e.permission}» (cere products.*)`,
        );
      }
    }
  }
  return problems;
}

const SKIP_DIRS = new Set(["node_modules", "generated", ".next", ".turbo", "dist", "coverage"]);
const TEST_FILE = /\.(test|spec)\.(ts|tsx)$|\.e2e\.tsx$/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".next")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !TEST_FILE.test(name)) out.push(full);
  }
}

function loadWebSource(): SourceFile[] {
  const paths: string[] = [];
  walk(join(root, "apps", "web", "src"), paths);
  return paths.map((full) => ({
    path: relative(root, full).split(sep).join("/"),
    content: readFileSync(full, "utf8"),
  }));
}

describe("scrierile de produse trec prin withPermission(products.*) (sursa reală)", () => {
  const files = loadWebSource();

  it("scanează aplicația (nu trece în gol) și recunoaște punctele de intrare existente", () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files.filter(isEntrypoint).length).toBeGreaterThan(0);
    // acțiunile de setări există și sunt recunoscute ca învelite (altă permisiune, nu produse)
    const settings = files.find((f) => f.path.endsWith("(admin)/admin/setari/actions.ts"));
    expect(settings).toBeDefined();
    expect(exportsOf(settings?.content ?? "").every((e) => e.permission !== null)).toBe(true);
  });

  it("acțiunile de categorii și branduri sunt recunoscute ca scrieri de catalog și sunt învelite cu products.*", () => {
    for (const suffix of ["categorii/actions.ts", "branduri/actions.ts"]) {
      const file = files.find((f) => f.path.endsWith("(admin)/admin/" + suffix));
      expect(file, suffix).toBeDefined();
      expect(WRITES_PRODUCTS(file?.content ?? ""), suffix).toBe(true);
      const exported = exportsOf(file?.content ?? "");
      expect(exported.length, suffix).toBeGreaterThanOrEqual(3);
      for (const e of exported) {
        expect(e.permission?.startsWith("products."), suffix + ": " + e.name).toBe(true);
      }
    }
  });

  it("acțiunile editorului de produs (creare, câmpuri, variante, categorii, media, cost) sunt recunoscute și învelite cu products.*", () => {
    const expected: Record<string, string[]> = {
      "editor-actions.ts": [
        "saveProductFields",
        "createProduct",
        "saveVariantFields",
        "saveProductCategories",
        "saveProductMedia",
        "checkProductSlug",
        // blocul 11b
        "saveProductAttributes",
        "addProductRelation",
        "removeProductRelation",
        "reorderProductRelations",
        "searchRelatedProducts",
        "previewProductVariants",
        "generateProductVariants",
        "deleteProductVariant",
      ],
      "purchase-actions.ts": ["savePurchasePrice"],
      // blocul 11c: documentele (încărcarea are ruta ei, acoperită de testul rutelor de upload)
      "document-actions.ts": [
        "updateProductDocument",
        "deleteProductDocument",
        "reorderProductDocuments",
      ],
    };
    for (const [suffix, names] of Object.entries(expected)) {
      const file = files.find((f) => f.path.endsWith("(admin)/admin/produse/" + suffix));
      expect(file, suffix).toBeDefined();
      expect(WRITES_PRODUCTS(file?.content ?? ""), suffix).toBe(true);
      const exported = exportsOf(file?.content ?? "");
      expect(exported.map((e) => e.name).sort(), suffix).toEqual([...names].sort());
      for (const e of exported) {
        expect(e.permission?.startsWith("products."), suffix + ": " + e.name).toBe(true);
      }
    }
  });

  it("acțiunile paginii Atribute sunt recunoscute ca scrieri de catalog și toate cer products.write", () => {
    const file = files.find((f) => f.path.endsWith("(admin)/admin/atribute/actions.ts"));
    expect(file).toBeDefined();
    expect(WRITES_PRODUCTS(file?.content ?? "")).toBe(true);
    const exported = exportsOf(file?.content ?? "");
    expect(exported.map((e) => e.name).sort()).toEqual(
      [
        "addAttributeOption",
        "createAttribute",
        "deleteAttribute",
        "deleteAttributeOption",
        "renameAttributeOption",
        "reorderAttributeOptions",
        "updateAttribute",
      ].sort(),
    );
    for (const e of exported) expect(e.permission, e.name).toBe("products.write");
  });

  it("nicio acțiune sau rută care modifică produse nu e neprotejată sau protejată cu altă permisiune", () => {
    expect(findUnguardedProductWrites(files)).toEqual([]);
  });
});

describe("findUnguardedProductWrites pe fișiere sintetice (testul pică când trebuie)", () => {
  const action = (body: string): SourceFile => ({
    path: "apps/web/src/app/(admin)/admin/produse/actions.ts",
    content: `"use server";\n${body}`,
  });

  it("prinde o acțiune care scrie produse fără permisiune", () => {
    const problems = findUnguardedProductWrites([
      action(
        `export async function updateTitle(id: string) {\n  await getDb().product.update({ where: { id }, data: {} });\n}`,
      ),
    ]);
    expect(problems).toEqual([
      expect.stringContaining("«updateTitle» modifică produse fără withPermission"),
    ]);
  });

  it("prinde o acțiune învelită cu permisiune din altă zonă (settings.write, content.write)", () => {
    for (const permission of ["settings.write", "content.write", "media.write"]) {
      const problems = findUnguardedProductWrites([
        action(
          `export const rename = withPermission("${permission}", async () => {\n  await getProductService().rename();\n});`,
        ),
      ]);
      expect(problems, permission).toEqual([expect.stringContaining("cere products.*")]);
    }
  });

  it("prinde o rută API care scrie produse fără învelișul de permisiune", () => {
    const problems = findUnguardedProductWrites([
      {
        path: "apps/web/src/app/api/produse/route.ts",
        content: `export async function POST(req: Request) {\n  await db.productVariant.updateMany({ data: {} });\n  return new Response();\n}`,
      },
    ]);
    expect(problems).toEqual([expect.stringContaining("«POST» modifică produse")]);
  });

  it("recunoaște permisiunea și când un comentariu stă între withPermission( și literal (forma din categorii)", () => {
    const withComment = (permission: string) =>
      action(
        [
          "export const rename = withPermission(",
          "  // poarta cea mai largă",
          "  /* și încă un comentariu */",
          `  "${permission}",`,
          "  async () => { await getProductService().rename(); },",
          ");",
        ].join("\n"),
      );
    // învelită cu products.*: nimic de raportat
    expect(findUnguardedProductWrites([withComment("products.content.write")])).toEqual([]);
    // altă zonă: se raportează ca permisiune greșită, nu ca „neprotejată” generic
    expect(findUnguardedProductWrites([withComment("settings.write")])).toEqual([
      expect.stringContaining("cere products.*"),
    ]);
  });

  it("prinde și un export neînvelit dintr-un fișier în care altul e învelit", () => {
    const problems = findUnguardedProductWrites([
      action(
        `export const ok = withPermission("products.content.write", async () => { await productService.update(); });\n` +
          `export async function sneaky() { await productService.update(); }`,
      ),
    ]);
    expect(problems).toEqual([expect.stringContaining("«sneaky»")]);
  });

  it("nu dă fals pozitive: acțiuni de produse învelite corect, acțiuni fără produse, fișiere fără directivă", () => {
    expect(
      findUnguardedProductWrites([
        action(
          `export const a = withPermission("products.write", async () => { await productService.update(); });\n` +
            `export const b = withPermission("products.content.write", async () => { await getProductService().update(); });\n` +
            `export const c = withPermission("products.cost.edit", async () => { await costPriceService.setCost(); });`,
        ),
        {
          path: "apps/web/src/app/(admin)/admin/setari/actions.ts",
          content: `"use server";\nexport const s = withPermission("settings.write", async () => {});`,
        },
        {
          path: "apps/web/src/lib/helper.ts",
          content: `export async function util() { await getDb().product.update({}); }`,
        },
      ]),
    ).toEqual([]);
  });
});

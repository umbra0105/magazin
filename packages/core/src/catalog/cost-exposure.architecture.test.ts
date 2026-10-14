import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură pentru prețul de achiziție (`costPrice`, `costPriceDate`, istoricul lui):
 * pică dacă o suprafață publică (storefront, API public, componente partajate, design system, emailuri)
 * sau o componentă client îl atinge, sau dacă un fișier nou din sursă începe să-l folosească fără ca
 * lista fișierelor permise să fie modificată în mod deliberat (deci vizibil la revizuire).
 *
 * Citește sursa ca text: nu are nevoie de bază de date. `findCostViolations` e pură și testată pe
 * fișiere sintetice, ca testul să nu poată trece „în gol”.
 */

const root = fileURLToPath(new URL("../../../../", import.meta.url));

/** Orice mențiune a costului: câmpuri, istoric, nume de coloane/tabel, în orice scriere. */
const COST_PATTERN = /cost_?price|cost_?net|cost_?history/i;
/** În suprafețele publice nici accesul direct la tabela de variante nu e permis (ar scoate costul). */
const VARIANT_DELEGATE_PATTERN = /\bproductVariant\b/;
const USE_CLIENT_PATTERN = /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*["']use client["']/;

export interface SourceFile {
  /** Cale relativă la rădăcina repo-ului, cu `/`. */
  path: string;
  content: string;
}

/** Rădăcinile suprafețelor publice (prefixe de cale). Excepțiile din interior sunt în `isPublic`. */
const PUBLIC_PREFIXES = [
  "apps/web/src/app/(storefront)/",
  "apps/web/src/app/(auth)/",
  "apps/web/src/app/cont/",
  "apps/web/src/app/api/",
  "apps/web/src/components/",
  "packages/ui/src/",
  "packages/emails/src/",
];

function isPublic(path: string): boolean {
  if (path.startsWith("apps/web/src/app/api/admin/")) return false;
  if (path.startsWith("apps/web/src/components/admin/")) return false;
  return PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Fișierele de producție care au voie să numească costul. Orice altul care îl menționează face testul
 * să pice: se adaugă aici DELIBERAT (și la revizuire se vede), nu din întâmplare.
 */
const ALLOWED_EXACT = new Set([
  "packages/core/src/catalog/cost-price.ts",
  "packages/core/src/catalog/cost-price-store.ts",
  // doar numele surselor de intrare (COST_PRICE_SOURCES), nicio valoare
  "packages/core/src/catalog/constants.ts",
  "packages/core/src/catalog/index.ts",
  // lista câmpurilor mascate din loguri și audit
  "packages/shared/src/redact.ts",
  "packages/shared/src/logger.ts",
]);

const ALLOWED_PREFIXES = [
  // motorul de prețuri (Faza 8) citește costul pentru prețul de partener și întoarce doar prețuri
  "packages/core/src/pricing/",
  // zona de admin: componente de server și rute de admin (componentele client sunt excluse separat)
  "apps/web/src/app/(admin)/",
  "apps/web/src/app/api/admin/",
  "apps/web/src/components/admin/",
];

function isAllowed(path: string): boolean {
  return ALLOWED_EXACT.has(path) || ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function findCostViolations(files: readonly SourceFile[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const mentionsCost = COST_PATTERN.test(file.content);
    if (isPublic(file.path)) {
      if (mentionsCost) violations.push(`${file.path}: suprafață publică care atinge costul`);
      if (VARIANT_DELEGATE_PATTERN.test(file.content)) {
        violations.push(`${file.path}: suprafață publică cu acces direct la productVariant`);
      }
    }
    if (mentionsCost && USE_CLIENT_PATTERN.test(file.content)) {
      violations.push(`${file.path}: componentă client care atinge costul (props către client)`);
    }
    if (mentionsCost && !isAllowed(file.path)) {
      violations.push(`${file.path}: fișier neautorizat să atingă costul (vezi lista permisă)`);
    }
  }
  return violations;
}

const SKIP_DIRS = new Set(["node_modules", "generated", ".next", ".turbo", "dist", "coverage"]);
const SOURCE = /\.(ts|tsx|mts|mjs|js|jsx)$/;
const TEST_FILE = /\.(test|spec|e2e)\.(ts|tsx)$|\.e2e\.tsx$/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".next")) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (SOURCE.test(name) && !TEST_FILE.test(name)) out.push(full);
  }
}

function loadSource(): SourceFile[] {
  const roots = [join(root, "apps", "web", "src")];
  for (const pkg of readdirSync(join(root, "packages"))) {
    const src = join(root, "packages", pkg, "src");
    try {
      if (statSync(src).isDirectory()) roots.push(src);
    } catch {
      // pachet fără `src`
    }
  }
  const paths: string[] = [];
  for (const dir of roots) walk(dir, paths);
  return paths.map((full) => ({
    path: relative(root, full).split(sep).join("/"),
    content: readFileSync(full, "utf8"),
  }));
}

describe("costul de achiziție nu iese din admin (sursa reală)", () => {
  const files = loadSource();

  it("scanează codul real (nu trece în gol) și fișierele permise există", () => {
    expect(files.length).toBeGreaterThan(100);
    const paths = new Set(files.map((f) => f.path));
    for (const allowed of ALLOWED_EXACT) expect(paths.has(allowed), allowed).toBe(true);
    // suprafețele publice sunt acoperite de scanare
    expect(files.some((f) => isPublic(f.path))).toBe(true);
    expect(files.some((f) => f.path.startsWith("packages/ui/src/"))).toBe(true);
  });

  it("nicio suprafață publică, componentă client sau fișier neautorizat nu atinge costul", () => {
    expect(findCostViolations(files)).toEqual([]);
  });

  it('niciun fișier de producție cu directiva "use client" nu conține cost (props către client)', () => {
    const client = files.filter((f) => USE_CLIENT_PATTERN.test(f.content));
    expect(client.length).toBeGreaterThan(0); // există componente client în aplicație
    expect(client.filter((f) => COST_PATTERN.test(f.content)).map((f) => f.path)).toEqual([]);
  });
});

describe("findCostViolations pe fișiere sintetice (testul pică când trebuie)", () => {
  const f = (path: string, content: string): SourceFile => ({ path, content });

  it("prinde costul în storefront, API public, componente partajate, design system și emailuri", () => {
    for (const path of [
      "apps/web/src/app/(storefront)/produs/[slug]/page.tsx",
      "apps/web/src/app/api/produse/route.ts",
      "apps/web/src/components/product-card.tsx",
      "packages/ui/src/price.tsx",
      "packages/emails/src/templates/oferta.tsx",
    ]) {
      expect(findCostViolations([f(path, "const c = variant.costPrice;")]), path).not.toEqual([]);
    }
  });

  it("prinde accesul direct la tabela de variante din suprafețele publice", () => {
    expect(
      findCostViolations([
        f(
          "apps/web/src/app/(storefront)/p/page.tsx",
          "const v = await db.productVariant.findMany()",
        ),
      ]),
    ).not.toEqual([]);
  });

  it("prinde costul într-o componentă client, chiar în zona de admin", () => {
    const content = '"use client";\nexport function Form({ costPrice }: { costPrice: number }) {}';
    expect(
      findCostViolations([f("apps/web/src/components/admin/produse/cost-field.tsx", content)]),
    ).not.toEqual([]);
    expect(
      findCostViolations([
        f("apps/web/src/components/admin/x.tsx", "// notă\n'use client'\nconst { costNet } = p;"),
      ]),
    ).not.toEqual([]);
  });

  it("prinde un fișier nou din nucleu care folosește costul fără să fie pe lista permisă", () => {
    expect(
      findCostViolations([
        f("packages/core/src/catalog/product-service.ts", "select: { costPrice: true }"),
      ]),
    ).not.toEqual([]);
    expect(findCostViolations([f("packages/jobs/src/feed.ts", "row.cost_price")])).not.toEqual([]);
  });

  it("nu dă fals pozitive: admin de server, serviciul de cost, motorul de prețuri, fișiere fără cost", () => {
    expect(
      findCostViolations([
        f("apps/web/src/app/(admin)/admin/produse/[id]/page.tsx", "const { costPrice } = cost;"),
        f("packages/core/src/catalog/cost-price.ts", "costPrice"),
        f("packages/core/src/pricing/engine.ts", "variant.costPrice"),
        f("apps/web/src/components/product-card.tsx", "export const price = salePrice;"),
        f("apps/web/src/components/shipping-cost.tsx", '"use client"; const shippingCost = 10;'),
      ]),
    ).toEqual([]);
  });
});

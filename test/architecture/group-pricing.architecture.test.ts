import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură pentru prețurile de grup (Faza 15, docs/09 §3 și §5). Citește sursa ca text. Garanții:
 *  1. CACHE: prețul de grup se calculează DINAMIC, pe cerere (acțiune de server). Nicio pagină publică (ISR), niciun cititor de
 *     catalog și nicio funcție cache-uită nu cheamă calculul prețului de grup; acțiunea și funcția ei nu folosesc niciun cache.
 *  2. FĂRĂ ADAOS ȘI COST în ce ajunge la client: DTO-ul, încărcătorul, componentele și magazinul de pe client nu pomenesc adaosul
 *     (`markup`) sau costul; vitrina primește doar numele grupului, tipul și reducerea.
 *  3. UN SINGUR CALCUL DE PREȚ DE GRUP: un fișier care aplică un grup (tip de preț, reducere, adaos) cu `resolveUnitPrice` sau
 *     `priceLines` e doar motorul, coșul sau prețul de grup al vitrinei; nimeni altcineva nu calculează un preț de grup (nici în
 *     checkout, nici în componente). Afișările de preț public (editorul, lista din admin) nu aplică grup și nu intră aici.
 *  4. COSTUL: doar `pricing/customer-pricing.ts` încarcă prețul de achiziție pentru coș; `cart-service.ts`, `checkout-service.ts` și
 *     tot `customers/` nu îl pomenesc (verificat și de testul de arhitectură al costului).
 * Funcțiile `find*` sunt pure și testate pe fișiere sintetice, ca testul să nu poată trece «în gol».
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

export interface SourceFile {
  path: string;
  content: string;
}

const strip = (content: string): string =>
  content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const GROUP_PRICE_CALLS =
  /\b(loadGroupDisplayPrices|loadCustomerPricing|getGroupPrices|loadPartnerInputs|withPartnerInput|estimatePurchasePoints|getPurchasePointsNote)\b|group-prices["']/;
const CACHE_USE =
  /\b(unstable_cache|revalidate|revalidateTag|cache\s*\(|use cache)\b|["']use cache["']/;
const MARKUP_OR_COST = /markup|cost(Net|Price)|cost_price|costNet/i;

/** Locurile (prefixe sau fișiere) care au voie să cheme calculul prețului de grup. */
const GROUP_PRICE_ALLOWED = [
  "packages/core/src/pricing/",
  "packages/core/src/cart/cart-service.ts",
  "packages/core/src/orders/checkout-service.ts",
  "apps/web/src/lib/group-prices.ts",
  "apps/web/src/app/(storefront)/pret-grup/actions.ts",
  "packages/core/src/index.ts",
];

/**
 * Singurele module ale vitrinei care au voie să atingă prețul de grup: calculează pe cerere, pentru cumpărătorul curent, și nu
 * folosesc niciun cache (prețul de grup și, din Faza 15b, estimarea «primești X puncte»).
 */
const DYNAMIC_MODULES = [
  "apps/web/src/lib/group-prices.ts",
  "apps/web/src/app/(storefront)/pret-grup/actions.ts",
  "apps/web/src/lib/purchase-points.ts",
  "apps/web/src/app/(storefront)/puncte-produs/actions.ts",
];

export function findGroupPriceCacheViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const code = strip(file.content);
    const isDynamic = DYNAMIC_MODULES.includes(file.path);
    const isPublicPage = file.path.startsWith("apps/web/src/app/(storefront)/") && !isDynamic;
    const isCatalogReader =
      file.path.startsWith("packages/core/src/storefront/") ||
      file.path === "apps/web/src/lib/storefront-catalog.ts";
    if ((isPublicPage || isCatalogReader) && GROUP_PRICE_CALLS.test(code)) {
      problems.push(
        `${file.path}: pagină publică sau cititor de catalog care atinge prețul de grup (ar intra în cache)`,
      );
    }
    if (isDynamic && CACHE_USE.test(code)) {
      problems.push(`${file.path}: prețul de grup nu se pune în niciun cache`);
    }
    if (
      !GROUP_PRICE_ALLOWED.some((allowed) => file.path.startsWith(allowed)) &&
      !/\.(test|spec)\.tsx?$/.test(file.path) &&
      /\bloadGroupDisplayPrices\b/.test(code)
    ) {
      problems.push(`${file.path}: cheamă prețul de grup din afara locurilor permise`);
    }
  }
  return problems;
}

const CLIENT_SIDE = [
  "apps/web/src/lib/group-prices-dto.ts",
  "apps/web/src/lib/group-prices.ts",
  "apps/web/src/app/(storefront)/pret-grup/actions.ts",
  "apps/web/src/components/storefront/catalog/group-price.tsx",
  "apps/web/src/components/storefront/catalog/group-price-store.ts",
  "apps/web/src/lib/cart-dto.ts",
  // punctele de loialitate (Faza 15b)
  "apps/web/src/lib/checkout-dto.ts",
  "apps/web/src/lib/purchase-points.ts",
  "apps/web/src/app/(storefront)/puncte-produs/actions.ts",
  "apps/web/src/components/storefront/checkout/points-choice.tsx",
  "apps/web/src/components/storefront/catalog/purchase-points.tsx",
];

export function findMarkupLeaks(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (!CLIENT_SIDE.includes(file.path)) continue;
    if (MARKUP_OR_COST.test(strip(file.content))) {
      problems.push(
        `${file.path}: pomenește adaosul sau costul într-o suprafață trimisă clientului`,
      );
    }
  }
  return problems;
}

const PRICE_CALL = /\b(resolveUnitPrice|priceLines)\s*\(/;
const GROUP_APPLIED =
  /(customerGroup|toPriceGroup|PriceGroup|cost_plus|discountBps|groupPricingType)/;
const PRICE_CALLERS = ["packages/core/src/pricing/", "packages/core/src/cart/cart-service.ts"];

export function findPriceCalcViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (/\.(test|spec)\.tsx?$/.test(file.path)) continue;
    if (PRICE_CALLERS.some((allowed) => file.path.startsWith(allowed))) continue;
    const code = strip(file.content);
    if (PRICE_CALL.test(code) && GROUP_APPLIED.test(code)) {
      problems.push(`${file.path}: aplică un grup de clienți în afara motorului și a coșului`);
    }
  }
  return problems;
}

const COST_FREE = [
  "packages/core/src/cart/cart-service.ts",
  "packages/core/src/orders/checkout-service.ts",
];

export function findCostInCartViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (/\.(test|spec)\.tsx?$/.test(file.path)) continue;
    const inCustomers =
      file.path.startsWith("packages/core/src/customers/") ||
      file.path.startsWith("packages/core/src/loyalty/");
    if (!COST_FREE.includes(file.path) && !inCustomers) continue;
    if (/cost_?price|cost_?net|cost_?history/i.test(strip(file.content))) {
      problems.push(`${file.path}: pomenește prețul de achiziție`);
    }
  }
  return problems;
}

const SKIP = new Set(["node_modules", "generated", ".next", ".turbo", "dist", "coverage"]);
const SOURCE = /\.(ts|tsx|mts|mjs|js|jsx)$/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".next")) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (SOURCE.test(name)) out.push(full);
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

describe("prețul de grup (sursa reală)", () => {
  const files = loadSource();
  const byPath = new Set(files.map((f) => f.path));

  it("scanează codul real: fișierele păzite există", () => {
    expect(files.length).toBeGreaterThan(300);
    for (const path of [
      ...CLIENT_SIDE,
      ...COST_FREE,
      ...PRICE_CALLERS.filter((p) => p.endsWith(".ts")),
    ]) {
      expect(byPath.has(path), path).toBe(true);
    }
  });

  it("prețul de grup nu intră în cache-ul paginilor publice", () => {
    expect(findGroupPriceCacheViolations(files)).toEqual([]);
  });

  it("adaosul și costul nu ajung în ce primește clientul", () => {
    expect(findMarkupLeaks(files)).toEqual([]);
  });

  it("un singur calcul de preț: motorul, chemat doar din coș și din prețul de grup al vitrinei", () => {
    expect(findPriceCalcViolations(files)).toEqual([]);
  });

  it("coșul, checkout-ul și grupurile nu pomenesc prețul de achiziție", () => {
    expect(findCostInCartViolations(files)).toEqual([]);
  });
});

describe("gărzile pe fișiere sintetice (testul pică când trebuie)", () => {
  const f = (path: string, content: string): SourceFile => ({ path, content });

  it("prinde prețul de grup într-o pagină publică, într-un cititor de catalog sau într-un cache", () => {
    for (const path of [
      "apps/web/src/app/(storefront)/produs/[slug]/page.tsx",
      "packages/core/src/storefront/catalog-reader.ts",
      "apps/web/src/lib/storefront-catalog.ts",
    ]) {
      expect(
        findGroupPriceCacheViolations([f(path, "await loadGroupDisplayPrices(db)")]),
        path,
      ).not.toEqual([]);
    }
    expect(
      findGroupPriceCacheViolations([
        f("apps/web/src/lib/group-prices.ts", 'import { unstable_cache } from "next/cache";'),
      ]),
    ).not.toEqual([]);
    expect(
      findGroupPriceCacheViolations([
        f("apps/web/src/app/(storefront)/pret-grup/actions.ts", "export const revalidate = 60;"),
      ]),
    ).not.toEqual([]);
    expect(
      findGroupPriceCacheViolations([
        f("apps/web/src/lib/altceva.ts", "loadGroupDisplayPrices(db)"),
      ]),
    ).not.toEqual([]);
  });

  it("prinde adaosul sau costul în suprafețele trimise clientului", () => {
    expect(
      findMarkupLeaks([f("apps/web/src/lib/group-prices-dto.ts", "markupBps: number")]),
    ).not.toEqual([]);
    expect(
      findMarkupLeaks([f("apps/web/src/lib/cart-dto.ts", "const c = line.costNetMinor;")]),
    ).not.toEqual([]);
    expect(
      findMarkupLeaks([
        f("apps/web/src/lib/cart-dto.ts", "// adaosul: nu se trimite\nconst a = 1;"),
      ]),
    ).toEqual([]);
  });

  it("prinde un al doilea calcul de preț", () => {
    expect(
      findPriceCalcViolations([
        f(
          "packages/core/src/orders/checkout-service.ts",
          "resolveUnitPrice(a, { group: toPriceGroup(g) })",
        ),
      ]),
    ).not.toEqual([]);
    expect(
      findPriceCalcViolations([
        f(
          "apps/web/src/components/x.tsx",
          'const p = priceLines(a, { pricingType: "cost_plus" }); // cost_plus',
        ),
      ]),
    ).not.toEqual([]);
    expect(
      findPriceCalcViolations([
        f("packages/core/src/pricing/group-display.ts", "resolveUnitPrice(a, b)"),
      ]),
    ).toEqual([]);
    // afișarea unui preț public (fără grup) nu e un al doilea calcul de preț de grup
    expect(
      findPriceCalcViolations([
        f(
          "apps/web/src/lib/price-view.ts",
          'priceLines(inputs, { group: { pricingType: "none" } })',
        ),
      ]),
    ).toEqual([]);
  });

  it("prinde costul în coș, în checkout sau în grupuri", () => {
    for (const path of [
      "packages/core/src/cart/cart-service.ts",
      "packages/core/src/orders/checkout-service.ts",
      "packages/core/src/customers/customer-group-service.ts",
    ]) {
      expect(findCostInCartViolations([f(path, "select: { costPrice: true }")]), path).not.toEqual(
        [],
      );
    }
  });
});

describe("gărzile punctelor de loialitate (Faza 15b), pe fișiere sintetice", () => {
  const f = (path: string, content: string): SourceFile => ({ path, content });

  it("estimarea «primești X puncte» nu intră în paginile publice și nu se pune în cache", () => {
    for (const call of ["await estimatePurchasePoints(db)", "await getPurchasePointsNote(r)"]) {
      expect(
        findGroupPriceCacheViolations([
          f("apps/web/src/app/(storefront)/produs/[slug]/page.tsx", call),
        ]),
        call,
      ).not.toEqual([]);
    }
    for (const path of [
      "apps/web/src/lib/purchase-points.ts",
      "apps/web/src/app/(storefront)/puncte-produs/actions.ts",
    ]) {
      expect(
        findGroupPriceCacheViolations([f(path, 'import { unstable_cache } from "next/cache";')]),
        path,
      ).not.toEqual([]);
    }
  });

  it("suprafețele punctelor trimise clientului nu pomenesc adaosul sau costul", () => {
    for (const path of [
      "apps/web/src/lib/purchase-points.ts",
      "apps/web/src/lib/checkout-dto.ts",
      "apps/web/src/components/storefront/checkout/points-choice.tsx",
      "apps/web/src/components/storefront/catalog/purchase-points.tsx",
    ]) {
      expect(findMarkupLeaks([f(path, "const c = group.markupBps;")]), path).not.toEqual([]);
    }
    expect(
      findCostInCartViolations([
        f("packages/core/src/loyalty/loyalty-read.ts", "select: { costPrice: true }"),
      ]),
    ).not.toEqual([]);
  });
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură pentru motorul de prețuri și coș (Faza 8). Reguli, pe codul de producție (testele, e2e și scripturile sunt
 * scutite):
 *  1. FĂRĂ `float` pe sume în zona de preț și coș (`pricing/`, `cart/`, `money.ts`): niciun `parseFloat`, `toFixed`,
 *     `Math.round|floor|ceil|trunc` și niciun literal zecimal în cod. Sumele sunt `int` în bani, calculul exact e `bigint`.
 *  2. Costul de achiziție NU intră în coș: în `cart/` și în interfața coșului nu apare niciun nume de cost (`costPrice`,
 *     `costPriceDate`, `CostPriceHistory`, `costNet…`; câmpul `costNetMinor` al motorului e opțional și coșul îl omite, fiindcă
 *     grupul coșului real e «none»). Interogările coșului folosesc liste `select`, niciodată `include` (care ar aduce toate
 *     câmpurile variantei).
 *  3. Niciun calcul de preț duplicat: `priceLines` și `resolveUnitPrice` se apelează doar din `pricing/` și `cart/`.
 *  4. Nicio suprafață publică de aplicare a cuponului: în `apps/web/src` nu apare cuvântul «coupon»/«cupon». Câmpul «Ai un cupon?»
 *     rămâne ascuns până în Faza 17 (tabela de reduceri, adminul, generatorul de coduri); atunci testul se extinde, nu se ocolește.
 *
 * Funcțiile `find…` sunt pure și testate pe cazuri sintetice, ca testul să nu poată trece «în gol».
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

export interface SourceFile {
  path: string;
  content: string;
}

const isTestPath = (path: string): boolean =>
  /\.(test|spec)\.[cm]?tsx?$/.test(path) ||
  /\.e2e\.[cm]?tsx?$/.test(path) ||
  path.startsWith("e2e/") ||
  path.startsWith("test/") ||
  /(^|\/)test-utils\//.test(path);

const isCode = (path: string): boolean => /\.[cm]?tsx?$/.test(path) && !isTestPath(path);

/** Scoate comentariile și șirurile de caractere, păstrând numerele de linie (regulile se aplică doar pe cod). */
export function stripCommentsAndStrings(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i] as string;
    const n = source[i + 1];
    if (c === "/" && n === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i++;
        if (source[i] === "\n") out += "\n";
        i++;
      }
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const inMoneyZone = (path: string): boolean =>
  /^packages\/core\/src\/(pricing|cart)\//.test(path) || path === "packages/shared/src/money.ts";

const FLOAT_FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/\bparseFloat\s*\(/, "parseFloat"],
  [/\.toFixed\s*\(/, "toFixed"],
  [/\bMath\.(?:round|floor|ceil|trunc)\s*\(/, "Math.round/floor/ceil/trunc"],
  [/(?<![\w.])\d+\.\d+(?![\w.])/, "literal zecimal"],
];

export function findFloatViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (!isCode(file.path) || !inMoneyZone(file.path)) continue;
    stripCommentsAndStrings(file.content)
      .split("\n")
      .forEach((line, index) => {
        for (const [pattern, name] of FLOAT_FORBIDDEN) {
          if (pattern.test(line)) {
            problems.push(
              `${file.path}:${index + 1}: ${name} în zona de preț/coș (sumele sunt bani întregi)`,
            );
          }
        }
      });
  }
  return problems;
}

const inCartZone = (path: string): boolean =>
  /^packages\/core\/src\/cart\//.test(path) ||
  /^apps\/web\/src\/app\/\(storefront\)\/cos\//.test(path) ||
  /^apps\/web\/src\/components\/storefront\/cart\//.test(path) ||
  /^apps\/web\/src\/lib\/cart[\w.-]*\.[cm]?tsx?$/.test(path);

export function findCartCostViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (!isCode(file.path) || !inCartZone(file.path)) continue;
    stripCommentsAndStrings(file.content)
      .split("\n")
      .forEach((line, index) => {
        const where = `${file.path}:${index + 1}`;
        if (/\bcostPrice\w*|\bCostPriceHistory\b/.test(line)) {
          problems.push(`${where}: costul de achiziție nu are voie în coș`);
        }
        if (/\bcostNet\w*/.test(line)) {
          problems.push(`${where}: costul net nu are voie în coș (coșul real e în grupul «none»)`);
        }
        if (file.path.startsWith("packages/core/src/cart/") && /\binclude\s*:/.test(line)) {
          problems.push(
            `${where}: coșul folosește liste «select», nu «include» (ar aduce și costul)`,
          );
        }
      });
  }
  return problems;
}

const inPriceEngineZone = (path: string): boolean =>
  /^packages\/core\/src\/(pricing|cart)\//.test(path);

/** Importul motorului de prețuri (`priceLines`, `resolveUnitPrice`) din pachetul de bază sau din `pricing/`. */
const PRICING_IMPORT =
  /import\s*(?:type\s*)?\{[^}]*\b(?:priceLines|resolveUnitPrice)\b[^}]*\}\s*from\s*["'](?:@ecom\/core[^"']*|[^"']*\/pricing(?:\/[^"']*)?)["']/;

export function findDuplicatedPricingViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (!isCode(file.path) || inPriceEngineZone(file.path)) continue;
    if (PRICING_IMPORT.test(file.content)) {
      problems.push(
        `${file.path}: prețul se calculează doar prin serviciul de coș (pricing/ și cart/); importul motorului din alt loc e interzis`,
      );
    }
  }
  return problems;
}

export function findCouponSurfaceViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (!file.path.startsWith("apps/web/src/") || !isCode(file.path)) continue;
    if (/coupon|cupon/i.test(file.path)) problems.push(`${file.path}: cale cu «cupon»`);
    file.content.split("\n").forEach((line, index) => {
      if (/coupon|cupon/i.test(line)) {
        problems.push(
          `${file.path}:${index + 1}: «cupon» în interfață; câmpul vine în Faza 17 (extinde testul atunci)`,
        );
      }
    });
  }
  return problems;
}

function walk(dir: string, out: SourceFile[]): void {
  for (const name of readdirSync(dir)) {
    if (
      ["node_modules", ".next", ".next-probe", "generated", "dist", "test-results"].includes(name)
    )
      continue;
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) walk(full, out);
    else if (/\.[cm]?tsx?$/.test(name)) {
      out.push({
        path: relative(root, full).split(sep).join("/"),
        content: readFileSync(full, "utf8"),
      });
    }
  }
}

const allFiles = (): SourceFile[] => {
  const files: SourceFile[] = [];
  for (const dir of ["packages", "apps"]) walk(join(root, dir), files);
  return files;
};

describe("arhitectură: motor de prețuri și coș (Faza 8)", () => {
  it("cazuri sintetice: regulile prind încălcările (testul nu trece «în gol»)", () => {
    const money = (content: string) => [{ path: "packages/core/src/pricing/x.ts", content }];
    expect(findFloatViolations(money("const a = price * 1.21;"))).toHaveLength(1);
    expect(findFloatViolations(money("const a = Math.round(x);"))).toHaveLength(1);
    expect(findFloatViolations(money("const a = x.toFixed(2);"))).toHaveLength(1);
    expect(findFloatViolations(money("const a = parseFloat(x);"))).toHaveLength(1);
    expect(findFloatViolations(money("// 0.5 în comentariu\nconst a = 'v1.2';"))).toHaveLength(0);
    expect(findFloatViolations(money("const a = (2n * x + y) / (2n * z);"))).toHaveLength(0);
    expect(
      findFloatViolations([{ path: "packages/core/src/catalog/x.ts", content: "const a = 1.5;" }]),
    ).toHaveLength(0);

    const cart = (content: string) => [{ path: "packages/core/src/cart/x.ts", content }];
    expect(findCartCostViolations(cart("select: { costPrice: true }"))).toHaveLength(1);
    expect(findCartCostViolations(cart("costNetMinor: variant.costPrice,"))).toHaveLength(2);
    expect(findCartCostViolations(cart("costNetMinor: row.cost,"))).toHaveLength(1);
    expect(findCartCostViolations(cart("costNetMinor: null,"))).toHaveLength(1);
    expect(findCartCostViolations(cart("const lineInput = { priceMinor: 1 };"))).toHaveLength(0);
    expect(
      findCartCostViolations(cart("db.cart.findMany({ include: { items: true } })")),
    ).toHaveLength(1);
    expect(findCartCostViolations(cart("// costPrice nu se citește"))).toHaveLength(0);
    expect(
      findCartCostViolations([
        { path: "apps/web/src/lib/cart-view.ts", content: "const c = costPrice;" },
      ]),
    ).toHaveLength(1);

    expect(
      findDuplicatedPricingViolations([
        {
          path: "apps/web/src/app/x.tsx",
          content: 'import { priceLines } from "@ecom/core";\nconst r = priceLines(l, o);',
        },
      ]),
    ).toHaveLength(1);
    expect(
      findDuplicatedPricingViolations([
        {
          path: "apps/web/src/lib/price-view.ts",
          content: "export function priceLines(a: number) { return a; }",
        },
      ]),
    ).toHaveLength(0);
    expect(
      findDuplicatedPricingViolations([
        { path: "packages/core/src/cart/x.ts", content: "priceLines(lines, o);" },
      ]),
    ).toHaveLength(0);

    expect(
      findCouponSurfaceViolations([
        {
          path: "apps/web/src/components/storefront/cart/x.tsx",
          content: "<label>Ai un cupon?</label>",
        },
      ]),
    ).toHaveLength(1);
    expect(
      findCouponSurfaceViolations([
        { path: "apps/web/src/app/api/cupon/route.ts", content: "export const x = 1;" },
      ]),
    ).toHaveLength(1);
    expect(
      findCouponSurfaceViolations([{ path: "apps/web/src/a.tsx", content: "const ok = 1;" }]),
    ).toHaveLength(0);
  });

  it("fără float pe sume în zona de preț și coș", () => {
    expect(findFloatViolations(allFiles())).toEqual([]);
  });

  it("costul de achiziție nu intră în coș", () => {
    expect(findCartCostViolations(allFiles())).toEqual([]);
  });

  it("niciun calcul de preț duplicat în afara motorului și a serviciului de coș", () => {
    expect(findDuplicatedPricingViolations(allFiles())).toEqual([]);
  });

  it("nicio suprafață publică de aplicare a cuponului (rămâne ascuns până în Faza 17)", () => {
    expect(findCouponSurfaceViolations(allFiles())).toEqual([]);
  });

  it("zonele reale există (regulile nu se aplică pe niciun fișier din greșeală)", () => {
    const files = allFiles();
    expect(files.some((f) => f.path === "packages/core/src/pricing/engine.ts")).toBe(true);
    expect(files.some((f) => f.path === "packages/core/src/cart/cart-service.ts")).toBe(true);
    expect(files.some((f) => f.path === "packages/shared/src/money.ts")).toBe(true);
  });
});

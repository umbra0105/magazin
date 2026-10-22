import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură: nicio cantitate nu se manipulează ca număr zecimal în afara modulului `Quantity`
 * (`packages/shared/src/quantity.ts`). Cantitățile sunt întregi (`bigint`, zecimi de miime); `float` strică exactitatea
 * (0,1 + 0,2 ≠ 0,3) și stocul/comenzile nu se pot permite asta (Faza 5, D11).
 *
 * Reguli (pe codul de producție; testele, e2e și scripturile de test sunt scutite):
 *  1. Factorul de scală (`10_000n`) apare doar în `quantity.ts`: restul codului nu face singur conversii de scală.
 *  2. Un identificator de cantitate (quantity, qty, physical, committed, reserved, saleStep, safetyBuffer …) nu trece prin
 *     `Number(...)`, `parseFloat(...)` sau `parseInt(...)` și nu se înmulțește/împarte cu un literal zecimal.
 *  3. În fișierele de stoc (`/inventory/`, `/stock/`, `quantity*`, `stock-*`): niciun `parseFloat`, `toFixed`, `Math.round|floor|ceil|trunc`
 *     și niciun `Number(...)`.
 *  4. Schema Prisma: niciun câmp `Float`/`Decimal` cu nume de cantitate, iar `quantity`, `physical`, `committed`, `reserved`,
 *     `safetyBuffer` sunt `BigInt`.
 *
 * `findQuantityViolations` și `findSchemaViolations` sunt pure și testate pe cazuri sintetice, ca testul să nu poată trece
 * «în gol». Limită: regulile 2–3 sunt euristici pe text (nu văd o variabilă redenumită); le completează tipul `Quantity`
 * (brand) și testele numerice din `packages/shared`.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

export interface SourceFile {
  path: string;
  content: string;
}

const NAME =
  "(?:\\w*[qQ]uantity\\w*|qty\\w*|saleStep\\w*|minSteps\\w*|physical\\w*|committed\\w*|reserved\\w*|safetyBuffer\\w*|lowStockSteps\\w*)";

const QUANTITY_MODULE = "packages/shared/src/quantity.ts";

const isTestPath = (path: string): boolean =>
  /\.(test|spec)\.[cm]?tsx?$/.test(path) ||
  path.startsWith("e2e/") ||
  path.startsWith("test/") ||
  /(^|\/)test-utils\//.test(path);

const inStockZone = (path: string): boolean =>
  /(^|\/)(inventory|stock)\//.test(path) || /(^|\/)(quantity|stock)[\w.-]*\.[cm]?tsx?$/.test(path);

const ZONE_FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/\bparseFloat\s*\(/, "parseFloat"],
  [/\.toFixed\s*\(/, "toFixed"],
  [/\bMath\.(?:round|floor|ceil|trunc)\s*\(/, "Math.round/floor/ceil/trunc"],
  [/\bNumber\s*\(/, "Number(...)"],
];

export function findQuantityViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  const scaleLiteral = /\b10_?000n\b/;
  const floatCall = new RegExp(`\\b(?:Number|parseFloat|parseInt)\\s*\\([^)]*\\b${NAME}\\b`);
  const decimalLiteral = new RegExp(`\\b${NAME}\\b\\s*[*/]\\s*(?:[0-9]*\\.[0-9]+|[0-9]+e[0-9]+)`);
  for (const file of files) {
    if (!/\.[cm]?tsx?$/.test(file.path) || isTestPath(file.path)) continue;
    const zone = inStockZone(file.path);
    file.content.split("\n").forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const where = `${file.path}:${index + 1}`;
      if (file.path !== QUANTITY_MODULE && scaleLiteral.test(line)) {
        problems.push(`${where}: factorul de scală 10_000n trebuie să rămână în quantity.ts`);
      }
      if (floatCall.test(line)) {
        problems.push(
          `${where}: cantitate trecută prin Number/parseFloat/parseInt (folosește Quantity)`,
        );
      }
      if (decimalLiteral.test(line)) {
        problems.push(`${where}: cantitate înmulțită/împărțită cu un literal zecimal`);
      }
      if (zone) {
        for (const [pattern, label] of ZONE_FORBIDDEN) {
          if (pattern.test(line))
            problems.push(`${where}: ${label} în cod de stoc (folosește Quantity)`);
        }
      }
    });
  }
  return problems;
}

const FIELD = /^\s+(\w+)\s+(\w+)(\?|\[\])?(\s|$)/;
const QUANTITY_FIELD =
  /^(?:quantity|qty\w*|physical|committed|reserved|safetyBuffer|delta\w+|\w*Quantity)$/;
const MUST_BE_BIGINT = /^(?:quantity|physical|committed|reserved|safetyBuffer)$/;

export function findSchemaViolations(schema: string): string[] {
  const problems: string[] = [];
  let model = "";
  schema.split("\n").forEach((line, index) => {
    const start = /^model\s+(\w+)\s*\{/.exec(line);
    if (start) model = start[1] ?? "";
    if (/^\}/.test(line)) model = "";
    if (!model || /^\s*\/\//.test(line)) return;
    const field = FIELD.exec(line);
    if (!field) return;
    const [, name = "", type = ""] = field;
    const where = `schema.prisma:${index + 1} ${model}.${name}`;
    if (
      (type === "Float" || type === "Decimal") &&
      /quantity|qty|stock|physical|committed|reserved|saleStep|safetyBuffer/i.test(name)
    ) {
      problems.push(
        `${where}: câmp de cantitate de tip ${type} (folosește BigInt/Int, zecimi de miime)`,
      );
    }
    if (MUST_BE_BIGINT.test(name) && type !== "BigInt") {
      problems.push(`${where}: trebuie să fie BigInt (cantitate în zecimi de miime), nu ${type}`);
    }
    if (QUANTITY_FIELD.test(name) && (type === "Float" || type === "Decimal")) {
      problems.push(`${where}: cantitate de tip ${type}`);
    }
  });
  return problems;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".turbo",
  "dist",
  "generated",
  "test-results",
  "playwright-report",
  "local-data",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".next")) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, out);
    else if (/\.[cm]?tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function realFiles(): SourceFile[] {
  return ["packages", "apps", "scripts"]
    .flatMap((dir) => walk(join(root, dir)))
    .map((full) => ({
      path: relative(root, full).split(sep).join("/"),
      content: readFileSync(full, "utf8"),
    }));
}

const file = (path: string, content: string): SourceFile => ({ path, content });

describe("cantități exacte: cazuri sintetice (regulile 1–3)", () => {
  it.each([
    ["scala în afara modulului", "packages/core/src/inventory/x.ts", `const t = value * 10_000n;`],
    ["scala fără liniuță", "apps/web/src/lib/a.ts", `const ticks = qty / 10000n;`],
    ["Number pe cantitate", "packages/core/src/orders/a.ts", `const n = Number(line.quantity);`],
    ["parseFloat pe cantitate", "apps/web/src/lib/a.ts", `return parseFloat(saleStepInput);`],
    ["parseInt pe stoc", "packages/core/src/a.ts", `const x = parseInt(item.physical, 10);`],
    ["înmulțire cu literal zecimal", "packages/core/src/a.ts", `const total = quantity * 1.5;`],
    ["împărțire cu 1e4", "packages/core/src/a.ts", `const units = quantity / 1e4;`],
    ["toFixed în cod de stoc", "packages/core/src/inventory/a.ts", `label = total.toFixed(2);`],
    ["Math.round în cod de stoc", "packages/core/src/inventory/a.ts", `const r = Math.round(x);`],
    ["Number în cod de stoc", "packages/core/src/inventory/a.ts", `const n = Number(x);`],
    ["fișier quantity*", "apps/web/src/lib/quantity-input.ts", `return parseFloat(text);`],
  ])("prinde: %s", (_name, path, code) => {
    expect(findQuantityViolations([file(path, code)])).toHaveLength(1);
  });

  it("nu se plânge de modul, comentarii, teste sau cod fără cantități", () => {
    const ok: SourceFile[] = [
      file(
        "packages/shared/src/quantity.ts",
        `export const QUANTITY_FACTOR = 10_000n;\nconst n = value * 10_000n;`,
      ),
      file(
        "packages/core/src/inventory/a.ts",
        `// nu folosi Number(quantity) sau parseFloat\n * Math.round(x) interzis`,
      ),
      file(
        "packages/core/src/inventory/a.test.ts",
        `const t = Number(quantity) * 1.5; const q = 10_000n;`,
      ),
      file("e2e/stock.spec.ts", `const n = parseFloat(quantity);`),
      file(
        "apps/web/src/lib/price.ts",
        `const p = Math.round(price * 1.21); const n = Number(total);`,
      ),
      file(
        "packages/core/src/catalog/a.ts",
        `const reservedWord = Number(x); // nume asemănător fără cantitate`,
      ),
      file("packages/core/src/a.ts", `const q = parseQuantity(text); const s = stepsIn(q, step);`),
    ];
    expect(findQuantityViolations(ok)).toEqual([]);
  });
});

describe("cantități exacte: schema (regula 4)", () => {
  const model = (fields: string) => `model Stoc {\n  id String @id\n${fields}\n}\n`;

  it.each([
    ["Float", `  quantity Float`],
    ["Decimal", `  stockQty Decimal`],
    ["physical Int", `  physical Int`],
    ["committed Float", `  committed Float @default(0)`],
    ["reserved Int?", `  reserved Int?`],
    ["quantity Int", `  quantity Int`],
    ["delta Float", `  deltaPhysical Float`],
  ])("prinde: %s", (_name, field) => {
    expect(findSchemaViolations(model(field)).length).toBeGreaterThan(0);
  });

  it("acceptă BigInt și câmpuri fără legătură", () => {
    const ok = model(
      [
        `  physical BigInt @default(0)`,
        `  quantity BigInt`,
        `  deltaPhysical BigInt @default(0)`,
        `  physicalAsOf DateTime?`,
        `  price Int`,
        `  numberValue Decimal?`,
        `  // quantity Float este doar un comentariu`,
      ].join("\n"),
    );
    expect(findSchemaViolations(ok)).toEqual([]);
  });
});

describe("cantități exacte: sursa reală", () => {
  const files = realFiles();

  it("scanează sursa reală, nu un set gol", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => f.path === QUANTITY_MODULE)).toBe(true);
    expect(files.some((f) => f.path === "packages/core/src/inventory/constants.ts")).toBe(true);
  });

  it("nicio cantitate ca număr zecimal în codul de producție", () => {
    expect(findQuantityViolations(files)).toEqual([]);
  });

  it("schema Prisma: cantitățile sunt BigInt, niciun Float/Decimal de cantitate", () => {
    const schema = readFileSync(join(root, "packages/db/prisma/schema.prisma"), "utf8");
    expect(schema).toContain("model InventoryItem");
    expect(findSchemaViolations(schema)).toEqual([]);
  });
});

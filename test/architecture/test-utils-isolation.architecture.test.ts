import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Codul de test (`test-utils/`: fixture-uri care șterg date, inclusiv registre imuabile) nu are voie să ajungă în
 * aplicație, în pachetul distribuit sau în build-ul de producție. Garanția e dublă:
 *  1. NIMENI în afara testelor nu importă `test-utils`; singura excepție sunt scripturile de dezvoltare
 *     `packages/<pachet>/scripts/dev-<nume>.ts` (rulate manual, pe baza de test), pe care Faza 21 le scoate din pachet;
 *  2. punctele de intrare ale pachetelor (`index.ts`) nu îl reexportă, deci nu e atins de nicio cale de import din
 *     `apps/web` (Next împachetează doar ce se importă).
 */
const root = fileURLToPath(new URL("../../", import.meta.url));

export interface SourceFile {
  path: string;
  content: string;
}

const isTestFile = (path: string): boolean => /\.(test|spec)\.[cm]?tsx?$/.test(path);
const isTestUtilsFile = (path: string): boolean => /(^|\/)test-utils\//.test(path);
const isDevScript = (path: string): boolean =>
  /^packages\/[\w-]+\/scripts\/dev-[\w-]+\.ts$/.test(path);
const isTestTree = (path: string): boolean => path.startsWith("test/") || path.startsWith("e2e/");

/** Importuri statice, dinamice, reexporturi și `require` care duc într-un director `test-utils`. */
const TEST_UTILS_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'][^"']*\btest-utils\b[^"']*["']/;

export function findTestUtilsLeaks(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const path = file.path;
    if (isTestFile(path) || isTestUtilsFile(path) || isDevScript(path) || isTestTree(path))
      continue;
    file.content.split("\n").forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (TEST_UTILS_IMPORT.test(line)) {
        problems.push(
          `${path}:${index + 1}: importă test-utils din cod care poate ajunge în pachet (permis doar în teste și în scripturile dev-*.ts)`,
        );
      }
    });
  }
  return problems;
}

/**
 * `packages/core/test/e2e-support.ts` oprește TEMPORAR triggerul de imuabilitate al registrului de mișcări (excepția
 * aprobată din `append-only.test.ts`): nu intră în pachet sau build. Îl pot importa doar testele, `e2e/`, `test/` și
 * directoarele `packages/<pachet>/test/` (unde stă el).
 */
const E2E_SUPPORT_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'][^"']*\be2e-support\b[^"']*["']/;
const isPackageTestDir = (path: string): boolean => /^packages\/[\w-]+\/test\//.test(path);

export function findE2eSupportLeaks(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const path = file.path;
    if (isTestFile(path) || isTestTree(path) || isPackageTestDir(path)) continue;
    file.content.split("\n").forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (E2E_SUPPORT_IMPORT.test(line)) {
        problems.push(
          `${path}:${index + 1}: importă e2e-support din cod care poate ajunge în pachet (permis doar în teste, e2e/, test/ și packages/*/test/)`,
        );
      }
    });
  }
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
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.[cm]?[jt]sx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function sourceFiles(): SourceFile[] {
  return ["apps", "packages", "scripts"]
    .flatMap((dir) => walk(join(root, dir)))
    .map((full) => ({
      path: relative(root, full).replaceAll("\\", "/"),
      content: readFileSync(full, "utf8"),
    }));
}

describe("test-utils nu ajunge în aplicație, pachet sau build", () => {
  it("nicio sursă în afara testelor și a scripturilor dev-*.ts nu importă test-utils", () => {
    const files = sourceFiles();
    expect(files.some((f) => isTestUtilsFile(f.path))).toBe(true);
    expect(files.length).toBeGreaterThan(200);
    expect(findTestUtilsLeaks(files)).toEqual([]);
  });

  it("punctele de intrare ale pachetelor și aplicația nu reexportă test-utils", () => {
    const entries = sourceFiles().filter(
      (f) =>
        /^packages\/[\w-]+\/src\/index\.[cm]?ts$/.test(f.path) || f.path.startsWith("apps/web/"),
    );
    expect(entries.length).toBeGreaterThan(50);
    for (const entry of entries) {
      if (isTestFile(entry.path)) continue;
      expect(entry.content, entry.path).not.toMatch(TEST_UTILS_IMPORT);
    }
  });

  it("detectorul prinde importurile interzise și lasă testele și scripturile dev-*.ts", () => {
    const leak = (path: string, content: string) => findTestUtilsLeaks([{ path, content }]);
    const bad = [
      `import { x } from "../test-utils/stock-fixtures";`,
      `export * from "./test-utils/stock-fixtures";`,
      `const m = await import("../test-utils/rollback");`,
      `const m = require("../../test-utils/fraction");`,
      `import "./test-utils/setup";`,
    ];
    for (const line of bad) {
      expect(leak("packages/core/src/inventory/index.ts", line), line).toHaveLength(1);
      expect(leak("apps/web/src/app/page.tsx", line), line).toHaveLength(1);
      expect(leak("packages/core/scripts/seed.ts", line), line).toHaveLength(1);
    }
    const line = bad[0] as string;
    expect(leak("packages/core/src/inventory/stock-service.integration.test.ts", line)).toEqual([]);
    expect(leak("packages/core/src/test-utils/stock-fixtures.ts", line)).toEqual([]);
    expect(leak("packages/core/scripts/dev-stock-race.ts", line)).toEqual([]);
    expect(leak("test/support/x.ts", line)).toEqual([]);
    // un comentariu sau un text care doar numește test-utils nu e import
    expect(leak("packages/core/src/a.ts", `// vezi test-utils/stock-fixtures`)).toEqual([]);
    expect(leak("packages/core/src/a.ts", `const nume = "test-utils";`)).toEqual([]);
  });

  it("nicio sursă în afara testelor nu importă e2e-support (el oprește triggerul registrului: nu intră în pachet sau build)", () => {
    expect(findE2eSupportLeaks(sourceFiles())).toEqual([]);
  });

  it("detectorul pentru e2e-support: prinde importurile din aplicație și pachete, lasă testele, e2e/ și test/", () => {
    const line = `import { removeE2eStock } from "../../test/e2e-support";`;
    const leak = (path: string, content = line) => findE2eSupportLeaks([{ path, content }]);
    for (const path of [
      "apps/web/src/lib/x.ts",
      "packages/core/src/inventory/index.ts",
      "packages/jobs/scripts/stock-jobs.ts",
      "packages/core/scripts/seed.ts",
    ]) {
      expect(leak(path), path).toHaveLength(1);
    }
    expect(leak("packages/core/src/index.ts", `export * from "../test/e2e-support";`)).toHaveLength(
      1,
    );
    expect(
      leak("packages/core/src/a.ts", `const m = await import("../test/e2e-support");`),
    ).toHaveLength(1);
    for (const path of [
      "e2e/stock.spec.ts",
      "test/support/x.ts",
      "packages/core/test/e2e-support-stock.integration.test.ts",
      "packages/core/src/a.test.ts",
      "packages/core/test/alt-ajutor.ts",
    ]) {
      expect(leak(path), path).toEqual([]);
    }
    expect(leak("packages/core/src/a.ts", `// vezi test/e2e-support`)).toEqual([]);
    expect(leak("packages/core/src/a.ts", `const nume = "e2e-support";`)).toEqual([]);
  });
});

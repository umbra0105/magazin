import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură: parserul de registre de calcul (SheetJS `xlsx` 0.20.3) intră în proiect într-un singur fel și se
 * folosește într-un singur loc.
 *
 *  1. ARHIVA: `vendor/xlsx-0.20.3.tgz` este copiată în repo (nicio descărcare la instalare), iar SHA-256 al ei este cel
 *     fixat aici ȘI cel din `vendor/xlsx-0.20.3.tgz.sha256`; lockfile-ul poartă SHA-512 al aceleiași arhive. Dacă cineva
 *     schimbă arhiva (sau lockfile-ul), testul pică.
 *  2. DECLARAȚIA: doar `packages/integrations/package.json` declară `xlsx`, cu `file:../../vendor/xlsx-0.20.3.tgz`
 *     (niciodată o versiune din npm, unde `xlsx` e 0.18.5, veche și cu vulnerabilități cunoscute); nicio altă bibliotecă
 *     SheetJS (`@e965/xlsx`, `xlsx-js-style`, `node-xlsx`, `sheetjs-style`) nu e declarată.
 *  3. FOLOSIREA: `xlsx` se importă doar în adaptorul `stock-report-reader.ts` (testele și `test-utils/` fabrică fișiere
 *     cu el), iar adaptorul păstrează restricțiile aprobate: fără formule, fără stiluri, doar prima foaie, fără citire de
 *     fișiere după cale, cu număr limitat de rânduri.
 *
 * `findXlsxImportViolations`, `findManifestViolations` și `findReaderViolations` sunt pure și testate pe cazuri sintetice,
 * ca testul să nu poată trece «în gol».
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

export interface SourceFile {
  path: string;
  content: string;
}

const ARCHIVE = "vendor/xlsx-0.20.3.tgz";
const ARCHIVE_SHA256 = "8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8";
const ARCHIVE_SHA512 =
  "sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==";
const DEPENDENCY_SPEC = "file:../../vendor/xlsx-0.20.3.tgz";
const READER = "packages/integrations/src/spreadsheet/stock-report-reader.ts";
const OWNER_MANIFEST = "packages/integrations/package.json";
const FORBIDDEN_PACKAGES = ["@e965/xlsx", "xlsx-js-style", "node-xlsx", "sheetjs-style"];

const isTestPath = (path: string): boolean =>
  /\.(test|spec)\.[cm]?tsx?$/.test(path) ||
  path.startsWith("e2e/") ||
  path.startsWith("test/") ||
  /(^|\/)test-utils\//.test(path);

const XLSX_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']xlsx(?:\/[^"']*)?["']/;

const stripComments = (content: string): string =>
  content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

export function findXlsxImportViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file.path) || isTestPath(file.path) || file.path === READER)
      continue;
    if (XLSX_IMPORT.test(stripComments(file.content))) {
      problems.push(`${file.path}: importă xlsx; parserul se folosește doar în ${READER}`);
    }
  }
  return problems;
}

export interface Manifest {
  path: string;
  json: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
}

export function findManifestViolations(manifests: readonly Manifest[]): string[] {
  const problems: string[] = [];
  for (const { path, json } of manifests) {
    for (const section of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ] as const) {
      for (const [name, spec] of Object.entries(json[section] ?? {})) {
        if (FORBIDDEN_PACKAGES.includes(name)) {
          problems.push(
            `${path}: ${section}.${name}; ${name} nu e aprobat (doar SheetJS din vendor/)`,
          );
        }
        if (name === "xlsx") {
          if (path !== OWNER_MANIFEST) {
            problems.push(`${path}: ${section}.xlsx; doar ${OWNER_MANIFEST} îl declară`);
          } else if (section !== "dependencies" || spec !== DEPENDENCY_SPEC) {
            problems.push(
              `${path}: xlsx trebuie să fie în dependencies cu "${DEPENDENCY_SPEC}" (găsit "${spec}")`,
            );
          }
        }
      }
    }
  }
  return problems;
}

/** Restricțiile aprobate ale adaptorului (scrise în codul lui; orice abatere pică). */
export function findReaderViolations(reader: SourceFile): string[] {
  const code = stripComments(reader.content);
  const problems: string[] = [];
  const required: Array<[RegExp, string]> = [
    [/cellFormula:\s*false/, "cellFormula: false (formulele nu se citesc)"],
    [/cellStyles:\s*false/, "cellStyles: false (stilurile nu se citesc)"],
    [/sheets:\s*0\b/, "sheets: 0 (doar prima foaie)"],
    [/sheetRows:/, "sheetRows (număr limitat de rânduri)"],
    [/STOCK_REPORT_MAX_BYTES/, "limita de mărime a fișierului"],
    [/await import\(\s*["']xlsx["']\s*\)/, 'import dinamic al parserului: await import("xlsx")'],
  ];
  for (const [pattern, label] of required) {
    if (!pattern.test(code)) problems.push(`${reader.path}: lipsește ${label}`);
  }
  const forbidden: Array<[RegExp, string]> = [
    [/cellFormula:\s*true/, "cellFormula: true"],
    [/cellStyles:\s*true/, "cellStyles: true"],
    [/\bbookVBA:\s*true/, "bookVBA: true"],
    [/\.readFile\s*\(/, "readFile (parserul primește doar octeți, nu căi)"],
    [/\.writeFile\s*\(/, "writeFile"],
    [/\bset_fs\b/, "set_fs"],
    [/\bfrom\s*["']node:fs/, "import node:fs"],
    [/\bfetch\s*\(/, "fetch"],
    [/\bpassword\s*:/, "opțiunea password"],
  ];
  for (const [pattern, label] of forbidden) {
    if (pattern.test(code)) problems.push(`${reader.path}: ${label} nu e permis`);
  }
  return problems;
}

const SKIP_DIRS = new Set([
  "node_modules",
  "generated",
  ".next",
  ".turbo",
  "dist",
  "coverage",
  "vendor",
]);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".next")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
}

const posix = (full: string): string => relative(root, full).split(sep).join("/");

function loadFiles(): SourceFile[] {
  const dirs = [join(root, "apps"), join(root, "packages"), join(root, "scripts")];
  const paths: string[] = [];
  for (const dir of dirs) walk(dir, paths);
  return paths
    .filter((full) => /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(full))
    .map((full) => ({ path: posix(full), content: readFileSync(full, "utf8") }));
}

function loadManifests(): Manifest[] {
  const paths: string[] = [join(root, "package.json")];
  for (const base of ["apps", "packages"]) {
    for (const name of readdirSync(join(root, base))) {
      const file = join(root, base, name, "package.json");
      try {
        if (statSync(file).isFile()) paths.push(file);
      } catch {
        // director fără package.json
      }
    }
  }
  return paths.map((full) => ({
    path: posix(full),
    json: JSON.parse(readFileSync(full, "utf8")) as Manifest["json"],
  }));
}

describe("SheetJS: arhiva din vendor/ (sursa reală)", () => {
  const archive = readFileSync(join(root, ARCHIVE));

  it("SHA-256 al arhivei este cel fixat în test și cel din fișierul .sha256", () => {
    const digest = createHash("sha256").update(archive).digest("hex");
    expect(digest).toBe(ARCHIVE_SHA256);
    const recorded = readFileSync(join(root, `${ARCHIVE}.sha256`), "utf8")
      .trim()
      .split(/\s+/)[0];
    expect(recorded).toBe(ARCHIVE_SHA256);
  });

  it("lockfile-ul poartă SHA-512 al aceleiași arhive și o leagă de fișierul din vendor/", () => {
    const digest = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    expect(digest).toBe(ARCHIVE_SHA512);
    const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    const entry = /^ {2}xlsx@file:vendor\/xlsx-0\.20\.3\.tgz:\n {4}resolution: \{([^}]*)\}/m.exec(
      lock,
    );
    expect(entry, "intrarea xlsx din pnpm-lock.yaml").not.toBeNull();
    expect(entry?.[1]).toContain(`integrity: ${ARCHIVE_SHA512}`);
    expect(entry?.[1]).toContain("tarball: file:vendor/xlsx-0.20.3.tgz");
    expect(lock).not.toMatch(/^ {2}xlsx@0\./m);
  });

  it("licența Apache-2.0 a arhivei este în THIRD-PARTY-NOTICES.md", () => {
    const notices = readFileSync(join(root, "THIRD-PARTY-NOTICES.md"), "utf8");
    expect(notices).toMatch(/SheetJS/);
    expect(notices).toMatch(/Apache-2\.0/);
    expect(notices).toMatch(/xlsx@0\.20\.3/);
  });
});

describe("SheetJS: declarația și folosirea (sursa reală)", () => {
  it("scanează codul real (nu trece în gol)", () => {
    const files = loadFiles();
    expect(files.length).toBeGreaterThan(300);
    const reader = files.find((f) => f.path === READER);
    expect(reader).toBeDefined();
    expect(reader?.content).toMatch(/await import\("xlsx"\)/);
    expect(loadManifests().some((m) => m.path === OWNER_MANIFEST)).toBe(true);
  });

  it("xlsx se importă doar în adaptor", () => {
    expect(findXlsxImportViolations(loadFiles())).toEqual([]);
  });

  it("doar pachetul integrations declară xlsx, din vendor/", () => {
    expect(findManifestViolations(loadManifests())).toEqual([]);
  });

  it("adaptorul păstrează restricțiile aprobate", () => {
    const reader = loadFiles().find((f) => f.path === READER);
    expect(reader).toBeDefined();
    expect(findReaderViolations(reader as SourceFile)).toEqual([]);
  });
});

describe("pe fișiere sintetice (testul pică când trebuie)", () => {
  it("prinde importul parserului în afara adaptorului, în toate formele", () => {
    const forms = [
      `import * as XLSX from "xlsx";`,
      `import { read } from 'xlsx';`,
      `import "xlsx";`,
      `const x = await import("xlsx");`,
      `const x = require("xlsx");`,
      `import { read } from "xlsx/xlsx.mjs";`,
    ];
    for (const content of forms) {
      expect(
        findXlsxImportViolations([{ path: "packages/core/src/catalog/import/x.ts", content }]),
        content,
      ).toHaveLength(1);
    }
  });

  it("nu semnalează adaptorul, testele, test-utils și comentariile", () => {
    const content = `import * as XLSX from "xlsx";`;
    expect(findXlsxImportViolations([{ path: READER, content }])).toEqual([]);
    expect(
      findXlsxImportViolations([
        { path: "packages/integrations/src/spreadsheet/x.test.ts", content },
      ]),
    ).toEqual([]);
    expect(
      findXlsxImportViolations([
        { path: "packages/integrations/src/spreadsheet/test-utils/x.ts", content },
      ]),
    ).toEqual([]);
    expect(
      findXlsxImportViolations([
        {
          path: "packages/core/src/a.ts",
          content: `// import * as XLSX from "xlsx";\n/* require("xlsx") */`,
        },
      ]),
    ).toEqual([]);
    expect(
      findXlsxImportViolations([
        { path: "packages/core/src/a.ts", content: `import x from "xlsx-extra-lib";` },
      ]),
    ).toEqual([]);
  });

  it("prinde declarații greșite ale parserului", () => {
    const manifest = (path: string, dependencies: Record<string, string>): Manifest => ({
      path,
      json: { dependencies },
    });
    expect(findManifestViolations([manifest(OWNER_MANIFEST, { xlsx: DEPENDENCY_SPEC })])).toEqual(
      [],
    );
    expect(findManifestViolations([manifest(OWNER_MANIFEST, { xlsx: "0.18.5" })])).toHaveLength(1);
    expect(findManifestViolations([manifest(OWNER_MANIFEST, { xlsx: "^0.20.3" })])).toHaveLength(1);
    expect(
      findManifestViolations([manifest("packages/core/package.json", { xlsx: DEPENDENCY_SPEC })]),
    ).toHaveLength(1);
    expect(
      findManifestViolations([manifest("apps/web/package.json", { "@e965/xlsx": "0.20.3" })]),
    ).toHaveLength(1);
    expect(
      findManifestViolations([manifest("package.json", { "xlsx-js-style": "1.2.0" })]),
    ).toHaveLength(1);
    expect(
      findManifestViolations([
        { path: OWNER_MANIFEST, json: { devDependencies: { xlsx: DEPENDENCY_SPEC } } },
      ]),
    ).toHaveLength(1);
  });

  it("prinde abaterile adaptorului de la restricțiile aprobate", () => {
    const good = [
      "cellFormula: false,",
      "cellStyles: false,",
      "sheets: 0,",
      "sheetRows: 10,",
      "const limit = STOCK_REPORT_MAX_BYTES;",
      'const X = await import("xlsx");',
    ].join("\n");
    expect(findReaderViolations({ path: READER, content: good })).toEqual([]);
    for (const [from, to] of [
      ["cellFormula: false", "cellFormula: true"],
      ["cellStyles: false", "cellStyles: true"],
      ["sheets: 0,", ""],
      ["sheetRows: 10,", ""],
      ["STOCK_REPORT_MAX_BYTES", "ALTCEVA"],
      ['await import("xlsx")', 'await import("alt")'],
    ] as const) {
      expect(
        findReaderViolations({ path: READER, content: good.replace(from, to) }),
        from,
      ).not.toEqual([]);
    }
    for (const extra of [
      "XLSX.readFile(path);",
      "XLSX.set_fs(fs);",
      'import { readFileSync } from "node:fs";',
      "await fetch(url);",
      "password: secret,",
    ]) {
      expect(
        findReaderViolations({ path: READER, content: `${good}\n${extra}` }),
        extra,
      ).not.toEqual([]);
    }
  });
});

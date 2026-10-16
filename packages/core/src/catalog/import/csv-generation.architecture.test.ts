import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură: orice CSV generat de aplicație (șablon, raport, export) trece prin funcția comună
 * din `import-csv.ts` (`toCsv` / `csvResponse`), care pune BOM UTF-8 și prima linie «sep=;» (altfel Excel
 * pe un calculator cu separatorul de listă «,» lipește coloanele). Pică dacă un alt fișier de producție:
 *  - declară tipul MIME `text/csv` ca valoare (singurul loc e `import-csv.ts`);
 *  - folosește `csvCell` (funcția internă de scriere a unei celule);
 *  - scrie «sep=» (prefixul se pune doar în funcția comună; importul îl CITEȘTE în `import-file.ts`);
 *  - trimite un fișier `.csv` ca atașament (`Content-Disposition` + un nume `.csv` între ghilimele)
 *    fără funcția comună.
 *
 * Citește sursa ca text; `findCsvViolations` e pură și testată pe fișiere sintetice.
 */

const root = fileURLToPath(new URL("../../../../../", import.meta.url));

export interface SourceFile {
  path: string;
  content: string;
}

const COMMON = "packages/core/src/catalog/import/import-csv.ts";

/** Fișiere care pot scrie «sep=»: parserul, care îl citește din fișierele încărcate. */
const SEP_EXCEPTIONS: Readonly<Record<string, string>> = {
  "packages/core/src/catalog/import/import-file.ts":
    "parserul recunoaște linia «sep=» a fișierelor încărcate",
};

const isTest = (path: string): boolean =>
  /\.(test|spec)\.(ts|tsx)$/.test(path) || path.includes("/test/") || path.includes("/scripts/");

/** Un literal-valoare «text/csv…» (nu o frază din interfață, nici lista `accept` a unui câmp de încărcare). */
const MIME_LITERAL = /["'`]text\/csv(?:;[^"'`]*)?["'`]/i;
/** Un nume de fișier `.csv` între ghilimele. */
const CSV_FILE_NAME = /["'`][^"'`\n]*\.csv\b[^"'`\n]*["'`]/i;

export function findCsvViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (isTest(file.path) || file.path === COMMON) continue;
    const { path } = file;
    const content = file.content.replace(/\/\/.*$/gm, "");
    if (MIME_LITERAL.test(content)) {
      problems.push(
        `${path}: declară text/csv; CSV-urile se generează doar cu funcția comună din import-csv.ts`,
      );
    }
    if (/\bcsvCell\b/.test(content)) {
      problems.push(
        `${path}: folosește csvCell; scrie CSV-ul cu toCsv/csvResponse din import-csv.ts`,
      );
    }
    if (/["'`]sep=/i.test(content) && !Object.hasOwn(SEP_EXCEPTIONS, path)) {
      problems.push(
        `${path}: scrie linia «sep=» de mână; o pune doar funcția comună din import-csv.ts`,
      );
    }
    if (/Content-Disposition/i.test(content) && CSV_FILE_NAME.test(content)) {
      problems.push(
        `${path}: trimite un fișier .csv ca atașament fără funcția comună (csvResponse)`,
      );
    }
  }
  return problems;
}

const SKIP_DIRS = new Set(["node_modules", "generated", ".next", ".turbo", "dist", "coverage"]);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".next")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(full);
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

describe("CSV-urile generate trec prin funcția comună (sursa reală)", () => {
  const files = loadSource();

  it("scanează codul real (nu trece în gol) și funcția comună pune BOM și «sep=;»", () => {
    expect(files.length).toBeGreaterThan(100);
    const common = files.find((f) => f.path === COMMON);
    expect(common).toBeDefined();
    const content = common?.content ?? "";
    expect(content).toMatch(/0xfeff/i);
    expect(content).toMatch(/sep=\$\{DELIMITER\}/);
    expect(content).toMatch(/export function toCsv/);
    expect(content).toMatch(/export function csvResponse/);
    // excepțiile există (altfel lista s-ar învechi în tăcere)
    const paths = new Set(files.map((f) => f.path));
    for (const path of Object.keys(SEP_EXCEPTIONS)) expect(paths.has(path), path).toBe(true);
  });

  it("niciun fișier de producție nu generează CSV pe lângă funcția comună", () => {
    expect(findCsvViolations(files)).toEqual([]);
  });

  it("toate generatoarele CSV existente apelează funcția comună (lista se actualizează deliberat)", () => {
    const callsCommon = /\b(csvResponse|toCsv)\(/;
    const users = files.filter(
      (f) => callsCommon.test(f.content) && f.path !== COMMON && !isTest(f.path),
    );
    expect(users.map((f) => f.path).sort()).toEqual(
      [
        "packages/core/src/catalog/import/import-handler.ts",
        "packages/core/src/catalog/import/import-template.ts",
      ].sort(),
    );
  });
});

describe("findCsvViolations pe fișiere sintetice (testul pică când trebuie)", () => {
  const handCsv = `export async function GET() {
  const rows = [["a", "b"]];
  return new Response(rows.map((r) => r.join(";")).join("\\n"), {
    headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="export.csv"' },
  });
}`;

  it("prinde un generator care ocolește funcția comună (MIME + atașament .csv)", () => {
    const problems = findCsvViolations([
      { path: "apps/web/src/app/api/admin/export/route.ts", content: handCsv },
    ]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("text/csv");
    expect(problems[1]).toContain("atașament");
  });

  it("prinde csvCell folosit în afara modulului comun și un «sep=» scris de mână", () => {
    const problems = findCsvViolations([
      {
        path: "packages/core/src/x/a.ts",
        content: `import { csvCell } from "../import-csv"; csvCell("a");`,
      },
      { path: "packages/core/src/x/b.ts", content: "const head = `sep=;\\r\\n`;" },
    ]);
    expect(problems.map((p) => p.split(":")[0])).toEqual([
      "packages/core/src/x/a.ts",
      "packages/core/src/x/b.ts",
    ]);
  });

  it("nu dă fals pozitive: modulul comun, parserul, lista accept, o frază din interfață, testele, un atașament XLSX", () => {
    expect(
      findCsvViolations([
        { path: COMMON, content: handCsv },
        {
          path: "packages/core/src/catalog/import/import-file.ts",
          content: 'const re = /^sep=(.)/; const x = "sep=";',
        },
        {
          path: "apps/web/src/components/admin/products/product-import-wizard.tsx",
          content: 'accept=".csv,text/csv" // text/csv',
        },
        { path: "apps/web/src/messages/ro.ts", content: 'help: "Date → Din text/CSV și alege ;"' },
        { path: "packages/core/src/catalog/import/x.test.ts", content: handCsv },
        {
          path: "packages/core/src/catalog/import/import-handler.ts",
          content:
            'const name = TEMPLATE_FILE_NAMES.csv; headers["Content-Disposition"] = `attachment; filename="sablon.xlsx"`;',
        },
      ]),
    ).toEqual([]);
  });
});

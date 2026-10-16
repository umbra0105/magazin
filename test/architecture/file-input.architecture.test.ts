import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură: niciun `<input type="file">` direct în aplicație. Câmpul nativ afișează «Choose
 * File / No file chosen» în limba browserului (nu în română) și e greu de distins pe fundal alb; singurul
 * loc care îl randează e componenta comună `FileInput` din `@ecom/ui`, care păstrează câmpul real
 * (accesibil, trimis în formulare), dar cu buton și texte în română. Pică dacă apare în altă parte
 * (JSX, obiect `type: "file"`, `createElement`, `.type = "file"`).
 *
 * Citește sursa ca text; `findFileInputViolations` e pură și testată pe fișiere sintetice.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

export interface SourceFile {
  path: string;
  content: string;
}

const COMPONENT = "packages/ui/src/components/file-input.tsx";

const FILE_TYPE = [
  /\btype\s*=\s*["'`]file["'`]/, // JSX / HTML: type="file"
  /\btype\s*=\s*\{\s*["'`]file["'`]\s*\}/, // JSX: type={"file"}
  /\btype\s*:\s*["'`]file["'`]/, // obiect de props: { type: "file" }
  /\.type\s*=\s*["'`]file["'`]/, // DOM: input.type = "file"
  /setAttribute\(\s*["'`]type["'`]\s*,\s*["'`]file["'`]/, // DOM: setAttribute("type", "file")
];

const isTest = (path: string): boolean =>
  /\.(test|spec)\.(ts|tsx)$/.test(path) || path.includes("/test/") || path.startsWith("e2e/");

export function findFileInputViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (file.path === COMPONENT || isTest(file.path)) continue;
    // comentariile pot numi tipul (documentație), codul nu
    const code = file.content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    if (FILE_TYPE.some((pattern) => pattern.test(code))) {
      problems.push(`${file.path}: <input type="file"> direct; folosește FileInput din @ecom/ui`);
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
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) out.push(full);
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

describe('niciun <input type="file"> direct (sursa reală)', () => {
  const files = loadSource();

  it("scanează codul real (nu trece în gol); componenta comună există și randează câmpul real", () => {
    expect(files.length).toBeGreaterThan(100);
    const component = files.find((f) => f.path === COMPONENT);
    expect(component).toBeDefined();
    expect(component?.content).toMatch(/type="file"/);
    expect(component?.content).toMatch(/className="peer sr-only"/);
  });

  it("câmpurile de încărcare folosesc FileInput", () => {
    const users = files
      .filter((f) => /<FileInput\b/.test(f.content) && f.path !== COMPONENT)
      .map((f) => f.path)
      .sort();
    expect(users).toEqual([
      "apps/web/src/components/admin/media/upload-panel.tsx",
      "apps/web/src/components/admin/products/documents-tab.tsx",
      "apps/web/src/components/admin/products/product-import-wizard.tsx",
    ]);
  });

  it("nicio altă sursă nu randează un câmp de fișier nativ", () => {
    expect(findFileInputViolations(files)).toEqual([]);
  });
});

describe("findFileInputViolations pe fișiere sintetice (testul pică când trebuie)", () => {
  it("prinde toate formele de câmp de fișier direct", () => {
    const forms = [
      `<input type="file" />`,
      `<input type='file' accept=".csv" />`,
      `<input type={"file"} />`,
      `const props = { type: "file" };`,
      `el.type = "file";`,
      `el.setAttribute("type", "file");`,
      `<Input type="file" />`,
    ];
    for (const content of forms) {
      expect(
        findFileInputViolations([{ path: "apps/web/src/components/x.tsx", content }]),
        content,
      ).toHaveLength(1);
    }
  });

  it("nu dă fals pozitive: componenta comună, testele, comentariile, alte tipuri de input", () => {
    expect(
      findFileInputViolations([
        { path: COMPONENT, content: `<input type="file" />` },
        { path: "e2e/x.spec.ts", content: `page.locator('input[type="file"]')` },
        { path: "apps/web/src/a.test.tsx", content: `<input type="file" />` },
        {
          path: "apps/web/src/components/y.tsx",
          content: `// nu folosi <input type="file">\n/* type="file" */\n<input type="text" /><Input type="password" />`,
        },
      ]),
    ).toEqual([]);
  });
});

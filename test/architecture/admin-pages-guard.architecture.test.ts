import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură: fiecare pagină din zona de administrare își verifică ea însăși accesul. Layout-urile nu
 * se re-rulează la navigarea în aplicație, iar pagina și layout-ul se randează în paralel, deci o pagină nu se
 * poate baza pe layout (vezi `requireAdmin`). Pică dacă o pagină din `(admin)` nu cheamă `requireAdmin(`.
 *
 * Paginile zonei de import (`produse/import/**`, inclusiv istoricul importurilor și detaliile lor) cer în plus
 * permisiunea `products.write`, aceeași ca importul: istoricul arată fișiere, utilizatori și rapoarte.
 *
 * Citește sursa ca text; `findPageGuardViolations` e pură și testată pe fișiere sintetice.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

export interface SourceFile {
  path: string;
  content: string;
}

const ADMIN_PAGES = /^apps\/web\/src\/app\/\(admin\)\/.*\/page\.tsx$/;
const IMPORT_AREA = "apps/web/src/app/(admin)/admin/produse/import/";

export function findPageGuardViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (!ADMIN_PAGES.test(file.path)) continue;
    // comentariile pot numi funcția (documentație), codul trebuie s-o cheme
    const code = file.content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    if (!/\brequireAdmin\s*\(/.test(code)) {
      problems.push(`${file.path}: pagină de admin fără requireAdmin(…)`);
      continue;
    }
    if (file.path.startsWith(IMPORT_AREA) && !/permission:\s*["']products\.write["']/.test(code)) {
      problems.push(
        `${file.path}: pagina zonei de import trebuie să ceară requireAdmin({ permission: "products.write" })`,
      );
    }
  }
  return problems;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".next")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name === "page.tsx") out.push(full);
  }
}

function loadPages(): SourceFile[] {
  const paths: string[] = [];
  walk(join(root, "apps", "web", "src", "app", "(admin)"), paths);
  return paths.map((full) => ({
    path: relative(root, full).split(sep).join("/"),
    content: readFileSync(full, "utf8"),
  }));
}

describe("paginile de admin își verifică accesul (sursa reală)", () => {
  const pages = loadPages();

  it("scanează paginile reale (nu trece în gol), inclusiv istoricul importurilor și detaliile lui", () => {
    expect(pages.length).toBeGreaterThan(10);
    const paths = pages.map((p) => p.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "apps/web/src/app/(admin)/admin/produse/import/page.tsx",
        "apps/web/src/app/(admin)/admin/produse/import/istoric/page.tsx",
        "apps/web/src/app/(admin)/admin/produse/import/istoric/[id]/page.tsx",
      ]),
    );
  });

  it("nicio pagină nu lipsește de requireAdmin; zona de import cere products.write", () => {
    expect(findPageGuardViolations(pages)).toEqual([]);
  });
});

describe("findPageGuardViolations pe fișiere sintetice (testul pică când trebuie)", () => {
  const page = (path: string, content: string): SourceFile => ({
    path: `apps/web/src/app/(admin)/admin/${path}/page.tsx`,
    content,
  });

  it("prinde o pagină de istoric fără nicio verificare de acces", () => {
    expect(
      findPageGuardViolations([
        page("produse/import/istoric", "export default async function P() { return null; }"),
      ]),
    ).toEqual([expect.stringContaining("fără requireAdmin")]);
  });

  it("prinde o pagină de import care verifică doar accesul în admin, nu products.write", () => {
    expect(
      findPageGuardViolations([
        page("produse/import/istoric", "await requireAdmin();\nexport default function P() {}"),
        page("produse/import/istoric/[id]", 'await requireAdmin({ permission: "products.read" });'),
      ]),
    ).toHaveLength(2);
  });

  it("acceptă paginile corecte; un comentariu cu numele funcției nu ține loc de apel", () => {
    expect(
      findPageGuardViolations([
        page("produse/import/istoric", 'await requireAdmin({ permission: "products.write" });'),
        page("categorii", 'await requireAdmin({ permission: "products.read" });'),
        page("media", "await requireAdmin();"),
        // un comentariu care numește funcția nu ține loc de apel
        page(
          "produse/import/x",
          '// requireAdmin({ permission: "products.write" })\nexport default () => null;',
        ),
      ]),
    ).toEqual([
      expect.stringContaining("produse/import/x/page.tsx: pagină de admin fără requireAdmin"),
    ]);
  });
});

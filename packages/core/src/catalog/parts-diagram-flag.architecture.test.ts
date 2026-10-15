import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură pentru flag-ul `partsDiagrams` (regula „isEnabled ascunde meniul, ruta ȘI codul”):
 *  1. orice pagină din `fise-explodate/` cere flag-ul în `requireAdmin` (flag oprit = 404);
 *  2. intrarea din meniu declară `feature: "partsDiagrams"`;
 *  3. fișele se ating DOAR prin `PartsDiagramService`, care verifică flag-ul la fiecare operație:
 *     nicio altă sursă nu folosește direct delegatele Prisma ale fișelor (excepții: serviciul/store-ul
 *     lui, providerul de utilizare media, care e doar citire și trebuie să rămână activ ca o imagine
 *     folosită să nu devină ștergibilă când flag-ul e oprit, și testele);
 *  4. tabul „Piese de schimb” din produs încarcă fișele doar în ramura `isEnabled("partsDiagrams")`.
 *
 * Citește sursa ca text; funcțiile de verificare sunt pure și testate pe fișiere sintetice.
 */

const root = fileURLToPath(new URL("../../../../", import.meta.url));

export interface SourceFile {
  path: string;
  content: string;
}

const PAGES_DIR = "apps/web/src/app/(admin)/admin/fise-explodate/";
const FEATURE_REQUIRED = /requireAdmin\(\s*\{[^}]*feature:\s*["']partsDiagrams["'][^}]*\}\s*\)/;
const PRISMA_DELEGATE = /\.\s*partsDiagram(?:Hotspot|Product)?\s*\./;

/** Fișiere care au voie să folosească direct delegatele Prisma ale fișelor. */
const DELEGATE_ALLOWED = new Set([
  "packages/core/src/catalog/parts-diagram-service.ts",
  // doar citire; trebuie să funcționeze și cu flag-ul oprit (protejează imaginea)
  "packages/core/src/catalog/media-usage.ts",
]);

const isTest = (path: string): boolean =>
  /\.(test|spec)\.(ts|tsx)$/.test(path) ||
  path.includes("/test/") ||
  path.includes("/scripts/") ||
  path.includes("/seed/");

export function findFlagViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (file.path.startsWith(PAGES_DIR) && /\/page\.tsx$/.test(file.path)) {
      if (!FEATURE_REQUIRED.test(file.content)) {
        problems.push(`${file.path}: pagina nu cere flag-ul partsDiagrams în requireAdmin`);
      }
    }
    if (
      PRISMA_DELEGATE.test(file.content) &&
      !DELEGATE_ALLOWED.has(file.path) &&
      !isTest(file.path) &&
      !file.path.startsWith("packages/db/")
    ) {
      problems.push(
        `${file.path}: folosește direct delegatele Prisma ale fișelor (doar PartsDiagramService, care verifică flag-ul)`,
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
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
}

function load(base: string): SourceFile[] {
  const paths: string[] = [];
  walk(join(root, base), paths);
  return paths.map((full) => ({
    path: relative(root, full).split(sep).join("/"),
    content: readFileSync(full, "utf8"),
  }));
}

describe("flag-ul partsDiagrams ascunde meniul, rutele și codul (sursa reală)", () => {
  const files = [...load("apps/web/src"), ...load("packages/core/src")];

  it("scanează paginile fișelor (nu trece în gol) și fiecare cere flag-ul", () => {
    const pages = files.filter((f) => f.path.startsWith(PAGES_DIR) && /\/page\.tsx$/.test(f.path));
    expect(pages.map((p) => p.path).sort()).toEqual(
      [`${PAGES_DIR}page.tsx`, `${PAGES_DIR}[id]/page.tsx`].sort(),
    );
    for (const page of pages) expect(FEATURE_REQUIRED.test(page.content), page.path).toBe(true);
  });

  it("intrarea din meniu declară flag-ul", () => {
    const nav = files.find((f) => f.path === "apps/web/src/lib/admin-nav.ts");
    expect(nav).toBeDefined();
    expect(nav?.content).toMatch(/id:\s*"partsDiagrams"[^}]*feature:\s*"partsDiagrams"/s);
  });

  it("tabul din produs încarcă fișele doar cu flag-ul pornit", () => {
    const page = files.find(
      (f) => f.path === "apps/web/src/app/(admin)/admin/produse/[id]/page.tsx",
    );
    expect(page).toBeDefined();
    const content = page?.content ?? "";
    const gate = content.indexOf('isEnabled("partsDiagrams")');
    const first = content.indexOf("getPartsDiagramService()");
    expect(gate).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(gate);
  });

  it("nicio sursă nu ocolește serviciul (singurul care verifică flag-ul)", () => {
    expect(findFlagViolations(files)).toEqual([]);
  });

  it("serviciul verifică flag-ul la fiecare metodă publică", () => {
    const service = files.find(
      (f) => f.path === "packages/core/src/catalog/parts-diagram-service.ts",
    );
    const content = service?.content ?? "";
    const klass = content.slice(content.indexOf("export class PartsDiagramService"));
    // metodele publice sunt `  async nume(` (cele private au `private` înainte)
    const found = [...klass.matchAll(/\n {2}async (\w+)\(/g)].map((m) => ({
      name: m[1] as string,
      index: m.index as number,
    }));
    expect(found.map((m) => m.name).sort()).toEqual(
      [
        "list",
        "get",
        "forProduct",
        "create",
        "update",
        "delete",
        "attachProduct",
        "detachProduct",
        "saveHotspot",
        "deleteHotspot",
      ].sort(),
    );
    found.forEach((method, i) => {
      const body = klass.slice(method.index, found[i + 1]?.index ?? klass.length);
      expect(body, `metoda ${method.name}`).toContain("await this.gate()");
    });
  });
});

describe("findFlagViolations pe fișiere sintetice (testul pică când trebuie)", () => {
  it("prinde o pagină din fise-explodate fără flag în requireAdmin", () => {
    const problems = findFlagViolations([
      {
        path: `${PAGES_DIR}noua/page.tsx`,
        content: `export default async function P() { await requireAdmin({ permission: "products.read" }); }`,
      },
    ]);
    expect(problems).toEqual([expect.stringContaining("nu cere flag-ul partsDiagrams")]);
  });

  it("prinde folosirea directă a delegatelor Prisma ale fișelor în afara serviciului", () => {
    const problems = findFlagViolations([
      {
        path: "apps/web/src/app/(admin)/admin/produse/proba/actions.ts",
        content: `export async function x() { return getDb().partsDiagramHotspot.findMany(); }`,
      },
      {
        path: "packages/core/src/catalog/altceva.ts",
        content: `const d = await db.partsDiagram.findMany();`,
      },
    ]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("delegatele Prisma");
  });

  it("nu dă fals pozitive: pagina corectă, serviciul, providerul media, testele", () => {
    expect(
      findFlagViolations([
        {
          path: `${PAGES_DIR}page.tsx`,
          content: `await requireAdmin({ permission: "products.read", feature: "partsDiagrams" });`,
        },
        {
          path: "packages/core/src/catalog/parts-diagram-service.ts",
          content: `db.partsDiagram.findMany(); db.partsDiagramHotspot.create();`,
        },
        { path: "packages/core/src/catalog/media-usage.ts", content: `db.partsDiagram.findMany()` },
        {
          path: "packages/core/src/catalog/x.integration.test.ts",
          content: `tx.partsDiagram.create()`,
        },
      ]),
    ).toEqual([]);
  });
});

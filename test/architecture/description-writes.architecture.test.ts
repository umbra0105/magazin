import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură (15c): HTML din descrierea produsului ajunge în baza de date DOAR prin sanitizatorul comun
 * (`packages/core/src/catalog/rich-text`). Pică dacă:
 *  1. alt fișier decât `html-engine.ts` importă `sanitize-html` (un singur punct de intrare în bibliotecă);
 *  2. un fișier care scrie în `product` (create/update/updateMany/upsert/createMany) și poate atinge descrierea nu trece
 *     prin `prepareDescription` (magazinele de produse și de ciclu de viață) sau prin funcțiile comune (`sanitizeDescription`,
 *     `sanitizeRichHtml`, `plainTextToHtml`);
 *  3. un `UPDATE`/`INSERT` SQL brut în `product` atinge coloana `description` din cod (migrările din `packages/db` sunt
 *     în afara scanării);
 *  4. `dangerouslySetInnerHTML` apare în alt loc decât componenta de randare a descrierii și scriptul de temă din layoutul
 *     de admin (HTML-ul din bază nu intră în pagină pe altă cale).
 *
 * Citește sursa ca text; `findDescriptionWriteViolations` e pură și testată pe fișiere sintetice.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

export interface SourceFile {
  path: string;
  content: string;
}

const HTML_ENGINE = "packages/core/src/catalog/rich-text/html-engine.ts";

/** Magazinele care scriu descrierea și TREBUIE să apeleze `prepareDescription` (și să țină la zi legăturile media). */
const DESCRIPTION_WRITERS: readonly string[] = [
  "packages/core/src/catalog/product-store.ts",
  "packages/core/src/catalog/product-lifecycle-store.ts",
];

/** Singurele fișiere care au voie să folosească `dangerouslySetInnerHTML`. */
const INNER_HTML_ALLOWED: readonly string[] = [
  "apps/web/src/components/rich-text/rich-text.tsx",
  // scriptul de inițializare a temei (constantă din cod, nu conținut din bază)
  "apps/web/src/app/(admin)/admin/layout.tsx",
];
const INNER_HTML = /\bdangerouslySetInnerHTML\b/;

const SANCTIONED =
  /\b(?:prepareDescription|sanitizeDescription|sanitizeRichHtml|plainTextToHtml)\b/;
const PRODUCT_WRITE =
  /\b(?:db|tx|prisma|client)\.product\.(?:create|createMany|update|updateMany|upsert)\s*\(/g;
const RAW_SQL_PRODUCT = /(?:UPDATE|INSERT\s+INTO)\s+"?product"?\b[\s\S]{0,400}?\bdescription\b/i;
const SANITIZE_HTML_IMPORT = /from\s+["']sanitize-html["']|require\(\s*["']sanitize-html["']\s*\)/;

const isTest = (path: string): boolean =>
  /\.(test|spec)\.(ts|tsx)$/.test(path) ||
  path.includes("/test/") ||
  path.includes("/test-utils/") ||
  path.startsWith("e2e/");

export function findDescriptionWriteViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (isTest(file.path)) continue;
    const { path, content } = file;

    if (SANITIZE_HTML_IMPORT.test(content) && path !== HTML_ENGINE) {
      problems.push(
        `${path}: importă «sanitize-html» direct; folosește funcțiile din catalog/rich-text`,
      );
    }

    if (DESCRIPTION_WRITERS.includes(path)) {
      if (!/\bprepareDescription\s*\(/.test(content)) {
        problems.push(`${path}: scrie în product, dar nu apelează prepareDescription`);
      }
      if (!/\bsyncDescriptionMedia\s*\(/.test(content)) {
        problems.push(
          `${path}: scrie descrierea, dar nu ține la zi legăturile media (syncDescriptionMedia)`,
        );
      }
      continue;
    }

    for (const match of content.matchAll(PRODUCT_WRITE)) {
      const after = content.slice(match.index ?? 0, (match.index ?? 0) + 800);
      if (/\bdescription\b/.test(after) && !SANCTIONED.test(content)) {
        problems.push(
          `${path}: scrie «description» în product fără sanitizatorul comun (prepareDescription / sanitizeDescription / plainTextToHtml)`,
        );
        break;
      }
    }

    if (INNER_HTML.test(content) && !INNER_HTML_ALLOWED.includes(path)) {
      problems.push(
        `${path}: dangerouslySetInnerHTML în afara componentei de randare a descrierii`,
      );
    }

    if (RAW_SQL_PRODUCT.test(content)) {
      problems.push(`${path}: SQL brut care scrie coloana description din product`);
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
    for (const sub of ["src", "scripts"]) {
      const dir = join(root, "packages", pkg, sub);
      try {
        if (statSync(dir).isDirectory()) roots.push(dir);
      } catch {
        // fără acest director
      }
    }
  }
  const paths: string[] = [];
  for (const dir of roots) walk(dir, paths);
  return paths.map((full) => ({
    path: relative(root, full).split(sep).join("/"),
    content: readFileSync(full, "utf8"),
  }));
}

describe("descrierea produsului se scrie doar prin sanitizator (sursa reală)", () => {
  const files = loadSource();

  it("scanează codul real (nu trece în gol): găsește magazinele de produse și motorul HTML", () => {
    expect(files.length).toBeGreaterThan(100);
    for (const writer of DESCRIPTION_WRITERS)
      expect(files.some((f) => f.path === writer)).toBe(true);
    expect(files.some((f) => f.path === HTML_ENGINE)).toBe(true);
    const writers = files.filter((f) => new RegExp(PRODUCT_WRITE.source).test(f.content));
    expect(writers.length).toBeGreaterThan(3);
  });

  it("nicio cale de scriere a descrierii nu ocolește sanitizatorul", () => {
    expect(findDescriptionWriteViolations(files)).toEqual([]);
  });
});

describe("findDescriptionWriteViolations pe fișiere sintetice (testul pică când trebuie)", () => {
  const check = (path: string, content: string): string[] =>
    findDescriptionWriteViolations([{ path, content }]);

  it("prinde un import direct al bibliotecii", () => {
    expect(
      check("packages/core/src/x.ts", `import sanitizeHtml from "sanitize-html";`),
    ).toHaveLength(1);
    expect(check("apps/web/src/y.ts", `const s = require("sanitize-html");`)).toHaveLength(1);
    expect(check(HTML_ENGINE, `import sanitizeHtml from "sanitize-html";`)).toEqual([]);
  });

  it("prinde un magazin de produse care nu apelează sanitizatorul sau nu ține la zi legăturile media", () => {
    const store = "packages/core/src/catalog/product-store.ts";
    expect(check(store, `await tx.product.create({ data });`)).toHaveLength(2);
    expect(
      check(store, `await prepareDescription(tx, d); await tx.product.create({ data });`),
    ).toHaveLength(1);
    expect(
      check(
        store,
        `await prepareDescription(tx, d); await syncDescriptionMedia(tx, id, []); tx.product.update({});`,
      ),
    ).toEqual([]);
    expect(
      check(
        "packages/core/src/catalog/product-lifecycle-store.ts",
        `tx.product.create({ data: { description: x } })`,
      ),
    ).toHaveLength(2);
  });

  it("prinde o scriere nouă a descrierii în alt fișier, dar nu și scrierile altor câmpuri", () => {
    expect(
      check(
        "packages/core/src/new.ts",
        `await tx.product.update({ where: { id }, data: { description: html } });`,
      ),
    ).toHaveLength(1);
    expect(
      check(
        "packages/core/scripts/dev.ts",
        `await db.product.createMany({ data: rows.map((r) => ({ title: r, description: "x" })) });`,
      ),
    ).toHaveLength(1);
    expect(
      check(
        "packages/core/src/inventory/x.ts",
        `await tx.product.updateMany({ where: { id }, data: { manageStock: true } });`,
      ),
    ).toEqual([]);
    expect(
      check(
        "packages/core/scripts/dev.ts",
        `import { plainTextToHtml } from "@ecom/core";\nawait db.product.create({ data: { description: plainTextToHtml(t) } });`,
      ),
    ).toEqual([]);
  });

  it("prinde dangerouslySetInnerHTML în afara fișierelor permise", () => {
    const code = "<div dangerouslySetInnerHTML={{ __html: html }} />";
    expect(check("apps/web/src/components/x.tsx", code)).toHaveLength(1);
    expect(check("apps/web/src/components/rich-text/rich-text.tsx", code)).toEqual([]);
    expect(check("apps/web/src/app/(admin)/admin/layout.tsx", code)).toEqual([]);
    expect(check("apps/web/src/components/x.test.tsx", code)).toEqual([]);
  });

  it("prinde SQL brut care scrie description din product; ignoră testele", () => {
    expect(
      check(
        "packages/core/src/z.ts",
        'await db.$executeRaw`UPDATE "product" SET "description" = ${x}`;',
      ),
    ).toHaveLength(1);
    expect(
      check("packages/core/src/z.ts", 'INSERT INTO "product" ("id", "description") VALUES'),
    ).toHaveLength(1);
    expect(check("packages/core/src/z.ts", 'UPDATE "product" SET "title" = $1')).toEqual([]);
    expect(check("packages/core/src/z.test.ts", 'UPDATE "product" SET "description" = $1')).toEqual(
      [],
    );
    expect(
      check(
        "packages/core/src/test-utils/f.ts",
        "await db.product.create({ data: { description: 'x' } })",
      ),
    ).toEqual([]);
  });
});

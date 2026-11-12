import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Ecranele migrate la design-ul din docs/17 folosesc doar numele semantice de tokeni (`text-ink-secondary`, `border-line-subtle`,
 * `text-body`, `text-label`, `text-title`, `text-section`, `bg-tone-problem-bg` …), nu numele vechi ale punții de dinaintea
 * redesignului (`text-muted-foreground`, `border-border`, `text-danger`) și nici scara Tailwind de text (`text-sm`, `text-xs`).
 * Lotul 2b (editarea produsului) și Lotul 3a (Categorii, Branduri, Atribute, Unități de măsură) curăță fișierele de mai jos;
 * Lotul 3b le adaugă pe celelalte (Media, Import/Export, Depozite, Fișe explodate).
 * Citește sursa ca text; `findLegacyClasses` e pură și testată pe fișiere sintetice.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Numele vechi (cu variantele de opacitate, `bg-border/30`) și scara de text Tailwind. */
const LEGACY =
  /(?<![\w-])(?:text-(?:muted-foreground|foreground|danger|primary|primary-foreground|xs|sm|base|lg|xl|2xl|3xl)|(?:border|ring|divide)-(?:border|danger|primary|input)|bg-(?:border|background|primary|danger|muted|accent)|border-danger)(?:\/\d+)?(?![\w-])/g;

export interface SourceFile {
  path: string;
  content: string;
}

/** Fără comentarii: textul explicativ poate cita numele vechi fără să le folosească. */
function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/.*$/gm, (_m, lead: string) => lead);
}

export function findLegacyClasses(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const code = stripComments(file.content);
    for (const match of code.matchAll(LEGACY)) {
      const line = code.slice(0, match.index).split("\n").length;
      problems.push(
        `${file.path}:${line}: clasă veche «${match[0]}» (folosește tokenii din docs/17)`,
      );
    }
  }
  return problems;
}

/** Folderele de componente și paginile celor patru ecrane de catalog din Lotul 3a. */
const CATALOG_SCREENS = [
  { components: "apps/web/src/components/admin/categories", page: "categorii" },
  { components: "apps/web/src/components/admin/brands", page: "branduri" },
  { components: "apps/web/src/components/admin/attributes", page: "atribute" },
  { components: "apps/web/src/components/admin/measure-units", page: "unitati-de-masura" },
] as const;

/** Fișierele migrate: editarea produsului (Lotul 2b) și cele 4 ecrane de catalog (Lotul 3a), fără importul de produse (Lotul 3b). */
export function migratedFiles(): SourceFile[] {
  const dir = join(root, "apps/web/src/components/admin/products");
  const out: SourceFile[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".tsx")) continue;
    if (name.startsWith("product-import-")) continue; // Lotul 3
    const full = join(dir, name);
    out.push({
      path: relative(root, full).replaceAll("\\", "/"),
      content: readFileSync(full, "utf8"),
    });
  }
  for (const page of [
    "apps/web/src/app/(admin)/admin/produse/[id]/page.tsx",
    "apps/web/src/app/(admin)/admin/produse/nou/page.tsx",
    ...CATALOG_SCREENS.map(
      (screen) => `apps/web/src/app/(admin)/admin/produse/${screen.page}/page.tsx`,
    ),
  ]) {
    out.push({ path: page, content: readFileSync(join(root, page), "utf8") });
  }
  for (const screen of CATALOG_SCREENS) {
    const dir = join(root, screen.components);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".tsx")) continue;
      out.push({
        path: relative(root, join(dir, name)).replaceAll("\\", "/"),
        content: readFileSync(join(dir, name), "utf8"),
      });
    }
  }
  // antetul comun al paginilor de catalog (Lotul 3a)
  const header = "apps/web/src/components/admin/page-header.tsx";
  try {
    out.push({ path: header, content: readFileSync(join(root, header), "utf8") });
  } catch {
    // fișierul apare odată cu migrarea; până atunci nu există
  }
  return out;
}

describe("findLegacyClasses", () => {
  const file = (content: string): SourceFile[] => [{ path: "x.tsx", content }];

  it("prinde numele vechi, cu și fără opacitate, și scara Tailwind de text", () => {
    const code = `<p className="text-sm text-muted-foreground">a</p><div className="border border-border bg-border/30 text-danger" />`;
    const found = findLegacyClasses(file(code)).map((p) => /«([^»]+)»/.exec(p)?.[1]);
    expect(found).toEqual([
      "text-sm",
      "text-muted-foreground",
      "border-border",
      "bg-border/30",
      "text-danger",
    ]);
  });

  it("nu prinde tokenii noi și nu confundă prefixe (text-body, text-ink-secondary, border-line-subtle, bg-surface-subtle)", () => {
    const code = `<p className="text-body text-label text-title text-section text-ink-secondary border-line-subtle bg-surface-subtle bg-tone-problem-bg text-tone-problem-fg text-brand" />`;
    expect(findLegacyClasses(file(code))).toEqual([]);
  });

  it("ignoră comentariile", () => {
    expect(findLegacyClasses(file(`// text-sm\n/* border-border */\nconst a = 1;`))).toEqual([]);
  });
});

describe("lista fișierelor migrate", () => {
  const paths = migratedFiles().map((file) => file.path);

  it("cuprinde editarea produsului, cele 4 ecrane de catalog (pagini și componente) și antetul comun, nu importul de produse", () => {
    for (const expected of [
      "apps/web/src/components/admin/products/general-tab.tsx",
      "apps/web/src/components/admin/categories/category-manager.tsx",
      "apps/web/src/components/admin/categories/category-form-dialog.tsx",
      "apps/web/src/components/admin/brands/brand-manager.tsx",
      "apps/web/src/components/admin/attributes/attribute-manager.tsx",
      "apps/web/src/components/admin/measure-units/measure-unit-manager.tsx",
      "apps/web/src/components/admin/page-header.tsx",
      "apps/web/src/app/(admin)/admin/produse/categorii/page.tsx",
      "apps/web/src/app/(admin)/admin/produse/branduri/page.tsx",
      "apps/web/src/app/(admin)/admin/produse/atribute/page.tsx",
      "apps/web/src/app/(admin)/admin/produse/unitati-de-masura/page.tsx",
    ]) {
      expect(paths, expected).toContain(expected);
    }
    expect(paths.some((path) => path.includes("product-import-"))).toBe(false);
  });
});

describe("codul real", () => {
  it("fișierele editării produsului și ale celor 4 ecrane de catalog nu mai folosesc nume vechi de clase", () => {
    expect(findLegacyClasses(migratedFiles())).toEqual([]);
  });
});

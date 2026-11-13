import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Ecranele migrate la design-ul din docs/17 folosesc doar numele semantice de tokeni (`text-ink-secondary`, `border-line-subtle`,
 * `text-body`, `text-label`, `text-title`, `text-section`, `bg-tone-problem-bg` …), nu numele vechi ale punții de dinaintea
 * redesignului (`text-muted-foreground`, `border-border`, `text-danger`) și nici scara Tailwind de text (`text-sm`, `text-xs`).
 * Lotul 2b (editarea produsului), Lotul 3a (Categorii, Branduri, Atribute, Unități de măsură) și Lotul 3b-1 (Media, Depozite)
 * curăță fișierele de mai jos; Lotul 3b-2 le adaugă pe celelalte (Import/Export, Fișe explodate).
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

/** Folderele de componente și paginile ecranelor Media și Depozite din Lotul 3b-1. */
const MEDIA_WAREHOUSE_SCREENS = [
  {
    components: "apps/web/src/components/admin/media",
    page: "apps/web/src/app/(admin)/admin/media/page.tsx",
  },
  {
    components: "apps/web/src/components/admin/warehouses",
    page: "apps/web/src/app/(admin)/admin/produse/depozite/page.tsx",
  },
] as const;

/** Fișe explodate (Lotul 3b-2): componentele și cele două pagini. */
const DIAGRAM_SCREENS = [
  {
    components: "apps/web/src/components/admin/diagrams",
    page: "apps/web/src/app/(admin)/admin/produse/fise-explodate/page.tsx",
  },
  {
    components: "apps/web/src/components/admin/diagrams",
    page: "apps/web/src/app/(admin)/admin/produse/fise-explodate/[id]/page.tsx",
  },
] as const;

/** Paginile importului de produse și ale istoricului lui (Lotul 3b-2); componentele lui stau în folderul produselor. */
const IMPORT_PAGES = [
  "apps/web/src/app/(admin)/admin/produse/import/page.tsx",
  "apps/web/src/app/(admin)/admin/produse/import/istoric/page.tsx",
  "apps/web/src/app/(admin)/admin/produse/import/istoric/[id]/page.tsx",
] as const;

/** Autentificare, 404, eroare și încărcare (Lotul 4): paginile, cadrul și componentele formularelor. */
const AUTH_DIR = "apps/web/src/components/auth";
const STATE_FILES = [
  "apps/web/src/app/(auth)/layout.tsx",
  "apps/web/src/app/(auth)/autentificare/page.tsx",
  "apps/web/src/app/(auth)/inregistrare/page.tsx",
  "apps/web/src/app/(auth)/recuperare-parola/page.tsx",
  "apps/web/src/app/(auth)/resetare-parola/page.tsx",
  "apps/web/src/app/(auth)/verificare-email/page.tsx",
  "apps/web/src/app/not-found.tsx",
  "apps/web/src/app/global-error.tsx",
  "apps/web/src/app/(admin)/admin/not-found.tsx",
  "apps/web/src/app/(admin)/admin/error.tsx",
  "apps/web/src/components/admin/page-skeleton.tsx",
  "apps/web/src/components/admin/admin-surface.tsx",
] as const;

/** Fișierele migrate: editarea produsului (Lotul 2b), cele 4 ecrane de catalog (3a), Media și Depozite (3b-1), fără importul de produse (3b-2). */
export function migratedFiles(): SourceFile[] {
  const dir = join(root, "apps/web/src/components/admin/products");
  const out: SourceFile[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".tsx")) continue;
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
    ...MEDIA_WAREHOUSE_SCREENS.map((screen) => screen.page),
    ...DIAGRAM_SCREENS.map((screen) => screen.page),
    ...IMPORT_PAGES,
    "apps/web/src/components/admin/inventory/movements-table.tsx",
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
  for (const screen of [...MEDIA_WAREHOUSE_SCREENS, DIAGRAM_SCREENS[0]]) {
    const dir = join(root, screen.components);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".tsx")) continue;
      out.push({
        path: relative(root, join(dir, name)).replaceAll("\\", "/"),
        content: readFileSync(join(dir, name), "utf8"),
      });
    }
  }
  // Lotul 4: componentele de autentificare și fișierele de stare (cele lipsă nu se citesc; lista lor e păzită mai jos)
  for (const name of readdirSync(join(root, AUTH_DIR))) {
    if (!name.endsWith(".tsx")) continue;
    out.push({
      path: `${AUTH_DIR}/${name}`,
      content: readFileSync(join(root, AUTH_DIR, name), "utf8"),
    });
  }
  for (const path of STATE_FILES) {
    try {
      out.push({ path, content: readFileSync(join(root, path), "utf8") });
    } catch {
      // fișierul apare odată cu migrarea
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

  it("cuprinde editarea produsului, cele 4 ecrane de catalog, Media, Depozite, Fișele explodate și importul de produse cu istoricul lui (pagini și componente) și antetul comun", () => {
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
      "apps/web/src/components/admin/media/media-library.tsx",
      "apps/web/src/components/admin/media/media-card.tsx",
      "apps/web/src/components/admin/media/media-grid.tsx",
      "apps/web/src/components/admin/media/folder-panel.tsx",
      "apps/web/src/components/admin/media/upload-panel.tsx",
      "apps/web/src/components/admin/media/detail-dialog.tsx",
      "apps/web/src/components/admin/media/media-picker.tsx",
      "apps/web/src/components/admin/media/media-filter-fields.tsx",
      "apps/web/src/components/admin/warehouses/warehouse-manager.tsx",
      "apps/web/src/app/(admin)/admin/media/page.tsx",
      "apps/web/src/app/(admin)/admin/produse/depozite/page.tsx",
      "apps/web/src/components/admin/diagrams/diagram-editor.tsx",
      "apps/web/src/components/admin/diagrams/diagram-list.tsx",
      "apps/web/src/app/(admin)/admin/produse/fise-explodate/page.tsx",
      "apps/web/src/app/(admin)/admin/produse/fise-explodate/[id]/page.tsx",
      "apps/web/src/components/admin/products/product-import-wizard.tsx",
      "apps/web/src/components/admin/products/product-import-woo.tsx",
      "apps/web/src/components/admin/products/product-import-images.tsx",
      "apps/web/src/components/admin/products/product-export-dialog.tsx",
      "apps/web/src/app/(admin)/admin/produse/import/page.tsx",
      "apps/web/src/app/(admin)/admin/produse/import/istoric/page.tsx",
      "apps/web/src/app/(admin)/admin/produse/import/istoric/[id]/page.tsx",
      "apps/web/src/components/admin/inventory/movements-table.tsx",
      "apps/web/src/components/auth/login-form.tsx",
      "apps/web/src/components/auth/form-alert.tsx",
      ...STATE_FILES,
    ]) {
      expect(paths, expected).toContain(expected);
    }
  });
});

describe("codul real", () => {
  it("fișierele migrate (editarea produsului, catalogul, Media, Depozitele, Fișele explodate, importul de produse) nu mai folosesc nume vechi de clase", () => {
    expect(findLegacyClasses(migratedFiles())).toEqual([]);
  });
});

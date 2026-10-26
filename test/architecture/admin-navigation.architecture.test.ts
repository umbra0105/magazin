import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADMIN_NAV,
  CATALOG_ITEMS,
  activeItemId,
  pathInGroup,
} from "../../apps/web/src/lib/admin-nav";
import { LEGACY_ADMIN_ROUTES } from "../../apps/web/src/lib/admin-redirects";

/**
 * Navigația de admin (blocul 8c): meniul din stânga are GRUPURI care se deschid și se închid (primul: «Catalog»), cu
 * ecranele grupului ca sub-elemente; nu mai există bară de taburi. Garanții, pe sursa reală:
 *  1. fiecare element al grupului duce la o pagină care există, iar fiecare pagină de sub adresa grupului are un
 *     element evidențiat în meniu (editorul de produs, produsul nou și importul țin «Produse» evidențiat);
 *  2. bara de taburi și dosarul de rute `(tabs)` au dispărut, iar meniul desenează grupurile generic (săgeată,
 *     `aria-expanded`), nu cu cod special pentru «Catalog»;
 *  3. nicio sursă nu mai leagă de adresele vechi (ele există doar în tabelul de redirecturi).
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const ADMIN_PAGES = "apps/web/src/app/(admin)/admin";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry.startsWith(".next")) continue;
    if (entry === "test-results" || entry === "playwright-report" || entry === "local-data")
      continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const rel = (full: string): string => relative(root, full).replaceAll("\\", "/");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

/** `…/admin/produse/stoc/[variantId]/page.tsx` → `/admin/produse/stoc/[variantId]` (grupurile de rute în paranteze nu intră în adresă). */
function adminPages(): { url: string; file: string }[] {
  return walk(join(root, ADMIN_PAGES))
    .map(rel)
    .filter((f) => f.endsWith("/page.tsx"))
    .map((file) => {
      const segments = file
        .slice(ADMIN_PAGES.length, -"/page.tsx".length)
        .split("/")
        .filter(Boolean);
      return {
        file,
        url: `/admin${segments
          .filter((s) => !/^\(.*\)$/.test(s))
          .map((s) => `/${s}`)
          .join("")}`,
      };
    });
}

describe("grupul «Catalog» din meniu", () => {
  const pages = adminPages();
  const group = ADMIN_NAV.find((entry) => entry.id === "catalog");

  it("fiecare element are o pagină care există", () => {
    const urls = new Set(pages.map((p) => p.url));
    for (const item of CATALOG_ITEMS) expect(urls.has(item.href), item.href).toBe(true);
  });

  it("fiecare pagină de sub adresa grupului are un element evidențiat (niciuna fără loc în meniu)", () => {
    const underGroup = pages.filter((p) => pathInGroup(p.url, group?.href ?? "/nu-exista"));
    expect(underGroup.length).toBeGreaterThanOrEqual(CATALOG_ITEMS.length);
    for (const page of underGroup) {
      // segmentele dinamice se înlocuiesc cu o valoare oarecare
      const concrete = page.url.replace(/\[[^\]]+\]/g, "x");
      expect(activeItemId(concrete, CATALOG_ITEMS), page.file).toBeDefined();
    }
  });

  it("paginile de produs (editor, produs nou, import, istoric) țin «Produse» evidențiat; ecranele proprii, elementul lor", () => {
    const highlighted = (url: string) =>
      activeItemId(url.replace(/\[[^\]]+\]/g, "x"), CATALOG_ITEMS);
    expect(highlighted("/admin/produse/[id]")).toBe("allProducts");
    expect(highlighted("/admin/produse/nou")).toBe("allProducts");
    expect(highlighted("/admin/produse/import")).toBe("allProducts");
    expect(highlighted("/admin/produse/import/istoric")).toBe("allProducts");
    expect(highlighted("/admin/produse/import/istoric/[id]")).toBe("allProducts");
    expect(highlighted("/admin/produse/stoc/[variantId]")).toBe("inventory");
    expect(highlighted("/admin/produse/fise-explodate/[id]")).toBe("partsDiagrams");
    // paginile reale chiar există la aceste adrese
    const urls = new Set(pages.map((p) => p.url));
    for (const url of [
      "/admin/produse/[id]",
      "/admin/produse/nou",
      "/admin/produse/import",
      "/admin/produse/import/istoric",
      "/admin/produse/import/istoric/[id]",
      "/admin/produse/stoc/[variantId]",
      "/admin/produse/fise-explodate/[id]",
    ]) {
      expect(urls.has(url), url).toBe(true);
    }
  });

  it("meniul are un singur grup pentru tot catalogul, iar niciun element nu e și intrare separată", () => {
    expect(ADMIN_NAV.filter((e) => e.children).map((e) => e.id)).toEqual(["catalog"]);
    const hrefs = ADMIN_NAV.map((e) => e.href);
    for (const item of CATALOG_ITEMS.filter((i) => i.href !== group?.href)) {
      expect(hrefs, item.href).not.toContain(item.href);
    }
    // toate elementele stau sub adresa grupului
    for (const item of CATALOG_ITEMS) {
      expect(pathInGroup(item.href, group?.href ?? ""), item.href).toBe(true);
    }
  });
});

describe("bara de taburi a dispărut; grupurile sunt generice", () => {
  it("fără AdminTabBar, fără dosarul (tabs), fără eticheta barei", () => {
    expect(existsSync(join(root, "apps/web/src/components/admin/admin-tab-bar.tsx"))).toBe(false);
    const files = walk(join(root, "apps", "web", "src")).map(rel);
    expect(files.some((f) => f.includes("/(tabs)/"))).toBe(false);
    const offenders: string[] = [];
    for (const file of files.filter((f) => /\.[tj]sx?$/.test(f))) {
      const text = readFileSync(join(root, file), "utf8");
      if (/AdminTabBar|admin-tab-bar|productTabsLabel|PRODUCT_TABS|\(tabs\)/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("meniul desenează orice grup cu săgeată și aria-expanded, din datele ADMIN_NAV (nu cod special pentru «Catalog»)", () => {
    // în cod, fără comentarii: un cuvânt dintr-un comentariu nu dovedește că atributul e pus
    const sidebar = read("apps/web/src/components/admin/sidebar-nav.tsx")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(sidebar).toMatch(/aria-expanded=\{/);
    expect(sidebar).toMatch(/aria-controls=\{/);
    expect(sidebar).toMatch(/hidden=\{/);
    expect(sidebar).toMatch(/item\.children/);
    expect(sidebar).toMatch(/pathInGroup\(/);
    // fără ramuri speciale pentru un anumit grup sau element (pictograma grupului stă în harta de pictograme, nu într-o condiție)
    expect(sidebar).not.toMatch(/===\s*["']catalog["']|allProducts|inventory|partsDiagrams/);
    const layout = read("apps/web/src/app/(admin)/admin/layout.tsx");
    expect(layout).toMatch(/children/);
    expect(layout).not.toMatch(/catalog/i);
  });
});

describe("adresele vechi există doar în tabelul de redirecturi", () => {
  // și în regex-uri (`/\/admin\/stoc$/`), nu doar în șiruri
  const OLD =
    /(?:["'`]|\/\\)?\/admin(?:\/|\\\/)(?:categorii|branduri|atribute|unitati-de-masura|fise-explodate|stoc)(?=[/?"'`$\\\s)]|$)/;
  const ALLOWED = new Set([
    "apps/web/src/lib/admin-redirects.ts",
    "apps/web/src/lib/admin-redirects.test.ts",
    "e2e/admin-navigation.spec.ts",
  ]);

  it("nicio sursă (aplicație, pachete, teste E2E) nu leagă de ele", () => {
    const files = ["apps", "packages", "e2e", "scripts"]
      .flatMap((dir) => walk(join(root, dir)))
      .map(rel)
      .filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !ALLOWED.has(f));
    expect(files.length).toBeGreaterThan(200);
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(join(root, file), "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (OLD.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 100)}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("detectorul prinde adresele vechi și lasă pe cele noi", () => {
    for (const bad of [
      'href="/admin/stoc"',
      "`/admin/stoc/${id}`",
      '"/admin/categorii?edit=1"',
      "'/admin/fise-explodate/x'",
    ]) {
      expect(OLD.test(bad), bad).toBe(true);
    }
    for (const good of [
      'href="/admin/produse/stoc"',
      "`/admin/produse/categorii?edit=1`",
      '"/admin/stocuri-vechi"',
    ]) {
      expect(OLD.test(good), good).toBe(false);
    }
  });

  it("tabelul de redirecturi e singurul loc cu ele și acoperă exact adresele detectate", () => {
    expect(LEGACY_ADMIN_ROUTES.map((r) => r.from).sort()).toEqual(
      [
        "/admin/atribute",
        "/admin/branduri",
        "/admin/categorii",
        "/admin/fise-explodate",
        "/admin/stoc",
        "/admin/unitati-de-masura",
      ].sort(),
    );
  });
});

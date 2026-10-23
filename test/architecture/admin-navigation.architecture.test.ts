import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ADMIN_NAV, PRODUCT_TABS, activeTabId } from "../../apps/web/src/lib/admin-nav";
import { LEGACY_ADMIN_ROUTES } from "../../apps/web/src/lib/admin-redirects";

/**
 * Navigația de admin (blocul 8b): o intrare de meniu pe grup, ecranele grupului ca taburi. Garanții, pe sursa reală:
 *  1. fiecare tab duce la o pagină care există și fiecare pagină din grupul `(tabs)` e un tab (altfel bara ar
 *     afișa un tab activ greșit sau nimic);
 *  2. paginile pline (editorul de produs, produsul nou, importul, editorul fișei) rămân în afara grupului, deci
 *     fără bară de taburi;
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

/** `…/admin/produse/(tabs)/stoc/[variantId]/page.tsx` → `/admin/produse/stoc/[variantId]`, plus dacă e în grup. */
function adminPages(): { url: string; inTabs: boolean; file: string }[] {
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
        inTabs: segments.includes("(tabs)"),
        url: `/admin${segments
          .filter((s) => !/^\(.*\)$/.test(s))
          .map((s) => `/${s}`)
          .join("")}`,
      };
    });
}

describe("bara de taburi a grupului «Produse»", () => {
  const pages = adminPages();
  const tabPages = pages.filter((p) => p.inTabs);

  it("fiecare tab are o pagină în grupul (tabs)", () => {
    expect(tabPages.length).toBeGreaterThanOrEqual(PRODUCT_TABS.length);
    const urls = new Set(tabPages.map((p) => p.url));
    for (const tab of PRODUCT_TABS) expect(urls.has(tab.href), tab.href).toBe(true);
  });

  it("fiecare pagină din grupul (tabs) are un tab activ (nu apare bara fără un tab selectat)", () => {
    for (const page of tabPages) {
      // segmentele dinamice se înlocuiesc cu o valoare oarecare
      const concrete = page.url.replace(/\[[^\]]+\]/g, "x");
      expect(activeTabId(concrete, PRODUCT_TABS), page.file).toBeDefined();
    }
  });

  it("paginile pline (editor produs, produs nou, import, editorul fișei) sunt în afara grupului", () => {
    const outside = pages
      .filter((p) => p.url.startsWith("/admin/produse") && !p.inTabs)
      .map((p) => p.url)
      .sort();
    expect(outside).toEqual(
      [
        "/admin/produse/[id]",
        "/admin/produse/fise-explodate/[id]",
        "/admin/produse/import",
        "/admin/produse/import/istoric",
        "/admin/produse/import/istoric/[id]",
        "/admin/produse/nou",
      ].sort(),
    );
  });

  it("meniul are o singură intrare pentru tot grupul și niciun tab nu e intrare separată", () => {
    const hrefs = ADMIN_NAV.map((e) => e.href);
    for (const tab of PRODUCT_TABS.filter((t) => t.href !== "/admin/produse")) {
      expect(hrefs, tab.href).not.toContain(tab.href);
    }
    expect(ADMIN_NAV.filter((e) => e.tabs).map((e) => e.id)).toEqual(["products"]);
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

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GLOBAL_STATE_SPEC_FILES, globalStateSpecPattern } from "../support/e2e-projects";

/**
 * Specurile E2E care calculează un plan pe TOT catalogul rulează singure, după restul suitei.
 *
 * Importul «stoc la zi» și pornirea gestionării stocului arată un plan (previzualizare) și îl aplică după confirmare, iar
 * serverul refuză aplicarea dacă amprenta planului s-a schimbat (`STOCK_IMPORT_PLAN_CHANGED`). Amprenta cuprinde TOATE
 * variantele gestionate care lipsesc din fișier, cu stocul lor fizic: orice alt fișier E2E care, în paralel, creează sau
 * șterge un produs gestionat ori mișcă stoc în depozitul implicit o schimbă între previzualizare și aplicare. Incidentul CI
 * din 2026-11-06 (`stock.spec.ts:884`, «Fișierul, setările sau stocul s-au schimbat de la verificare»), reprodus local cu un
 * proces care mișcă stocul unei alte variante în timpul testului. De aceea aceste specuri stau într-un proiect Playwright
 * propriu, care pornește abia după ce proiectul principal s-a terminat (`dependencies`), nu printr-un timeout sau o reîncercare.
 *
 * Citește sursa ca text; `findGlobalStateViolations` e pură și testată pe intrări sintetice.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

export interface SpecFile {
  name: string;
  content: string;
}

/** Specul trimite un fișier de stoc la ecranele de import / pornire, deci aplică un plan calculat pe tot catalogul. */
const WHOLE_CATALOG_PLAN =
  /#stock-(?:import|activation)-file|\/admin\/produse\/stoc\/(?:import|pornire)\b/;

export function findGlobalStateViolations(input: {
  specs: readonly SpecFile[];
  isolated: readonly string[];
  config: string;
}): string[] {
  const problems: string[] = [];
  const names = new Set(input.specs.map((spec) => spec.name));
  for (const spec of input.specs) {
    if (WHOLE_CATALOG_PLAN.test(spec.content) && !input.isolated.includes(spec.name)) {
      problems.push(
        `${spec.name}: aplică un plan calculat pe tot catalogul, dar nu e în GLOBAL_STATE_SPEC_FILES (ar rula în paralel cu alte specuri)`,
      );
    }
  }
  for (const name of input.isolated) {
    if (!names.has(name))
      problems.push(`${name}: e în GLOBAL_STATE_SPEC_FILES, dar fișierul nu există`);
  }
  const config = input.config;
  const projects = config.slice(config.indexOf("projects:"));
  if (!/testIgnore:\s*\[[^\]]*globalStateSpecPattern/.test(projects)) {
    problems.push(
      "playwright.config.ts: proiectul principal nu exclude `globalStateSpecPattern` (testIgnore)",
    );
  }
  if (!/testMatch:\s*globalStateSpecPattern/.test(projects)) {
    problems.push(
      "playwright.config.ts: lipsește proiectul izolat (`testMatch: globalStateSpecPattern`)",
    );
  }
  if (!/dependencies:\s*\["chromium"\]/.test(projects)) {
    problems.push(
      'playwright.config.ts: proiectul izolat nu așteaptă proiectul principal (`dependencies: ["chromium"]`)',
    );
  }
  return problems;
}

const spec = (name: string, content: string): SpecFile => ({ name, content });
const GOOD_CONFIG = [
  "projects: [",
  '  { name: "chromium", testIgnore: [/media-s3.spec.ts/, globalStateSpecPattern] },',
  '  { name: "chromium-global-state", testMatch: globalStateSpecPattern, dependencies: ["chromium"] },',
  "]",
].join("\n");

describe("specurile cu plan pe tot catalogul rulează izolat (cazuri sintetice)", () => {
  const upload = 'await page.locator("#stock-import-file").setInputFiles(file);';

  it("prinde un spec care încarcă un fișier de stoc și nu e în lista izolată", () => {
    const problems = findGlobalStateViolations({
      specs: [spec("nou.spec.ts", upload)],
      isolated: [],
      config: GOOD_CONFIG,
    });
    expect(problems.join("\n")).toContain("nou.spec.ts");
  });

  it("prinde și navigarea spre ecranul de pornire a gestionării", () => {
    const problems = findGlobalStateViolations({
      specs: [spec("nou.spec.ts", 'await login(page, m, "/admin/produse/stoc/pornire");')],
      isolated: [],
      config: GOOD_CONFIG,
    });
    expect(problems).toHaveLength(1);
  });

  it("nu prinde un spec fără plan pe tot catalogul și acceptă unul izolat", () => {
    expect(
      findGlobalStateViolations({
        specs: [spec("alt.spec.ts", "await page.goto('/admin/produse');")],
        isolated: [],
        config: GOOD_CONFIG,
      }),
    ).toEqual([]);
    expect(
      findGlobalStateViolations({
        specs: [spec("stock.spec.ts", upload)],
        isolated: ["stock.spec.ts"],
        config: GOOD_CONFIG,
      }),
    ).toEqual([]);
  });

  it("prinde un fișier din listă care nu există", () => {
    const problems = findGlobalStateViolations({
      specs: [],
      isolated: ["dispărut.spec.ts"],
      config: GOOD_CONFIG,
    });
    expect(problems.join("\n")).toContain("dispărut.spec.ts");
  });

  it("prinde configurația în care proiectul principal nu exclude specurile izolate", () => {
    const config = GOOD_CONFIG.replace(", globalStateSpecPattern]", "]");
    expect(findGlobalStateViolations({ specs: [], isolated: [], config }).join("\n")).toContain(
      "testIgnore",
    );
  });

  it("prinde configurația fără proiectul izolat sau fără dependența de proiectul principal", () => {
    const withoutProject = 'projects: [{ name: "chromium", testIgnore: [globalStateSpecPattern] }]';
    expect(
      findGlobalStateViolations({ specs: [], isolated: [], config: withoutProject }).join("\n"),
    ).toContain("lipsește proiectul izolat");
    const withoutDeps = GOOD_CONFIG.replace(', dependencies: ["chromium"]', "");
    expect(
      findGlobalStateViolations({ specs: [], isolated: [], config: withoutDeps }).join("\n"),
    ).toContain("dependencies");
  });
});

describe("tiparul proiectului izolat", () => {
  it("potrivește exact fișierele din listă, pe orice separator, și nimic altceva", () => {
    for (const name of GLOBAL_STATE_SPEC_FILES) {
      expect(globalStateSpecPattern.test(`/x/e2e/${name}`)).toBe(true);
      expect(globalStateSpecPattern.test(`X:\\x\\e2e\\${name}`)).toBe(true);
    }
    expect(globalStateSpecPattern.test("/x/e2e/low-stock.spec.ts")).toBe(false);
    expect(globalStateSpecPattern.test("/x/e2e/stock.spec.ts.bak")).toBe(false);
  });
});

describe("suita E2E reală", () => {
  it("niciun spec cu plan pe tot catalogul nu rulează în paralel cu celelalte", () => {
    const dir = join(root, "e2e");
    const specs = readdirSync(dir)
      .filter((name) => name.endsWith(".spec.ts"))
      .map((name) => spec(name, readFileSync(join(dir, name), "utf8")));
    const config = readFileSync(join(root, "playwright.config.ts"), "utf8");
    expect(findGlobalStateViolations({ specs, isolated: GLOBAL_STATE_SPEC_FILES, config })).toEqual(
      [],
    );
  });
});

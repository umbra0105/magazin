import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Valorile de design ale adminului trăiesc într-un singur loc: `packages/ui/src/styles/admin-tokens.css`
 * (`docs/17-design-sistem-admin.md` §2, regula permanentă din CLAUDE.md «Design admin»). Restul codului din
 * `apps/web/src` și `packages/ui/src` (ts, tsx, css) NU are voie să conțină:
 *   1. culori hex (`#1A1A1A`);
 *   2. valori arbitrare Tailwind în px/rem/em (`h-[44px]`, `w-[calc(100%-1.5rem)]`);
 *   3. umbre care nu sunt tokeni (`shadow-lg`, `shadow-[...]`, `box-shadow: …`); tokenii sunt `shadow-popover`,
 *      `shadow-drawer`, `shadow-dialog`, `shadow-none`.
 * Hex-urile mai sunt permise doar în `packages/core/src/branding/presets.ts` (în afara folderelor scanate aici).
 *
 * Valorile arbitrare dinaintea redesignului, în ecranele încă nemigrate, sunt într-o listă de EXCEPȚII care doar scade
 * (ratchet): un fișier nou sau o apariție în plus pică; când un fișier ajunge la zero (sau mai puțin), intrarea trebuie
 * coborâtă sau ștearsă. Lista se golește până la finalul Lotului 3.
 *
 * Citește sursa ca text; `findDesignViolations` e pură și testată pe fișiere sintetice.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

export const TOKENS_FILE = "packages/ui/src/styles/admin-tokens.css";
const SCANNED_DIRS = ["apps/web/src", "packages/ui/src"];
const EXTENSIONS = [".ts", ".tsx", ".css"];

export interface SourceFile {
  path: string;
  content: string;
}

/**
 * Valori arbitrare în px/rem/em care existau înainte de redesign: cale → număr de apariții. Se golește pe măsură ce
 * lanțul de loturi (docs/17 §8) migrează ecranele; NU se adaugă intrări noi.
 */
export const LEGACY_ARBITRARY_LENGTHS: Readonly<Record<string, number>> = {
  "apps/web/src/components/admin/inventory/movements-table.tsx": 1,
};

const HEX = /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g;
const ARBITRARY_LENGTH = /\[[^\]\s]*\d(?:px|rem|em)(?![a-z])[^\]\s]*\]/g;
const SHADOW_CLASS =
  /(?<![\w-])(?:drop-|inset-|text-)?shadow-(?!(?:none|popover|drawer|dialog)(?![\w-]))[\w[]/g;
// lookahead-ul cuprinde și spațiile (altfel `\s*` cedează un spațiu și valoarea permisă trece drept interzisă)
const BOX_SHADOW_CSS = /box-shadow\s*:(?!\s*(?:none\b|var\(--shadow-))/g;
const BOX_SHADOW_JS = /\bboxShadow\s*:(?!\s*["'](?:none["']|var\(--shadow-))/g;

/** Fără comentarii: textul explicativ poate cita valori fără să le «scrie». */
function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/.*$/gm, (_m, lead: string) => lead);
}

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

export function findDesignViolations(
  files: readonly SourceFile[],
  legacy: Readonly<Record<string, number>> = LEGACY_ARBITRARY_LENGTHS,
): string[] {
  const problems: string[] = [];
  const arbitrary = new Map<string, number>();
  for (const file of files) {
    if (file.path === TOKENS_FILE) continue;
    const code = stripComments(file.content);
    for (const match of code.matchAll(HEX)) {
      problems.push(
        `${file.path}:${lineOf(code, match.index)}: culoare hex ${match[0]} scrisă direct (valorile stau în ${TOKENS_FILE})`,
      );
    }
    for (const pattern of [SHADOW_CLASS, BOX_SHADOW_CSS, BOX_SHADOW_JS]) {
      for (const match of code.matchAll(pattern)) {
        problems.push(
          `${file.path}:${lineOf(code, match.index)}: umbră care nu e un token (folosește shadow-popover / shadow-drawer / shadow-dialog)`,
        );
      }
    }
    const lengths = [...code.matchAll(ARBITRARY_LENGTH)];
    if (lengths.length > 0) arbitrary.set(file.path, lengths.length);
  }
  for (const [path, count] of arbitrary) {
    const allowed = legacy[path] ?? 0;
    if (count > allowed) {
      problems.push(
        `${path}: ${count} valori arbitrare în px/rem/em (permise ${allowed}); folosește tokeni sau scara Tailwind`,
      );
    }
  }
  for (const [path, allowed] of Object.entries(legacy)) {
    const count = arbitrary.get(path) ?? 0;
    if (count < allowed) {
      problems.push(
        `${path}: lista de excepții spune ${allowed}, dar sunt ${count}; coboară sau șterge intrarea (lista doar scade)`,
      );
    }
  }
  return problems;
}

function listSources(dir: string, out: SourceFile[] = []): SourceFile[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listSources(full, out);
    else if (
      EXTENSIONS.some((ext) => name.endsWith(ext)) &&
      !/\.test\.tsx?$/.test(name) &&
      !name.endsWith(".d.ts")
    ) {
      out.push({
        path: relative(root, full).replaceAll("\\", "/"),
        content: readFileSync(full, "utf8"),
      });
    }
  }
  return out;
}

const file = (path: string, content: string): SourceFile => ({ path, content });

describe("valorile de design (cazuri sintetice)", () => {
  it("acceptă clase cu tokeni și valori din scara Tailwind", () => {
    const content =
      'const c = "bg-surface-page text-ink border-line-subtle rounded-md h-9 shadow-popover shadow-none";';
    expect(findDesignViolations([file("a.tsx", content)], {})).toEqual([]);
  });

  it("prinde o culoare hex în ts, tsx și css, în toate formele", () => {
    for (const hex of ["#fff", "#FFFFFF", "#abcd", "#aabbccdd"]) {
      expect(findDesignViolations([file("a.tsx", `const c = "${hex}";`)], {})).toHaveLength(1);
      expect(findDesignViolations([file("a.css", `a { color: ${hex}; }`)], {})).toHaveLength(1);
    }
  });

  it("nu confundă ancorele, entitățile numerice sau identificatorii cu culori", () => {
    const content =
      'const a = "#main-content"; const b = "&#169;"; const c = "#admin-sidebar"; const d = "#add-form";';
    expect(findDesignViolations([file("a.tsx", content)], {})).toEqual([]);
  });

  it("ignoră valorile citate în comentarii", () => {
    const content =
      "// culoarea #1A1A1A și h-[44px]\n/* shadow-lg #fff */\nconst x = 1; // shadow-md";
    expect(findDesignViolations([file("a.tsx", content)], {})).toEqual([]);
  });

  it("scutește fișierul de tokeni", () => {
    expect(findDesignViolations([file(TOKENS_FILE, "a { color: #FFFFFF; }")], {})).toEqual([]);
  });

  it("prinde valori arbitrare în px, rem și em, inclusiv în calc și grile", () => {
    for (const cls of ["h-[44px]", "max-w-[12rem]", "w-[calc(100%-1.5rem)]", "text-[0.8em]"]) {
      expect(findDesignViolations([file("a.tsx", `const c = "${cls}";`)], {})).toHaveLength(1);
    }
    expect(
      findDesignViolations([file("a.tsx", 'const c = "grid-cols-[16rem_1fr]";')], {}),
    ).toHaveLength(1);
  });

  it("nu prinde valori arbitrare fără unități fixe (procente, dvh, variabile) și indexări", () => {
    const content =
      'const c = "max-h-[92dvh] w-[40%] h-(--control-h) bg-[var(--x)]"; const v = a[0];';
    expect(findDesignViolations([file("a.tsx", content)], {})).toEqual([]);
  });

  it("prinde umbre care nu sunt tokeni", () => {
    for (const cls of ["shadow-lg", "shadow-sm", "shadow-[0_1px_2px_black]", "drop-shadow-md"]) {
      expect(
        findDesignViolations([file("a.tsx", `const c = "${cls}";`)], {}).some((p) =>
          p.includes("umbră"),
        ),
      ).toBe(true);
    }
    expect(
      findDesignViolations([file("a.css", "a { box-shadow: 0 1px 2px black; }")], {}),
    ).toHaveLength(1);
    expect(
      findDesignViolations([file("a.tsx", 'const s = { boxShadow: "0 1px 2px black" };')], {}),
    ).toHaveLength(1);
    expect(
      findDesignViolations([file("a.css", "a { box-shadow: var(--shadow-popover); }")], {}),
    ).toEqual([]);
    expect(findDesignViolations([file("a.css", "a { box-shadow: none; }")], {})).toEqual([]);
  });

  it("ratchet: apariții peste listă pică, sub listă pică, egale trec", () => {
    const two = 'const c = "h-[44px] w-[3rem]";';
    expect(findDesignViolations([file("a.tsx", two)], { "a.tsx": 2 })).toEqual([]);
    expect(findDesignViolations([file("a.tsx", two)], { "a.tsx": 1 }).join("\n")).toContain(
      "permise 1",
    );
    expect(findDesignViolations([file("a.tsx", two)], { "a.tsx": 3 }).join("\n")).toContain(
      "coboară sau șterge",
    );
    expect(
      findDesignViolations([file("a.tsx", "const c = 1;")], { "a.tsx": 1 }).join("\n"),
    ).toContain("coboară sau șterge");
    expect(findDesignViolations([file("b.tsx", two)], { "a.tsx": 0 }).join("\n")).toContain(
      "b.tsx",
    );
  });
});

describe("codul real", () => {
  it("fișierul de tokeni al adminului există și declară suprafața admin", () => {
    const path = join(root, TOKENS_FILE);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain('[data-surface="admin"]');
  });

  it("apps/web/src și packages/ui/src nu conțin hex, valori arbitrare noi în px/rem/em sau umbre fără token", () => {
    const files = SCANNED_DIRS.flatMap((dir) => listSources(join(root, dir)));
    expect(files.length).toBeGreaterThan(100);
    expect(findDesignViolations(files)).toEqual([]);
  });
});

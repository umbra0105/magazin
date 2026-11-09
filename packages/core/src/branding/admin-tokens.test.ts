import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";

/**
 * Fișierul de tokeni al adminului (`packages/ui/src/styles/admin-tokens.css`) citit ca text:
 *   1. fiecare culoare are valoare pentru AMBELE teme (`light-dark(deschis, închis)`);
 *   2. fiecare pereche text/fundal are contrast AA în ambele teme (4,5:1 pentru text, 3:1 pentru margini de câmp și grafice);
 *   3. valorile temei deschise coincid cu cele din docs/17 §2.1–2.2 (documentul nu rămâne în urmă);
 *   4. puntea către numele vechi (`--color-bg` etc.) există, ca ecranele nemigrate să urmeze adminul.
 */
const css = readFileSync(
  new URL("../../../ui/src/styles/admin-tokens.css", import.meta.url),
  "utf8",
);
const docs = readFileSync(
  new URL("../../../../docs/17-design-sistem-admin.md", import.meta.url),
  "utf8",
);

/** `--nume: light-dark(#aaa, #bbb)` → nume → [deschis, închis]. */
function pairs(): Map<string, [string, string]> {
  const result = new Map<string, [string, string]>();
  const pattern = /--([a-z0-9-]+):\s*light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\)/gi;
  for (const m of css.matchAll(pattern)) {
    result.set(m[1] as string, [(m[2] as string).toLowerCase(), (m[3] as string).toLowerCase()]);
  }
  return result;
}
const tokens = pairs();
const value = (name: string, mode: "light" | "dark"): string => {
  const pair = tokens.get(name);
  if (!pair)
    throw new Error(`--${name} nu e un light-dark() cu două culori hex în fișierul de tokeni`);
  return pair[mode === "light" ? 0 : 1];
};

const COLOR_TOKENS = [
  "surface-page",
  "surface-canvas",
  "surface-subtle",
  "surface-hover",
  "border-subtle",
  "border-control",
  "border-input",
  "text-primary",
  "text-secondary",
  "text-placeholder",
  "text-disabled",
  "action",
  "action-hover",
  "action-pressed",
  "action-fg",
  "link",
  "on-brand",
  "tone-neutral-bg",
  "tone-neutral-fg",
  "tone-info-bg",
  "tone-info-fg",
  "tone-success-bg",
  "tone-success-fg",
  "tone-warning-bg",
  "tone-warning-fg",
  "tone-problem-bg",
  "tone-problem-fg",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "kpi-cyan",
  "kpi-green",
  "kpi-indigo",
  "kpi-peach",
];

describe("fișierul de tokeni al adminului: ambele teme", () => {
  it("fiecare culoare are o valoare deschisă și una închisă", () => {
    for (const name of COLOR_TOKENS) expect(tokens.has(name), `--${name}`).toBe(true);
  });

  it("valorile închise sunt diferite de cele deschise acolo unde rolul o cere (text, suprafețe, acțiune)", () => {
    for (const name of ["surface-page", "text-primary", "action", "action-fg", "border-subtle"]) {
      expect(value(name, "light"), name).not.toBe(value(name, "dark"));
    }
  });

  it("suprafața adminului e definită o singură dată, iar fundalul paginii e alb în tema deschisă (decizia §9.1)", () => {
    expect(css.match(/^\[data-surface="admin"\]\s*\{/gm)).toHaveLength(1); // blocul principal (cele din @media sunt indentate)
    expect(value("surface-page", "light")).toBe("#ffffff");
    expect(value("surface-canvas", "light")).toBe("#ffffff");
  });
});

describe.each(["light", "dark"] as const)("contrast AA în tema %s", (mode) => {
  const v = (name: string) => value(name, mode);
  const ratio = (fg: string, bg: string) => contrastRatio(v(fg), v(bg));

  it("text pe suprafețe: 4,5:1", () => {
    for (const surface of ["surface-page", "surface-subtle", "surface-hover"]) {
      expect(ratio("text-primary", surface), `text-primary/${surface}`).toBeGreaterThanOrEqual(4.5);
      expect(ratio("text-secondary", surface), `text-secondary/${surface}`).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(ratio("link", surface), `link/${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("text-model pe fundalurile câmpurilor: 4,5:1 (inclusiv pe --surface-subtle, câmpul de căutare)", () => {
    for (const surface of ["surface-page", "surface-subtle"]) {
      expect(ratio("text-placeholder", surface), surface).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("marginea câmpurilor: 3:1 pe pagină și pe suprafața subtilă", () => {
    for (const surface of ["surface-page", "surface-subtle"]) {
      expect(ratio("border-input", surface), surface).toBeGreaterThanOrEqual(3);
    }
  });

  it("butonul principal în toate stările: 4,5:1", () => {
    for (const state of ["action", "action-hover", "action-pressed"]) {
      expect(ratio("action-fg", state), state).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("textul de pe brand: 4,5:1 pe brandul implicit", () => {
    const brand = css.match(new RegExp(`--brand-${mode}:\\s*(#[0-9a-f]{6})`, "i"))?.[1] as string;
    expect(contrastRatio(v("on-brand"), brand)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(brand, v("surface-page"))).toBeGreaterThanOrEqual(4.5);
  });

  it("perechile de stare: 4,5:1 pe fundalul lor și cel puțin 3:1 pe pagină", () => {
    for (const tone of ["neutral", "info", "success", "warning", "problem"]) {
      expect(ratio(`tone-${tone}-fg`, `tone-${tone}-bg`), tone).toBeGreaterThanOrEqual(4.5);
      expect(ratio(`tone-${tone}-fg`, "surface-page"), `${tone}/pagină`).toBeGreaterThanOrEqual(3);
    }
  });

  it("textul pericol (butonul de ștergere) pe pagină: 4,5:1", () => {
    expect(ratio("tone-problem-fg", "surface-page")).toBeGreaterThanOrEqual(4.5);
  });

  it("graficele și segmentele barei de stoc: 3:1 pe pagină", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      expect(ratio(`chart-${n}`, "surface-page"), `chart-${n}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("textul principal pe fundalurile cardurilor de indicatori: 4,5:1", () => {
    for (const kpi of ["kpi-cyan", "kpi-green", "kpi-indigo", "kpi-peach"]) {
      expect(ratio("text-primary", kpi), kpi).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("documentul docs/17 și fișierul de tokeni spun același lucru (tema deschisă)", () => {
  it("tabelul §2.1: fiecare token cu valoare hex coincide", () => {
    const rows = [...docs.matchAll(/^\| `--([a-z-]+)` \| `(#[0-9A-Fa-f]{6})` \|/gm)];
    expect(rows.length).toBeGreaterThan(14);
    for (const row of rows) {
      const name = row[1] as string;
      if (!tokens.has(name)) continue; // `--brand` etc. nu sunt perechi light-dark
      expect(value(name, "light"), `--${name}`).toBe((row[2] as string).toLowerCase());
    }
  });

  it("tabelul §2.2: perechile de stare coincid", () => {
    const map: Record<string, string> = {
      Neutru: "neutral",
      Informație: "info",
      Succes: "success",
      Atenție: "warning",
      Problemă: "problem",
    };
    const rows = [
      ...docs.matchAll(
        /^\| (Neutru|Informație|Succes|Atenție|Problemă) \| `(#[0-9A-Fa-f]{6})` \| `(#[0-9A-Fa-f]{6})` \|/gm,
      ),
    ];
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      const tone = map[row[1] as string] as string;
      expect(value(`tone-${tone}-bg`, "light")).toBe((row[2] as string).toLowerCase());
      expect(value(`tone-${tone}-fg`, "light")).toBe((row[3] as string).toLowerCase());
    }
  });
});

describe("light-dark() primește doar culori", () => {
  it("fiecare argument al unui light-dark() din fișier e o culoare (hex sau rgb), nu o umbră sau o lungime", () => {
    // light-dark() nu acceptă umbre: o valoare ca `light-dark(0 4px 16px …, …)` e invalidă la calcul și umbra dispare în tăcere
    const code = css.replace(/\/\*[\s\S]*?\*\//g, ""); // fără comentarii
    const calls = [...code.matchAll(/light-dark\(([^;]*)\);/g)].map((m) => m[1] as string);
    expect(calls.length).toBeGreaterThan(40);
    for (const call of calls) {
      const args = call.split(/,(?![^(]*\))/).map((arg) => arg.trim());
      expect(args, call).toHaveLength(2);
      for (const arg of args) {
        expect(arg, call).toMatch(/^(#[0-9a-f]{6}|rgb\([^)]*\)|var\(--[a-z-]+\))$/i);
      }
    }
  });

  it("umbrele se compun din culori pe temă (--shadow-tone-*) și geometrie, nu din light-dark() direct", () => {
    for (const name of ["popover", "drawer", "dialog"]) {
      const line = css.match(new RegExp(`--shadow-${name}:[^;]*;`))?.[0] ?? "";
      expect(line, name).not.toContain("light-dark");
      expect(line, name).toContain("var(--shadow-tone-");
    }
  });
});

describe("puntea către numele vechi", () => {
  it("--color-bg, -fg, -muted, -border, -primary, -primary-fg, -accent, -success, -danger urmează tokenii adminului", () => {
    for (const [legacy, token] of [
      ["bg", "surface-page"],
      ["fg", "text-primary"],
      ["muted", "text-secondary"],
      ["border", "border-subtle"],
      ["primary", "action"],
      ["primary-fg", "action-fg"],
      ["accent", "brand"],
      ["success", "tone-success-fg"],
      ["danger", "tone-problem-fg"],
    ] as const) {
      expect(css, `--color-${legacy}`).toContain(`--color-${legacy}: var(--${token});`);
    }
  });

  it("fontul adminului e Inter, independent de Branding", () => {
    expect(css).toMatch(/--font-body:\s*var\(--font-inter\)/);
    expect(css).toMatch(/--font-heading:\s*var\(--font-body\)/);
  });
});

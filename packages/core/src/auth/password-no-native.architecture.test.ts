import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură: parolele se hașează DOAR cu `crypto.argon2` din Node (`packages/core/src/auth/password.ts`).
 * Niciun modul NATIV de parole (`@node-rs/argon2`, `argon2`, `bcrypt`, `bcryptjs`, `@node-rs/bcrypt`, `node-argon2`)
 * nu are voie nici în cod, nici în dependențe, nici în `serverExternalPackages`.
 *
 * Motiv: un modul nativ nesemnat e blocat la încărcare pe Windows cu Smart App Control / Application Control
 * (incidentul din 2026-10-19), ceea ce oprește build-ul de producție, testele de integrare și E2E.
 *
 * Citește sursa ca text; `findNativePasswordViolations` e pură și testată pe fișiere sintetice, ca testul să nu
 * poată trece «în gol». Proba pe sursa reală: un fișier care importă `@node-rs/argon2` trebuie să facă testul să pice.
 */

const root = fileURLToPath(new URL("../../../../", import.meta.url));

export interface SourceFile {
  path: string;
  content: string;
}

const FORBIDDEN = [
  "@node-rs/argon2",
  "@node-rs/bcrypt",
  "argon2",
  "bcrypt",
  "bcryptjs",
  "node-argon2",
] as const;

const NAME = `(?:${FORBIDDEN.map((n) => n.replace(/[/@-]/g, "\\$&")).join("|")})(?:/[^"'\`]*)?`;
const QUOTE = "[\"'`]";

/**
 * Forme care aduc un modul în proiect: `from "x"`, `require("x")`, `import("x")`, `import "x"`, cheia de dependență
 * din package.json și o intrare de sine stătătoare într-o listă de configurare (ex. `serverExternalPackages`). Un
 * simplu text între ghilimele într-un test (ex. «nu conține argon2») nu e o aducere de modul.
 */
const FORMS: readonly RegExp[] = [
  new RegExp(`(?:from|require\\(|import\\()\\s*${QUOTE}${NAME}${QUOTE}`),
  new RegExp(`^\\s*import\\s+${QUOTE}${NAME}${QUOTE}`),
  new RegExp(`^\\s*${QUOTE}${NAME}${QUOTE}\\s*:\\s*["{]`),
  new RegExp(`^\\s*${QUOTE}${NAME}${QUOTE},?\\s*$`),
];

/** Fișierul acestui test și doar el pomenește numele modulelor interzise. */
const SELF = "packages/core/src/auth/password-no-native.architecture.test.ts";

export function findNativePasswordViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (file.path === SELF) continue;
    const lines = file.content.split("\n");
    lines.forEach((line, index) => {
      // comentariile pot explica de ce nu se folosește un modul; doar codul și configurația contează
      if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) return;
      const match = FORMS.map((form) => form.exec(line)).find((m) => m !== null);
      if (match)
        problems.push(`${file.path}:${index + 1}: modul nativ de parole (${match[0].trim()})`);
    });
  }
  return problems;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".turbo",
  "dist",
  "generated",
  "test-results",
  "playwright-report",
  "local-data",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".next")) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, out);
    else if (
      /\.(tsx?|mts|cts|mjs|cjs|js|json|ya?ml)$/.test(entry) &&
      !/(^|[\\/])(pnpm-lock\.yaml|tsconfig.*\.json|.*\.tsbuildinfo)$/.test(full)
    ) {
      out.push(full);
    }
  }
  return out;
}

function realFiles(): SourceFile[] {
  return ["packages", "apps", "scripts", "e2e", "test"]
    .flatMap((dir) => walk(join(root, dir)))
    .concat(["package.json", "pnpm-workspace.yaml"].map((name) => join(root, name)))
    .map((full) => ({
      path: relative(root, full).split(sep).join("/"),
      content: readFileSync(full, "utf8"),
    }));
}

const file = (path: string, content: string): SourceFile => ({ path, content });

describe("fără module native pentru parole (cazuri sintetice)", () => {
  it.each([
    ["import ESM", `import { hash } from "@node-rs/argon2";`],
    ["import din argon2", `import argon2 from "argon2";`],
    ["require", `const bcrypt = require("bcrypt");`],
    ["import dinamic", `const m = await import("@node-rs/argon2");`],
    ["bcryptjs", `import bcrypt from 'bcryptjs';`],
    ["subcale ale pachetului", `import x from "@node-rs/argon2/browser";`],
    ["dependență în package.json", `    "@node-rs/argon2": "2.2.2",`],
    ["serverExternalPackages", `    "@node-rs/argon2",`],
  ])("prinde %s", (_name, code) => {
    expect(
      findNativePasswordViolations([file("packages/core/src/auth/oricare.ts", code)]),
    ).toHaveLength(1);
  });

  it("nu se plânge de comentarii, de `crypto.argon2` sau de nume asemănătoare", () => {
    const ok = [
      `// înainte foloseam @node-rs/argon2, acum crypto.argon2`,
      ` * nu se importă "argon2" aici`,
      `import { argon2, randomBytes } from "node:crypto";`,
      `const argon2Params = 1;`,
      `import { hashPassword } from "./password";`,
    ].join("\n");
    expect(findNativePasswordViolations([file("packages/core/src/auth/ok.ts", ok)])).toEqual([]);
  });
});

describe("fără module native pentru parole (sursa reală)", () => {
  const files = realFiles();

  it("scanează sursa reală, nu un set gol", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => f.path === "packages/core/src/auth/password.ts")).toBe(true);
    expect(files.some((f) => f.path === "apps/web/next.config.ts")).toBe(true);
    expect(files.some((f) => f.path === "apps/web/package.json")).toBe(true);
    expect(files.some((f) => f.path === "packages/core/package.json")).toBe(true);
  });

  it("niciun import, dependență sau intrare de configurare nu aduce un modul nativ de parole", () => {
    expect(findNativePasswordViolations(files)).toEqual([]);
  });

  it("parolele folosesc crypto.argon2 din Node", () => {
    const password =
      files.find((f) => f.path === "packages/core/src/auth/password.ts")?.content ?? "";
    expect(password).toMatch(/node:crypto/);
    expect(password).toMatch(/timingSafeEqual/);
  });
});

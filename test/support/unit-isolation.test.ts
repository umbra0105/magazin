import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură: un fișier `*.test.ts` care NU se numește `*.integration.test.ts` rulează în
 * proiectul unitar și nu are voie să importe clienți reali (baza de date, Redis, serviciile
 * aplicației). Incidentul care a dus la această regulă: două teste cu numele greșit
 * (`*.integration.more.test.ts`) au rulat în proiectul unitar și au șters date din baza de dezvoltare.
 */

/** Module a căror importare (runtime) înseamnă acces la baza reală sau la Redis. */
const FORBIDDEN_MODULES = [
  "@ecom/db",
  "ioredis",
  "pg",
  "@prisma/client",
  "@prisma/adapter-pg",
  "../generated/prisma/client",
  "generated/prisma",
];
/** Căi care construiesc clienți reali (singletonurile aplicației). */
const FORBIDDEN_PATH = /(?:^|\/)lib\/services$/;

/**
 * Singurele excepții: testul gărzii (importă pg/ioredis ca să dovedească că NU se pot conecta) și acest
 * fișier (conține mostre de importuri interzise în șiruri).
 */
const ALLOWED = new Set(["test/support/unit-guard.test.ts", "test/support/unit-isolation.test.ts"]);

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".next", ".turbo", "dist", "coverage", "generated"]);

function allTestFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.isDirectory()) {
      if (!SKIP_DIRS.has(name.name)) allTestFiles(join(dir, name.name), out);
    } else if (/\.test\.tsx?$/.test(name.name)) {
      out.push(join(dir, name.name));
    }
  }
  return out;
}

/** Fișierele care rulează în proiectul UNITAR: orice *.test.ts(x) care nu e *.integration.test.ts. */
export function unitTestFiles(): string[] {
  return ["packages", "apps", "test"]
    .flatMap((dir) => allTestFiles(join(REPO_ROOT, dir)))
    .filter((file) => !/\.integration\.test\.tsx?$/.test(file));
}

function integrationTestFiles(): string[] {
  return ["packages", "apps", "test"]
    .flatMap((dir) => allTestFiles(join(REPO_ROOT, dir)))
    .filter((file) => /\.integration\.test\.tsx?$/.test(file));
}

/** Modulele importate la runtime (static, dinamic sau require); `import type` nu se numără. */
export function runtimeImports(source: string): string[] {
  const withoutTypeImports = source
    .replace(/import\s+type\s[^;]*?from\s*["'][^"']+["']/gs, "")
    .replace(/export\s+type\s[^;]*?from\s*["'][^"']+["']/gs, "");
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g, // import x from "m"; export * from "m"
    /\bimport\s*["']([^"']+)["']/g, // import "m"
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // import("m")
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of withoutTypeImports.matchAll(pattern)) specifiers.push(match[1] ?? "");
  }
  return specifiers;
}

export function forbiddenImports(source: string): string[] {
  return runtimeImports(source).filter(
    (specifier) =>
      FORBIDDEN_MODULES.some((m) => specifier === m || specifier.startsWith(`${m}/`)) ||
      FORBIDDEN_PATH.test(specifier),
  );
}

describe("izolarea testelor unitare", () => {
  it("detectorul prinde importurile interzise (nu trece în gol) și lasă tipurile în pace", () => {
    const bad = [
      'import { getDb } from "@ecom/db";',
      'import { Redis } from "ioredis";',
      'import { Client } from "pg";',
      'import { PrismaClient } from "@prisma/client";',
      'import { getBranding } from "@/lib/services";',
      'import { getBranding } from "../../lib/services";',
      'const { getDb } = await import("@ecom/db");',
      'const pg = require("pg");',
      'import {\n  a,\n  b,\n} from "ioredis";',
      'export * from "@ecom/db";',
    ];
    for (const sample of bad) expect(forbiddenImports(sample), sample).not.toEqual([]);

    const fine = [
      'import type { getDb } from "@ecom/db";',
      'import type { Redis } from "ioredis";',
      'import { describe, it } from "vitest";',
      'import { SettingsService } from "@ecom/core";',
      'import { createPrismaFeatureFlagStore } from "./prisma-store";',
      'import { Client } from "pg-connection-string";',
    ];
    for (const sample of fine) expect(forbiddenImports(sample), sample).toEqual([]);
  });

  it("scanează un număr rezonabil de fișiere (unitare și de integrare)", () => {
    expect(unitTestFiles().length).toBeGreaterThan(20);
    expect(integrationTestFiles().length).toBeGreaterThan(8);
  });

  it("niciun test care nu se numește *.integration.test.ts nu importă clienți reali", () => {
    const violations = unitTestFiles().flatMap((file) => {
      if (ALLOWED.has(relative(REPO_ROOT, file).replaceAll("\\", "/"))) return [];
      const found = forbiddenImports(readFileSync(file, "utf8"));
      return found.length > 0
        ? [
            `${relative(REPO_ROOT, file)} importă ${found.join(", ")} (redenumește-l *.integration.test.ts)`,
          ]
        : [];
    });
    expect(violations).toEqual([]);
  });

  it("fișierele de integrare chiar folosesc baza/Redis (regula nu e vidă)", () => {
    const usesRealClients = integrationTestFiles().filter(
      (file) => forbiddenImports(readFileSync(file, "utf8")).length > 0,
    );
    expect(usesRealClients.length).toBeGreaterThan(8);
  });
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AuditService } from "./audit-service";

/** Tipare care ar modifica sau șterge rânduri din audit_log (cod aplicație, SQL brut, migrații). */
const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  {
    name: "Prisma: update/upsert/delete pe auditLog",
    pattern: /\bauditLog\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b/,
  },
  {
    name: "SQL: UPDATE/DELETE FROM/TRUNCATE audit_log",
    // `[\\"]*` acoperă și ghilimelele escapate dintr-un șir TS: "DELETE FROM \"audit_log\"".
    pattern: /\b(update|delete\s+from|truncate(\s+table)?)\s+(only\s+)?[\\"]*audit_log/i,
  },
  { name: "SQL: oprirea triggerelor", pattern: /\b(disable|drop)\s+trigger\b/i },
  { name: "SQL: DROP TABLE audit_log", pattern: /\bdrop\s+table\s+[\\"]*audit_log/i },
];

/**
 * Singura excepție de la «fără oprirea triggerelor»: fixture-ul testelor de stoc oprește TEMPORAR, în tranzacția lui de
 * curățare, triggerul de imuabilitate al registrului de mișcări (stock_movement), singura cale de a șterge mișcările unor
 * variante de test, create de testele de concurență (date comise). Excepția e pe FIȘIER și pe acel trigger EXACT: orice altă
 * oprire de trigger, chiar în același fișier, sau aceeași instrucțiune în alt fișier, tot pică.
 */
const TRIGGER_EXCEPTIONS = new Map<string, RegExp>([
  [
    "packages/core/src/test-utils/stock-fixtures.ts",
    /ALTER TABLE "stock_movement" DISABLE TRIGGER "stock_movement_no_update_delete"/g,
  ],
]);

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".next", ".turbo", "dist", "coverage", "generated"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|mts|sql)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function scanTargets(): string[] {
  const roots = ["packages", "apps"].flatMap((group) =>
    readdirSync(join(REPO_ROOT, group)).map((pkg) => join(REPO_ROOT, group, pkg)),
  );
  return roots.flatMap((root) => sourceFiles(root));
}

function violationsInText(path: string, source: string): string[] {
  const exception = TRIGGER_EXCEPTIONS.get(path);
  const text = exception ? source.replace(exception, "") : source;
  return FORBIDDEN.filter(({ pattern }) => pattern.test(text)).map(
    ({ name }) => `${path}: ${name}`,
  );
}

function violations(files: string[]): string[] {
  return files.flatMap((file) =>
    violationsInText(relative(REPO_ROOT, file).replaceAll("\\", "/"), readFileSync(file, "utf8")),
  );
}

describe("audit_log este doar de adăugare", () => {
  it("detectorul prinde scrierile interzise (nu trece în gol)", () => {
    const samples = [
      "await db.auditLog.update({ where: { id }, data: {} })",
      "await tx.auditLog.deleteMany()",
      "await db.$executeRaw`UPDATE audit_log SET action = 1`",
      'await db.$executeRawUnsafe("DELETE FROM \\"audit_log\\"")',
      "TRUNCATE TABLE audit_log;",
      "ALTER TABLE audit_log DISABLE TRIGGER USER;",
    ];
    for (const sample of samples) {
      expect(
        FORBIDDEN.some(({ pattern }) => pattern.test(sample)),
        sample,
      ).toBe(true);
    }
    expect(FORBIDDEN.some(({ pattern }) => pattern.test("await db.auditLog.create({})"))).toBe(
      false,
    );
  });

  it("excepția pentru fixture-ul de stoc e îngustă: doar acel fișier și doar triggerul stock_movement", () => {
    const fixture = "packages/core/src/test-utils/stock-fixtures.ts";
    const allowed = `ALTER TABLE "stock_movement" DISABLE TRIGGER "stock_movement_no_update_delete"`;
    expect(violationsInText(fixture, allowed)).toEqual([]);
    // aceeași instrucțiune în alt fișier
    expect(violationsInText("packages/core/src/altceva.ts", allowed)).toHaveLength(1);
    // alt trigger, în același fișier
    expect(violationsInText(fixture, 'ALTER TABLE "audit_log" DISABLE TRIGGER USER')).toHaveLength(
      1,
    );
    expect(violationsInText(fixture, `${allowed}; DROP TRIGGER audit_log_no_update`)).toHaveLength(
      1,
    );
  });

  it("niciun fișier din aplicație sau din migrații nu modifică/șterge din audit_log", () => {
    const files = scanTargets();
    expect(files.length).toBeGreaterThan(20);
    expect(violations(files)).toEqual([]);
  });

  it("AuditService expune doar adăugare (record, recordMany) și citire (list): niciun update/delete", () => {
    const methods = Object.getOwnPropertyNames(AuditService.prototype).sort();
    expect(methods).toEqual(["constructor", "list", "record", "recordMany"]);
  });
});

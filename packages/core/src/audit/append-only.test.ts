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

function violations(files: string[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const { name, pattern } of FORBIDDEN) {
      if (pattern.test(text)) found.push(`${relative(REPO_ROOT, file)}: ${name}`);
    }
  }
  return found;
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

  it("niciun fișier din aplicație sau din migrații nu modifică/șterge din audit_log", () => {
    const files = scanTargets();
    expect(files.length).toBeGreaterThan(20);
    expect(violations(files)).toEqual([]);
  });

  it("AuditService expune doar record și list", () => {
    const methods = Object.getOwnPropertyNames(AuditService.prototype).sort();
    expect(methods).toEqual(["constructor", "list", "record"]);
  });
});

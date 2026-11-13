import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Migrări periculoase (docs/20 §6.2). O migrare NOUĂ (cu marcajul de timp după `LAST_SAFE_MIGRATION`) nu are voie să conțină
 * `DROP TABLE`, `DROP COLUMN`, `DROP SCHEMA`, `DROP TYPE`, `DROP DATABASE`, `TRUNCATE` sau `DELETE` fără `WHERE`, decât dacă are
 * adnotarea explicită de aprobare, pusă DUPĂ ce utilizatorul a aprobat:
 *
 *     -- migrare-periculoasa-aprobata: <motiv> (aprobat de utilizator, AAAA-LL-ZZ)
 *
 * O migrare cu pierdere de date e întotdeauna S1: se oprește și se cere aprobarea utilizatorului, nu se adnotează singur.
 * `DROP INDEX`, `DROP CONSTRAINT`, `DROP DEFAULT`, `DROP NOT NULL`, `DROP TRIGGER` etc. nu pierd date și nu sunt cuprinse.
 * Migrările existente la data adoptării modului autonom (până la `LAST_SAFE_MIGRATION`) sunt deja aplicate și nu se rescriu.
 * Citește sursa ca text; `findDangerousStatements` e pură și testată pe SQL sintetic.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS = "packages/db/prisma/migrations";

/** Ultima migrare existentă când s-a adoptat modul autonom (2026-11-13): marcajul ei de timp e pragul. */
export const LAST_SAFE_MIGRATION = "20261105090000";

export const APPROVAL =
  /^--\s*migrare-periculoasa-aprobata:\s*\S.*\(aprobat de utilizator,\s*\d{4}-\d{2}-\d{2}\)\s*$/m;

export interface Finding {
  kind: string;
  statement: string;
}

/** Fără comentarii și fără literale între apostroafe (textul lor nu e SQL executat). */
export function stripSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

const DROPS: readonly { kind: string; pattern: RegExp }[] = [
  { kind: "DROP TABLE", pattern: /\bDROP\s+TABLE\b/i },
  { kind: "DROP COLUMN", pattern: /\bDROP\s+COLUMN\b/i },
  { kind: "DROP SCHEMA", pattern: /\bDROP\s+SCHEMA\b/i },
  { kind: "DROP TYPE", pattern: /\bDROP\s+TYPE\b/i },
  { kind: "DROP DATABASE", pattern: /\bDROP\s+DATABASE\b/i },
  { kind: "TRUNCATE", pattern: /\bTRUNCATE\b/i },
];

/** Instrucțiunile (separate prin «;») care pierd date, în ordinea din fișier. */
export function findDangerousStatements(sql: string): Finding[] {
  const found: Finding[] = [];
  for (const raw of stripSql(sql).split(";")) {
    const statement = raw.trim().replace(/\s+/g, " ");
    if (statement === "") continue;
    for (const { kind, pattern } of DROPS) {
      if (pattern.test(statement)) found.push({ kind, statement });
    }
    if (/^DELETE\s+FROM\b/i.test(statement) && !/\bWHERE\b/i.test(statement)) {
      found.push({ kind: "DELETE fără WHERE", statement });
    }
  }
  return found;
}

export function isApproved(sql: string): boolean {
  return APPROVAL.test(sql);
}

export interface MigrationFile {
  name: string;
  sql: string;
}

export function findDangerousMigrations(
  migrations: readonly MigrationFile[],
  lastSafe: string = LAST_SAFE_MIGRATION,
): string[] {
  const problems: string[] = [];
  for (const migration of migrations) {
    const stamp = migration.name.slice(0, 14);
    if (/^\d{14}$/.test(stamp) && stamp <= lastSafe) continue; // existentă la adoptarea modului autonom
    const findings = findDangerousStatements(migration.sql);
    if (findings.length > 0 && !isApproved(migration.sql)) {
      const kinds = [...new Set(findings.map((finding) => finding.kind))].join(", ");
      problems.push(
        `${migration.name}: ${kinds} fără adnotarea «-- migrare-periculoasa-aprobata: <motiv> (aprobat de utilizator, AAAA-LL-ZZ)»; ` +
          "o migrare cu pierdere de date e S1: se oprește și se cere aprobarea utilizatorului",
      );
    }
  }
  return problems;
}

describe("findDangerousStatements", () => {
  const kinds = (sql: string) => findDangerousStatements(sql).map((f) => f.kind);

  it("prinde DROP TABLE, DROP COLUMN, DROP SCHEMA, DROP TYPE și DROP DATABASE, cu și fără IF EXISTS, în orice literă", () => {
    expect(kinds('DROP TABLE "x";')).toEqual(["DROP TABLE"]);
    expect(kinds("drop table if exists x cascade;")).toEqual(["DROP TABLE"]);
    expect(kinds('ALTER TABLE "x" DROP COLUMN "y";')).toEqual(["DROP COLUMN"]);
    expect(kinds('ALTER TABLE "x" DROP COLUMN IF EXISTS "y";')).toEqual(["DROP COLUMN"]);
    expect(kinds("DROP SCHEMA public;")).toEqual(["DROP SCHEMA"]);
    expect(kinds('DROP TYPE "Mood";')).toEqual(["DROP TYPE"]);
    expect(kinds("DROP DATABASE x;")).toEqual(["DROP DATABASE"]);
  });

  it("prinde TRUNCATE, cu și fără TABLE", () => {
    expect(kinds('TRUNCATE TABLE "x";')).toEqual(["TRUNCATE"]);
    expect(kinds("truncate x, y;")).toEqual(["TRUNCATE"]);
  });

  it("prinde DELETE fără WHERE, dar nu DELETE cu WHERE", () => {
    expect(kinds('DELETE FROM "x";')).toEqual(["DELETE fără WHERE"]);
    expect(kinds("delete from x\n  ;")).toEqual(["DELETE fără WHERE"]);
    expect(kinds("DELETE FROM x WHERE id = 3;")).toEqual([]);
    expect(kinds("delete from x\nwhere created < now();")).toEqual([]);
  });

  it("un DELETE fără WHERE nu e «acoperit» de un WHERE din instrucțiunea următoare", () => {
    expect(kinds('DELETE FROM "a"; UPDATE "b" SET x = 1 WHERE y = 2;')).toEqual([
      "DELETE fără WHERE",
    ]);
  });

  it("nu prinde operațiile care nu pierd date (DROP INDEX, CONSTRAINT, DEFAULT, NOT NULL, TRIGGER, FUNCTION, VIEW)", () => {
    const harmless = [
      'DROP INDEX "x_idx";',
      'ALTER TABLE "x" DROP CONSTRAINT "x_fk";',
      'ALTER TABLE "x" ALTER COLUMN "y" DROP DEFAULT;',
      'ALTER TABLE "x" ALTER COLUMN "y" DROP NOT NULL;',
      'DROP TRIGGER IF EXISTS t ON "x";',
      "DROP FUNCTION f();",
      "DROP VIEW v;",
    ];
    for (const sql of harmless) expect(kinds(sql), sql).toEqual([]);
  });

  it("ignoră cuvintele din comentarii și din literale între apostroafe", () => {
    expect(kinds("-- DROP TABLE x;\nSELECT 1;")).toEqual([]);
    expect(kinds("/* TRUNCATE x; DELETE FROM y; */ SELECT 1;")).toEqual([]);
    expect(kinds("COMMENT ON TABLE x IS 'nu face DROP TABLE y aici';")).toEqual([]);
    expect(kinds("INSERT INTO t VALUES ('it''s a DELETE FROM x');")).toEqual([]);
  });

  it("prinde mai multe în aceeași migrare, în ordinea din fișier", () => {
    expect(kinds('ALTER TABLE "a" DROP COLUMN "b";\nTRUNCATE "c";\nDELETE FROM "d";')).toEqual([
      "DROP COLUMN",
      "TRUNCATE",
      "DELETE fără WHERE",
    ]);
  });
});

describe("adnotarea de aprobare", () => {
  it("cere forma exactă: motiv, «aprobat de utilizator» și data", () => {
    expect(
      isApproved(
        "-- migrare-periculoasa-aprobata: coloana veche nu mai e folosită (aprobat de utilizator, 2026-11-20)\nDROP TABLE x;",
      ),
    ).toBe(true);
  });

  it("nu acceptă adnotări incomplete sau în altă formă", () => {
    for (const note of [
      "-- migrare-periculoasa-aprobata:",
      "-- migrare-periculoasa-aprobata: motiv",
      "-- migrare-periculoasa-aprobata: motiv (aprobat de utilizator)",
      "-- migrare-periculoasa-aprobata: motiv (aprobat de Claude, 2026-11-20)",
      "-- aprobat",
      "migrare-periculoasa-aprobata: motiv (aprobat de utilizator, 2026-11-20)",
      "/* migrare-periculoasa-aprobata: motiv (aprobat de utilizator, 2026-11-20) */",
    ]) {
      expect(isApproved(`${note}\nDROP TABLE x;`), note).toBe(false);
    }
  });
});

describe("findDangerousMigrations", () => {
  const dropSql = 'ALTER TABLE "x" DROP COLUMN "y";';
  const approved = `-- migrare-periculoasa-aprobata: curățenie (aprobat de utilizator, 2026-11-20)\n${dropSql}`;

  it("o migrare nouă periculoasă, fără adnotare, e respinsă", () => {
    const bad = findDangerousMigrations([{ name: "20261201090000_drop_y", sql: dropSql }]);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("20261201090000_drop_y");
    expect(bad[0]).toContain("DROP COLUMN");
  });

  it("o migrare nouă periculoasă, cu adnotare de aprobare, trece", () => {
    expect(findDangerousMigrations([{ name: "20261201090000_drop_y", sql: approved }])).toEqual([]);
  });

  it("o migrare nouă fără operații periculoase trece", () => {
    expect(
      findDangerousMigrations([
        { name: "20261201090000_add_z", sql: 'ALTER TABLE "x" ADD COLUMN "z" INT;' },
      ]),
    ).toEqual([]);
  });

  it("migrările existente (până la prag, inclusiv) nu se judecă", () => {
    expect(findDangerousMigrations([{ name: "20250101000000_old", sql: dropSql }])).toEqual([]);
    expect(
      findDangerousMigrations([{ name: `${LAST_SAFE_MIGRATION}_pragul`, sql: dropSql }]),
    ).toEqual([]);
    expect(
      findDangerousMigrations([{ name: "20261105090001_dupa_prag", sql: dropSql }]),
    ).toHaveLength(1);
  });

  it("prinde fiecare migrare periculoasă dintr-o listă", () => {
    const bad = findDangerousMigrations([
      { name: "20261201090000_a", sql: dropSql },
      { name: "20261202090000_b", sql: 'ALTER TABLE "x" ADD COLUMN "z" INT;' },
      { name: "20261203090000_c", sql: 'TRUNCATE "x";' },
    ]);
    expect(bad).toHaveLength(2);
  });
});

describe("migrările reale", () => {
  it("nicio migrare nouă (după prag) nu are operații periculoase fără adnotare de aprobare", () => {
    const dir = join(root, MIGRATIONS);
    const migrations: MigrationFile[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      migrations.push({
        name: entry.name,
        sql: readFileSync(join(dir, entry.name, "migration.sql"), "utf8"),
      });
    }
    expect(migrations.length).toBeGreaterThan(10);
    expect(findDangerousMigrations(migrations)).toEqual([]);
  });

  it("pragul e chiar ultima migrare existentă (nu se mută fără să se vadă)", () => {
    const names = readdirSync(join(root, MIGRATIONS), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name.slice(0, 14))
      .sort();
    const known = names.filter((name) => name <= LAST_SAFE_MIGRATION);
    expect(known.at(-1)).toBe(LAST_SAFE_MIGRATION);
  });
});

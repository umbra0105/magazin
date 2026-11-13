import { describe, expect, it } from "vitest";
import {
  KEEP_BACKUPS,
  backupFileName,
  backupsToDelete,
  parseDevDatabase,
} from "../../scripts/autonom/backup-core";

describe("copia de siguranță a bazei de dezvoltare: baza permisă", () => {
  it("citește utilizatorul, parola și numele bazei dintr-un URL local de dezvoltare", () => {
    expect(parseDevDatabase("postgresql://ecom:p%40ss@localhost:5432/ecom?schema=public")).toEqual({
      user: "ecom",
      password: "p@ss",
      database: "ecom",
    });
    expect(parseDevDatabase("postgres://u:x@127.0.0.1/mag_dev").database).toBe("mag_dev");
  });

  it("refuză bazele de test (orice nume cu «test», indiferent de litere)", () => {
    for (const name of ["ecom_test", "ecom_ci_test", "TEST_ecom", "ecomTest2"]) {
      expect(() => parseDevDatabase(`postgres://u:x@localhost/${name}`), name).toThrow();
    }
  });

  it("refuză bazele de sistem și serverele care nu sunt locale", () => {
    for (const name of ["postgres", "template0", "template1"]) {
      expect(() => parseDevDatabase(`postgres://u:x@localhost/${name}`), name).toThrow();
    }
    for (const host of ["db.example.com", "10.0.0.5", "prod.internal"]) {
      expect(() => parseDevDatabase(`postgres://u:x@${host}/ecom`), host).toThrow();
    }
  });

  it("refuză un URL care nu e PostgreSQL (alt protocol)", () => {
    for (const url of [
      "mysql://u:x@localhost/ecom",
      "http://u:x@localhost/ecom",
      "redis://u:x@localhost/0",
    ]) {
      expect(() => parseDevDatabase(url), url).toThrow();
    }
  });

  it("refuză un URL gol sau stricat, fără să tipărească parola în mesaj", () => {
    expect(() => parseDevDatabase("")).toThrow();
    expect(() => parseDevDatabase("nu e un url")).toThrow();
    let message = "";
    try {
      parseDevDatabase("postgres://u:parola-secreta@localhost/ecom_test");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("parola-secreta");
  });

  it("refuză o bază fără nume sau fără utilizator", () => {
    expect(() => parseDevDatabase("postgres://u:x@localhost/")).toThrow();
    expect(() => parseDevDatabase("postgres://:x@localhost/ecom")).toThrow();
  });
});

describe("numele fișierului de copie", () => {
  it("<baza>-AAAALLZZ-OOMMSS.sql, în UTC (se sortează cronologic după nume)", () => {
    expect(backupFileName("ecom", new Date("2026-11-13T09:05:07.000Z"))).toBe(
      "ecom-20261113-090507.sql",
    );
    expect(backupFileName("ecom", new Date("2026-01-02T23:59:59.999Z"))).toBe(
      "ecom-20260102-235959.sql",
    );
  });
});

describe("păstrarea ultimelor 5 copii", () => {
  const file = (day: number) => `ecom-202611${String(day).padStart(2, "0")}-100000.sql`;

  it("păstrează implicit 5", () => {
    expect(KEEP_BACKUPS).toBe(5);
  });

  it("cu cel mult 5 copii nu șterge nimic", () => {
    expect(backupsToDelete([file(1), file(2), file(3)], "ecom")).toEqual([]);
    expect(backupsToDelete([1, 2, 3, 4, 5].map(file), "ecom")).toEqual([]);
  });

  it("peste 5, șterge cele mai vechi (după timpul din nume, nu după ordinea listei)", () => {
    const names = [9, 1, 7, 3, 5, 2, 8, 4, 6].map(file);
    expect(backupsToDelete(names, "ecom").sort()).toEqual([1, 2, 3, 4].map(file));
  });

  it("nu atinge fișiere care nu sunt copii ale acestei baze (alte nume, alte extensii, alte baze)", () => {
    const names = [
      ...[1, 2, 3, 4, 5, 6, 7].map(file),
      "ecom-test-20260101-000000.sql",
      "alta-20260101-000000.sql",
      "ecom-20260101-000000.sql.bak",
      "ecom-20260101.sql",
      "NOTE.txt",
      "ecom-latest.sql",
    ];
    expect(backupsToDelete(names, "ecom").sort()).toEqual([file(1), file(2)]);
  });

  it("se poate cere alt număr de păstrat, dar niciodată sub 1 (nu șterge toate copiile)", () => {
    const names = [1, 2, 3].map(file);
    expect(backupsToDelete(names, "ecom", 1).sort()).toEqual([file(1), file(2)]);
    expect(() => backupsToDelete(names, "ecom", 0)).toThrow();
  });
});

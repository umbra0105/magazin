import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { inRolledBackTransaction } from "../test-utils/rollback";
import { sirutaCheckDigit } from "./siruta-check";
import {
  CHECK_DIGIT_EXCEPTION_REASON,
  SirutaImportError,
  toDerivedFile,
  type SirutaRow,
} from "./siruta-data";
import { GeoService, importSirutaDerived } from "./siruta-store";

const db = getDb();
afterAll(async () => {
  await db.$disconnect();
});

const META = {
  source: "INS (test)",
  version: "TEST 1",
  licence: "CC BY 4.0",
  licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
  attribution: "set fictiv de test",
  modifications: "Date modificate: set fictiv",
};

const ok = (unique: number): number => unique * 10 + sirutaCheckDigit(unique);
const bad = (unique: number): number => unique * 10 + ((sirutaCheckDigit(unique) + 1) % 10);

// Set fictiv: un județ obișnuit (JUD 98) și Municipiul București (JUD 40) cu cele 6 sectoare. Codurile sunt în afara
// celor reale (cifre mari) ca să nu se lovească de un nomenclator deja încărcat în baza de test.
const COUNTY = ok(80_001);
const UAT = ok(80_002);
const UAT_BAD = bad(80_003);
const VILLAGE_A = ok(80_004);
const VILLAGE_B = ok(80_005);
const VILLAGE_C = ok(80_006);
const BUC = ok(80_010);
const BUC_MUN = ok(80_011);

function fictiveRows(): SirutaRow[] {
  const rows: SirutaRow[] = [
    { code: COUNTY, countyCode: 98, name: "JUDEȚUL TEST", parentCode: null, tip: 40, level: 1 },
    { code: UAT, countyCode: 98, name: "COMUNA UNU", parentCode: COUNTY, tip: 3, level: 2 },
    { code: UAT_BAD, countyCode: 98, name: "COMUNA DOI", parentCode: COUNTY, tip: 3, level: 2 },
    {
      code: VILLAGE_A,
      countyCode: 98,
      name: "VALEA LUI MIHAI",
      parentCode: UAT,
      tip: 22,
      level: 3,
    },
    { code: VILLAGE_B, countyCode: 98, name: "SAT COMUN", parentCode: UAT, tip: 23, level: 3 },
    { code: VILLAGE_C, countyCode: 98, name: "SAT COMUN", parentCode: UAT_BAD, tip: 23, level: 3 },
    {
      code: BUC,
      countyCode: 40,
      name: "MUNICIPIUL BUCUREȘTI",
      parentCode: null,
      tip: 40,
      level: 1,
    },
    {
      code: BUC_MUN,
      countyCode: 40,
      name: "MUNICIPIUL BUCUREȘTI",
      parentCode: BUC,
      tip: 1,
      level: 2,
    },
  ];
  for (let i = 1; i <= 6; i++) {
    rows.push({
      code: ok(80_020 + i),
      countyCode: 40,
      name: `BUCUREȘTI SECTORUL ${i}`,
      parentCode: BUC_MUN,
      tip: 6,
      level: 3,
    });
  }
  return rows;
}

function fictiveFile(rows = fictiveRows()) {
  const exception = rows.find((r) => r.code === UAT_BAD) as SirutaRow;
  return toDerivedFile(
    rows,
    [
      {
        code: exception.code,
        name: exception.name,
        parentCode: exception.parentCode,
        tip: exception.tip,
        reason: CHECK_DIGIT_EXCEPTION_REASON,
      },
    ],
    META,
  );
}

const plain = (file: ReturnType<typeof fictiveFile>): unknown => JSON.parse(JSON.stringify(file));

describe("importul SIRUTA în baza de date", () => {
  it("încarcă setul și e idempotent (a doua rulare nu schimbă nimic)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const before = await tx.sirutaUnit.count();
      const first = await importSirutaDerived(tx, plain(fictiveFile()));
      expect(first.inserted).toBe(14);
      expect(await tx.sirutaUnit.count()).toBe(before + 14);
      const second = await importSirutaDerived(tx, plain(fictiveFile()));
      expect(second).toMatchObject({ inserted: 0, updated: 0, deactivated: 0, unchanged: 14 });
    });
  });

  it("o versiune nouă: actualizează, adaugă și dezactivează rândurile dispărute (nu le șterge)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await importSirutaDerived(tx, plain(fictiveFile()));
      const next = fictiveRows().filter((r) => r.code !== VILLAGE_C);
      (next.find((r) => r.code === VILLAGE_A) as SirutaRow).name = "VALEA LUI MIHAIL";
      const result = await importSirutaDerived(tx, plain(fictiveFile(next)));
      expect(result).toMatchObject({ inserted: 0, updated: 1, deactivated: 1 });
      const gone = await tx.sirutaUnit.findUniqueOrThrow({ where: { code: VILLAGE_C } });
      expect(gone.isActive).toBe(false);
      // dispare din liste, dar rândul rămâne (adresele vechi păstrează codul)
      const geo = new GeoService(tx);
      const names = (await geo.localities(98)).map((l) => l.name);
      expect(names).toEqual(["Sat Comun", "Valea lui Mihail"]);
      // reapare într-o versiune ulterioară: reactivat
      const back = await importSirutaDerived(tx, plain(fictiveFile()));
      expect(back.reactivated).toBe(1);
    });
  });

  it("un cod cu cifra greșită în afara listei respinge TOT: nu se scrie nimic", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const rows = fictiveRows();
      rows.push({
        code: bad(80_099),
        countyCode: 98,
        name: "SAT GREȘIT",
        parentCode: UAT,
        tip: 23,
        level: 3,
      });
      const before = await tx.sirutaUnit.count();
      await expect(importSirutaDerived(tx, plain(fictiveFile(rows)))).rejects.toBeInstanceOf(
        SirutaImportError,
      );
      expect(await tx.sirutaUnit.count()).toBe(before);
    });
  });

  it("o excepție cu numele schimbat respinge tot", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const file = fictiveFile();
      const rows = fictiveRows();
      (rows.find((r) => r.code === UAT_BAD) as SirutaRow).name = "COMUNA ALTCEVA";
      const tampered = { ...file, rows: fictiveFile(rows).rows };
      const before = await tx.sirutaUnit.count();
      await expect(importSirutaDerived(tx, plain(tampered))).rejects.toBeInstanceOf(
        SirutaImportError,
      );
      expect(await tx.sirutaUnit.count()).toBe(before);
    });
  });
});

describe("GeoService (citirea pentru checkout)", () => {
  it("listează județele cu nume de afișare, sortate, fără «Județul»", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await importSirutaDerived(tx, plain(fictiveFile()));
      const counties = await new GeoService(tx).counties();
      const names = counties.map((c) => c.name);
      expect(names).toContain("Test");
      expect(names).toContain("București");
      expect(names.indexOf("București")).toBeLessThan(names.indexOf("Test"));
      expect(counties.find((c) => c.code === 98)?.name).toBe("Test");
    });
  });

  it("sectoarele 1–6 ale Bucureștiului sunt selectabile ca localitate", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await importSirutaDerived(tx, plain(fictiveFile()));
      const geo = new GeoService(tx);
      const localities = await geo.localities(40);
      expect(localities.map((l) => l.name)).toEqual([
        "București Sectorul 1",
        "București Sectorul 2",
        "București Sectorul 3",
        "București Sectorul 4",
        "București Sectorul 5",
        "București Sectorul 6",
      ]);
      const sector = localities[0];
      expect(await geo.resolveLocation(40, sector!.code)).toEqual({
        countyName: "București",
        localityName: "București Sectorul 1",
      });
    });
  });

  it("nume identice în aceeași localitate administrativă diferită primesc contextul comunei", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await importSirutaDerived(tx, plain(fictiveFile()));
      const labels = (await new GeoService(tx).localities(98)).map((l) => l.label);
      expect(labels).toEqual([
        "Sat Comun (Comuna Doi)",
        "Sat Comun (Comuna Unu)",
        "Valea lui Mihai",
      ]);
    });
  });

  it("refuză o localitate din alt județ, un cod care nu e localitate sau unul inexistent", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await importSirutaDerived(tx, plain(fictiveFile()));
      const geo = new GeoService(tx);
      await expect(geo.resolveLocation(40, VILLAGE_A)).rejects.toThrow();
      await expect(geo.resolveLocation(98, UAT)).rejects.toThrow(); // UAT, nu localitate
      await expect(geo.resolveLocation(98, 1)).rejects.toThrow();
      await expect(geo.resolveLocation(97, VILLAGE_A)).rejects.toThrow();
      await expect(geo.resolveLocation(98, VILLAGE_A)).resolves.toMatchObject({
        localityName: "Valea lui Mihai",
      });
    });
  });
});

describe("fișierul derivat real din repo (într-o tranzacție anulată)", () => {
  it("se încarcă întreg: 42 de județe, 6 sectoare selectabile în București, 13.755 de localități", async () => {
    const file = JSON.parse(
      readFileSync(new URL("../../data/siruta/siruta-s1-2026.json", import.meta.url), "utf8"),
    ) as unknown;
    await inRolledBackTransaction(db, async (tx) => {
      const result = await importSirutaDerived(tx, file);
      expect(result.version).toBe("S1 2026");
      const geo = new GeoService(tx);
      const counties = await geo.counties();
      expect(counties).toHaveLength(42);
      const bucharest = counties.find((c) => c.name === "București");
      expect(bucharest?.code).toBe(40);
      const sectors = (await geo.localities(40)).filter((l) =>
        l.name.startsWith("București Sector"),
      );
      expect(sectors).toHaveLength(6);
      const total = await tx.sirutaUnit.count({ where: { level: 3, isActive: true } });
      expect(total).toBeGreaterThanOrEqual(13_755);
    });
  }, 120_000);
});

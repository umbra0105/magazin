import { describe, expect, it } from "vitest";
import { sirutaCheckDigit } from "./siruta-check";
import {
  CHECK_DIGIT_EXCEPTION_REASON,
  SirutaImportError,
  diffSiruta,
  findCheckDigitFailures,
  fromDerivedFile,
  parseSirutaCsv,
  toDerivedFile,
  validateSirutaRows,
  type CheckDigitException,
  type SirutaRow,
} from "./siruta-data";

/** Cod fictiv cu cifra de control corectă, din «numărul unic». */
const ok = (unique: number): number => unique * 10 + sirutaCheckDigit(unique);
/** Cod fictiv cu cifra de control GREȘITĂ. */
const bad = (unique: number): number => unique * 10 + ((sirutaCheckDigit(unique) + 1) % 10);

const COUNTY = ok(100);
const UAT = ok(101);
const UAT_BAD = bad(102);
const VILLAGE = ok(103);
const VILLAGE_BAD = bad(104);

function fixture(): SirutaRow[] {
  return [
    { code: COUNTY, countyCode: 1, name: "JUDEȚUL TEST", parentCode: null, tip: 40, level: 1 },
    { code: UAT, countyCode: 1, name: "COMUNA UNU", parentCode: COUNTY, tip: 3, level: 2 },
    { code: UAT_BAD, countyCode: 1, name: "COMUNA DOI", parentCode: COUNTY, tip: 3, level: 2 },
    { code: VILLAGE, countyCode: 1, name: "SAT TREI", parentCode: UAT, tip: 22, level: 3 },
    { code: VILLAGE_BAD, countyCode: 1, name: "SAT PATRU", parentCode: UAT_BAD, tip: 23, level: 3 },
  ];
}

const exceptionFor = (row: SirutaRow): CheckDigitException => ({
  code: row.code,
  name: row.name,
  parentCode: row.parentCode,
  tip: row.tip,
  reason: CHECK_DIGIT_EXCEPTION_REASON,
});

/** Excepțiile corecte pentru cele două coduri cu cifra greșită din fixture. */
function validExceptions(): CheckDigitException[] {
  const rows = fixture();
  return [exceptionFor(rows[2] as SirutaRow), exceptionFor(rows[4] as SirutaRow)];
}

function problemsOf(fn: () => void): readonly string[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SirutaImportError);
    return (error as SirutaImportError).problems;
  }
  return [];
}

describe("parseSirutaCsv", () => {
  const header = "SIRUTA;DENLOC;CODP;JUD;SIRSUP;TIP;NIV;MED;REGIUNE;FSJ;NUTS;LAU";

  it("citește BOM, CRLF și normalizează diacriticele la ș/ț", () => {
    const text = `\uFEFF${header}\r\n10;JUDEŢUL ALBA;0;1;1;40;1;0;7;1;RO121;\r\n1017;MUNICIPIUL ALBA IULIA;0;1;10;1;2;1;7;1;RO121;RO_1017\r\n`;
    expect(parseSirutaCsv(text)).toEqual([
      { code: 10, countyCode: 1, name: "JUDEȚUL ALBA", parentCode: null, tip: 40, level: 1 },
      {
        code: 1017,
        countyCode: 1,
        name: "MUNICIPIUL ALBA IULIA",
        parentCode: 10,
        tip: 1,
        level: 2,
      },
    ]);
  });

  it("nu păstrează codul poștal (CODP) în rezultat", () => {
    const rows = parseSirutaCsv(`${header}\n10;JUDEȚUL ALBA;510005;1;1;40;1;0;7;1;RO121;\n`);
    expect(JSON.stringify(rows)).not.toContain("510005");
  });

  it("refuză un antet fără una dintre coloanele necesare", () => {
    expect(() => parseSirutaCsv("SIRUTA;DENLOC;JUD;SIRSUP;TIP\n10;A;1;1;40\n")).toThrow(
      SirutaImportError,
    );
  });

  it("refuză un rând cu valori care nu sunt numere sau cu nume gol, cu numărul rândului", () => {
    const problems = problemsOf(() =>
      parseSirutaCsv(`${header}\nabc;X;0;1;1;40;1;0;7;1;;\n20;;0;1;1;40;1;0;7;1;;\n`),
    );
    expect(problems.some((p) => p.includes("rândul 2"))).toBe(true);
    expect(problems.some((p) => p.includes("rândul 3"))).toBe(true);
  });

  it("refuză un nivel în afara 1–3", () => {
    const problems = problemsOf(() => parseSirutaCsv(`${header}\n10;A;0;1;1;40;4;0;7;1;;\n`));
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe("validateSirutaRows: cifra de control și excepțiile", () => {
  it("fără excepții, codurile cu cifra greșită resping importul", () => {
    expect(problemsOf(() => validateSirutaRows(fixture(), []))).toHaveLength(2);
  });

  it("acceptă exact codurile din listă, cu tuplul identic", () => {
    expect(() => validateSirutaRows(fixture(), validExceptions())).not.toThrow();
  });

  it("o excepție cu NUMELE schimbat în fișier respinge tot", () => {
    const rows = fixture();
    (rows[2] as SirutaRow).name = "COMUNA ALTCEVA";
    const problems = problemsOf(() => validateSirutaRows(rows, validExceptions()));
    expect(problems.some((p) => p.includes(String(UAT_BAD)))).toBe(true);
  });

  it("o excepție cu PĂRINTELE schimbat respinge tot", () => {
    const rows = fixture();
    (rows[4] as SirutaRow).parentCode = UAT;
    expect(problemsOf(() => validateSirutaRows(rows, validExceptions())).length).toBeGreaterThan(0);
  });

  it("o excepție cu TIPUL schimbat respinge tot", () => {
    const rows = fixture();
    (rows[2] as SirutaRow).tip = 4;
    expect(problemsOf(() => validateSirutaRows(rows, validExceptions())).length).toBeGreaterThan(0);
  });

  it("un cod greșit în afara listei respinge tot, chiar dacă restul sunt excepții valide", () => {
    const exceptions = validExceptions().slice(0, 1); // lipsește VILLAGE_BAD
    const problems = problemsOf(() => validateSirutaRows(fixture(), exceptions));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(String(VILLAGE_BAD));
  });

  it("o excepție al cărei cod nu mai apare în fișier NU respinge importul (apare în raportul de diferențe)", () => {
    const rows = fixture().slice(0, 2); // fără cele două coduri greșite
    expect(() => validateSirutaRows(rows, validExceptions())).not.toThrow();
  });

  it("un cod duplicat respinge importul", () => {
    const rows = fixture();
    rows.push({ ...(rows[1] as SirutaRow) });
    expect(problemsOf(() => validateSirutaRows(rows, validExceptions())).length).toBeGreaterThan(0);
  });

  it("raportează TOATE problemele, nu doar prima", () => {
    const rows = fixture();
    rows.push({
      code: ok(105),
      countyCode: 1,
      name: "ORFAN",
      parentCode: ok(999),
      tip: 22,
      level: 3,
    });
    expect(problemsOf(() => validateSirutaRows(rows, [])).length).toBeGreaterThanOrEqual(3);
  });
});

describe("validateSirutaRows: ierarhia", () => {
  it("județul nu are părinte, UAT-ul are județ, localitatea are UAT", () => {
    expect(() => validateSirutaRows(fixture(), validExceptions())).not.toThrow();
  });

  it("respinge un UAT cu părinte inexistent", () => {
    const rows = fixture();
    (rows[1] as SirutaRow).parentCode = ok(777);
    expect(problemsOf(() => validateSirutaRows(rows, validExceptions())).length).toBeGreaterThan(0);
  });

  it("respinge o localitate cu părinte de nivel greșit (direct sub județ)", () => {
    const rows = fixture();
    (rows[3] as SirutaRow).parentCode = COUNTY;
    expect(problemsOf(() => validateSirutaRows(rows, validExceptions())).length).toBeGreaterThan(0);
  });

  it("respinge o localitate al cărei județ diferă de al părintelui", () => {
    const rows = fixture();
    (rows[3] as SirutaRow).countyCode = 2;
    expect(problemsOf(() => validateSirutaRows(rows, validExceptions())).length).toBeGreaterThan(0);
  });

  it("respinge un județ cu părinte", () => {
    const rows = fixture();
    (rows[0] as SirutaRow).parentCode = UAT;
    expect(problemsOf(() => validateSirutaRows(rows, validExceptions())).length).toBeGreaterThan(0);
  });
});

describe("findCheckDigitFailures", () => {
  it("întoarce doar rândurile cu cifra greșită", () => {
    expect(findCheckDigitFailures(fixture()).map((r) => r.code)).toEqual([UAT_BAD, VILLAGE_BAD]);
  });
});

describe("diffSiruta (raportul versiunii noi)", () => {
  it("fără schimbări, raportul e gol", () => {
    const diff = diffSiruta(fixture(), validExceptions(), fixture());
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.exceptions).toEqual({ added: [], removed: [], changed: [] });
  });

  it("raportează rândurile noi, dispărute, redenumite", () => {
    const next = fixture();
    next.push({
      code: ok(106),
      countyCode: 1,
      name: "SAT NOU",
      parentCode: UAT,
      tip: 23,
      level: 3,
    });
    const removed = next.splice(3, 1)[0] as SirutaRow; // VILLAGE dispare
    (next[1] as SirutaRow).name = "COMUNA UNU REDENUMITĂ";
    const diff = diffSiruta(fixture(), validExceptions(), next);
    expect(diff.added.map((r) => r.code)).toEqual([ok(106)]);
    expect(diff.removed.map((r) => r.code)).toEqual([removed.code]);
    expect(diff.changed.map((c) => [c.code, c.fields])).toEqual([[UAT, ["name"]]]);
  });

  it("raportează rândurile mutate (părinte) și cu alt tip", () => {
    const next = fixture();
    (next[3] as SirutaRow).parentCode = UAT_BAD;
    (next[1] as SirutaRow).tip = 4;
    const diff = diffSiruta(fixture(), validExceptions(), next);
    expect(diff.changed.map((c) => [c.code, c.fields]).sort()).toEqual(
      [
        [UAT, ["tip"]],
        [VILLAGE, ["parentCode"]],
      ].sort(),
    );
  });

  it("raportează excepțiile noi, dispărute și schimbate (decizia rămâne a utilizatorului)", () => {
    const next = fixture();
    next.push({
      code: bad(110),
      countyCode: 1,
      name: "SAT NOU GREȘIT",
      parentCode: UAT,
      tip: 23,
      level: 3,
    });
    next.splice(2, 1); // UAT_BAD dispare -> excepție dispărută
    (next.find((r) => r.code === VILLAGE_BAD) as SirutaRow).parentCode = UAT; // excepție schimbată
    const diff = diffSiruta(fixture(), validExceptions(), next);
    expect(diff.exceptions.added.map((r) => r.code)).toEqual([bad(110)]);
    expect(diff.exceptions.removed.map((e) => e.code)).toEqual([UAT_BAD]);
    expect(diff.exceptions.changed.map((c) => c.code)).toEqual([VILLAGE_BAD]);
  });
});

describe("fișierul derivat", () => {
  const meta = {
    source: "INS",
    version: "S1 2026",
    licence: "CC BY 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
    attribution: "Institutul Național de Statistică (INS), registrul SIRUTA, semestrul 1 din 2026",
    modifications: "Date modificate: coloane selectate, diacritice normalizate",
  };

  it("dus-întors păstrează rândurile și excepțiile", () => {
    const file = toDerivedFile(fixture(), validExceptions(), meta);
    const parsed = fromDerivedFile(JSON.parse(JSON.stringify(file)));
    expect(parsed.rows).toEqual(fixture());
    expect(parsed.exceptions).toEqual(validExceptions());
    expect(parsed.meta.version).toBe("S1 2026");
  });

  it("un fișier derivat fără atribuire e respins", () => {
    const broken = JSON.parse(JSON.stringify(toDerivedFile(fixture(), [], meta)));
    delete broken.meta.attribution;
    expect(() => fromDerivedFile(broken)).toThrow();
  });

  it("un fișier derivat cu o excepție fără motivul oficial e respins", () => {
    const rows = fixture();
    const file = toDerivedFile(
      rows,
      [{ ...exceptionFor(rows[2] as SirutaRow), reason: "oricum" }],
      meta,
    );
    expect(() => fromDerivedFile(JSON.parse(JSON.stringify(file)))).toThrow();
  });

  it("nu poartă codul poștal", () => {
    expect(JSON.stringify(toDerivedFile(fixture(), [], meta))).not.toMatch(/CODP|postal/i);
  });
});

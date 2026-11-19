import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHECK_DIGIT_EXCEPTION_REASON,
  findCheckDigitFailures,
  fromDerivedFile,
  validateSirutaRows,
} from "./siruta-data";
import { displayName } from "./siruta-names";

/** Fișierul derivat din repo (singurul cu date reale pe care îl citesc testele; fișierul brut rămâne în `local-data/`). */
const FILE = new URL("../../data/siruta/siruta-s1-2026.json", import.meta.url);
const derived = fromDerivedFile(JSON.parse(readFileSync(FILE, "utf8")));

describe("fișierul derivat SIRUTA din repo (S1 2026)", () => {
  it("are numărătoarea oficială: 42 de județe, 3.181 de UAT-uri, 13.755 de localități", () => {
    const count = (level: number) => derived.rows.filter((r) => r.level === level).length;
    expect([count(1), count(2), count(3)]).toEqual([42, 3181, 13_755]);
    expect(derived.rows).toHaveLength(16_978);
  });

  it("trece validarea completă (ierarhie și cifra de control, cu excepțiile din listă)", () => {
    expect(() => validateSirutaRows(derived.rows, derived.exceptions)).not.toThrow();
  });

  it("lista de excepții are exact codurile cu cifra greșită, fiecare cu motivul oficial", () => {
    const failures = findCheckDigitFailures(derived.rows)
      .map((r) => r.code)
      .sort((a, b) => a - b);
    const listed = derived.exceptions.map((e) => e.code).sort((a, b) => a - b);
    expect(listed).toEqual(failures);
    expect(listed).toHaveLength(77);
    for (const e of derived.exceptions) expect(e.reason).toBe(CHECK_DIGIT_EXCEPTION_REASON);
  });

  it("cele 6 sectoare ale Municipiului București există ca localități (nivelul 3, TIP 6)", () => {
    const sectors = derived.rows.filter((r) => r.tip === 6);
    expect(sectors).toHaveLength(6);
    expect(sectors.every((s) => s.level === 3 && s.countyCode === 40)).toBe(true);
    expect(sectors.map((s) => displayName(s.name)).sort()).toEqual([
      "București Sectorul 1",
      "București Sectorul 2",
      "București Sectorul 3",
      "București Sectorul 4",
      "București Sectorul 5",
      "București Sectorul 6",
    ]);
  });

  it("diacriticele sunt normalizate: niciun ş/ţ cu sedilă în nume", () => {
    expect(derived.rows.some((r) => /[ŞşŢţ]/.test(r.name))).toBe(false);
    expect(derived.rows.some((r) => /[ȘȚ]/.test(r.name))).toBe(true);
  });

  it("poartă atribuirea CC BY 4.0, linkul licenței și mențiunea modificărilor (cerute de licență)", () => {
    expect(derived.meta.licence).toBe("CC BY 4.0");
    expect(derived.meta.licenceUrl).toBe("https://creativecommons.org/licenses/by/4.0/");
    expect(derived.meta.attribution).toBe(
      "Institutul Național de Statistică (INS), registrul SIRUTA, semestrul 1 din 2026",
    );
    expect(derived.meta.modifications).toContain(
      "Date modificate: coloane selectate, diacritice normalizate",
    );
    // nicio formulare care să sugereze susținerea din partea INS
    expect(derived.meta.modifications).not.toMatch(/susținut de|în parteneriat|aprobat de INS/i);
  });

  it("nu conține coduri poștale", () => {
    const raw = readFileSync(FILE, "utf8");
    expect(raw).not.toMatch(/CODP|cod poștal/i);
  });

  it("atribuirea e în THIRD-PARTY-NOTICES.md, cu credit, link la licență și mențiunea modificărilor", () => {
    const notices = readFileSync(
      new URL("../../../../THIRD-PARTY-NOTICES.md", import.meta.url),
      "utf8",
    );
    expect(notices).toContain(derived.meta.attribution);
    expect(notices).toContain(derived.meta.licenceUrl);
    expect(notices).toContain("Date modificate: coloane selectate, diacritice normalizate");
    expect(notices).not.toMatch(/susținut de INS(?!.)|în parteneriat cu INS/i);
  });
});

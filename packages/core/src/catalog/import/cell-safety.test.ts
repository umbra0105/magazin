import { describe, expect, it } from "vitest";
import { neutralizeCell, restoreCell, restoredText } from "./cell-safety";

const TAB = String.fromCharCode(9);
const CR = String.fromCharCode(13);

describe("neutralizarea formulelor la export", () => {
  it("pune un apostrof în fața textelor care încep cu =, +, -, @, tab sau CR", () => {
    for (const value of [
      "=SUM(A1)",
      '=HYPERLINK("http://x";"y")',
      "+40 722 123 456",
      "-5°C",
      "@utilizator",
      `${TAB}text`,
      `${CR}text`,
      "-",
    ]) {
      expect(neutralizeCell(value), value).toBe(`'${value}`);
    }
  });

  it("nu atinge textele obișnuite", () => {
    for (const value of [
      "Pompă",
      "",
      " =spațiu înainte",
      "5-6",
      "a=b",
      "'salut",
      "ț ș ă",
      "100%",
    ]) {
      expect(neutralizeCell(value), value).toBe(value);
    }
  });

  it("un text care începe deja cu apostrof și apoi cu un caracter periculos primește încă un apostrof", () => {
    expect(neutralizeCell("'=x")).toBe("''=x");
    expect(neutralizeCell("''-1")).toBe("'''-1");
  });

  it("rezultatul neutralizat nu începe niciodată cu un caracter periculos", () => {
    for (const value of ["=a", "+a", "-a", "@a", `${TAB}a`, `${CR}a`, "'=a"]) {
      expect(/^[=+\-@\t\r]/.test(neutralizeCell(value)), value).toBe(false);
    }
  });
});

describe("restaurarea la import", () => {
  it("scoate UN apostrof doar când urmează un caracter periculos", () => {
    expect(restoreCell("'=SUM(A1)")).toBe("=SUM(A1)");
    expect(restoreCell("'-")).toBe("-");
    expect(restoreCell("''=x")).toBe("'=x");
    expect(restoreCell("'@utilizator")).toBe("@utilizator");
  });

  it("nu atinge ce n-a putut fi pus de export", () => {
    for (const value of ["'salut", "Pompă", "=SUM(A1)", "-", "", "'", "'5"]) {
      expect(restoreCell(value), value).toBeNull();
      expect(restoredText(value), value).toBe(value);
    }
  });
});

describe("dus-întors pe orice text", () => {
  it("restaurarea inversează neutralizarea pentru toate șirurile scurte dintr-un alfabet greu", () => {
    const alphabet = ["'", "=", "+", "-", "@", "a", " ", TAB, CR];
    let checked = 0;
    const walk = (prefix: string, depth: number): void => {
      const value = prefix;
      expect(restoredText(neutralizeCell(value)), JSON.stringify(value)).toBe(value);
      checked += 1;
      if (depth === 0) return;
      for (const ch of alphabet) walk(prefix + ch, depth - 1);
    };
    walk("", 5);
    expect(checked).toBeGreaterThan(50_000);
  });
});

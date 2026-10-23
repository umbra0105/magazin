import { describe, expect, it } from "vitest";
import { allowedDirections, composeQuantity, directionFor, validateAmount } from "./stock-form";

/** Logica pură a formularului «Ajustează» (fără componente): sensul după motiv, validarea cantității, textul trimis. */

describe("sensul permis de motiv", () => {
  it("motivele care scad permit doar «Scade», cel care adaugă doar «Adaugă», restul ambele", () => {
    expect(allowedDirections("decrease")).toEqual(["subtract"]);
    expect(allowedDirections("increase")).toEqual(["add"]);
    expect(allowedDirections("either")).toEqual(["subtract", "add"]);
  });

  it("la schimbarea motivului sensul curent se păstrează dacă e permis, altfel se alege singurul permis", () => {
    expect(directionFor("either", "add")).toBe("add");
    expect(directionFor("either", "subtract")).toBe("subtract");
    expect(directionFor("decrease", "add")).toBe("subtract");
    expect(directionFor("increase", "subtract")).toBe("add");
    expect(directionFor("decrease", "subtract")).toBe("subtract");
  });
});

describe("cantitatea introdusă (fără semn: sensul e ales separat)", () => {
  it("accepte numere cu virgulă sau punct, în limita zecimalelor unității", () => {
    expect(validateAmount("3", 0)).toEqual({ ok: true, normalized: "3" });
    expect(validateAmount("2,5", 1)).toEqual({ ok: true, normalized: "2,5" });
    expect(validateAmount("2.5", 2)).toEqual({ ok: true, normalized: "2.5" });
    expect(validateAmount("  41,25 ", 2)).toEqual({ ok: true, normalized: "41,25" });
    expect(validateAmount("0,0001", 4)).toEqual({ ok: true, normalized: "0,0001" });
  });

  it("zerourile de la coadă nu contează la zecimale: «2,50» e bun la o unitate cu 1 zecimală", () => {
    expect(validateAmount("2,50", 1).ok).toBe(true);
    expect(validateAmount("3,0", 0).ok).toBe(true);
    expect(validateAmount("2,51", 1)).toEqual({ ok: false, error: "decimals" });
    expect(validateAmount("0,5", 0)).toEqual({ ok: false, error: "decimals" });
  });

  it("gol, zero și text care nu e număr", () => {
    expect(validateAmount("", 2)).toEqual({ ok: false, error: "required" });
    expect(validateAmount("   ", 2)).toEqual({ ok: false, error: "required" });
    for (const zero of ["0", "0,00", "0.0", "000"]) {
      expect(validateAmount(zero, 2), zero).toEqual({ ok: false, error: "zero" });
    }
    for (const bad of ["abc", "-3", "+3", "1,2,3", "1 000", "12 buc", ",5", "5,", "1e3", "٣"]) {
      expect(validateAmount(bad, 2), bad).toEqual({ ok: false, error: "invalid" });
    }
  });

  it("prea lung (peste plafonul de 40 de caractere) se refuză", () => {
    expect(validateAmount("1".repeat(41), 0)).toEqual({ ok: false, error: "invalid" });
  });
});

describe("cantitatea trimisă la server", () => {
  it("«Adaugă» → +, «Scade» → −, cu virgula neschimbată", () => {
    expect(composeQuantity("add", "2,5")).toBe("+2,5");
    expect(composeQuantity("subtract", "2,5")).toBe("-2,5");
    expect(composeQuantity("subtract", "3")).toBe("-3");
  });
});

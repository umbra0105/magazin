import { describe, expect, it } from "vitest";
import {
  PHASE_MODES,
  branchOf,
  isValidPhaseId,
  modeOf,
  tagsOf,
} from "../../scripts/autonom/phases";

/** Tabelul din docs/20 §3, scris a doua oară aici: o modificare accidentală a modurilor pică testul. */
const MODE_A = ["redesign-final", "11", "12", "14", "16", "17", "19", "20"];
const MODE_B = ["8", "9", "10", "13", "14b", "15", "15b"];
const MODE_C = ["6", "7", "18", "22"];

describe("modurile fazelor (docs/20 §3)", () => {
  it("fiecare fază din tabel are modul ei", () => {
    for (const phase of MODE_A) expect(modeOf(phase), phase).toBe("A");
    for (const phase of MODE_B) expect(modeOf(phase), phase).toBe("B");
    for (const phase of MODE_C) expect(modeOf(phase), phase).toBe("C");
  });

  it("nu există alte faze decât cele din tabel", () => {
    expect(Object.keys(PHASE_MODES).sort()).toEqual([...MODE_A, ...MODE_B, ...MODE_C].sort());
  });

  it("o fază necunoscută nu are mod (poarta o refuză, nu o tratează ca A)", () => {
    expect(modeOf("99")).toBeNull();
    expect(modeOf("")).toBeNull();
    expect(modeOf("redesign-altceva")).toBeNull();
  });
});

describe("nume de ramură și de etichete", () => {
  it("fazele numerotate: ramura faza-N, etichetele pre-faza-N și faza-N-completa", () => {
    expect(branchOf("9")).toBe("faza-9");
    expect(branchOf("15b")).toBe("faza-15b");
    expect(tagsOf("9")).toEqual({ pre: "pre-faza-9", done: "faza-9-completa" });
    expect(tagsOf("15b")).toEqual({ pre: "pre-faza-15b", done: "faza-15b-completa" });
  });

  it("redesignul: ramura redesign-final (nu faza-redesign-final), etichetele cu numele fazei", () => {
    expect(branchOf("redesign-final")).toBe("redesign-final");
    expect(tagsOf("redesign-final")).toEqual({
      pre: "pre-faza-redesign-final",
      done: "faza-redesign-final-completa",
    });
  });
});

describe("identificatorul fazei (intră în comenzi git și gh)", () => {
  it("acceptă doar litere mici, cifre, cratimă și punct, începând cu literă sau cifră", () => {
    for (const ok of ["9", "15b", "redesign-final", "3b-2"])
      expect(isValidPhaseId(ok), ok).toBe(true);
    for (const bad of [
      "",
      "-9",
      "--force",
      "9 ",
      "9;rm",
      "faza 9",
      "Faza9",
      "a/b",
      "..",
      "9\n",
      "x".repeat(40),
    ]) {
      expect(isValidPhaseId(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  PHASE_MODES,
  branchOf,
  isValidPhaseId,
  modeOf,
  tagsOf,
} from "../../scripts/autonom/phases";
import { approvalsGuardProblems, isPhaseBranch } from "../../scripts/autonom/approvals-guard";

/** Tabelul din docs/20 §3, scris a doua oară aici: o modificare accidentală a modurilor pică testul. */
const MODE_A = [
  "redesign-final",
  "redesign-finisaje",
  "15d",
  "11",
  "12",
  "14",
  "16",
  "17",
  "19",
  "20",
  "poarta-draft",
  "ci-joburi",
  "ci-e2e-paralel",
  "e2e-curatare-comenzi",
  "storno-total",
  "prisma-join-tema",
];
const MODE_B = ["8", "9", "10", "13", "14b", "14c", "15", "15b"];
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

describe("faza redesign-finisaje", () => {
  it("modul A; ramura redesign-finisaje, etichetele cu numele fazei", () => {
    expect(modeOf("redesign-finisaje")).toBe("A");
    expect(branchOf("redesign-finisaje")).toBe("redesign-finisaje");
    expect(tagsOf("redesign-finisaje")).toEqual({
      pre: "pre-faza-redesign-finisaje",
      done: "faza-redesign-finisaje-completa",
    });
  });
});

describe("faza 6 (design system și layout, modul C)", () => {
  it("modul C; ramura faza-6, etichetele pre-faza-6 și faza-6-completa", () => {
    expect(modeOf("6")).toBe("C");
    expect(branchOf("6")).toBe("faza-6");
    expect(tagsOf("6")).toEqual({ pre: "pre-faza-6", done: "faza-6-completa" });
    expect(isValidPhaseId("6")).toBe(true);
  });
});

describe("faza 15d (mini-fază, modul A)", () => {
  it("modul A; ramura faza-15d, etichetele pre-faza-15d și faza-15d-completa", () => {
    expect(modeOf("15d")).toBe("A");
    expect(branchOf("15d")).toBe("faza-15d");
    expect(tagsOf("15d")).toEqual({ pre: "pre-faza-15d", done: "faza-15d-completa" });
    expect(isValidPhaseId("15d")).toBe(true);
  });
});

describe("faza ci-joburi (mini-fază, modul A)", () => {
  it("modul A; ramura faza-ci-joburi, etichetele pre-faza-ci-joburi și faza-ci-joburi-completa", () => {
    expect(modeOf("ci-joburi")).toBe("A");
    expect(branchOf("ci-joburi")).toBe("faza-ci-joburi");
    expect(tagsOf("ci-joburi")).toEqual({
      pre: "pre-faza-ci-joburi",
      done: "faza-ci-joburi-completa",
    });
    expect(isValidPhaseId("ci-joburi")).toBe(true);
  });

  it("garda de aprobări îi tratează ramura ca pe o ramură de fază (nu are voie să atingă AUTONOM-APROBARI.md)", () => {
    const branch = branchOf("ci-joburi");
    expect(isPhaseBranch(branch)).toBe(true);
    const problems = approvalsGuardProblems({
      branch,
      baseAvailable: true,
      ci: false,
      touchingCommits: ["abc1234"],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("abc1234");
  });
});

describe("faza ci-e2e-paralel (mini-fază, modul A)", () => {
  it("modul A; ramura faza-ci-e2e-paralel, etichetele pre-faza-ci-e2e-paralel și faza-ci-e2e-paralel-completa", () => {
    expect(modeOf("ci-e2e-paralel")).toBe("A");
    expect(branchOf("ci-e2e-paralel")).toBe("faza-ci-e2e-paralel");
    expect(tagsOf("ci-e2e-paralel")).toEqual({
      pre: "pre-faza-ci-e2e-paralel",
      done: "faza-ci-e2e-paralel-completa",
    });
    expect(isValidPhaseId("ci-e2e-paralel")).toBe(true);
  });

  it("garda de aprobări îi tratează ramura ca pe o ramură de fază (nu are voie să atingă AUTONOM-APROBARI.md)", () => {
    const branch = branchOf("ci-e2e-paralel");
    expect(isPhaseBranch(branch)).toBe(true);
    const problems = approvalsGuardProblems({
      branch,
      baseAvailable: true,
      ci: false,
      touchingCommits: ["abc1234"],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("abc1234");
  });
});

describe("faza e2e-curatare-comenzi (mini-fază, modul A)", () => {
  it("modul A; ramura faza-e2e-curatare-comenzi, etichetele pre-faza-e2e-curatare-comenzi și faza-e2e-curatare-comenzi-completa", () => {
    expect(modeOf("e2e-curatare-comenzi")).toBe("A");
    expect(branchOf("e2e-curatare-comenzi")).toBe("faza-e2e-curatare-comenzi");
    expect(tagsOf("e2e-curatare-comenzi")).toEqual({
      pre: "pre-faza-e2e-curatare-comenzi",
      done: "faza-e2e-curatare-comenzi-completa",
    });
    expect(isValidPhaseId("e2e-curatare-comenzi")).toBe(true);
  });

  it("garda de aprobări îi tratează ramura ca pe o ramură de fază (nu are voie să atingă AUTONOM-APROBARI.md)", () => {
    const branch = branchOf("e2e-curatare-comenzi");
    expect(isPhaseBranch(branch)).toBe(true);
    const problems = approvalsGuardProblems({
      branch,
      baseAvailable: true,
      ci: false,
      touchingCommits: ["abc1234"],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("abc1234");
  });
});

describe("faza 14c (checkout pentru produse digitale, modul B)", () => {
  it("modul B (aprobarea utilizatorului); ramura faza-14c, etichetele pre-faza-14c și faza-14c-completa", () => {
    expect(modeOf("14c")).toBe("B");
    expect(branchOf("14c")).toBe("faza-14c");
    expect(tagsOf("14c")).toEqual({ pre: "pre-faza-14c", done: "faza-14c-completa" });
    expect(isValidPhaseId("14c")).toBe(true);
  });

  it("garda de aprobări îi tratează ramura ca pe o ramură de fază (nu are voie să atingă AUTONOM-APROBARI.md)", () => {
    expect(isPhaseBranch(branchOf("14c"))).toBe(true);
    const problems = approvalsGuardProblems({
      branch: branchOf("14c"),
      baseAvailable: true,
      ci: false,
      touchingCommits: ["def5678"],
    });
    expect(problems).toHaveLength(1);
  });
});

describe("faza storno-total (mini-fază, modul A)", () => {
  it("modul A; ramura faza-storno-total, etichetele pre-faza-storno-total și faza-storno-total-completa", () => {
    expect(modeOf("storno-total")).toBe("A");
    expect(branchOf("storno-total")).toBe("faza-storno-total");
    expect(tagsOf("storno-total")).toEqual({
      pre: "pre-faza-storno-total",
      done: "faza-storno-total-completa",
    });
    expect(isValidPhaseId("storno-total")).toBe(true);
  });

  it("garda de aprobări îi tratează ramura ca pe o ramură de fază (nu are voie să atingă AUTONOM-APROBARI.md)", () => {
    const branch = branchOf("storno-total");
    expect(isPhaseBranch(branch)).toBe(true);
    const problems = approvalsGuardProblems({
      branch,
      baseAvailable: true,
      ci: false,
      touchingCommits: ["abc1234"],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("abc1234");
  });
});

describe("faza poarta-draft (mini-fază, modul A)", () => {
  it("modul A; ramura faza-poarta-draft, etichetele pre-faza-poarta-draft și faza-poarta-draft-completa", () => {
    expect(modeOf("poarta-draft")).toBe("A");
    expect(branchOf("poarta-draft")).toBe("faza-poarta-draft");
    expect(tagsOf("poarta-draft")).toEqual({
      pre: "pre-faza-poarta-draft",
      done: "faza-poarta-draft-completa",
    });
    expect(isValidPhaseId("poarta-draft")).toBe(true);
  });

  it("garda de aprobări îi tratează ramura ca pe o ramură de fază (nu are voie să atingă AUTONOM-APROBARI.md)", () => {
    const branch = branchOf("poarta-draft");
    expect(isPhaseBranch(branch)).toBe(true);
    const problems = approvalsGuardProblems({
      branch,
      baseAvailable: true,
      ci: false,
      touchingCommits: ["abc1234"],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("abc1234");
  });
});

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APPROVALS_FILE,
  approvalsGuardProblems,
  isPhaseBranch,
} from "../../scripts/autonom/approvals-guard";

/**
 * `docs/AUTONOM-APROBARI.md` îl scrie numai utilizatorul (docs/20 §5, condiția 6). Claude Code nu-l scrie și nu-l modifică niciodată.
 * Testul pică dacă un commit al ramurii de fază (`faza-N` sau `redesign-…`) modifică fișierul față de `main`, chiar dacă modificarea
 * a fost anulată mai târziu; pe `main` și pe orice altă ramură nu verifică nimic (aprobarea intră în `main` prin commit-ul
 * utilizatorului, iar ramura fazei o preia odată cu `main`). În CI checkout-ul e superficial și `origin/main` lipsește, deci acolo
 * testul nu se poate compara: contează testul rulat local (`verify:full`) și poarta de îmbinare, care tratează fișierul ca pe unul
 * din afara scopului fazei.
 */

describe("isPhaseBranch", () => {
  it("recunoaște ramurile de fază: faza-N și redesign-…", () => {
    for (const name of ["faza-9", "faza-15b", "redesign-final", "redesign-lot4"]) {
      expect(isPhaseBranch(name), name).toBe(true);
    }
  });

  it("nu recunoaște main, ramuri obișnuite sau nume apropiate", () => {
    for (const name of [
      "main",
      "master",
      "fix/ceva",
      "claude/x",
      "faza",
      "faza-",
      "fazele-9",
      "redesign",
      "redesign-",
      "Faza-9",
      "",
    ]) {
      expect(isPhaseBranch(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe("approvalsGuardProblems", () => {
  const base = {
    branch: "redesign-final",
    baseAvailable: true,
    ci: false,
    touchingCommits: [] as string[],
  };

  it("pe o ramură de fază cu un commit care modifică fișierul, pică și numește commit-ul și fișierul", () => {
    const problems = approvalsGuardProblems({ ...base, touchingCommits: ["abc1234"] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("abc1234");
    expect(problems[0]).toContain(APPROVALS_FILE);
  });

  it("numește toate commit-urile care îl modifică", () => {
    const problems = approvalsGuardProblems({ ...base, touchingCommits: ["aaa1111", "bbb2222"] });
    expect(problems.join(" ")).toContain("aaa1111");
    expect(problems.join(" ")).toContain("bbb2222");
  });

  it("pe o ramură de fază fără commit-uri care îl ating, trece", () => {
    expect(approvalsGuardProblems(base)).toEqual([]);
    expect(approvalsGuardProblems({ ...base, branch: "faza-9" })).toEqual([]);
  });

  it("pe main sau pe o ramură obișnuită nu verifică nimic (chiar dacă fișierul a fost modificat)", () => {
    for (const branch of ["main", "fix/ceva", null]) {
      expect(
        approvalsGuardProblems({ ...base, branch, touchingCommits: ["abc1234"] }),
        String(branch),
      ).toEqual([]);
    }
  });

  it("pe o ramură de fază fără baza origin/main, local, pică (nu poate dovedi că fișierul e neatins)", () => {
    const problems = approvalsGuardProblems({ ...base, baseAvailable: false });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("origin/main");
  });

  it("în CI (checkout superficial, fără origin/main), nu pică din cauza bazei lipsă", () => {
    expect(approvalsGuardProblems({ ...base, baseAvailable: false, ci: true })).toEqual([]);
  });

  it("dacă baza e disponibilă, și în CI un commit care atinge fișierul pică", () => {
    expect(
      approvalsGuardProblems({ ...base, ci: true, touchingCommits: ["abc1234"] }),
    ).toHaveLength(1);
  });
});

describe("ramura curentă, în depozitul real", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });

  it("niciun commit al ramurii de fază (față de origin/main) nu modifică docs/AUTONOM-APROBARI.md", () => {
    const head = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch =
      process.env["GITHUB_HEAD_REF"] || (head.status === 0 ? head.stdout.trim() : null);
    const baseAvailable = git(["rev-parse", "--verify", "--quiet", "origin/main"]).status === 0;
    const log = baseAvailable
      ? git(["log", "--no-merges", "--format=%h", "origin/main..HEAD", "--", APPROVALS_FILE])
      : null;
    const touching =
      log && log.status === 0 ? log.stdout.split(/\r?\n/).filter((line) => line.trim() !== "") : [];
    expect(
      approvalsGuardProblems({
        branch,
        baseAvailable,
        ci: process.env["CI"] === "true",
        touchingCommits: touching,
      }),
    ).toEqual([]);
  });
});

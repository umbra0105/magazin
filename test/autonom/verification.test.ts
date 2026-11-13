import { describe, expect, it } from "vitest";
import {
  STEP_NAMES,
  parsePlaywrightSummary,
  parseVitestSummary,
  validateVerification,
  type Counts,
  type StepRecord,
  type VerificationRecord,
} from "../../scripts/autonom/verification";

const ESC = String.fromCharCode(27);

describe("rezumatul Vitest (unitare, integrare)", () => {
  it("citește «Tests  3137 passed (3137)», chiar cu culori ANSI în jur", () => {
    const log = [
      ` Test Files  217 passed (217)`,
      `      Tests  3137 passed (3137)`,
      `   Duration  91.2s`,
    ].join("\n");
    expect(parseVitestSummary(log)).toEqual({
      passed: 3137,
      failed: 0,
      skipped: 0,
      notRun: 0,
      flaky: 0,
    });
    const colored = `${ESC}[2m      Tests ${ESC}[22m ${ESC}[1m${ESC}[32m920 passed${ESC}[39m${ESC}[22m (920)`;
    expect(parseVitestSummary(colored)?.passed).toBe(920);
  });

  it("citește picate și sărite: «Tests  1 failed | 2 skipped | 3133 passed (3136)»", () => {
    expect(parseVitestSummary("      Tests  1 failed | 2 skipped | 3133 passed (3136)")).toEqual({
      passed: 3133,
      failed: 1,
      skipped: 2,
      notRun: 0,
      flaky: 0,
    });
  });

  it("fără linia de rezumat întoarce null (rularea nu s-a terminat, deci nu e dovadă)", () => {
    expect(parseVitestSummary("RUN v5.0.3\n ❯ test.ts\n")).toBeNull();
    expect(parseVitestSummary("")).toBeNull();
  });

  it("nu confundă «Test Files» cu «Tests»", () => {
    expect(parseVitestSummary(" Test Files  217 passed (217)")).toBeNull();
  });
});

describe("rezumatul Playwright (E2E)", () => {
  it("citește «370 passed (5.1m)»", () => {
    const log = ["  ok 1 [chromium] › spec › test (500ms)", "", "  370 passed (5.1m)"].join("\n");
    expect(parsePlaywrightSummary(log)).toEqual({
      passed: 370,
      failed: 0,
      skipped: 0,
      notRun: 0,
      flaky: 0,
    });
  });

  it("citește picate, sărite, nerulate și intermitente din blocul final", () => {
    const log = [
      "  1 failed",
      "    [chromium] › e2e/x.spec.ts:10:5 › un test",
      "  2 skipped",
      "  36 did not run",
      "  1 flaky",
      "  320 passed (6.0m)",
    ].join("\n");
    expect(parsePlaywrightSummary(log)).toEqual({
      passed: 320,
      failed: 1,
      skipped: 2,
      notRun: 36,
      flaky: 1,
    });
  });

  it("nu ia în seamă liniile de test («x 3 …», «ok 4 …») și întoarce null fără rezumat", () => {
    expect(parsePlaywrightSummary("  x   3 [chromium] › 12 failed things")).toBeNull();
    expect(parsePlaywrightSummary("")).toBeNull();
  });
});

const COUNTS_OK: Counts = { passed: 100, failed: 0, skipped: 0, notRun: 0, flaky: 0 };

function step(name: StepRecord["name"], over: Partial<StepRecord> = {}): StepRecord {
  const counted = ["unit", "integrationDev", "integrationMigratedOnly", "e2e"].includes(name);
  return {
    name,
    exitCode: 0,
    counts: counted ? { ...COUNTS_OK } : null,
    log: `${name}.log`,
    ...over,
  };
}

function record(over: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    version: 1,
    headSha: "a".repeat(40),
    treeHash: "t".repeat(40),
    startedAt: "2026-11-13T10:00:00.000Z",
    finishedAt: "2026-11-13T10:30:00.000Z",
    steps: STEP_NAMES.map((name) => step(name)),
    ...over,
  };
}

const CURRENT = { treeHash: "t".repeat(40) };

describe("validarea înregistrării verificării complete", () => {
  it("o înregistrare completă, verde, pe același arbore de cod, e validă", () => {
    expect(validateVerification(record(), CURRENT)).toEqual({ ok: true });
  });

  it("pică dacă arborele de cod s-a schimbat de la verificare (nu e «pe codul final»)", () => {
    const result = validateVerification(record({ treeHash: "x".repeat(40) }), CURRENT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/cod|arbore/i);
  });

  it("pică dacă lipsește un pas (fiecare din cei 9 e obligatoriu)", () => {
    for (const name of STEP_NAMES) {
      const steps = STEP_NAMES.filter((n) => n !== name).map((n) => step(n));
      const result = validateVerification(record({ steps }), CURRENT);
      expect(result.ok, `fără ${name}`).toBe(false);
      if (!result.ok) expect(result.reason).toContain(name);
    }
  });

  it("pică dacă un pas apare de două ori", () => {
    const result = validateVerification(
      record({ steps: [...STEP_NAMES.map((n) => step(n)), step("unit")] }),
      CURRENT,
    );
    expect(result.ok).toBe(false);
  });

  it("pică la cod de ieșire diferit de 0, la oricare pas", () => {
    for (const name of STEP_NAMES) {
      const steps = STEP_NAMES.map((n) => (n === name ? step(n, { exitCode: 1 }) : step(n)));
      const result = validateVerification(record({ steps }), CURRENT);
      expect(result.ok, name).toBe(false);
      if (!result.ok) expect(result.reason).toContain(name);
    }
  });

  it("pașii cu teste cer numărători: lipsa lor, zero trecute, picate, sărite, nerulate sau intermitente pică", () => {
    const bad: Partial<Counts | null>[] = [
      null,
      { passed: 0 },
      { failed: 1 },
      { skipped: 1 },
      { notRun: 1 },
      { flaky: 1 },
    ];
    for (const name of ["unit", "integrationDev", "integrationMigratedOnly", "e2e"] as const) {
      for (const variant of bad) {
        const counts = variant === null ? null : { ...COUNTS_OK, ...variant };
        const steps = STEP_NAMES.map((n) => (n === name ? step(n, { counts }) : step(n)));
        const result = validateVerification(record({ steps }), CURRENT);
        expect(result.ok, `${name} ${JSON.stringify(variant)}`).toBe(false);
      }
    }
  });

  it("respinge orice care nu e o înregistrare (null, alt tip, altă versiune)", () => {
    for (const raw of [null, undefined, 3, "x", [], {}, { ...record(), version: 2 }]) {
      expect(validateVerification(raw, CURRENT).ok, JSON.stringify(raw)).toBe(false);
    }
  });
});

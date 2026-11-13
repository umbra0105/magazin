/**
 * Verificarea completă locală (CLAUDE.md «Verificare, commit și push»; docs/20 §5, condiția 3). `npm.cmd run verify:full` rulează cei
 * 9 pași și scrie o înregistrare cu rezultatele ÎNTR-UN FIȘIER; poarta o acceptă doar dacă a fost făcută pe EXACT arborele de cod de
 * acum (hash-ul arborelui git), cu toți pașii cu cod 0 și, la pașii cu teste, cu numărători fără picate, sărite, nerulate sau
 * intermitente. «Citită integral» devine astfel o regulă mecanică: o rulare cu un singur test sărit nu trece.
 */
export const STEP_NAMES = [
  "prettier",
  "lint",
  "lintRoot",
  "typecheck",
  "typecheckAutonom",
  "unit",
  "integrationDev",
  "integrationMigratedOnly",
  "e2e",
] as const;
export type StepName = (typeof STEP_NAMES)[number];

/** Pașii care rulează teste și au deci numărători (ceilalți se judecă doar după codul de ieșire). */
export const COUNTED_STEPS: readonly StepName[] = [
  "unit",
  "integrationDev",
  "integrationMigratedOnly",
  "e2e",
];

export interface Counts {
  passed: number;
  failed: number;
  skipped: number;
  notRun: number;
  flaky: number;
}

export interface StepRecord {
  name: StepName;
  exitCode: number;
  counts: Counts | null;
  /** Calea jurnalului pasului (în `local-data/gate/logs/`), pentru citire. */
  log: string;
}

export interface VerificationRecord {
  version: 1;
  headSha: string;
  treeHash: string;
  startedAt: string;
  finishedAt: string;
  steps: StepRecord[];
}

export type Validation = { ok: true } | { ok: false; reason: string };

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (text: string): string => text.replace(ANSI, "");

/** Rezumatul Vitest: linia «Tests  1 failed | 2 skipped | 3133 passed (3136)» (nu «Test Files»). */
export function parseVitestSummary(log: string): Counts | null {
  const line = stripAnsi(log)
    .split(/\r?\n/)
    .filter((l) => /^\s*Tests\s+\d/.test(l))
    .pop();
  if (!line) return null;
  const count = (word: string): number => {
    const match = new RegExp(`(\\d+)\\s+${word}\\b`).exec(line);
    return match ? Number(match[1]) : 0;
  };
  return {
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped"),
    notRun: 0,
    flaky: 0,
  };
}

/** Rezumatul Playwright: blocul de la sfârșit («  370 passed (5.1m)», «  1 failed», «  36 did not run» …). */
export function parsePlaywrightSummary(log: string): Counts | null {
  const tail = stripAnsi(log).split(/\r?\n/).slice(-60);
  const total = (word: string): number => {
    let sum = 0;
    for (const line of tail) {
      const match = new RegExp(`^ {2}(\\d+) ${word}\\b`).exec(line);
      if (match) sum += Number(match[1]);
    }
    return sum;
  };
  if (!tail.some((line) => /^ {2}\d+ passed\b/.test(line))) return null;
  return {
    passed: total("passed"),
    failed: total("failed"),
    skipped: total("skipped"),
    notRun: total("did not run"),
    flaky: total("flaky"),
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function countsProblem(name: string, counts: unknown): string | null {
  if (!isObject(counts)) return `${name}: lipsesc numărătorile testelor`;
  const n = (key: string): number =>
    typeof counts[key] === "number" ? (counts[key] as number) : Number.NaN;
  if (!(n("passed") > 0)) return `${name}: niciun test trecut`;
  if (n("failed") !== 0) return `${name}: teste picate`;
  if (n("skipped") !== 0) return `${name}: teste sărite`;
  if (n("notRun") !== 0) return `${name}: teste nerulate`;
  if (n("flaky") !== 0) return `${name}: teste intermitente`;
  return null;
}

export function validateVerification(raw: unknown, current: { treeHash: string }): Validation {
  if (!isObject(raw) || raw["version"] !== 1)
    return { ok: false, reason: "înregistrare invalidă sau de altă versiune" };
  if (raw["treeHash"] !== current.treeHash) {
    return {
      ok: false,
      reason: "verificarea nu e făcută pe codul final (arborele de cod s-a schimbat de atunci)",
    };
  }
  const steps = raw["steps"];
  if (!Array.isArray(steps)) return { ok: false, reason: "înregistrarea nu are pașii verificării" };
  for (const name of STEP_NAMES) {
    const found = steps.filter((step) => isObject(step) && step["name"] === name);
    if (found.length === 0) return { ok: false, reason: `lipsește pasul ${name}` };
    if (found.length > 1) return { ok: false, reason: `pasul ${name} apare de mai multe ori` };
    const step = found[0] as Record<string, unknown>;
    if (step["exitCode"] !== 0)
      return { ok: false, reason: `${name}: cod de ieșire ${String(step["exitCode"])}` };
    if (COUNTED_STEPS.includes(name)) {
      const problem = countsProblem(name, step["counts"]);
      if (problem) return { ok: false, reason: problem };
    }
  }
  return { ok: true };
}

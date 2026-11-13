/**
 * `npm.cmd run verify:full`: verificarea completă locală (CLAUDE.md «Verificare, commit și push»), în forma pe care o cere poarta de
 * îmbinare (docs/20 §5, condiția 3). Rulează cei 9 pași pe rând (toți, chiar dacă unul pică), scrie jurnalul fiecăruia în
 * `local-data/gate/logs/<moment>/` și o înregistrare în `local-data/gate/verificare.json`, legată de hash-ul arborelui de cod. Cere un
 * arbore curat (verificarea se face pe cod comis) și refuză să scrie înregistrarea dacă arborele s-a schimbat în timpul rulării.
 *
 * Integrarea rulează pe DOUĂ baze: cea de test obișnuită și o bază doar migrată (`ecom_ci_test`), creată aici și ștearsă după, ca în CI.
 * Fiecare pas e lansat direct cu `node` (nu prin npm), din comenzile scrise în `package.json`.
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  COUNTED_STEPS,
  STEP_NAMES,
  parsePlaywrightSummary,
  parseVitestSummary,
  type StepName,
  type StepRecord,
  type VerificationRecord,
} from "./verification";

const ROOT = process.cwd();
const CI_DATABASE = "ecom_ci_test";
const POSTGRES_CONTAINER = "ecom-dev-postgres-1";

const BIN: Record<string, string> = {
  eslint: "node_modules/eslint/bin/eslint.js",
  vitest: "node_modules/vitest/vitest.mjs",
  playwright: "node_modules/@playwright/test/cli.js",
};

/** O comandă din `package.json` (`eslint a b`, `vitest run --project unit`, `playwright test`) ca argumente pentru `node`. */
function fromPackageScript(script: string): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const command = pkg.scripts[script];
  if (!command) throw new Error(`lipsește scriptul ${script} din package.json`);
  const [bin, ...rest] = command.trim().split(/\s+/);
  const file = bin ? BIN[bin] : undefined;
  if (!file)
    throw new Error(
      `scriptul ${script} începe cu «${bin ?? ""}», pe care verify:full nu îl cunoaște`,
    );
  return [file, ...rest];
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

interface Outcome {
  exitCode: number;
  text: string;
}

function runNode(args: string[], logFile: string, env: NodeJS.ProcessEnv = {}): Promise<Outcome> {
  return new Promise((resolve) => {
    const out = createWriteStream(logFile);
    let text = "";
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, ...env, FORCE_COLOR: "0", NO_COLOR: "1" },
      windowsHide: true,
    });
    const take = (chunk: Buffer): void => {
      const piece = chunk.toString("utf8");
      text += piece;
      out.write(piece);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (error) => {
      take(Buffer.from(`\n[verify:full] ${error.message}\n`));
      out.end(() => resolve({ exitCode: 127, text }));
    });
    child.on("close", (code) => out.end(() => resolve({ exitCode: code ?? 1, text })));
  });
}

function docker(args: string[]): { status: number; stdout: string } {
  const result = spawnSync("docker", args, { cwd: ROOT, encoding: "utf8", windowsHide: true });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

/** Utilizatorul serverului de dezvoltare, din `DATABASE_URL` (fără parolă, nu se tipărește nimic secret). */
function databaseUser(): string {
  process.loadEnvFile(join(ROOT, ".env"));
  return decodeURIComponent(new URL(process.env["DATABASE_URL"] ?? "").username);
}

function ciDatabaseUrl(): string {
  const url = new URL(process.env["DATABASE_URL"] ?? "");
  url.pathname = `/${CI_DATABASE}`;
  return url.toString();
}

async function main(): Promise<number> {
  if (git(["status", "--porcelain"]) !== "") {
    console.error(
      "verify:full: arborele de lucru nu e curat. Verificarea se face pe cod comis; comite sau șterge modificările.",
    );
    return 2;
  }
  const startedAt = new Date().toISOString();
  const treeBefore = git(["rev-parse", "HEAD^{tree}"]);
  const headSha = git(["rev-parse", "HEAD"]);
  const stamp = startedAt.replace(/[:.]/g, "-");
  const logDir = join(ROOT, "local-data", "gate", "logs", stamp);
  mkdirSync(logDir, { recursive: true });
  const user = databaseUser();

  const steps: StepRecord[] = [];
  const record = async (
    name: StepName,
    args: string[],
    env: NodeJS.ProcessEnv = {},
  ): Promise<void> => {
    const logFile = join(logDir, `${name}.log`);
    console.log(`▶ ${name}`);
    const outcome = await runNode(args, logFile, env);
    const counts = COUNTED_STEPS.includes(name)
      ? name === "e2e"
        ? parsePlaywrightSummary(outcome.text)
        : parseVitestSummary(outcome.text)
      : null;
    steps.push({ name, exitCode: outcome.exitCode, counts, log: logFile });
    const detail = counts
      ? ` (${counts.passed} trecute, ${counts.failed} picate, ${counts.skipped} sărite, ${counts.notRun} nerulate, ${counts.flaky} intermitente)`
      : "";
    console.log(`${outcome.exitCode === 0 ? "✓" : "✗"} ${name}: cod ${outcome.exitCode}${detail}`);
  };

  await record("prettier", ["node_modules/prettier/bin/prettier.cjs", "--check", "."]);
  await record("lint", ["scripts/run-all.mjs", "lint"]);
  await record("lintRoot", fromPackageScript("lint:root"));
  await record("typecheck", ["scripts/run-all.mjs", "typecheck"]);
  await record("typecheckAutonom", [
    "node_modules/typescript/bin/tsc",
    "-p",
    "scripts/autonom/tsconfig.json",
  ]);
  await record("unit", fromPackageScript("test"));
  await record("integrationDev", fromPackageScript("test:integration"));

  // a doua bază de integrare: doar migrată, creată aici și ștearsă după (doar dacă nu exista deja)
  const exists = docker([
    "exec",
    POSTGRES_CONTAINER,
    "psql",
    "-U",
    user,
    "-d",
    "postgres",
    "-tAc",
    `SELECT 1 FROM pg_database WHERE datname='${CI_DATABASE}'`,
  ]);
  if (exists.status !== 0 || exists.stdout.trim() !== "") {
    console.error(
      `✗ integrationMigratedOnly: ${exists.status !== 0 ? "Docker sau Postgres nu răspund" : `baza ${CI_DATABASE} există deja (nu e creată de verify:full; nu o ating)`}`,
    );
    steps.push({ name: "integrationMigratedOnly", exitCode: 1, counts: null, log: "" });
  } else {
    try {
      await record("integrationMigratedOnly", fromPackageScript("test:integration"), {
        TEST_DATABASE_URL: ciDatabaseUrl(),
      });
    } finally {
      docker([
        "exec",
        POSTGRES_CONTAINER,
        "psql",
        "-U",
        user,
        "-d",
        "postgres",
        "-c",
        `DROP DATABASE IF EXISTS ${CI_DATABASE}`,
      ]);
    }
  }

  await record("e2e", fromPackageScript("test:e2e"));
  // construirea Next rescrie aceste două fișiere (regula din CLAUDE.md): se restabilesc la starea comisă
  spawnSync("git", ["checkout", "--", "apps/web/tsconfig.json", "apps/web/next-env.d.ts"], {
    cwd: ROOT,
    windowsHide: true,
  });

  const finishedAt = new Date().toISOString();
  const dirty = git(["status", "--porcelain"]) !== "";
  const treeAfter = git(["rev-parse", "HEAD^{tree}"]);
  if (dirty || treeAfter !== treeBefore) {
    console.error(
      "verify:full: arborele de lucru sau codul s-a schimbat în timpul verificării; înregistrarea NU se scrie.",
    );
    return 1;
  }
  const ordered = STEP_NAMES.map((name) => steps.find((step) => step.name === name)).filter(
    (step): step is StepRecord => step !== undefined,
  );
  const result: VerificationRecord = {
    version: 1,
    headSha,
    treeHash: treeBefore,
    startedAt,
    finishedAt,
    steps: ordered,
  };
  writeFileSync(
    join(ROOT, "local-data", "gate", "verificare.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  const failed = ordered.filter((step) => step.exitCode !== 0);
  console.log(
    `\nÎnregistrare scrisă în local-data/gate/verificare.json; jurnalele în local-data/gate/logs/${stamp}/`,
  );
  if (failed.length > 0) {
    console.error(`Pași picați: ${failed.map((step) => step.name).join(", ")}`);
    return 1;
  }
  console.log("Toți pașii au trecut. Citește numărătorile de mai sus (poarta le verifică și ea).");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(
      `verify:full: eroare neașteptată: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  },
);

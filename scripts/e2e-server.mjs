#!/usr/bin/env node
/**
 * Serverul de test E2E, în mod producție: `next build` (în `NEXT_DIST_DIR`, niciodată `.next`) apoi
 * `next start` pe portul dat, plus workerul de cozi (`packages/jobs`) ca proces separat, exact cum
 * rulează în producție (în `next dev` workerii pornesc în procesul serverului, doar în dezvoltare).
 *
 *   node scripts/e2e-server.mjs <port>
 *
 * Mediul (baza și Redis de test, STORAGE_*, E2E_HARNESS, NEXT_DIST_DIR) îl pune Playwright. Rulează
 * identic local și în CI. Se oprește (și oprește ce a pornit) la SIGINT/SIGTERM sau când unul dintre
 * procesele pornite iese. Oprește DOAR procesele pornite aici, după PID.
 */
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024) {
  console.error("Folosire: node scripts/e2e-server.mjs <port>");
  process.exit(2);
}
const distDir = process.env["NEXT_DIST_DIR"];
if (!distDir || distDir === ".next") {
  // Garanția din CLAUDE.md: build-ul E2E nu scrie peste `.next` al unui server de dev pornit.
  console.error("[e2e-server] NEXT_DIST_DIR trebuie setat la un director propriu (nu `.next`).");
  process.exit(2);
}

// Playwright își setează NODE_ENV=test; Next cere `production` la build și la start.
const env = {
  ...process.env,
  NODE_ENV: "production",
  // Aceeași configurație JSX ca `pnpm worker` (vezi scripts/worker.mjs).
  TSX_TSCONFIG_PATH: resolve(process.cwd(), "packages", "jobs", "tsconfig.run.json"),
};

const root = process.cwd();
const webDir = resolve(root, "apps", "web");
const nextBin = resolve(webDir, "node_modules/next/dist/bin/next");

const started = Date.now();
const build = spawnSync(process.execPath, [nextBin, "build"], {
  cwd: webDir,
  stdio: "inherit",
  env,
});
if (build.status !== 0) {
  console.error(`[e2e-server] next build a eșuat (cod ${build.status ?? "?"})`);
  process.exit(build.status ?? 1);
}
console.log(`[e2e-server] build: ${Math.round((Date.now() - started) / 1000)} s (${distDir})`);

/** @type {import("node:child_process").ChildProcess[]} */
const children = [];
let stopping = false;

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null || child.pid === undefined) continue;
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      // deja oprit
    }
  }
  process.exit(code);
}

function run(name, args, cwd) {
  const child = spawn(process.execPath, args, { cwd, stdio: "inherit", env });
  children.push(child);
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`[e2e-server] ${name} a ieșit (cod ${code ?? "?"})`);
      stopAll(code ?? 1);
    }
  });
}

// cwd = packages/jobs: `tsx` ia `jsx: react-jsx` din tsconfig-ul pachetului (vezi scripts/worker.mjs).
run("worker", ["--import", "tsx", "src/main.ts"], resolve(root, "packages", "jobs"));
run("next start", [nextBin, "start", "--port", String(port)], webDir);

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

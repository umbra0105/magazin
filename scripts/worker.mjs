#!/usr/bin/env node
/**
 * Procesul de worker (`pnpm worker`): rulează `packages/jobs/src/main.ts` cu directorul curent în
 * `packages/jobs`, ca `tsx` să folosească `tsconfig.json`-ul pachetului (`jsx: react-jsx`). Din rădăcină
 * (fără tsconfig.json acolo) transformarea JSX era cea clasică și emailurile eșuau cu
 * „React is not defined".
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const result = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts"], {
  cwd: resolve("packages", "jobs"),
  stdio: "inherit",
  env: { ...process.env, TSX_TSCONFIG_PATH: resolve("packages", "jobs", "tsconfig.run.json") },
});
process.exit(result.status ?? 1);

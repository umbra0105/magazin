#!/usr/bin/env node
/**
 * Rulează un program JavaScript dintr-un alt director, fără pnpm, npm sau turbo:
 *
 *   node scripts/in.mjs <director> <fișier.js> [argumente...]
 *
 * Folosit de scripturile din rădăcină (dev:web, build:web, db:migrate, db:studio) ca să meargă la fel
 * prin pnpm, npm sau direct cu node (inclusiv pe mașini unde pnpm.exe e blocat).
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const [dir, file, ...args] = process.argv.slice(2);
if (!dir || !file) {
  console.error("Folosire: node scripts/in.mjs <director> <fișier.js> [argumente...]");
  process.exit(2);
}
const cwd = resolve(dir);
const result = spawnSync(process.execPath, [resolve(cwd, file), ...args], {
  cwd,
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);

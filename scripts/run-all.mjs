#!/usr/bin/env node
/**
 * Rulează scriptul `<nume>` din fiecare pachet al workspace-ului care îl are (apps/*, packages/*),
 * pe rând, fără turbo și fără pnpm:
 *
 *   node scripts/run-all.mjs typecheck
 *   node scripts/run-all.mjs lint
 *   node scripts/run-all.mjs build
 *
 * Fiecare pachet își rulează propriul script prin `npm run` (npm se lansează prin node și pune
 * node_modules/.bin în PATH). Se opește la sfârșit cu cod ≠ 0 dacă vreun pachet a eșuat, dar
 * rulează toate pachetele, ca raportul să fie complet.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const task = process.argv[2];
if (!task || !/^[A-Za-z0-9:._-]+$/.test(task)) {
  console.error("Folosire: node scripts/run-all.mjs <script>");
  process.exit(2);
}

const root = resolve(import.meta.dirname, "..");
const dirs = ["apps", "packages"].flatMap((group) =>
  existsSync(join(root, group))
    ? readdirSync(join(root, group), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(group, d.name))
    : [],
);

const npm = "npm";
const failed = [];
let ran = 0;
for (const dir of dirs) {
  const file = join(root, dir, "package.json");
  if (!existsSync(file)) continue;
  const scripts = JSON.parse(readFileSync(file, "utf8")).scripts ?? {};
  if (!scripts[task]) continue;
  ran += 1;
  console.log(`\n▶ ${dir}: ${task}`);
  // O singură linie de comandă (nu listă de argumente) ca să evităm DEP0190; `task` vine din
  // linia de comandă a dezvoltatorului și trebuie să fie un nume de script simplu.
  const result = spawnSync(`${npm} run ${task} --silent`, {
    cwd: join(root, dir),
    stdio: "inherit",
    shell: true,
    env: process.env,
  });
  if (result.status !== 0) failed.push(dir);
}

if (ran === 0) console.warn(`Niciun pachet nu are scriptul „${task}”.`);
if (failed.length > 0) {
  console.error(`\n✖ ${task} a eșuat în: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\n✔ ${task}: ${ran} pachete`);

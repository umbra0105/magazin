/**
 * `npm.cmd run gate:merge -- --faza <id> [--dry-run]`: poarta de îmbinare în `main` (docs/20 §5), cu `git` și `gh` reale.
 * Logica e în `gate.ts` (testată cu `git` și `gh` simulate); aici sunt doar legăturile cu sistemul. Cod de ieșire: 0 = îmbinat
 * (sau --dry-run reușit), 1 = o condiție nu e îndeplinită, 2 = argumente greșite sau `gh` lipsește.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseGateArgs, runGate, type GatePorts, type RunResult } from "./gate";

const ROOT = process.cwd();
/** `gh` poate lipsi din PATH-ul sesiunii (instalat după pornirea ei): se încearcă și calea implicită de pe Windows. */
const GH_CANDIDATES = ["gh", "C:\\Program Files\\GitHub CLI\\gh.exe"];

function run(command: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error: NodeJS.ErrnoException) => {
      resolve({
        code: error.code === "ENOENT" ? 127 : 126,
        stdout,
        stderr: `${stderr}${error.message}`,
      });
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function findGh(): Promise<string | null> {
  for (const candidate of GH_CANDIDATES) {
    const result = await run(candidate, ["--version"]);
    if (result.code === 0) return candidate;
  }
  return null;
}

async function readIfExists(relPath: string): Promise<string | null> {
  try {
    return await readFile(join(ROOT, relPath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function main(): Promise<number> {
  const parsed = parseGateArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`Poarta de îmbinare: ${parsed.error}`);
    console.error("Folosire: npm.cmd run gate:merge -- --faza <id> [--dry-run]");
    return 2;
  }
  const gh = await findGh();
  if (gh === null) {
    console.error(
      "Poarta de îmbinare: `gh` nu răspunde (nici în PATH, nici în C:\\Program Files\\GitHub CLI). Nu instalez nimic.",
    );
    return 2;
  }
  const ports: GatePorts = {
    git: (args) => run("git", args),
    gh: (args) => run(gh, args),
    readText: readIfExists,
    readVerification: async () => {
      const text = await readIfExists("local-data/gate/verificare.json");
      if (text === null) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return {};
      }
    },
    log: (line) => console.log(line),
  };

  console.log(
    `Poarta de îmbinare, faza ${parsed.options.phase}${parsed.options.dryRun ? " (--dry-run)" : ""}`,
  );
  const result = await runGate(parsed.options, ports);
  if (result.ok) {
    console.log(
      result.dryRun
        ? "OK (--dry-run): toate condițiile sunt îndeplinite."
        : `OK: faza îmbinată, commit ${result.mergeCommit ?? "?"}.`,
    );
    return 0;
  }
  console.error(`✗ Condiția ${result.failed.id}, ${result.failed.name}: ${result.failed.reason}`);
  if (result.failed.hint) console.error(`  Ce faci: ${result.failed.hint}`);
  console.error("Poarta s-a oprit la prima condiție neîndeplinită. Nu există mod de a o ocoli.");
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(
      `Poarta de îmbinare: eroare neașteptată: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  },
);

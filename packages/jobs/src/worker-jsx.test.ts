import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const jobsDir = resolve(root, "packages", "jobs");
const tsconfig = resolve(jobsDir, "tsconfig.run.json");

// Randarea unui șablon de email într-un proces `tsx` curat, cu aceeași configurație ca workerul de
// producție (scripts/worker.mjs). Vitest are propria transformare JSX, deci testele de randare din
// `packages/emails` nu prind o configurație `tsx` stricată (defectul „React is not defined").
const SCRIPT = `
const { renderEmail } = await import(${JSON.stringify(pathToFileURL(resolve(root, "packages/emails/src/render.ts")).href)});
const theme = {
  storeName: "Test",
  logoUrl: null,
  colors: { bg: "#ffffff", fg: "#111111", muted: "#555555", border: "#dddddd", primary: "#0b5fff", primaryFg: "#ffffff" },
  fontFamily: "Arial, sans-serif",
  radiusPx: 4,
};
const mail = await renderEmail(theme, { kind: "verify-email", name: "Ana", link: "https://x.test/v#token=abc", validForHours: 24 });
console.log(JSON.stringify({ ok: mail.html.includes("https://x.test/v#token=abc"), subject: mail.subject }));
`;

describe("worker: șabloanele de email se randează sub tsx", () => {
  it("randează un șablon cu tsconfig.run.json (jsx react-jsx), ca `pnpm worker`", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", SCRIPT],
      {
        cwd: jobsDir,
        encoding: "utf8",
        env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig },
        timeout: 60_000,
      },
    );
    expect(result.stderr).not.toContain("React is not defined");
    expect(result.status, result.stderr.slice(0, 600)).toBe(0);
    expect(JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}")).toMatchObject({ ok: true });
  });

  it("ambele puncte de pornire a workerului folosesc același tsconfig", () => {
    for (const file of ["scripts/worker.mjs", "scripts/e2e-server.mjs"]) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source, file).toContain("TSX_TSCONFIG_PATH");
      expect(source, file).toContain("tsconfig.run.json");
    }
  });
});

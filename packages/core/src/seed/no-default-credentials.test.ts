import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CORE = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Scripturi care NU sunt seed. `admin-create`/`admin-set-password` manipulează o parolă tastată de om și au
 * garanții proprii în `test/support/admin-create-security.test.ts`. `dev-age-session` (doar dezvoltare)
 * modifică exclusiv `session.createdAt` al unui utilizator; garanția e în `_dev-age-session-args.test.ts`.
 */
const NOT_SEED = new Set(["admin-create.ts", "admin-set-password.ts", "dev-age-session.ts"]);

function seedFiles(): string[] {
  const dirs = [join(CORE, "scripts"), join(CORE, "src", "seed")];
  return dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && !/\.test\.ts$/.test(name) && !NOT_SEED.has(name))
      .map((name) => join(dir, name)),
  );
}

describe("seed-urile nu conțin credențiale", () => {
  it("citește fișierele de seed (nu trece în gol)", () => {
    expect(seedFiles().length).toBeGreaterThanOrEqual(4);
  });

  it("nu scriu utilizatori, conturi sau sesiuni", () => {
    for (const file of seedFiles()) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(
        /\.(user|account|session|verification)\s*\.\s*(create|upsert|update)/,
      );
    }
  });

  it("nu atribuie nicio parolă sau cheie în cod", () => {
    for (const file of seedFiles()) {
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code, file).not.toMatch(/\b(password|passwd|secret|apiKey)\b\s*[:=]/i);
    }
  });
});

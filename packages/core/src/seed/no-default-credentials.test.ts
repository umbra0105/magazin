import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CORE = fileURLToPath(new URL("../../", import.meta.url));

function seedFiles(): string[] {
  const dirs = [join(CORE, "scripts"), join(CORE, "src", "seed")];
  return dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && !/\.test\.ts$/.test(name))
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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Configurarea modului autonom (docs/20 §10): fișierele care ajută frâna și plasa de siguranță rămân în `.gitignore`, comenzile
 * există în `package.json`, iar `CLAUDE.md` și `docs/` le pomenesc. Dacă cineva scoate una dintre ele, testul pică.
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), "utf8");

describe(".gitignore", () => {
  const lines = read(".gitignore")
    .split(/\r?\n/)
    .map((line) => line.trim());

  it("ține în afara depozitului STOP.txt (frâna de mână)", () => {
    expect(lines).toContain("STOP.txt");
  });

  it("ține în afara depozitului local-data/ (copiile bazei, înregistrarea verificării, arhiva, capturile)", () => {
    expect(lines).toContain("/local-data");
  });
});

describe("comenzile modului autonom", () => {
  const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;

  it("package.json are cele patru comenzi, spre scripturile din scripts/autonom", () => {
    expect(scripts["gate:merge"]).toBe("node --import tsx scripts/autonom/gate-cli.ts");
    expect(scripts["verify:full"]).toBe("node --import tsx scripts/autonom/verify-full.ts");
    expect(scripts["autonom:stop-check"]).toBe("node --import tsx scripts/autonom/stop-check.ts");
    expect(scripts["db:backup"]).toBe("node --import tsx scripts/autonom/db-backup.ts");
  });

  it("fiecare comandă duce la un fișier care există", () => {
    for (const name of ["gate:merge", "verify:full", "autonom:stop-check", "db:backup"]) {
      const target = /scripts\/autonom\/[\w-]+\.ts/.exec(scripts[name] ?? "")?.[0] ?? "";
      expect(existsSync(join(root, target)), `${name} → ${target}`).toBe(true);
    }
  });
});

describe("documentația modului autonom", () => {
  it("CLAUDE.md are secțiunea «Mod autonom» și pomenește poarta, frâna și copia de siguranță", () => {
    const claude = read("CLAUDE.md");
    for (const needle of [
      "## Mod autonom",
      "docs/20-mod-autonom.md",
      "gate:merge",
      "autonom:stop-check",
      "db:backup",
      "STOP.txt",
      "S1",
      "S2",
      "S3",
    ]) {
      expect(claude, needle).toContain(needle);
    }
  });

  it("docs/20 există, iar README-ul îl pune în index împreună cu 17", () => {
    expect(existsSync(join(root, "docs/20-mod-autonom.md"))).toBe(true);
    const readme = read("docs/README.md");
    expect(readme).toContain("`20-mod-autonom.md`");
    expect(readme).toContain("`17-design-sistem-admin.md`");
  });
});

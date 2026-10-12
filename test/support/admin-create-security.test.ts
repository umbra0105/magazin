import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Garanții de arhitectură pentru comenzile CLI cu parole: parola vine DOAR dintr-un prompt
 * interactiv fără echo, nu din argumente, variabile de mediu, fișiere sau valori implicite.
 */
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");

describe("pnpm admin:create", () => {
  const script = read("packages/core/scripts/admin-create.ts");

  it("nu citește parola din variabile de mediu și nu are opțiune --password", () => {
    expect(script).not.toMatch(/process\.env\W+\w*PASS/i);
    expect(script).not.toMatch(/--password/i);
    expect(script).not.toMatch(/ADMIN_(PASSWORD|PASS|EMAIL)/);
  });

  it("singurele argumente acceptate sunt --force; orice altceva e refuzat", () => {
    expect(script).toMatch(/a !== "--force"/);
    expect(script).toMatch(/unknownArgs\.length > 0/);
  });

  it("parola se cere prin promptNewPassword (fără echo, de două ori), doar în terminal interactiv", () => {
    expect(script.match(/promptNewPassword\(/g)?.length).toBe(1);
    expect(script).toMatch(/!process\.stdin\.isTTY/);
  });

  it("funcția de creare nu are nicio parolă implicită și nu scrie parola în audit", () => {
    const create = read("packages/core/src/auth/create-admin.ts");
    expect(create).not.toMatch(/password:\s*["'`][^"'`]+["'`]/);
    expect(create).toMatch(/after: \{ email, role: OWNER_ROLE_KEY, emailVerified: true \}/);
  });
});

describe("pnpm admin:set-password", () => {
  const script = read("packages/core/scripts/admin-set-password.ts");

  it("parola nu vine din env, argumente sau opțiuni; singurul argument e emailul", () => {
    expect(script).not.toMatch(/process\.env\W+\w*PASS/i);
    expect(script).not.toMatch(/--password|--pass\b/i);
    expect(script).toMatch(/args\.length !== 1/);
  });

  it("parola se cere prin promptNewPassword, doar în terminal interactiv", () => {
    expect(script.match(/promptNewPassword\(/g)?.length).toBe(1);
    expect(script).toMatch(/!process\.stdin\.isTTY/);
  });

  it("auditul nu primește parola, iar motivul e „schimbare din CLI”", () => {
    const core = read("packages/core/src/auth/set-password.ts");
    expect(core).toMatch(
      /after: \{ reason: SET_PASSWORD_REASON, sessionsRevoked: sessions\.length \}/,
    );
    expect(core).toMatch(/SET_PASSWORD_REASON = "schimbare din CLI"/);
  });
});

describe("comenzile CLI de la rădăcină", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

  it("rulează direct cu node + tsx, nu prin runner-ul recursiv pnpm --filter (pierdea tastele pe Windows)", () => {
    for (const name of [
      "admin:create",
      "admin:set-password",
      "admin:unlock",
      "rbac:revoke",
      "cli:tty-test",
    ]) {
      const command = pkg.scripts[name] ?? "";
      expect(command, name).toMatch(/^node --import tsx packages\/core\/scripts\/[\w-]+\.ts$/);
      expect(command, name).not.toContain("--filter");
    }
  });
});

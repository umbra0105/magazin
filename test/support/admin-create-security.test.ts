import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Garanții de arhitectură pentru contul de administrator: parola vine DOAR dintr-un prompt
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

  it("parola se cere prin promptHidden (fără echo), de două ori", () => {
    expect(script.match(/promptHidden\(/g)?.length).toBe(2);
    expect(script).toMatch(/!process\.stdin\.isTTY/);
  });

  it("funcția de creare nu are nicio parolă implicită și nu scrie parola în audit", () => {
    const create = read("packages/core/src/auth/create-admin.ts");
    expect(create).not.toMatch(/password:\s*["'`][^"'`]+["'`]/);
    expect(create).toMatch(/after: \{ email, role: OWNER_ROLE_KEY, emailVerified: true \}/);
  });
});

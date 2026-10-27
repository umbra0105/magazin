import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Suita E2E și testele de integrare NU împart indexul Redis.
 *
 * Dacă ambele scriu în același index, sesiunile și contoarele E2E (TTL până la 30 de zile) se adună acolo și orice test de
 * integrare care citește chei în masă încetinește pe măsură ce indexul crește (incidentul `auth-email`: 41.761 de chei
 * `ecom:auth:*`, `GET`-uri în serie în 14,2 s din 15 s). De aceea `playwright.config.ts` pune serverul E2E și procesele
 * Playwright pe indexul derivat de `deriveE2eRedisUrl`, nu pe cel de integrare (`testRedisUrl`).
 *
 * Atenție: Playwright reevaluează configurația în FIECARE worker, după ce procesul principal a pus deja
 * `TEST_REDIS_URL` pe indexul E2E. Derivarea trebuie să fie idempotentă: indexul E2E se păstrează în `E2E_REDIS_URL`
 * și se refolosește (altfel workerii derivă încă o dată, ajung pe alt index decât serverul, iar helperele E2E, de exemplu
 * ștergerea cache-ului de flaguri, nu mai ating Redis-ul serverului).
 *
 * Citește configurația ca text; `findRedisSharing` e pură și testată pe texte sintetice.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

export function findRedisSharing(config: string): string[] {
  const problems: string[] = [];
  if (!/deriveE2eRedisUrl\(/.test(config)) {
    problems.push("configurația nu derivă un index Redis separat pentru E2E (deriveE2eRedisUrl)");
  }
  if (/TEST_REDIS_URL"\]\s*=\s*testRedisUrl\b/.test(config)) {
    problems.push("TEST_REDIS_URL al suitei E2E e indexul testelor de integrare (testRedisUrl)");
  }
  if (/REDIS_URL:\s*testRedisUrl\b/.test(config)) {
    problems.push("serverul E2E primește indexul testelor de integrare (REDIS_URL: testRedisUrl)");
  }
  if (!/TEST_REDIS_URL"\]\s*=\s*e2eRedisUrl\b/.test(config)) {
    problems.push("TEST_REDIS_URL nu e setat pe indexul E2E (e2eRedisUrl)");
  }
  if (!/REDIS_URL:\s*e2eRedisUrl\b/.test(config)) {
    problems.push("serverul E2E nu primește indexul E2E (REDIS_URL: e2eRedisUrl)");
  }
  if (!/process\.env\["E2E_REDIS_URL"\]\s*\?\?\s*deriveE2eRedisUrl\(/.test(config)) {
    problems.push(
      "derivarea nu e idempotentă: workerii Playwright reevaluează configurația (E2E_REDIS_URL ?? deriveE2eRedisUrl(...))",
    );
  }
  if (!/process\.env\["E2E_REDIS_URL"\]\s*=\s*e2eRedisUrl\b/.test(config)) {
    problems.push("indexul E2E nu e păstrat în E2E_REDIS_URL pentru workeri");
  }
  return problems;
}

const good = `
const e2eRedisUrl = process.env["E2E_REDIS_URL"] ?? deriveE2eRedisUrl(testRedisUrl);
process.env["E2E_REDIS_URL"] = e2eRedisUrl;
process.env["TEST_REDIS_URL"] = e2eRedisUrl;
const server = { env: { REDIS_URL: e2eRedisUrl } };
`;

describe("findRedisSharing (pură)", () => {
  it("o configurație cu indexul E2E separat nu are probleme", () => {
    expect(findRedisSharing(good)).toEqual([]);
  });

  it("prinde serverul E2E pe indexul de integrare", () => {
    const bad = good.replace("REDIS_URL: e2eRedisUrl", "REDIS_URL: testRedisUrl");
    expect(findRedisSharing(bad)).toEqual(
      expect.arrayContaining([expect.stringContaining("REDIS_URL: testRedisUrl")]),
    );
  });

  it("prinde TEST_REDIS_URL rămas pe indexul de integrare", () => {
    const bad = good.replace(
      '["TEST_REDIS_URL"] = e2eRedisUrl',
      '["TEST_REDIS_URL"] = testRedisUrl',
    );
    expect(findRedisSharing(bad).length).toBeGreaterThan(0);
  });

  it("prinde lipsa derivării", () => {
    expect(findRedisSharing("const x = 1;")).toHaveLength(5);
  });

  it("prinde derivarea neidempotentă (workerii ar deriva a doua oară)", () => {
    const bad = good.replace('process.env["E2E_REDIS_URL"] ?? ', "");
    expect(findRedisSharing(bad)).toEqual(
      expect.arrayContaining([expect.stringContaining("idempotentă")]),
    );
  });
});

describe("playwright.config.ts: indexul Redis al E2E", () => {
  it("E2E nu folosește indexul testelor de integrare", () => {
    const config = readFileSync(`${root}playwright.config.ts`, "utf8");
    expect(findRedisSharing(config)).toEqual([]);
  });
});

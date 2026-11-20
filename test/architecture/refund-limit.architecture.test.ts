import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Limita de rambursare a rolului Suport (Faza 11, decizia 2026-11-19) nu poate fi ocolită printr-o cale nouă. Reguli, pe codul de
 * producție (testele, e2e și scripturile sunt scutite):
 *  1. `requestRefund` (rambursarea FĂRĂ limită) se apelează doar din acțiunea ecranului de plăți, care cere `payments.refund`.
 *  2. `createRefundInTx` (care creează rândul și angajează suma) se apelează doar din serviciile de rambursare (`order-refund`,
 *     `refund-service`) și din procesorul de plăți (rambursările AUTOMATE ale sistemului, fără actor).
 *  3. Orice apel `requestOrderRefund` din aplicație calculează `actorUnlimited` din permisiunea `payments.refund` (niciodată o
 *     constantă `true`) și stă într-o acțiune cu `orders.refund`.
 *  4. Rolul Suport nu primește `payments.refund` (verificat și în `catalog.test.ts`; aici, pe textul sursei).
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const SKIP = new Set(["node_modules", ".next", "dist", "generated"]);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".next")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
}

const isExempt = (path: string): boolean =>
  /\.(test|spec)\.[cm]?tsx?$/.test(path) ||
  /\.e2e\.[cm]?tsx?$/.test(path) ||
  path.startsWith("e2e/") ||
  path.startsWith("test/") ||
  /(^|\/)test-utils\//.test(path) ||
  /(^|\/)scripts\//.test(path);

function production(): { path: string; content: string }[] {
  const all: string[] = [];
  for (const base of ["apps", "packages"]) walk(join(root, base), all);
  return all
    .map((full) => relative(root, full).split(sep).join("/"))
    .filter((p) => /\.[cm]?tsx?$/.test(p) && !isExempt(p))
    .map((path) => ({ path, content: readFileSync(join(root, path), "utf8") }));
}

/** Fișierele (fără comentarii de linie) care conțin un apel `name(`, fără definiția lui. */
function callers(name: string): string[] {
  const call = new RegExp(`(?<![\\w.])${name}\\s*\\(`);
  return production()
    .filter(({ content }) =>
      content
        .split("\n")
        .some(
          (line) =>
            !line.trim().startsWith("//") && !line.includes(`function ${name}`) && call.test(line),
        ),
    )
    .map(({ path }) => path);
}

describe("limita de rambursare: nicio cale de ocolire", () => {
  it("`requestRefund` (fără limită) se apelează doar din acțiunea ecranului de plăți", () => {
    expect(callers("requestRefund")).toEqual([
      "apps/web/src/app/(admin)/admin/comenzi/plati/actions.ts",
    ]);
    const source = readFileSync(
      join(root, "apps/web/src/app/(admin)/admin/comenzi/plati/actions.ts"),
      "utf8",
    );
    expect(source).toMatch(/withPermission\(\s*"payments\.refund"/);
  });

  it("`createRefundInTx` se apelează doar din serviciile de rambursare și din procesorul de plăți (rambursări automate)", () => {
    expect(callers("createRefundInTx").sort()).toEqual([
      "packages/core/src/payments/order-refund.ts",
      "packages/core/src/payments/payment-processor.ts",
      "packages/core/src/payments/refund-service.ts",
    ]);
  });

  it("orice apel `requestOrderRefund` din aplicație derivă `actorUnlimited` din `payments.refund` și cere `orders.refund`", () => {
    const files = callers("requestOrderRefund").filter((p) => p.startsWith("apps/"));
    for (const path of files) {
      const source = readFileSync(join(root, path), "utf8");
      expect(source, path).toMatch(/actorUnlimited:\s*can\(\s*subject,\s*"payments\.refund"\s*\)/);
      expect(source, path).toMatch(/withPermission\(\s*"orders\.refund"/);
      expect(source, path).not.toMatch(/actorUnlimited:\s*true/);
    }
  });

  it("rolul Suport nu are `payments.refund` în catalog", () => {
    const catalog = readFileSync(join(root, "packages/core/src/rbac/catalog.ts"), "utf8");
    const start = catalog.indexOf('key: "support"');
    const end = catalog.indexOf('key: "warehouse"');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(catalog.slice(start, end)).not.toContain('"payments.refund"');
    expect(catalog.slice(start, end)).toContain('"orders.refund"');
  });
});

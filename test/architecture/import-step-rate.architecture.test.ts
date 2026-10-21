import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Pașii «analizează» și «verifică» ai importului reparsează fișierul întreg (CSV/XLSX, până la zeci de MB) la fiecare
 * apel. Doar încărcarea și descărcarea raportului aveau limită pe utilizator; un utilizator cu `products.write` putea
 * repeta pașii fără frână și ține procesul ocupat (Blocul C, C-04). Fiecare dintre acești pași trebuie să treacă prin
 * `checkImportStepRate` înainte de serviciu. Testul citește sursa ca text; `findStepsWithoutRateCheck` e pură.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

export function findStepsWithoutRateCheck(content: string, actions: readonly string[]): string[] {
  const problems: string[] = [];
  for (const name of actions) {
    const start = content.indexOf(`export const ${name} = withPermission(`);
    if (start < 0) {
      problems.push(`${name}: acțiunea lipsește`);
      continue;
    }
    const next = content.indexOf("\nexport const ", start + 10);
    const body = content.slice(start, next < 0 ? content.length : next);
    const check = body.indexOf("checkImportStepRate(");
    const service = body.indexOf("getProductImportService()");
    if (check < 0) problems.push(`${name}: nu apelează checkImportStepRate`);
    else if (service >= 0 && check > service) {
      problems.push(`${name}: limita trebuie verificată ÎNAINTE de serviciu`);
    }
  }
  return problems;
}

describe("pașii importului au limită pe utilizator", () => {
  it("detectează un pas fără limită sau cu limita după serviciu", () => {
    const bad = `export const a = withPermission("x", async () => { await getProductImportService().analyze(); });`;
    expect(findStepsWithoutRateCheck(bad, ["a"])).toEqual(["a: nu apelează checkImportStepRate"]);
    const late = `export const a = withPermission("x", async () => { await getProductImportService().analyze(); await checkImportStepRate(1); });`;
    expect(findStepsWithoutRateCheck(late, ["a"])).toEqual([
      "a: limita trebuie verificată ÎNAINTE de serviciu",
    ]);
    const good = `export const a = withPermission("x", async () => { await checkImportStepRate(1); await getProductImportService().analyze(); });
export const b = withPermission("x", async () => {});`;
    expect(findStepsWithoutRateCheck(good, ["a"])).toEqual([]);
  });

  it("analyzeProductImport și validateProductImport apelează checkImportStepRate", () => {
    const source = readFileSync(
      `${root}apps/web/src/app/(admin)/admin/produse/import/actions.ts`,
      "utf8",
    );
    expect(
      findStepsWithoutRateCheck(source, ["analyzeProductImport", "validateProductImport"]),
    ).toEqual([]);
  });
});

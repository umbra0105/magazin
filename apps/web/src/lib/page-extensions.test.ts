import { describe, expect, it } from "vitest";
import { pageExtensionsFor } from "./page-extensions";

/**
 * Fișierele `*.e2e.tsx` (harness-uri pentru teste și pagina de exemplu a componentelor, docs/17 §7) sunt rute DOAR în
 * dezvoltare (`NODE_ENV` ≠ `production`) sau cu `E2E_HARNESS=1` (build-ul de test al Playwright). Într-un build de producție
 * obișnuit (`next build`, `NODE_ENV=production`, fără variabilă) extensia nu e inclusă: fișierele nu devin rute și nu se compilează.
 */
describe("extensiile de pagină ale aplicației", () => {
  it("producție fără E2E_HARNESS: fără `e2e.tsx` (pagina de exemplu și harness-urile nu există)", () => {
    expect(pageExtensionsFor({ NODE_ENV: "production" })).toEqual(["tsx", "ts", "jsx", "js"]);
    expect(pageExtensionsFor({ NODE_ENV: "production", E2E_HARNESS: "0" })).not.toContain(
      "e2e.tsx",
    );
    expect(pageExtensionsFor({ NODE_ENV: "production", E2E_HARNESS: "" })).not.toContain("e2e.tsx");
  });

  it("producție cu E2E_HARNESS=1 (build-ul de test): includ `e2e.tsx`", () => {
    expect(pageExtensionsFor({ NODE_ENV: "production", E2E_HARNESS: "1" })).toContain("e2e.tsx");
  });

  it("dezvoltare: includ `e2e.tsx`, ca pagina de exemplu să se vadă pe `next dev`", () => {
    expect(pageExtensionsFor({ NODE_ENV: "development" })).toContain("e2e.tsx");
  });

  it("fără NODE_ENV (necunoscut) se tratează ca producție: nu includ `e2e.tsx`", () => {
    expect(pageExtensionsFor({})).not.toContain("e2e.tsx");
  });

  it("extensiile obișnuite rămân mereu", () => {
    for (const env of [{}, { NODE_ENV: "production" }, { NODE_ENV: "development" }]) {
      expect(pageExtensionsFor(env)).toEqual(expect.arrayContaining(["tsx", "ts", "jsx", "js"]));
    }
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Șabloanele emailurilor (Faza 11) nu au valori de brand: nicio culoare hex, niciun nume de magazin scris în cod. Aspectul vine
 * din `EmailTheme` (generată din `Branding`), numele și datele firmei din setări. Mostrele («Magazin Exemplu») sunt date de probă.
 */
const root = fileURLToPath(new URL("../../packages/emails/src/", import.meta.url));
const FILES = [
  "catalog.ts",
  "template-model.ts",
  "template-text.ts",
  "render-template.ts",
  "blocks.ts",
  "templates/blocks-email.tsx",
  "templates/email-layout.tsx",
  "templates/action-email.tsx",
];

describe("șabloanele de email: fără culori și nume de brand în cod", () => {
  for (const file of FILES) {
    it(file, () => {
      const source = readFileSync(`${root}${file}`, "utf8");
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source).not.toMatch(/\b(rgb|hsl)a?\(/);
      expect(source).not.toMatch(/Piscine|TotalWater|Total Water/i);
    });
  }
});

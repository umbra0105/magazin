import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Zona de încărcare a bibliotecii: regulile ei de aspect stau în clase, iar ecranele tactile nu pot fi emulate separat pe
 * «hover: none» și pe «pointer: coarse» (Chromium le schimbă împreună), deci condiția dublă se păzește pe textul sursei.
 * Comportamentul real (ce dispare pe un ecran tactil, cât de înalt e panoul) e verificat de `e2e/media-warehouses-design.spec.ts`.
 * Componenta nu se poate randa în testele unitare (configurația TSX a aplicației Next nu e cea a Vitest), de aceea citim fișierul.
 */
const source = readFileSync(
  fileURLToPath(new URL("./upload-panel.tsx", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** Ecranele fără cursor (hover: none) SAU cu pointer grosier (pointer: coarse): un singur media query cu «,» = «sau». */
const TOUCH = "[@media(hover:none),(pointer:coarse)]";

describe("UploadPanel (sursa)", () => {
  it("ascunde pe ecrane tactile textul de tragere, «sau» și pictograma (trei elemente), cu condiția «hover: none» SAU «pointer: coarse»", () => {
    expect(source.split(`${TOUCH}:hidden`).length - 1).toBe(3);
    // niciun element nu se ascunde doar pe una dintre condiții (ar lăsa textul pe un ecran tactil de celălalt fel)
    expect(source).not.toMatch(/\[@media\(hover:none\)\]:hidden/);
    expect(source).not.toMatch(/\[@media\(pointer:coarse\)\]:hidden/);
    expect(source).not.toMatch(/pointer-coarse:hidden/);
  });

  it("textul de tragere nu e ascuns niciodată pe desktop: ascunderea apare numai în condiția tactilă", () => {
    // fără «hidden» simplu sau cu alt prefix (sm:, md:, lg:) pe elementele zonei de tragere
    expect(source).not.toMatch(/className="[^"]*(?<![:\w-])hidden[^"]*"/);
  });

  it("«Alege fișiere» e principal doar când panoul e cerut ca principal (biblioteca), altfel secundar (selectorul)", () => {
    expect(source).toMatch(/variant=\{primary \? "default" : "outline"\}/);
  });
});

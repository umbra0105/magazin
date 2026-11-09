import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ADMIN_BRAND_MIN_CONTRAST,
  adminBrandStyle,
  resolveAdminBrand,
  type AdminBrandInput,
} from "./admin-brand";
import { contrastRatio } from "./contrast";
import { ADMIN_BRAND_REFERENCE, PRESETS } from "./presets";

/**
 * Din `Branding` vin în admin doar culoarea de brand (`accent`), cu gardă de contrast: legătura trebuie să aibă cel puțin
 * 4,5:1 pe fundalul paginii (3:1 ar fi minimul inelului de focus, acoperit de 4,5:1) și textul `--on-brand` cel puțin 4,5:1 pe
 * ea (contoare). Altfel adminul rămâne pe valoarea lui implicită (`null` aici = «nu suprascrie»). Garda e pe fiecare temă.
 */
const input = (light: string, dark: string): AdminBrandInput => ({
  light: { accent: light },
  dark: { accent: dark },
});

describe("garda de contrast a brandului din admin", () => {
  it("acceptă un brand cu contrast suficient pe ambele teme", () => {
    expect(resolveAdminBrand(input("#2563eb", "#60a5fa"))).toEqual({
      light: "#2563eb",
      dark: "#60a5fa",
    });
  });

  it("respinge un brand deschis pe tema deschisă (sub 4,5:1 pe alb) și îl lasă pe cel întunecat", () => {
    const pale = "#93c5fd";
    expect(contrastRatio(pale, ADMIN_BRAND_REFERENCE.light.page)).toBeLessThan(
      ADMIN_BRAND_MIN_CONTRAST,
    );
    expect(resolveAdminBrand(input(pale, "#60a5fa"))).toEqual({ light: null, dark: "#60a5fa" });
  });

  it("respinge un brand închis pe tema întunecată (sub 4,5:1 pe fundalul închis) și îl lasă pe cel deschis", () => {
    const deep = "#1e3a8a";
    expect(contrastRatio(deep, ADMIN_BRAND_REFERENCE.dark.page)).toBeLessThan(
      ADMIN_BRAND_MIN_CONTRAST,
    );
    expect(resolveAdminBrand(input("#2563eb", deep))).toEqual({ light: "#2563eb", dark: null });
  });

  it("limita e 4,5:1 exact: o culoare puțin sub e respinsă, una puțin peste e acceptată", () => {
    // gri pe alb: #767676 = 4,54:1 (trece), #7a7a7a = 4,28:1 (pică)
    expect(contrastRatio("#767676", ADMIN_BRAND_REFERENCE.light.page)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#7a7a7a", ADMIN_BRAND_REFERENCE.light.page)).toBeLessThan(4.5);
    expect(resolveAdminBrand(input("#767676", "#60a5fa")).light).toBe("#767676");
    expect(resolveAdminBrand(input("#7a7a7a", "#60a5fa")).light).toBeNull();
  });

  it("toate valorile întoarse ating pragul față de pagină și de textul de pe brand", () => {
    for (const preset of Object.values(PRESETS)) {
      const brand = resolveAdminBrand(preset.colors);
      for (const mode of ["light", "dark"] as const) {
        const value = brand[mode];
        if (value === null) continue;
        expect(contrastRatio(value, ADMIN_BRAND_REFERENCE[mode].page)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("stilul inline conține doar valorile care au trecut", () => {
    expect(adminBrandStyle({ light: "#2563eb", dark: "#60a5fa" })).toEqual({
      "--brand-light": "#2563eb",
      "--brand-dark": "#60a5fa",
    });
    expect(adminBrandStyle({ light: null, dark: "#60a5fa" })).toEqual({
      "--brand-dark": "#60a5fa",
    });
    expect(adminBrandStyle({ light: null, dark: null })).toEqual({});
  });
});

describe("referințele de contrast coincid cu fișierul de tokeni al adminului", () => {
  const css = readFileSync(
    new URL("../../../ui/src/styles/admin-tokens.css", import.meta.url),
    "utf8",
  );
  const pair = (name: string): [string, string] => {
    const match = css.match(
      new RegExp(
        `--${name}:\\s*light-dark\\(\\s*(#[0-9a-f]{6})\\s*,\\s*(#[0-9a-f]{6})\\s*\\)`,
        "i",
      ),
    );
    if (!match) throw new Error(`--${name} lipsește sau nu e light-dark() în fișierul de tokeni`);
    return [(match[1] as string).toLowerCase(), (match[2] as string).toLowerCase()];
  };

  it("fundalul paginii și textul de pe brand", () => {
    expect(pair("surface-page")).toEqual([
      ADMIN_BRAND_REFERENCE.light.page,
      ADMIN_BRAND_REFERENCE.dark.page,
    ]);
    // textul de pe brand are exact culoarea paginii în fiecare temă: o singură verificare de contrast acoperă ambele roluri
    expect(pair("on-brand")).toEqual(pair("surface-page"));
  });

  it("brandul implicit al adminului îndeplinește el însuși garda", () => {
    const light = css.match(/--brand-light:\s*(#[0-9a-f]{6})/i)?.[1] as string;
    const dark = css.match(/--brand-dark:\s*(#[0-9a-f]{6})/i)?.[1] as string;
    expect(resolveAdminBrand(input(light, dark))).toEqual({ light, dark });
  });
});

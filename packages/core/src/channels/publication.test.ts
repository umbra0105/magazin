import { describe, expect, it } from "vitest";
import { validateForPublication } from "./publication";

const web = { requiresEan: false, requiresBrand: false };
const emag = { requiresEan: true, requiresBrand: true };

const codes = (
  channel: { requiresEan: boolean; requiresBrand: boolean },
  candidate: { ean: string | null; brandId: string | null },
) => validateForPublication(channel, candidate).map((i) => i.code);

describe("validateForPublication", () => {
  it("canalul fără cerințe publică orice (fără EAN, fără brand)", () => {
    expect(validateForPublication(web, { ean: null, brandId: null })).toEqual([]);
  });

  it("canalul care cere EAN și brand le raportează pe amândouă când lipsesc", () => {
    const issues = validateForPublication(emag, { ean: null, brandId: null });
    expect(issues.map((i) => i.code)).toEqual(["EAN_MISSING", "BRAND_MISSING"]);
    expect(issues.map((i) => i.field)).toEqual(["ean", "brandId"]);
  });

  it("raportează doar ce lipsește", () => {
    expect(codes(emag, { ean: "5901234123457", brandId: null })).toEqual(["BRAND_MISSING"]);
    expect(codes(emag, { ean: null, brandId: "brand-1" })).toEqual(["EAN_MISSING"]);
    expect(codes(emag, { ean: "5901234123457", brandId: "brand-1" })).toEqual([]);
  });

  it("un șir gol sau doar spații nu e un EAN și nici un brand", () => {
    expect(codes(emag, { ean: "  ", brandId: "b" })).toEqual(["EAN_MISSING"]);
    expect(codes(emag, { ean: "", brandId: "  " })).toEqual(["EAN_MISSING", "BRAND_MISSING"]);
  });

  it("cerințele sunt independente (doar EAN, doar brand)", () => {
    const none = { ean: null, brandId: null };
    expect(codes({ requiresEan: true, requiresBrand: false }, none)).toEqual(["EAN_MISSING"]);
    expect(codes({ requiresEan: false, requiresBrand: true }, none)).toEqual(["BRAND_MISSING"]);
  });
});

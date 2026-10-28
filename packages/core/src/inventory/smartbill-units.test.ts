import { describe, expect, it } from "vitest";
import { classifySmartbillUnit, normalizeUnitText } from "./smartbill-units";

const unit = (key: string) => ({ kind: "unit", key });

describe("normalizeUnitText: fără deosebire de litere, diacritice și spații în plus", () => {
  it("taie spațiile, coboară literele, scoate diacriticele și punctul final", () => {
    expect(normalizeUnitText("  BUC. ")).toBe("buc");
    expect(normalizeUnitText("Bucăți")).toBe("bucati");
    expect(normalizeUnitText("metru   pătrat")).toBe("metru patrat");
    expect(normalizeUnitText("M²")).toBe("m2");
    expect(normalizeUnitText("")).toBe("");
  });
});

describe("classifySmartbillUnit: tabelul explicit al unităților din raportul «Stoc la zi»", () => {
  it("bucată în toate scrierile observate", () => {
    for (const text of ["BUC", "buc", "Buc", "bucata", "unitate", "UNIT", " buc ", "Bucăți"]) {
      expect(classifySmartbillUnit(text), text).toEqual(unit("buc"));
    }
  });

  it("metri liniari, metri pătrați și cubi", () => {
    expect(classifySmartbillUnit("ML")).toEqual(unit("ml"));
    expect(classifySmartbillUnit("ml")).toEqual(unit("ml"));
    for (const text of ["MP", "mp", "M2", "m2", "M²"]) {
      expect(classifySmartbillUnit(text), text).toEqual(unit("mp"));
    }
    expect(classifySmartbillUnit("M3")).toEqual(unit("mc"));
  });

  it("kilograme, litri, saci, cutii, role", () => {
    for (const text of ["KG", "kg", "kilogram"]) {
      expect(classifySmartbillUnit(text), text).toEqual(unit("kg"));
    }
    for (const text of ["LT", "lt", "LITRI", "litru"]) {
      expect(classifySmartbillUnit(text), text).toEqual(unit("l"));
    }
    expect(classifySmartbillUnit("SAC")).toEqual(unit("sac"));
    expect(classifySmartbillUnit("CUTIE")).toEqual(unit("cutie"));
    expect(classifySmartbillUnit("Rolă")).toEqual(unit("rola"));
  });

  it("serviciile (curs, xpp, turn) sunt recunoscute ca servicii, nu ca unități de stoc", () => {
    for (const text of ["CURS", "XPP", "TURN", "curs"]) {
      expect(classifySmartbillUnit(text), text).toEqual({ kind: "service" });
    }
  });

  it("o unitate necunoscută sau goală nu se ghicește", () => {
    expect(classifySmartbillUnit("palet")).toEqual({ kind: "unknown", text: "palet" });
    expect(classifySmartbillUnit("")).toEqual({ kind: "unknown", text: "" });
    expect(classifySmartbillUnit(null)).toEqual({ kind: "unknown", text: "" });
    expect(classifySmartbillUnit(undefined)).toEqual({ kind: "unknown", text: "" });
  });

  it("nu confundă unități apropiate (m2 ≠ m3, ml ≠ mp)", () => {
    expect(classifySmartbillUnit("m2")).not.toEqual(classifySmartbillUnit("m3"));
    expect(classifySmartbillUnit("ml")).not.toEqual(classifySmartbillUnit("mp"));
  });
});

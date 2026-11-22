import { describe, expect, it } from "vitest";
import { formatUnitNames, parseUnitNames } from "./invoicing-texts";

describe("numele unităților din contul de facturare", () => {
  it("citește perechi «simbol = nume», cu spații și rânduri goale", () => {
    expect(parseUnitNames("mp = mp\n\n  sac=Sac \r\nbuc = Bucata")).toEqual({
      mp: "mp",
      sac: "Sac",
      buc: "Bucata",
    });
    expect(parseUnitNames("")).toEqual({});
  });

  it("refuză rândurile fără «=», cu cheie sau valoare goală ori prea lungi", () => {
    expect(parseUnitNames("mp")).toBeNull();
    expect(parseUnitNames("= mp")).toBeNull();
    expect(parseUnitNames("mp =")).toBeNull();
    expect(parseUnitNames(`mp = ${"x".repeat(41)}`)).toBeNull();
    expect(parseUnitNames(`${"x".repeat(41)} = mp`)).toBeNull();
  });

  it("afișarea și citirea sunt inverse una alteia", () => {
    const names = { sac: "Sac", mp: "mp" };
    expect(formatUnitNames(names)).toBe("mp = mp\nsac = Sac");
    expect(parseUnitNames(formatUnitNames(names))).toEqual(names);
  });
});

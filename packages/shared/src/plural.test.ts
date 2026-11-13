import { describe, expect, it } from "vitest";
import { pluralRo } from "./plural";

const form = (n: number) => pluralRo(n, "brand", "branduri", "de branduri");

describe("pluralRo (acordul numeralului în română)", () => {
  it("1 = singular", () => {
    expect(form(1)).toBe("1 brand");
  });

  it("0 și 2–19 = plural, fără «de»", () => {
    expect(form(0)).toBe("0 branduri");
    for (const n of [2, 3, 10, 11, 12, 19]) expect(form(n), String(n)).toBe(`${n} branduri`);
  });

  it("20–99 și rotunjimile de sute = plural cu «de»", () => {
    for (const n of [20, 21, 22, 50, 99, 100, 200, 120]) {
      expect(form(n), String(n)).toBe(`${n} de branduri`);
    }
    expect(form(1000)).toBe("1.000 de branduri");
  });

  it("restul se judecă după ultimele două cifre: 101 și 119 fără «de», 120 cu «de»", () => {
    for (const n of [101, 102, 111, 119]) expect(form(n), String(n)).toBe(`${n} branduri`);
    expect(form(1001)).toBe("1.001 branduri");
    expect(form(1019)).toBe("1.019 branduri");
    expect(form(2005)).toBe("2.005 branduri");
    for (const n of [120, 121, 199]) expect(form(n), String(n)).toBe(`${n} de branduri`);
    expect(form(1020)).toBe("1.020 de branduri");
  });

  it("numerele mari se scriu cu separator de mii românesc", () => {
    expect(form(12345)).toBe("12.345 de branduri");
  });
});

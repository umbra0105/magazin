import { describe, expect, it } from "vitest";
import { bpsToPercentText, parsePercentToBps } from "./customer-group-form";

describe("procentele grupurilor de clienți", () => {
  it.each([
    ["5", 500],
    ["7", 700],
    ["12,5", 1250],
    ["12.5", 1250],
    ["21%", 2100],
    ["0", 0],
    ["100", 10_000],
    [" 17 ", 1700],
    ["0,05", 5],
  ])("«%s» → %i puncte de bază", (text, bps) => {
    expect(parsePercentToBps(text, 100)).toEqual({ ok: true, bps });
  });

  it("adaosul poate depăși 100%, reducerea nu", () => {
    expect(parsePercentToBps("150", 1000)).toEqual({ ok: true, bps: 15_000 });
    expect(parsePercentToBps("101", 100)).toEqual({ ok: false, problem: "too_big" });
    expect(parsePercentToBps("1000,01", 1000)).toEqual({ ok: false, problem: "too_big" });
  });

  it.each([
    ["", "required"],
    ["  ", "required"],
    ["abc", "invalid"],
    ["5,555", "invalid"],
    ["-5", "invalid"],
    ["1e2", "invalid"],
    ["5,", "invalid"],
  ])("«%s» e refuzat (%s)", (text, problem) => {
    expect(parsePercentToBps(text, 100)).toEqual({ ok: false, problem });
  });

  it("bpsToPercentText inversează fără float", () => {
    expect(bpsToPercentText(500)).toBe("5");
    expect(bpsToPercentText(1250)).toBe("12,5");
    expect(bpsToPercentText(5)).toBe("0,05");
    expect(bpsToPercentText(0)).toBe("0");
    for (const bps of [0, 5, 100, 1250, 1999, 10_000]) {
      expect(parsePercentToBps(bpsToPercentText(bps), 1000)).toEqual({ ok: true, bps });
    }
  });
});

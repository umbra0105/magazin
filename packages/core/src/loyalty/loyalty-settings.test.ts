import { describe, expect, it } from "vitest";
import { getSettingSchema } from "../settings/registry";
import { loyaltySettingsFrom } from "./loyalty-settings";

const parse = (key: string, value: unknown) => getSettingSchema(key)!.safeParse(value);

describe("setările de loialitate (decizia 9 și D12)", () => {
  it("valorile implicite ale pachetului: program oprit, fără tratament TVA", () => {
    expect(loyaltySettingsFrom(new Map(), false)).toEqual({
      featureOn: false,
      enabled: false,
      active: false,
      redeemAvailable: false,
      earnRate: 10_000,
      pointValue: 100,
      expiryMonths: 12,
      expiryWarningDays: 30,
      maxRedeemPercent: null,
      minRedeemPoints: 10,
      minCashAmount: 100,
      earnOnDiscountedItems: true,
      vatMode: null,
      releasedGraceDays: 30,
    });
  });

  it("`vatMode` acceptă doar gol și `base_reduced`; `base_full` și orice altceva sunt respinse", () => {
    expect(parse("loyalty.vatMode", null).success).toBe(true);
    expect(parse("loyalty.vatMode", "base_reduced").success).toBe(true);
    for (const bad of ["base_full", "", "reduced", true, 1]) {
      expect(parse("loyalty.vatMode", bad).success, String(bad)).toBe(false);
    }
  });

  it.each([
    ["loyalty.minCashAmount", 0],
    ["loyalty.earnRate", 0],
    ["loyalty.pointValue", 0],
    ["loyalty.minRedeemPoints", 0],
    ["loyalty.maxRedeemPercent", 101],
    ["loyalty.maxRedeemPercent", 0],
    ["loyalty.releasedGraceDays", -1],
    ["loyalty.expiryMonths", 0],
  ])("%s = %s e respins (regula dură nu se poate dezactiva)", (key, value) => {
    expect(parse(key, value).success).toBe(false);
  });

  it("programul merge doar cu flag-ul ȘI cu `enabled`; folosirea punctelor cere și `vatMode`", () => {
    const rows = (over: Record<string, unknown>) => new Map(Object.entries(over));
    const on = { "loyalty.enabled": true };
    expect(loyaltySettingsFrom(rows(on), false).active).toBe(false);
    expect(loyaltySettingsFrom(rows({}), true).active).toBe(false);
    expect(loyaltySettingsFrom(rows(on), true)).toMatchObject({
      active: true,
      redeemAvailable: false,
    });
    expect(
      loyaltySettingsFrom(rows({ ...on, "loyalty.vatMode": "base_reduced" }), true).redeemAvailable,
    ).toBe(true);
  });

  it("o valoare stricată în bază cade pe cea implicită, iar un `vatMode` necunoscut blochează folosirea", () => {
    const rows = new Map<string, unknown>([
      ["loyalty.enabled", true],
      ["loyalty.vatMode", "base_full"],
      ["loyalty.minCashAmount", 0],
    ]);
    expect(loyaltySettingsFrom(rows, true)).toMatchObject({
      vatMode: null,
      redeemAvailable: false,
      minCashAmount: 100,
    });
  });
});

import { describe, expect, it } from "vitest";
import { decideRefundLimit, type RefundLimitInput } from "./refund-limit";

/**
 * Limita de rambursare a rolului Suport (decizia din 2026-11-19): `orders.refund` fără `payments.refund` = actor CU LIMITĂ.
 * Suma cerută plus ce au rambursat deja actorii cu limită pe aceeași comandă nu poate depăși limita din setare. Setarea lipsă
 * sau coruptă = refuz (niciodată «fără limită»).
 */
const base: RefundLimitInput = {
  actorUnlimited: false,
  limitMinor: 50_000,
  alreadyLimitedMinor: 0,
  amountMinor: 10_000,
};

describe("decideRefundLimit", () => {
  it("sub limită trece", () => {
    expect(decideRefundLimit(base)).toEqual({ allowed: true });
  });

  it("LIMITA EXACTĂ trece", () => {
    expect(decideRefundLimit({ ...base, amountMinor: 50_000 })).toEqual({ allowed: true });
  });

  it("limita + 1 ban se refuză, cu suma rămasă în răspuns", () => {
    expect(decideRefundLimit({ ...base, amountMinor: 50_001 })).toEqual({
      allowed: false,
      reason: "over_limit",
      remainingMinor: 50_000,
    });
  });

  it("rambursările anterioare ale actorilor cu limită se adună (cumulat pe comandă)", () => {
    expect(
      decideRefundLimit({ ...base, alreadyLimitedMinor: 40_000, amountMinor: 10_000 }),
    ).toEqual({ allowed: true });
    expect(
      decideRefundLimit({ ...base, alreadyLimitedMinor: 40_000, amountMinor: 10_001 }),
    ).toEqual({ allowed: false, reason: "over_limit", remainingMinor: 10_000 });
  });

  it("limita deja epuizată: orice sumă se refuză, restul e 0 (niciodată negativ)", () => {
    expect(decideRefundLimit({ ...base, alreadyLimitedMinor: 50_000, amountMinor: 1 })).toEqual({
      allowed: false,
      reason: "over_limit",
      remainingMinor: 0,
    });
    expect(decideRefundLimit({ ...base, alreadyLimitedMinor: 70_000, amountMinor: 1 })).toEqual({
      allowed: false,
      reason: "over_limit",
      remainingMinor: 0,
    });
  });

  it("actorul fără limită (payments.refund: Manager, Admin, Owner) trece peste limită", () => {
    expect(
      decideRefundLimit({
        ...base,
        actorUnlimited: true,
        alreadyLimitedMinor: 49_999,
        amountMinor: 5_000_000,
      }),
    ).toEqual({ allowed: true });
  });

  it("setare lipsă, coruptă sau negativă = refuz pentru actorul cu limită", () => {
    for (const limitMinor of [null, Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(decideRefundLimit({ ...base, limitMinor }), String(limitMinor)).toEqual({
        allowed: false,
        reason: "limit_unavailable",
      });
    }
  });

  it("limita 0 înseamnă «Suport nu poate rambursa nimic»", () => {
    expect(decideRefundLimit({ ...base, limitMinor: 0, amountMinor: 1 })).toEqual({
      allowed: false,
      reason: "over_limit",
      remainingMinor: 0,
    });
  });

  it("setarea lipsă NU blochează actorul fără limită (nu depinde de ea)", () => {
    expect(decideRefundLimit({ ...base, actorUnlimited: true, limitMinor: null })).toEqual({
      allowed: true,
    });
  });

  it("sumă nepozitivă sau neîntreagă: refuzată (nu intră în calculul limitei)", () => {
    for (const amountMinor of [0, -1, 2.5]) {
      expect(decideRefundLimit({ ...base, amountMinor }).allowed, String(amountMinor)).toBe(false);
    }
  });
});

import { describe, expect, it } from "vitest";
import { quantityFromTicks, type Quantity } from "@ecom/shared";
import { computeAvailability, type Availability } from "../inventory/availability";
import { checkCartQuantity, lineIssues } from "./cart-rules";

/**
 * Faza 14c, decizia 1: maxim o bucată pe o linie digitală. Regula pură (aceeași la adăugare, modificare, afișare și plasare);
 * produsele fizice rămân exact cum erau (cantitatea lor nu e atinsă de regulă).
 */
const ONE = quantityFromTicks(10_000n);
const TWO = quantityFromTicks(20_000n);
const LIMITS = { maxLines: 3, maxStepsPerLine: 100 };

const available: Availability = computeAvailability({
  isDigital: false,
  manageStock: false,
  stockStatus: "instock",
  allowBackorder: false,
  step: ONE,
  inventory: null,
  defaultLowStockSteps: 2,
  leadTime: { productDays: null, brandDays: null, globalDays: 14 },
});

const check = (quantity: Quantity, digital?: boolean) =>
  checkCartQuantity({
    quantity,
    step: ONE,
    minSteps: null,
    availability: available,
    limits: LIMITS,
    ...(digital === undefined ? {} : { digital }),
  });

const issues = (quantity: Quantity, digital?: boolean) =>
  lineIssues({
    quantity,
    step: ONE,
    minSteps: null,
    sellable: true,
    availability: available,
    ackedUnitPriceMinor: null,
    currentUnitPriceMinor: 1_000,
    ...(digital === undefined ? {} : { digital }),
  });

describe("maxim o bucată pe linie digitală (Faza 14c)", () => {
  it("o bucată digitală e acceptată", () => {
    expect(check(ONE, true)).toEqual({ ok: true, steps: 1n });
  });

  it("două bucăți digitale sunt refuzate, cu motivul «digital_single»", () => {
    expect(check(TWO, true)).toEqual({ ok: false, rejection: { reason: "digital_single" } });
  });

  it("produsul fizic (sau fără indicator) păstrează cantitatea ca înainte", () => {
    expect(check(TWO, false)).toEqual({ ok: true, steps: 2n });
    expect(check(TWO)).toEqual({ ok: true, steps: 2n });
  });

  it("un coș existent cu 2 bucăți digitale cere o decizie: problema liniei «digital_quantity»", () => {
    expect(issues(TWO, true)).toEqual([{ type: "digital_quantity" }]);
  });

  it("o bucată digitală și produsele fizice nu au nicio problemă nouă", () => {
    expect(issues(ONE, true)).toEqual([]);
    expect(issues(TWO, false)).toEqual([]);
    expect(issues(TWO)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { parseQuantity, quantityFromTicks, type Quantity } from "@ecom/shared";
import { computeAvailability, type Availability } from "../inventory/availability";
import {
  cartExpiry,
  checkCartQuantity,
  clampMergedQuantity,
  freeShippingProgress,
  generateCartToken,
  hashCartToken,
  isWellFormedCartToken,
  lineIssues,
} from "./cart-rules";

const q = (text: string): Quantity => parseQuantity(text, { maxDecimals: 4 });
const ONE = quantityFromTicks(10_000n);
const LIMITS = { maxLines: 3, maxStepsPerLine: 100 };

/** Disponibilitate negestionată, în stoc: fără limită de cantitate. */
const unlimited: Availability = computeAvailability({
  isDigital: false,
  manageStock: false,
  stockStatus: "instock",
  allowBackorder: false,
  step: ONE,
  inventory: null,
  defaultLowStockSteps: 2,
  leadTime: { productDays: null, brandDays: null, globalDays: 14 },
});

/** Gestionat, cu `steps` pași disponibili (pas = `step`). */
function managed(
  steps: number,
  step: Quantity = ONE,
  minSteps: number | null = null,
): Availability {
  return computeAvailability({
    isDigital: false,
    manageStock: true,
    stockStatus: "instock",
    allowBackorder: false,
    step,
    minSteps,
    inventory: {
      physical: quantityFromTicks(BigInt(steps) * BigInt(step)),
      committed: quantityFromTicks(0n),
      reserved: quantityFromTicks(0n),
      safetyBuffer: quantityFromTicks(0n),
      lowStockSteps: null,
    },
    defaultLowStockSteps: 2,
    leadTime: { productDays: null, brandDays: null, globalDays: 14 },
  });
}

describe("Tokenul coșului de oaspete", () => {
  it("are cel puțin 128 de biți aleatori (aici 256), în formă URL-safe, diferit la fiecare apel", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateCartToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(isWellFormedCartToken(token)).toBe(true);
    }
  });

  it("refuză tokenuri prost formate (lungime, caractere, tip), înainte de orice interogare", () => {
    for (const bad of [
      "",
      "abc",
      "a".repeat(42),
      "a".repeat(44),
      `${"a".repeat(42)}!`,
      null,
      5,
      undefined,
    ]) {
      expect(isWellFormedCartToken(bad)).toBe(false);
    }
  });

  it("în baza de date stă doar amprenta (SHA-256 hex, 64 de caractere), niciodată tokenul", () => {
    const token = generateCartToken();
    const hash = hashCartToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashCartToken(token)).toBe(hash);
    expect(hashCartToken(generateCartToken())).not.toBe(hash);
  });
});

describe("Validarea cantității în coș (pasul, minimul, stocul, plafonul)", () => {
  it("cantitate multiplu exact al pasului: acceptată (3 × 2,03 = 6,09)", () => {
    const result = checkCartQuantity({
      quantity: q("6,09"),
      step: q("2,03"),
      minSteps: null,
      availability: unlimited,
      limits: LIMITS,
    });
    expect(result).toEqual({ ok: true, steps: 3n });
  });

  it("nu e multiplu al pasului → refuzată, cu motivul", () => {
    const result = checkCartQuantity({
      quantity: q("6"),
      step: q("2,03"),
      minSteps: null,
      availability: unlimited,
      limits: LIMITS,
    });
    expect(result).toMatchObject({
      ok: false,
      rejection: { reason: "invalid_quantity", detail: "not_multiple_of_step" },
    });
  });

  it("zero și sub minim → refuzate", () => {
    const base = { step: ONE, availability: unlimited, limits: LIMITS };
    expect(checkCartQuantity({ ...base, quantity: q("0"), minSteps: null })).toMatchObject({
      ok: false,
      rejection: { reason: "invalid_quantity", detail: "not_positive" },
    });
    expect(checkCartQuantity({ ...base, quantity: q("2"), minSteps: 5 })).toMatchObject({
      ok: false,
      rejection: { reason: "invalid_quantity", detail: "below_minimum" },
    });
    expect(checkCartQuantity({ ...base, quantity: q("5"), minSteps: 5 })).toEqual({
      ok: true,
      steps: 5n,
    });
  });

  it("produs indisponibil → refuzat", () => {
    const outOfStock = computeAvailability({
      isDigital: false,
      manageStock: false,
      stockStatus: "outofstock",
      allowBackorder: false,
      step: ONE,
      inventory: null,
      defaultLowStockSteps: 2,
      leadTime: { productDays: null, brandDays: null, globalDays: 14 },
    });
    expect(
      checkCartQuantity({
        quantity: q("1"),
        step: ONE,
        minSteps: null,
        availability: outOfStock,
        limits: LIMITS,
      }),
    ).toMatchObject({ ok: false, rejection: { reason: "unavailable" } });
  });

  it("peste stocul disponibil → refuzat, cu numărul de pași care se pot comanda", () => {
    const result = checkCartQuantity({
      quantity: q("5"),
      step: ONE,
      minSteps: null,
      availability: managed(3),
      limits: LIMITS,
    });
    expect(result).toMatchObject({
      ok: false,
      rejection: { reason: "exceeds_available", maxSteps: 3n },
    });
  });

  it("«La comandă» nu are limită de cantitate (doar plafonul tehnic)", () => {
    const onOrder = computeAvailability({
      isDigital: false,
      manageStock: false,
      stockStatus: "onbackorder",
      allowBackorder: false,
      step: ONE,
      inventory: null,
      defaultLowStockSteps: 2,
      leadTime: { productDays: null, brandDays: null, globalDays: 14 },
    });
    expect(
      checkCartQuantity({
        quantity: q("100"),
        step: ONE,
        minSteps: null,
        availability: onOrder,
        limits: LIMITS,
      }),
    ).toEqual({ ok: true, steps: 100n });
    expect(
      checkCartQuantity({
        quantity: q("101"),
        step: ONE,
        minSteps: null,
        availability: onOrder,
        limits: LIMITS,
      }),
    ).toMatchObject({ ok: false, rejection: { reason: "exceeds_limit", maxSteps: 100n } });
  });

  it("plafonul tehnic pe linie (în pași) se aplică și cu stoc mult", () => {
    expect(
      checkCartQuantity({
        quantity: q("101"),
        step: ONE,
        minSteps: null,
        availability: managed(1000),
        limits: LIMITS,
      }),
    ).toMatchObject({ ok: false, rejection: { reason: "exceeds_limit" } });
  });

  it("pasul fracționar și stocul în pași: 4 role de 41,25 mp cu 3 disponibile → refuzat", () => {
    const step = q("41,25");
    expect(
      checkCartQuantity({
        quantity: q("165"),
        step,
        minSteps: null,
        availability: managed(3, step),
        limits: LIMITS,
      }),
    ).toMatchObject({ ok: false, rejection: { reason: "exceeds_available", maxSteps: 3n } });
  });
});

describe("Îmbinarea cantităților (coșul de oaspete în coșul utilizatorului)", () => {
  it("cantitățile pe aceeași variantă se adună", () => {
    expect(clampMergedQuantity(q("2"), q("3"), ONE, 100)).toEqual({
      quantity: q("5"),
      clamped: false,
    });
  });

  it("suma peste plafonul pe linie se reduce la plafon (în pași întregi), cu semnal", () => {
    expect(clampMergedQuantity(q("60"), q("70"), ONE, 100)).toEqual({
      quantity: q("100"),
      clamped: true,
    });
    // pas fracționar: plafonul e în pași, deci rezultatul rămâne multiplu exact
    const step = q("2,03");
    const merged = clampMergedQuantity(stepsOf(60, step), stepsOf(70, step), step, 100);
    expect(merged.clamped).toBe(true);
    expect(merged.quantity).toBe(stepsOf(100, step));
  });
});

function stepsOf(count: number, step: Quantity): Quantity {
  return quantityFromTicks(BigInt(count) * BigInt(step));
}

describe("Problemele unei linii de coș", () => {
  const ok = {
    quantity: q("2"),
    step: ONE,
    minSteps: null,
    sellable: true,
    availability: unlimited,
    ackedUnitPriceMinor: 19900,
    currentUnitPriceMinor: 19900,
  };

  it("linie în regulă: nicio problemă", () => {
    expect(lineIssues(ok)).toEqual([]);
  });

  it("produs nevandabil (arhivat, șters, draft) sau indisponibil: «unavailable», fără alte mesaje", () => {
    expect(lineIssues({ ...ok, sellable: false })).toEqual([{ type: "unavailable" }]);
    const gone = computeAvailability({
      isDigital: false,
      manageStock: false,
      stockStatus: "outofstock",
      allowBackorder: false,
      step: ONE,
      inventory: null,
      defaultLowStockSteps: 2,
      leadTime: { productDays: null, brandDays: null, globalDays: 14 },
    });
    expect(lineIssues({ ...ok, availability: gone })).toEqual([{ type: "unavailable" }]);
  });

  it("cantitate peste stocul curent: «exceeds_available» cu numărul de pași disponibili", () => {
    expect(lineIssues({ ...ok, availability: managed(1) })).toEqual([
      { type: "exceeds_available", maxSteps: 1 },
    ]);
  });

  it("pasul sau minimul s-au schimbat în admin și cantitatea nu mai e validă: «invalid_quantity»", () => {
    expect(lineIssues({ ...ok, quantity: q("2"), step: q("2,03") })).toEqual([
      { type: "invalid_quantity", detail: "not_multiple_of_step" },
    ]);
    expect(lineIssues({ ...ok, minSteps: 5 })).toEqual([
      { type: "invalid_quantity", detail: "below_minimum" },
    ]);
  });

  it("prețul s-a schimbat față de cel confirmat: «price_changed» cu vechiul și noul preț unitar", () => {
    expect(lineIssues({ ...ok, currentUnitPriceMinor: 21900 })).toEqual([
      { type: "price_changed", fromMinor: 19900, toMinor: 21900 },
    ]);
    // nu era confirmat nimic (linie nouă): fără mesaj
    expect(lineIssues({ ...ok, ackedUnitPriceMinor: null, currentUnitPriceMinor: 21900 })).toEqual(
      [],
    );
  });
});

describe("Pragul de transport gratuit", () => {
  it("setare goală = dezactivat: nu există indicator", () => {
    expect(freeShippingProgress(null, 5000)).toBeNull();
  });

  it("sub prag: cât mai lipsește (după reduceri, cu TVA, fără transport)", () => {
    expect(freeShippingProgress(30000, 12345)).toEqual({
      thresholdMinor: 30000,
      remainingMinor: 17655,
      reached: false,
    });
  });

  it("la prag exact și peste: atins", () => {
    expect(freeShippingProgress(30000, 30000)).toEqual({
      thresholdMinor: 30000,
      remainingMinor: 0,
      reached: true,
    });
    expect(freeShippingProgress(30000, 45000)).toEqual({
      thresholdMinor: 30000,
      remainingMinor: 0,
      reached: true,
    });
  });

  it("coș gol: nu se arată progres spre prag", () => {
    expect(freeShippingProgress(30000, 0)).toEqual({
      thresholdMinor: 30000,
      remainingMinor: 30000,
      reached: false,
    });
  });
});

describe("Expirarea coșului", () => {
  it("se calculează din ora injectată și numărul de zile din setări", () => {
    const now = new Date("2026-06-01T10:00:00.000Z");
    expect(cartExpiry(now, 30).toISOString()).toBe("2026-07-01T10:00:00.000Z");
    expect(cartExpiry(now, 1).toISOString()).toBe("2026-06-02T10:00:00.000Z");
  });
});

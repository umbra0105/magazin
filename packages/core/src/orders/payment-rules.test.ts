import { describe, expect, it } from "vitest";
import {
  PAYMENT_RULE_DEFAULTS,
  assertPaymentMethodAllowed,
  availablePaymentMethods,
  isCompanyBuyer,
  type PaymentRuleInput,
} from "./payment-rules";

const base: PaymentRuleInput = {
  lines: [{ stockState: "in_stock" }],
  payableOnDeliveryMinor: 100_000,
  isCompany: false,
  codMaxIndividualMinor: 1_000_000,
  codMaxCompanyMinor: 500_000,
};
const withInput = (over: Partial<PaymentRuleInput>): PaymentRuleInput => ({ ...base, ...over });
const methodOf = (input: PaymentRuleInput, code: "cod" | "bank_transfer") =>
  availablePaymentMethods(input).find((m) => m.method === code);

describe("ramburs interzis la «La comandă» (regulă fixă)", () => {
  it("o linie «La comandă» ascunde rambursul, transferul rămâne", () => {
    const input = withInput({
      lines: [{ stockState: "in_stock" }, { stockState: "on_order" }],
    });
    expect(methodOf(input, "cod")).toEqual({
      method: "cod",
      available: false,
      reason: "has_on_order_line",
    });
    expect(methodOf(input, "bank_transfer")).toEqual({ method: "bank_transfer", available: true });
  });

  it("«Stoc limitat» și «În stoc» permit rambursul", () => {
    expect(methodOf(withInput({ lines: [{ stockState: "limited" }] }), "cod")?.available).toBe(
      true,
    );
    expect(methodOf(base, "cod")?.available).toBe(true);
  });

  it("regula nu depinde de limite: și o comandă mică cu o linie «La comandă» nu are ramburs", () => {
    const input = withInput({ lines: [{ stockState: "on_order" }], payableOnDeliveryMinor: 100 });
    expect(methodOf(input, "cod")?.available).toBe(false);
  });

  it("regula nu se poate dezactiva din setări: limitele uriașe nu o ocolesc", () => {
    const input = withInput({
      lines: [{ stockState: "on_order" }],
      codMaxIndividualMinor: Number.MAX_SAFE_INTEGER,
      codMaxCompanyMinor: Number.MAX_SAFE_INTEGER,
    });
    expect(methodOf(input, "cod")?.available).toBe(false);
  });

  it("motivul «La comandă» are prioritate față de limită", () => {
    const input = withInput({
      lines: [{ stockState: "on_order" }],
      payableOnDeliveryMinor: 5_000_000,
    });
    expect(methodOf(input, "cod")).toMatchObject({ reason: "has_on_order_line" });
  });
});

describe("limitele de ramburs", () => {
  it("persoană fizică: exact limita e permisă, cu un ban peste se ascunde", () => {
    expect(methodOf(withInput({ payableOnDeliveryMinor: 1_000_000 }), "cod")?.available).toBe(true);
    expect(methodOf(withInput({ payableOnDeliveryMinor: 1_000_001 }), "cod")).toEqual({
      method: "cod",
      available: false,
      reason: "over_limit_individual",
    });
  });

  it("persoană juridică: limita e cea de firmă", () => {
    const company = withInput({ isCompany: true });
    expect(methodOf({ ...company, payableOnDeliveryMinor: 500_000 }, "cod")?.available).toBe(true);
    expect(methodOf({ ...company, payableOnDeliveryMinor: 500_001 }, "cod")).toEqual({
      method: "cod",
      available: false,
      reason: "over_limit_company",
    });
  });

  it("aceeași sumă de 7.000 lei: permisă unei persoane fizice, refuzată unei firme", () => {
    const amount = 700_000;
    expect(methodOf(withInput({ payableOnDeliveryMinor: amount }), "cod")?.available).toBe(true);
    expect(
      methodOf(withInput({ payableOnDeliveryMinor: amount, isCompany: true }), "cod")?.available,
    ).toBe(false);
  });

  it("limitele vin din setări, nu din cod (alte valori, alt rezultat)", () => {
    const input = withInput({ payableOnDeliveryMinor: 150_000, codMaxIndividualMinor: 100_000 });
    expect(methodOf(input, "cod")?.available).toBe(false);
  });

  it("valorile implicite: 10.000 lei persoane fizice, 5.000 lei persoane juridice", () => {
    expect(PAYMENT_RULE_DEFAULTS).toEqual({
      codMaxIndividualMinor: 1_000_000,
      codMaxCompanyMinor: 500_000,
    });
  });

  it("transferul bancar nu are limită", () => {
    const input = withInput({ payableOnDeliveryMinor: 99_999_999, isCompany: true });
    expect(methodOf(input, "bank_transfer")?.available).toBe(true);
  });
});

describe("cardul nu e o opțiune în Faza 9", () => {
  it("lista conține doar ramburs și transfer bancar", () => {
    expect(availablePaymentMethods(base).map((m) => m.method)).toEqual(["cod", "bank_transfer"]);
  });
});

describe("persoană juridică = CUI la facturare SAU grup cost_plus", () => {
  it("CUI → firmă", () => {
    expect(isCompanyBuyer({ vatId: "RO14399840", groupPricingType: "none" })).toBe(true);
  });
  it("grup cost_plus → firmă, chiar fără CUI", () => {
    expect(isCompanyBuyer({ vatId: null, groupPricingType: "cost_plus" })).toBe(true);
  });
  it("fără CUI, grup none sau discount → persoană fizică", () => {
    expect(isCompanyBuyer({ vatId: null, groupPricingType: "none" })).toBe(false);
    expect(isCompanyBuyer({ vatId: "", groupPricingType: "discount" })).toBe(false);
    expect(isCompanyBuyer({ vatId: "   ", groupPricingType: "none" })).toBe(false);
  });
});

describe("assertPaymentMethodAllowed (validare la plasare)", () => {
  it("aruncă ORDER_PAYMENT_METHOD_UNAVAILABLE cu motivul, pentru o metodă ascunsă", () => {
    const input = withInput({ lines: [{ stockState: "on_order" }] });
    try {
      assertPaymentMethodAllowed(input, "cod");
      throw new Error("trebuia să arunce");
    } catch (error) {
      expect(error).toMatchObject({
        code: "ORDER_PAYMENT_METHOD_UNAVAILABLE",
        details: { method: "cod", reason: "has_on_order_line" },
      });
    }
  });

  it("nu aruncă pentru o metodă disponibilă; refuză o metodă necunoscută", () => {
    expect(() => assertPaymentMethodAllowed(base, "cod")).not.toThrow();
    expect(() => assertPaymentMethodAllowed(base, "bank_transfer")).not.toThrow();
    expect(() => assertPaymentMethodAllowed(base, "card" as never)).toThrow();
  });
});

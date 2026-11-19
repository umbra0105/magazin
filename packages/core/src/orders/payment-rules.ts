import { DomainError } from "@ecom/shared";

/**
 * Metodele de plată disponibile la checkout (Faza 9: ramburs și transfer bancar; cardul vine în Faza 10) și regulile lor.
 *
 * ⚠️ REGULĂ FIXĂ, NU SETARE: rambursul e INTERZIS la orice comandă cu cel puțin o linie «La comandă» (produsul se aduce de la
 * furnizor după comandă; clientul care refuză colețul ne lasă cu un produs adus special). Rămâne doar transferul bancar (cardul,
 * din Faza 10), cu plata integrală în avans. Regula se aplică pe server la afișare ȘI la plasare, înaintea oricărei limite, și
 * nu depinde de nicio setare. Limitele de ramburs (setări `payment.cod.*`) se aplică restului comenzilor.
 */

export const PAYMENT_METHODS = ["cod", "bank_transfer"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Valorile implicite ale limitelor, în bani: 10.000 lei persoane fizice, 5.000 lei persoane juridice (editabile din admin). */
export const PAYMENT_RULE_DEFAULTS = {
  codMaxIndividualMinor: 1_000_000,
  codMaxCompanyMinor: 500_000,
} as const;

export type CodUnavailableReason =
  "has_on_order_line" | "over_limit_individual" | "over_limit_company";

export interface PaymentRuleInput {
  /** Starea de stoc a fiecărei linii, din regulile de disponibilitate (D6). */
  lines: ReadonlyArray<{ stockState: "in_stock" | "limited" | "on_order" }>;
  /** Suma care s-ar încasa la livrare cu rambursul: produse + transport + taxa de ramburs. */
  payableOnDeliveryMinor: number;
  /** Persoană juridică: CUI la facturare SAU grup `cost_plus`. */
  isCompany: boolean;
  codMaxIndividualMinor: number;
  codMaxCompanyMinor: number;
}

export type PaymentMethodAvailability =
  | { method: PaymentMethod; available: true }
  | { method: PaymentMethod; available: false; reason: CodUnavailableReason };

/** Persoană juridică la facturare: are CUI sau face parte dintr-un grup `cost_plus`. */
export function isCompanyBuyer(input: {
  vatId: string | null;
  groupPricingType: "none" | "discount" | "cost_plus";
}): boolean {
  return (input.vatId ?? "").trim() !== "" || input.groupPricingType === "cost_plus";
}

function codAvailability(input: PaymentRuleInput): PaymentMethodAvailability {
  // regula fixă, înaintea limitelor
  if (input.lines.some((line) => line.stockState === "on_order")) {
    return { method: "cod", available: false, reason: "has_on_order_line" };
  }
  const limit = input.isCompany ? input.codMaxCompanyMinor : input.codMaxIndividualMinor;
  if (input.payableOnDeliveryMinor > limit) {
    return {
      method: "cod",
      available: false,
      reason: input.isCompany ? "over_limit_company" : "over_limit_individual",
    };
  }
  return { method: "cod", available: true };
}

/** Toate metodele, în ordinea afișării, cu starea fiecăreia (cele indisponibile poartă motivul, pentru explicația din interfață). */
export function availablePaymentMethods(input: PaymentRuleInput): PaymentMethodAvailability[] {
  return [codAvailability(input), { method: "bank_transfer", available: true }];
}

/** Validarea de la plasare: aceeași regulă ca la afișare, pe server; o metodă ascunsă sau necunoscută nu se acceptă. */
export function assertPaymentMethodAllowed(input: PaymentRuleInput, method: PaymentMethod): void {
  const found = availablePaymentMethods(input).find((m) => m.method === method);
  if (!found) {
    throw new DomainError("ORDER_PAYMENT_METHOD_UNKNOWN", "Metoda de plată nu este disponibilă", {
      method,
    });
  }
  if (!found.available) {
    throw new DomainError(
      "ORDER_PAYMENT_METHOD_UNAVAILABLE",
      "Metoda de plată aleasă nu este disponibilă pentru această comandă",
      { method, reason: found.reason },
    );
  }
}

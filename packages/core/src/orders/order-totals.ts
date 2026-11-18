import { DomainError, vatFromGross } from "@ecom/shared";
import type { PaymentMethod } from "./payment-rules";

/**
 * Totalul unei comenzi, DOAR din sumele deja calculate: produsele vin din motorul de prețuri (prin `CartService`), transportul și
 * taxa de ramburs din oferta aleasă. Transportul și taxa sunt sume cu TVA INCLUS (ca prețurile produselor), iar TVA-ul se
 * extrage din fiecare cu aceeași cotă și aceeași funcție ca la linii (`vat.ts`, o rotunjire pe sumă). TVA-ul comenzii = suma TVA
 * pe linii + TVA transport + TVA taxă (docs/09 §2). Taxa de ramburs se aplică DOAR la plata cu ramburs.
 */

export interface OrderTotalsInput {
  /** Totalul produselor (cu TVA) și TVA-ul lor (suma pe linii), din motorul de prețuri. */
  cart: { totalMinor: number; vatMinor: number };
  shippingMinor: number;
  /** Taxa de ramburs a ofertei; se ignoră dacă plata nu e rambursul. */
  codFeeMinor: number;
  paymentMethod: PaymentMethod;
  taxRateBps: number;
}

export interface OrderTotals {
  subtotalMinor: number;
  shippingMinor: number;
  codFeeMinor: number;
  shippingTaxMinor: number;
  codFeeTaxMinor: number;
  taxMinor: number;
  totalMinor: number;
}

function assertMinor(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(
      "ORDER_AMOUNT_INVALID",
      `Suma «${name}» nu este un număr întreg de bani ≥ 0`,
      {
        name,
      },
    );
  }
}

export function computeOrderTotals(input: OrderTotalsInput): OrderTotals {
  assertMinor(input.cart.totalMinor, "produse");
  assertMinor(input.cart.vatMinor, "TVA produse");
  assertMinor(input.shippingMinor, "transport");
  assertMinor(input.codFeeMinor, "taxă ramburs");
  const codFeeMinor = input.paymentMethod === "cod" ? input.codFeeMinor : 0;
  const shippingTaxMinor = vatFromGross(input.shippingMinor, input.taxRateBps);
  const codFeeTaxMinor = vatFromGross(codFeeMinor, input.taxRateBps);
  const totalMinor = input.cart.totalMinor + input.shippingMinor + codFeeMinor;
  if (!Number.isSafeInteger(totalMinor)) {
    throw new DomainError(
      "ORDER_AMOUNT_INVALID",
      "Totalul comenzii depășește valoarea maximă permisă",
    );
  }
  return {
    subtotalMinor: input.cart.totalMinor,
    shippingMinor: input.shippingMinor,
    codFeeMinor,
    shippingTaxMinor,
    codFeeTaxMinor,
    taxMinor: input.cart.vatMinor + shippingTaxMinor + codFeeTaxMinor,
    totalMinor,
  };
}

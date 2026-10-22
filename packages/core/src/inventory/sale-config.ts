import { QUANTITY_FACTOR, QuantityError, assertSaleStep, formatQuantity } from "@ecom/shared";
import type { Quantity } from "@ecom/shared";

/**
 * Validarea configurării de vânzare (unitate, pas, conversie SmartBill): funcții PURE, fără acces la date. Serviciul
 * de produse le cheamă cu valorile EFECTIVE (varianta, apoi produsul, apoi o unitate) și transformă problemele în
 * `ValidationError` cu calea câmpului, ca formularul să arate mesajul sub câmpul greșit.
 */

/** O unitate (1,0000) în zecimi de miime: pasul când nici varianta, nici produsul nu au unul. */
export const DEFAULT_SALE_STEP = QUANTITY_FACTOR;

/** Pasul efectiv: al variantei, altfel al produsului, altfel o unitate. */
export function effectiveSaleStep(
  variantStep: number | null | undefined,
  productStep: number | null | undefined,
): bigint {
  const step = variantStep ?? productStep;
  return step === null || step === undefined ? DEFAULT_SALE_STEP : BigInt(step);
}

export type SaleConfigField = "saleStep" | "smartbillRatio" | "smartbillMode";

export interface SaleConfigIssue {
  path: SaleConfigField;
  message: string;
}

export interface SaleConfigInput {
  /** Zecimalele unității EFECTIVE (0 la «buc»). */
  unitDecimals: number;
  /** Pasul EFECTIV, în zecimi de miime. */
  step: bigint;
  smartbillMode: string | null;
  smartbillRatio: number | null;
}

/**
 * Orice comandă valabilă (n × pas) se convertește EXACT în unitatea SmartBill, cu cantitatea SmartBill de cel mult
 * 4 zecimale, ⇔ pasul convertit e exact (n = 1; multiplii urmează). `ratio` = zecimi de miime din unitatea noastră
 * într-o unitate SmartBill.
 */
export function smartbillConversionExact(step: bigint, ratio: number): boolean {
  return ratio > 0 && (step * QUANTITY_FACTOR) % BigInt(ratio) === 0n;
}

/** Problemele configurării (listă goală = în regulă). */
export function checkSaleConfig(input: SaleConfigInput): SaleConfigIssue[] {
  const issues: SaleConfigIssue[] = [];
  const stepText = formatQuantity(input.step as Quantity);

  try {
    assertSaleStep(input.step, input.unitDecimals);
  } catch (error) {
    if (!(error instanceof QuantityError)) throw error;
    issues.push({
      path: "saleStep",
      message:
        error.reason === "invalid_step" && input.unitDecimals < 4
          ? `Pasul ${stepText} are mai multe zecimale decât permite unitatea (${input.unitDecimals}). Alege o unitate cu mai multe zecimale sau un pas mai simplu.`
          : error.message,
    });
  }

  if (input.smartbillMode === "ratio") {
    if (input.smartbillRatio === null || input.smartbillRatio <= 0) {
      issues.push({
        path: "smartbillRatio",
        message: "Raportul față de unitatea SmartBill trebuie să fie un număr mai mare ca zero.",
      });
    } else if (!smartbillConversionExact(input.step, input.smartbillRatio)) {
      const ratioText = formatQuantity(BigInt(input.smartbillRatio) as Quantity);
      issues.push({
        path: "smartbillRatio",
        message: `Cu pasul ${stepText} și raportul ${ratioText}, o comandă nu se convertește exact în unitatea SmartBill (ar rezulta cantități cu mai mult de 4 zecimale). Alege un raport care împarte exact pasul.`,
      });
    }
  } else if (input.smartbillRatio !== null) {
    issues.push({
      path: "smartbillRatio",
      message: "Raportul se folosește doar când stocul SmartBill e ținut «cu raport».",
    });
  }
  return issues;
}

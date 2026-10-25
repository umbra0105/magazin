import { describePrice } from "@ecom/shared/price-display";
import { QUANTITY_FACTOR, quantityFromTicks } from "@ecom/shared/quantity";
import { priceLines, type PriceLines } from "@/lib/price-view";
import { getMessages } from "@/messages";

/**
 * Previzualizarea «Cum se afișează prețul» din tabul Prețuri: valorile EFECTIVE ale variantei (varianta peste produs peste
 * «buc»), apoi textele prețului pe unitate și pe pas. Doar asamblare: calculul e în `describePrice`. PROVIZORIU.
 */

export interface PreviewProduct {
  measureUnitId: string | null;
  priceBasis: string;
  saleStep: number | null;
  saleStepLabel: string | null;
  showStepPrice: boolean;
}

export interface PreviewVariant {
  price: number;
  salePrice: number | null;
  measureUnitId: string | null;
  priceBasis: string | null;
  saleStep: number | null;
}

export interface PreviewUnit {
  id: string;
  symbol: string;
}

/** Unitatea (simbolul; `null` = «buc»), baza și pasul efective: varianta peste produs. */
export function effectiveSale(
  variant: Pick<PreviewVariant, "measureUnitId" | "priceBasis" | "saleStep">,
  product: PreviewProduct,
  units: readonly PreviewUnit[],
): { unitSymbol: string | null; basis: "unit" | "step"; step: number | null } {
  const unitId = variant.measureUnitId ?? product.measureUnitId;
  const unit = unitId === null ? undefined : units.find((u) => u.id === unitId);
  return {
    unitSymbol: unit?.symbol ?? null,
    basis: (variant.priceBasis ?? product.priceBasis) === "step" ? "step" : "unit",
    step: variant.saleStep ?? product.saleStep,
  };
}

/** Textele prețului întreg și ale celui redus (dacă există) al unei variante. */
export function previewVariantPrice(
  variant: PreviewVariant,
  product: PreviewProduct,
  units: readonly PreviewUnit[],
  format: { currency: string; locale: string },
): { price: PriceLines; sale: PriceLines | null } {
  const sale = effectiveSale(variant, product, units);
  const symbol = sale.unitSymbol ?? getMessages().admin.priceDisplay.defaultUnit;
  const lines = (priceMinor: number): PriceLines =>
    priceLines(
      describePrice({
        priceMinor,
        basis: sale.basis,
        step: quantityFromTicks(sale.step ?? QUANTITY_FACTOR),
        unitSymbol: symbol,
        stepLabel: product.saleStepLabel,
        showStepPrice: product.showStepPrice,
      }),
      format,
    );
  return {
    price: lines(variant.price),
    sale: variant.salePrice === null ? null : lines(variant.salePrice),
  };
}

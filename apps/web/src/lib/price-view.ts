import type { PriceDisplay } from "@ecom/shared/price-display";
import { formatQuantity } from "@ecom/shared/quantity";
import { getMessages } from "@/messages";
import { formatMoney } from "./money-input";

/**
 * Textele afișării prețului pe unitate și pe pas (română, moneda din setări). Doar asamblează valorile funcției pure
 * `describePrice` (din `@ecom/shared`): nu calculează și nu rotunjește nimic. «≈» apare doar când suma nu e exactă;
 * afișarea e PROVIZORIE (informativă) până la motorul de prețuri din Faza 8.
 */

const m = () => getMessages().admin.priceDisplay;

export interface PriceLines {
  /** «120,00 RON / sac de 25 kg» sau «87,35 RON / mp» */
  reference: string;
  /** Ce urmează după «/»: «sac de 25 kg», «mp» (lista îl pune după un interval de preț) */
  per: string;
  /** «(4,80 RON/kg)» sau «(≈ 33,33 RON/kg)»; doar la baza «pe pas» */
  perUnit: string | null;
  /** «Rolă de 41,25 mp ≈ 3.603,19 RON»; doar la baza «pe unitate» cu «arată prețul pasului» */
  stepPrice: string | null;
  provisional: true;
}

export function priceLines(
  display: PriceDisplay,
  format: { currency: string; locale: string },
): PriceLines {
  const text = m();
  const money = (minor: bigint): string =>
    formatMoney(Number(minor), format.currency, format.locale);

  const per = display.reference.per;
  const amount = money(display.reference.amount.minor);
  const perText =
    per.kind === "unit"
      ? text.perUnit(per.symbol)
      : text.perStep(formatQuantity(per.step), per.symbol, per.label);
  const reference = text.reference(amount, perText);

  const perUnit = display.perUnit
    ? text.unitInfo(
        money(display.perUnit.minor),
        display.reference.per.kind === "step" ? display.reference.per.symbol : "",
        !display.perUnit.exact,
      )
    : null;

  const stepPrice = display.stepPrice
    ? text.stepPrice(
        display.stepPrice.label,
        formatQuantity(display.stepPrice.step),
        display.stepPrice.symbol,
        money(display.stepPrice.amount.minor),
        display.stepPrice.amount.exact,
      )
    : null;

  return { reference, per: perText, perUnit, stepPrice, provisional: true };
}

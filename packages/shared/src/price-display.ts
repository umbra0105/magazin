import {
  QUANTITY_FACTOR,
  exactLineValue,
  exactUnitPrice,
  quantityFromTicks,
  splitScaledMoney,
  type Quantity,
} from "./quantity";

/**
 * Afișarea prețului pe UNITATE și pe PAS (Faza 5, punctul 9b). PROVIZORIE: aparține motorului de prețuri din Faza 8 și va fi
 * mutată sau înlocuită acolo. Funcție PURĂ, doar cu `Quantity` (fără `float`): primește prețul introdus de administrator (în
 * bani, cu TVA) și configurarea de vânzare și întoarce VALORI (nu text); textele în română le asamblează aplicația.
 *
 * Reguli:
 *  - referința e mereu prețul introdus, exact («87,35 lei / mp» sau «120,00 lei / sac de 25 kg»);
 *  - baza «pe unitate» + «arată prețul pasului»: prețul unui pas = preț × pas («Rolă de 41,25 mp ≈ 3.603,19 lei»);
 *  - baza «pe pas»: prețul pe unitate = preț ÷ pas, informativ («(4,80 lei/kg)»);
 *  - «≈» (`exact: false`) când suma nu iese exactă în bani. Suma afișată e cea exactă rotunjită la 2 zecimale, half-up: DOAR
 *    pentru text. NU e regula de rotunjire a liniei de comandă: nu se salvează, nu intră în coș, iar totalul îl calculează
 *    motorul de prețuri (R1/R2, Faza 8).
 *  - un pas de o singură unitate nu repetă prețul (se tratează ca preț pe unitate).
 */

export interface PriceDisplayInput {
  /** Prețul introdus, în bani, brut (cu TVA): pe unitate sau pe pas, după `basis` */
  priceMinor: number;
  basis: "unit" | "step";
  /** Pasul de vânzare EFECTIV (o unitate când nu e setat) */
  step: Quantity;
  /** Simbolul unității EFECTIVE («mp»; «buc» la implicită) */
  unitSymbol: string;
  /** Denumirea pasului («sac», «rolă»), dacă există */
  stepLabel: string | null;
  showStepPrice: boolean;
}

export interface DisplayAmount {
  /** Bani întregi, rotunjiți half-up din valoarea exactă; doar pentru afișare */
  minor: bigint;
  /** Valoarea exactă e un număr întreg de bani (fără «≈») */
  exact: boolean;
}

export type PricePer =
  | { kind: "unit"; symbol: string }
  | { kind: "step"; step: Quantity; label: string | null; symbol: string };

export interface PriceDisplay {
  reference: { amount: DisplayAmount; per: PricePer };
  /** Preț pe unitate, informativ, lângă prețul pe pas (doar la baza «pe pas») */
  perUnit: DisplayAmount | null;
  /** Prețul unui pas (doar la baza «pe unitate», cu «arată prețul pasului», dacă pasul ≠ o unitate) */
  stepPrice: { amount: DisplayAmount; step: Quantity; label: string | null; symbol: string } | null;
  /** Mereu `true`: afișare informativă până la motorul de prețuri (Faza 8) */
  provisional: true;
}

/** Valoarea în bani × 10⁻⁴ → bani întregi half-up (doar pentru text), cu indicatorul de exactitate. */
function forDisplay(scaledMinor: bigint, lossy: boolean): DisplayAmount {
  const { wholeMinor, remainderScaled } = splitScaledMoney(scaledMinor);
  const roundUp = remainderScaled * 2n >= QUANTITY_FACTOR;
  return {
    minor: roundUp ? wholeMinor + 1n : wholeMinor,
    exact: !lossy && remainderScaled === 0n,
  };
}

export function describePrice(input: PriceDisplayInput): PriceDisplay {
  const step = quantityFromTicks(input.step);
  if (step <= 0n) throw new RangeError("Pasul de vânzare trebuie să fie pozitiv");
  // referința: prețul introdus, exact (validează totodată că e un număr întreg de bani ≥ 0)
  const entered = forDisplay(
    exactLineValue(input.priceMinor, quantityFromTicks(QUANTITY_FACTOR)),
    false,
  );
  const oneUnit = step === QUANTITY_FACTOR;
  const unit: PricePer = { kind: "unit", symbol: input.unitSymbol };

  if (input.basis === "step" && !oneUnit) {
    const unitPrice = exactUnitPrice(input.priceMinor, step);
    return {
      reference: {
        amount: entered,
        per: { kind: "step", step, label: input.stepLabel, symbol: input.unitSymbol },
      },
      perUnit: forDisplay(unitPrice.scaledMinor, unitPrice.lossy),
      stepPrice: null,
      provisional: true,
    };
  }

  const stepPrice =
    input.basis === "unit" && input.showStepPrice && !oneUnit
      ? {
          amount: forDisplay(exactLineValue(input.priceMinor, step), false),
          step,
          label: input.stepLabel,
          symbol: input.unitSymbol,
        }
      : null;
  return { reference: { amount: entered, per: unit }, perUnit: null, stepPrice, provisional: true };
}

/**
 * Calcul de referință pentru testele de cantități, INDEPENDENT de `Quantity`: fracții exacte cu numitor propriu (nu zecimi
 * de miime), construite din textul zecimal, și adunare repetată. Nimic de aici nu folosește funcțiile din
 * `packages/shared/src/quantity.ts`, ca un test să poată compara două drumuri diferite spre același rezultat.
 */

function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b);
}

export class Fraction {
  readonly n: bigint;
  readonly d: bigint;

  constructor(n: bigint, d: bigint) {
    const g = gcd(n, d) || 1n;
    this.n = n / g;
    this.d = d / g;
  }

  /** „2,03” / „2.03” / „25” → fracție exactă (fără `float`) */
  static of(text: string): Fraction {
    const [whole = "0", frac = ""] = text.replace(",", ".").split(".");
    return new Fraction(BigInt(whole + frac), 10n ** BigInt(frac.length));
  }

  plus(other: Fraction): Fraction {
    return new Fraction(this.n * other.d + other.n * this.d, this.d * other.d);
  }

  minus(other: Fraction): Fraction {
    return new Fraction(this.n * other.d - other.n * this.d, this.d * other.d);
  }

  /** Cel mai mare dintre `this` și zero (stocul nu e niciodată negativ) */
  atLeastZero(): Fraction {
    return this.n < 0n ? new Fraction(0n, 1n) : this;
  }

  /** `this ≥ other` */
  gte(other: Fraction): boolean {
    return this.n * other.d >= other.n * this.d;
  }

  equals(other: Fraction): boolean {
    return this.n * other.d === other.n * this.d;
  }

  /** Forma zecimală cu virgulă și cel mult 4 zecimale, fără zerouri de la coadă („82,5”); pentru valori reprezentabile */
  toDecimalText(): string {
    const scaled = (this.n * 10_000n) / this.d;
    const digits = scaled.toString().padStart(5, "0");
    const whole = digits.slice(0, -4);
    const fraction = digits.slice(-4).replace(/0+$/, "");
    return fraction === "" ? whole : `${whole},${fraction}`;
  }
}

/**
 * Câți pași ÎNTREGI încap, prin scădere repetată (nu prin împărțire): întoarce numărul de pași și restul. `limit` oprește
 * bucla pe intrări absurde.
 */
export function stepsBySubtraction(
  available: Fraction,
  step: Fraction,
  limit = 100_000,
): { steps: number; rest: Fraction } {
  let rest = available;
  let steps = 0;
  while (rest.gte(step) && steps < limit) {
    rest = rest.minus(step);
    steps++;
  }
  return { steps, rest };
}

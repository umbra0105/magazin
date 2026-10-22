import { quantityFromTicks, sumQuantities, type Quantity, type QuantityDelta } from "@ecom/shared";

/**
 * Regula «o bucată se scade o singură dată» (D1) și aplicarea unei poze SmartBill. Funcții PURE.
 *
 * SmartBill e sursa cantității fizice. O comandă online confirmată e «angajată» în aplicație până când poza o conține:
 * - factura emisă ÎNAINTE de poză (cu cel puțin fereastra de siguranță) → bucata e deja scăzută în SmartBill, deci
 *   comanda este «oglindită» și încetează să fie angajată (altfel s-ar scădea a doua oară);
 * - factura emisă DUPĂ poză, în fereastra de siguranță din jurul pozei sau lipsă → bucata rămâne angajată. Fereastra
 *   acoperă diferențele de ceas și exporturile fără oră exactă: eroarea posibilă e o SUBVÂNZARE temporară (apare mai
 *   puțin stoc decât există), niciodată o supravânzare; se corectează la poza următoare.
 * Ajustările manuale cu ora efectivă DUPĂ poză rămân aplicate (vânzarea din magazin încă nu e în poză), cele dinainte sau
 * de la ora pozei sunt înlocuite de ea.
 */

const MAX_WINDOW_MINUTES = 1440;

function assertWindow(minutes: number): void {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_WINDOW_MINUTES) {
    throw new RangeError(
      `Fereastra de siguranță trebuie să fie un număr întreg de minute între 0 și ${MAX_WINDOW_MINUTES}`,
    );
  }
}

function time(date: Date, label: string): number {
  const value = date.getTime();
  if (Number.isNaN(value)) throw new RangeError(`${label} nu este o dată validă`);
  return value;
}

export type MirrorDecision = "mirrored" | "committed";

/**
 * Comanda e «oglindită» (poza o conține) ⇔ factura există și a fost emisă cel târziu cu `safetyWindowMinutes` înaintea
 * pozei (marginea e inclusă). Altfel rămâne angajată.
 */
export function mirrorDecision(
  invoicedAt: Date | null,
  snapshotAt: Date,
  safetyWindowMinutes: number,
): MirrorDecision {
  assertWindow(safetyWindowMinutes);
  const photo = time(snapshotAt, "Ora pozei");
  if (invoicedAt === null) return "committed";
  const invoice = time(invoicedAt, "Ora facturii");
  return invoice <= photo - safetyWindowMinutes * 60_000 ? "mirrored" : "committed";
}

export interface CommitmentInput {
  id: string;
  quantity: Quantity;
  /** Ora facturii, dacă a fost emisă */
  invoicedAt: Date | null;
}

export interface AdjustmentInput {
  /** Ora efectivă a faptului (nu ora scrierii) */
  effectiveAt: Date;
  delta: QuantityDelta;
}

export interface ReconcileInput {
  snapshot: { quantity: Quantity; takenAt: Date };
  safetyWindowMinutes: number;
  /** Angajările deschise, în ordinea dorită a rezultatului */
  commitments: readonly CommitmentInput[];
  adjustments: readonly AdjustmentInput[];
}

export interface ReconcileResult {
  /** Cantitatea fizică nouă: poza plus ajustările de după ea (≥ 0) */
  physical: Quantity;
  /** Ajustările de după poză ar fi dus sub zero: fizicul a rămas 0 (fără stoc negativ) */
  physicalClamped: boolean;
  /** Angajatul rămas: suma comenzilor care nu sunt încă în poză */
  committed: Quantity;
  mirroredIds: string[];
  stillCommittedIds: string[];
  keptAdjustments: number;
  droppedAdjustments: number;
}

/** Rezultatul aplicării unei poze noi; nu scrie nimic (serviciul aplică totul într-o tranzacție, toate sau niciuna). */
export function reconcileSnapshot(input: ReconcileInput): ReconcileResult {
  const photoTime = time(input.snapshot.takenAt, "Ora pozei");
  assertWindow(input.safetyWindowMinutes);

  const kept = input.adjustments.filter((a) => time(a.effectiveAt, "Ora efectivă") > photoTime);
  const adjustment = kept.reduce<bigint>((sum, a) => sum + a.delta, 0n);
  const raw = input.snapshot.quantity + adjustment;
  let physical: Quantity;
  let physicalClamped = false;
  if (raw < 0n) {
    physical = quantityFromTicks(0n);
    physicalClamped = true;
  } else {
    physical = quantityFromTicks(raw); // peste plafon: QUANTITY_OVERFLOW, nu se taie
  }

  const mirroredIds: string[] = [];
  const stillCommitted: CommitmentInput[] = [];
  for (const commitment of input.commitments) {
    if (
      mirrorDecision(commitment.invoicedAt, input.snapshot.takenAt, input.safetyWindowMinutes) ===
      "mirrored"
    ) {
      mirroredIds.push(commitment.id);
    } else {
      stillCommitted.push(commitment);
    }
  }

  return {
    physical,
    physicalClamped,
    committed: sumQuantities(stillCommitted.map((c) => c.quantity)),
    mirroredIds,
    stillCommittedIds: stillCommitted.map((c) => c.id),
    keptAdjustments: kept.length,
    droppedAdjustments: input.adjustments.length - kept.length,
  };
}

export type SnapshotFreshness =
  { status: "never" } | { status: "fresh" | "stale"; ageHours: number };

const MAX_STALE_HOURS = 720;

/**
 * Cât de proaspătă e ultima poză: «stale» abia după `staleHours` (strict), «never» fără nicio poză. O poză «din viitor»
 * (ceas în urmă) e proaspătă, cu vârsta 0.
 */
export function snapshotFreshness(
  takenAt: Date | null,
  now: Date,
  staleHours: number,
): SnapshotFreshness {
  if (!Number.isInteger(staleHours) || staleHours < 1 || staleHours > MAX_STALE_HOURS) {
    throw new RangeError(
      `Pragul «poza e veche» trebuie să fie între 1 și ${MAX_STALE_HOURS} de ore`,
    );
  }
  if (takenAt === null) return { status: "never" };
  const ageMs = Math.max(0, time(now, "Ora curentă") - time(takenAt, "Ora pozei"));
  const ageHours = ageMs / 3_600_000;
  return { status: ageMs > staleHours * 3_600_000 ? "stale" : "fresh", ageHours };
}

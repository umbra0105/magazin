/**
 * Constantele stocului (Faza 5). Listele de mai jos oglindesc CHECK-urile din migrația `stock_foundation`;
 * un test de integrare verifică, pe baza reală, că fiecare valoare e acceptată (și una străină, respinsă).
 */

/** Codul depozitului implicit creat de seed; numele se poate schimba din admin, codul nu. */
export const DEFAULT_WAREHOUSE_CODE = "main";
export const DEFAULT_WAREHOUSE_NAME = "Depozit principal";

/**
 * Unitatea implicită: «bucată». O unitate nulă pe produs sau variantă înseamnă EXACT «buc» (pas o unitate); peste tot
 * în cod se trece prin `effectiveMeasureUnit`/`sameMeasureUnit` (units.ts), niciodată prin comparații directe.
 */
export const DEFAULT_MEASURE_UNIT_CODE = "buc";

export interface InitialMeasureUnit {
  code: string;
  name: string;
  symbol: string;
  /** Câte zecimale are voie cantitatea (0–4) */
  decimals: number;
}

/**
 * Unitățile de pornire (D11): ambalaje fără zecimale și unități măsurate cu până la 4 zecimale. Sunt valori
 * inițiale editabile din admin; numele din SmartBill NU se inventează aici (rămâne gol până îl aduce utilizatorul).
 */
export const INITIAL_MEASURE_UNITS: readonly InitialMeasureUnit[] = [
  { code: DEFAULT_MEASURE_UNIT_CODE, name: "Bucată", symbol: "buc", decimals: 0 },
  { code: "set", name: "Set", symbol: "set", decimals: 0 },
  { code: "pachet", name: "Pachet", symbol: "pachet", decimals: 0 },
  { code: "cutie", name: "Cutie", symbol: "cutie", decimals: 0 },
  { code: "rola", name: "Rolă", symbol: "rolă", decimals: 0 },
  { code: "sac", name: "Sac", symbol: "sac", decimals: 0 },
  { code: "ml", name: "Metru liniar", symbol: "ml", decimals: 4 },
  { code: "mp", name: "Metru pătrat", symbol: "mp", decimals: 4 },
  { code: "kg", name: "Kilogram", symbol: "kg", decimals: 4 },
  { code: "l", name: "Litru", symbol: "l", decimals: 4 },
];

/** Baza prețului: `price` e pe unitate (lei/ml) sau pe pas (lei/sac) */
export const PRICE_BASES = ["unit", "step"] as const;
export type PriceBasis = (typeof PRICE_BASES)[number];

/** Cum ține SmartBill stocul unei variante (D11.6, varianta S1) */
export const SMARTBILL_MODES = ["same_unit", "steps", "ratio"] as const;
export type SmartbillMode = (typeof SMARTBILL_MODES)[number];

export const STOCK_MOVEMENT_KINDS = [
  "adjustment",
  "snapshot",
  "commit",
  "release",
  "mirror",
  "transfer_in",
  "transfer_out",
] as const;
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number];

/** Motivele fixe ale ajustărilor manuale (D8) */
export const ADJUSTMENT_REASONS = [
  "sale_in_store",
  "receipt",
  "return",
  "inventory_correction",
  "damaged",
  "lost_stolen",
  "other",
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export const SNAPSHOT_SOURCES = ["import", "api"] as const;
export type SnapshotSource = (typeof SNAPSHOT_SOURCES)[number];

export const RESERVATION_STATUSES = ["active", "confirmed", "released", "expired"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const COMMITMENT_STATUSES = ["open", "mirrored", "released"] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

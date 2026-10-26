import { DomainError } from "@ecom/shared";

/**
 * Erorile serviciului de stoc, cu cod stabil. Mesajele sunt în română și nu conțin valori sensibile.
 *
 * - `STOCK_INSUFFICIENT`: cel puțin o linie nu încape; `details.lines` = `{ variantId, sku, requestedSteps, maxSteps }`
 *   (pași, ca șiruri), ca interfața să spună cât se poate comanda. Nimic nu s-a modificat.
 * - `STOCK_RESERVATION_MISMATCH`: aceeași comandă a cerut altă cantitate pentru aceeași linie.
 * - `STOCK_RESERVATION_LOST`: rezervarea expirase și stocul a fost luat între timp; plata trebuie rambursată.
 * - `STOCK_COMMITMENT_RELEASED`: comanda a fost anulată (angajare eliberată); aceeași comandă nu se mai angajează.
 * - `STOCK_VARIANT_NOT_FOUND`, `STOCK_NO_WAREHOUSE`: date lipsă.
 * - `STOCK_NOT_MANAGED`: varianta nu are stoc de ajustat (produs digital sau cu gestionarea stocului oprită).
 * - `STOCK_THRESHOLD_INVALID`: pragul «stoc mic» nu e un număr întreg de pași între 0 și `LOW_STOCK_STEPS_MAX` (sau gol).
 *
 * Ajustările manuale de stoc fizic (`adjustPhysical`), toate fără nicio modificare la refuz:
 * - `STOCK_ADJUSTMENT_INVALID_REASON`, `STOCK_ADJUSTMENT_NOTE_REQUIRED`, `STOCK_ADJUSTMENT_NOTE_TOO_LONG`,
 *   `STOCK_ADJUSTMENT_ZERO`: motiv necunoscut, text liber lipsă sau prea lung, variație zero.
 * - `STOCK_ADJUSTMENT_WRONG_SIGN`: semnul nu e cel al motivului (`details.reason`, `details.required`).
 * - `STOCK_ADJUSTMENT_INVALID_TIME`, `STOCK_ADJUSTMENT_FUTURE`: ora efectivă e invalidă sau mai departe în viitor decât
 *   toleranța.
 * - `STOCK_ADJUSTMENT_PRECISION`: mai multe zecimale decât are unitatea (`details.decimals`).
 * - `STOCK_ADJUSTMENT_BELOW_ZERO`: stocul ar deveni negativ (`details.available`, `details.requested`, în zecimi de miime).
 * - `STOCK_ADJUSTMENT_OVERFLOW`: stocul ar depăși plafonul cantităților.
 */
export class StockError extends DomainError {}

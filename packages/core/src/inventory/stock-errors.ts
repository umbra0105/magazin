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
 */
export class StockError extends DomainError {}

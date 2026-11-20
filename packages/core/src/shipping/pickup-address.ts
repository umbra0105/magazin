/**
 * Adresa de ridicare personală = adresa MAGAZINULUI (`company.address`), niciodată adresa clientului. Un singur loc pentru regula
 * de completitudine și pentru formatare, ca checkout-ul, confirmarea, urmărirea și, mai târziu, emailurile (Faza 11) și AWB-ul
 * (Faza 12) să nu poată ajunge la formate sau reguli diferite.
 */

/** Cum e stocată adresa firmei în setarea `company.address`. */
export interface PickupAddress {
  street: string;
  city: string;
  county: string;
  postalCode: string;
  country: string;
}

/** Adresa de ridicare tăiată de spații, cu textul formatat; aceasta se salvează în snapshot-ul comenzii (imuabil). */
export interface NormalizedPickupAddress extends PickupAddress {
  text: string;
}

const trimmed = (value: string): string => value.trim();

/** Ridicarea se poate oferi doar cu stradă ȘI oraș completate (județul și codul poștal ajută, dar nu sunt obligatorii). */
export function isPickupAddressComplete(address: PickupAddress | null): address is PickupAddress {
  return address !== null && trimmed(address.street) !== "" && trimmed(address.city) !== "";
}

/**
 * UN SINGUR format al adresei magazinului (decizia din 2026-11-19), folosit de subsolul vitrinei, de ridicarea personală
 * (checkout, confirmare, urmărire, snapshot-ul comenzii) și de emailuri: «stradă, cod poștal oraș, județ»; țara se adaugă doar
 * când nu e România. Părțile goale se sar, fără virgule duble. Ecranul pentru datele firmei rămâne în Faza 13.
 */
export function formatCompanyAddress(address: PickupAddress): string {
  const country = trimmed(address.country);
  const postalAndCity = [address.postalCode, address.city]
    .map(trimmed)
    .filter((part) => part !== "")
    .join(" ");
  return [
    trimmed(address.street),
    postalAndCity,
    trimmed(address.county),
    country.toUpperCase() === "RO" ? "" : country,
  ]
    .filter((part) => part !== "")
    .join(", ");
}

/** Adresa de ridicare = adresa magazinului, în același format. */
export function formatPickupAddress(address: PickupAddress): string {
  return formatCompanyAddress(address);
}

/** Adresa gata de pus pe ofertă și în snapshot, sau `null` dacă lipsește ori e incompletă. */
export function normalizePickupAddress(
  address: PickupAddress | null,
): NormalizedPickupAddress | null {
  if (!isPickupAddressComplete(address)) return null;
  return {
    street: trimmed(address.street),
    city: trimmed(address.city),
    county: trimmed(address.county),
    postalCode: trimmed(address.postalCode),
    country: trimmed(address.country),
    text: formatPickupAddress(address),
  };
}

/**
 * Textul adresei de ridicare dintr-un `shippingSnapshot` salvat la plasare. O comandă mai veche (fără adresă în snapshot) sau un
 * snapshot ciudat dau `null`: NU se înlocuiește niciodată cu adresa clientului.
 */
export function pickupAddressTextFromSnapshot(snapshot: unknown): string | null {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const address = (snapshot as Record<string, unknown>)["pickupAddress"];
  if (typeof address !== "object" || address === null) return null;
  const text = (address as Record<string, unknown>)["text"];
  return typeof text === "string" && text.trim() !== "" ? text : null;
}

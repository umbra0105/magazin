import { getMessages } from "@/messages";

/**
 * Validarea câmpurilor de la checkout în browser: doar pentru experiența de utilizare (mesaj imediat, focus pe primul câmp
 * greșit). Serverul validează oricum TOT, din nou (`CheckoutService`): nimic de aici nu e o garanție. Fără validarea nativă a
 * browserului (formularele au `noValidate`), ca mesajele să fie în română.
 */

const e = () => getMessages().storefront.checkout.errors;

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_PATTERN = /^(?:\+40|0040|0)\d{9}$/;
const POSTAL_PATTERN = /^\d{6}$/;

export const isEmail = (value: string): boolean =>
  value.length <= 254 && EMAIL_PATTERN.test(value.trim());
export const isRoPhone = (value: string): boolean =>
  PHONE_PATTERN.test(value.replace(/[\s.\-()]/g, ""));
export const isPostalCode = (value: string): boolean => POSTAL_PATTERN.test(value.trim());

export type FieldErrors = Record<string, string>;

export interface ContactValues {
  email: string;
  phone: string;
}

export interface AddressValues {
  fullName: string;
  countyCode: string;
  localityCode: string;
  street: string;
  postalCode: string;
}

export function contactErrors(values: ContactValues): FieldErrors {
  const errors: FieldErrors = {};
  if (!isEmail(values.email)) errors["email"] = e().email;
  if (!isRoPhone(values.phone)) errors["phone"] = e().phone;
  return errors;
}

/** `prefix` ajută la câmpurile adresei de facturare (aceleași reguli, alte chei). */
export function addressErrors(values: AddressValues, prefix = ""): FieldErrors {
  const errors: FieldErrors = {};
  const key = (name: string) => (prefix ? `${prefix}.${name}` : name);
  if (values.fullName.trim().length < 2) errors[key("fullName")] = e().required;
  if (values.countyCode === "") errors[key("countyCode")] = e().county;
  if (values.localityCode === "") errors[key("localityCode")] = e().locality;
  if (values.street.trim().length < 3) errors[key("street")] = e().required;
  if (!isPostalCode(values.postalCode)) errors[key("postalCode")] = e().postal;
  return errors;
}

export function companyErrors(values: { companyName: string; vatId: string }): FieldErrors {
  const errors: FieldErrors = {};
  if (values.companyName.trim().length < 2) errors["companyName"] = e().company;
  if (values.vatId.trim() === "") errors["vatId"] = e().required;
  return errors;
}

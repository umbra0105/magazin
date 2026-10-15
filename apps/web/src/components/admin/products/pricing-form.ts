import { parseMoneyInput } from "@/lib/money-input";

/**
 * Logica pură a formularului de prețuri (testabilă fără DOM): validarea de pe client (aceleași reguli
 * ca pe server, pentru mesaje imediate) și construirea cererii cu DOAR câmpurile modificate.
 * Serverul rămâne autoritatea: validează din nou, inclusiv față de valorile existente.
 */

export interface PricingValues {
  sku: string;
  price: string;
  salePrice: string;
  saleStartsAt: string;
  saleEndsAt: string;
  ean: string;
  warrantyMonths: string;
  [key: string]: string;
}

export interface PricingTexts {
  skuRequired: string;
  priceInvalid: string;
  saleAbovePrice: string;
  windowOrder: string;
  eanInvalid: string;
  warrantyInvalid: string;
  /** Doar la formularul de variantă din tabul Variante. */
  weightInvalid?: string;
}

export function validatePricing(
  values: PricingValues,
  changed: readonly string[],
  text: PricingTexts,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const touched = (key: string) => changed.includes(key);

  if (touched("sku") && values.sku.trim() === "") errors["sku"] = text.skuRequired;

  const price = parseMoneyInput(values.price);
  if (touched("price") && price === null) errors["price"] = text.priceInvalid;

  const sale = values.salePrice.trim() === "" ? null : parseMoneyInput(values.salePrice);
  if (touched("salePrice") && values.salePrice.trim() !== "" && sale === null) {
    errors["salePrice"] = text.priceInvalid;
  }
  if (
    (touched("salePrice") || touched("price")) &&
    price !== null &&
    sale !== null &&
    sale > price
  ) {
    errors["salePrice"] = text.saleAbovePrice;
  }

  if (
    (touched("saleStartsAt") || touched("saleEndsAt")) &&
    values.saleStartsAt !== "" &&
    values.saleEndsAt !== "" &&
    values.saleStartsAt > values.saleEndsAt
  ) {
    errors["saleEndsAt"] = text.windowOrder;
  }

  if (touched("ean") && values.ean.trim() !== "" && !/^[0-9]{8,14}$/.test(values.ean.trim())) {
    errors["ean"] = text.eanInvalid;
  }

  if (touched("warrantyMonths") && values.warrantyMonths.trim() !== "") {
    const months = Number(values.warrantyMonths);
    if (!Number.isInteger(months) || months < 0 || months > 240) {
      errors["warrantyMonths"] = text.warrantyInvalid;
    }
  }
  if (touched("weightGrams") && values["weightGrams"] !== undefined) {
    const raw = values["weightGrams"].trim();
    if (raw !== "") {
      const grams = Number(raw);
      if (!/^d+$/.test(raw) || !Number.isSafeInteger(grams) || grams < 1 || grams > 10_000_000) {
        errors["weightGrams"] = text.weightInvalid ?? text.priceInvalid;
      }
    }
  }
  return errors;
}

/** Cererea către server: doar câmpurile modificate, cu tipurile corecte (bani întregi, `null` pentru gol). */
export function buildVariantPatch(
  values: PricingValues,
  changed: readonly string[],
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of changed) {
    switch (key) {
      case "sku":
        patch["sku"] = values.sku.trim();
        break;
      case "price":
        patch["price"] = parseMoneyInput(values.price);
        break;
      case "salePrice":
        patch["salePrice"] =
          values.salePrice.trim() === "" ? null : parseMoneyInput(values.salePrice);
        break;
      case "saleStartsAt":
      case "saleEndsAt":
        // „” = fără limită; formatul AAAA-LL-ZZTHH:mm e în ora magazinului, convertit pe server
        patch[key] = values[key];
        break;
      case "ean":
        patch["ean"] = values.ean.trim() === "" ? null : values.ean.trim();
        break;
      case "warrantyMonths":
        patch["warrantyMonths"] =
          values.warrantyMonths.trim() === "" ? null : Number(values.warrantyMonths);
        break;
      case "weightGrams":
        patch["weightGrams"] =
          (values["weightGrams"] ?? "").trim() === "" ? null : Number(values["weightGrams"]);
        break;
      case "manufacturerPartNumber":
        patch["manufacturerPartNumber"] =
          (values["manufacturerPartNumber"] ?? "").trim() === ""
            ? null
            : (values["manufacturerPartNumber"] ?? "").trim();
        break;
      default:
        break;
    }
  }
  return patch;
}

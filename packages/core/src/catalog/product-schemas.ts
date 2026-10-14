import { z } from "zod";
import { ValidationError } from "@ecom/shared";
import {
  PRODUCT_STATUSES,
  PRODUCT_TYPES,
  SHIPPING_CLASSES,
  STOCK_STATUSES,
  ENERGY_CLASSES,
} from "./constants";
import { SLUG_MAX_LENGTH, SLUG_PATTERN } from "./slug";

/**
 * Validarea la marginea sistemului pentru produse și variante. Toate schemele sunt STRICTE: o cheie
 * necunoscută e o eroare, nu e ignorată în tăcere. Prețul de achiziție NU e în nicio schemă de aici:
 * se scrie doar prin serviciul lui dedicat, deci o cerere care îl conține e refuzată ca „cheie
 * necunoscută” înainte să ajungă la vreun serviciu.
 */

/** 10.000.000 lei în bani: un plafon care prinde greșelile de zero în plus, nu o regulă de business. */
export const MAX_MONEY = 1_000_000_000;

const money = z.number().int().min(0).max(MAX_MONEY);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const slug = z
  .string()
  .trim()
  .min(1)
  .max(SLUG_MAX_LENGTH)
  .regex(SLUG_PATTERN, "Adresa poate conține doar litere mici, cifre și cratime");

const gtin = z
  .string()
  .trim()
  .regex(/^[0-9]{8,14}$/, "EAN-ul are 8–14 cifre");

const variantFields = {
  sku: z.string().trim().min(1).max(64),
  ean: gtin.nullable().optional(),
  warrantyMonths: z.number().int().min(0).max(240).nullable().optional(),
  price: money,
  salePrice: money.nullable().optional(),
  saleStartsAt: z.coerce.date().nullable().optional(),
  saleEndsAt: z.coerce.date().nullable().optional(),
  weightGrams: z.number().int().min(1).max(10_000_000).nullable().optional(),
  lengthMm: z.number().int().min(1).max(100_000).nullable().optional(),
  widthMm: z.number().int().min(1).max(100_000).nullable().optional(),
  heightMm: z.number().int().min(1).max(100_000).nullable().optional(),
  manufacturerPartNumber: optionalText(100),
  manufacturerName: optionalText(150),
  manageStock: z.boolean().nullable().optional(),
  stockStatus: z.enum(STOCK_STATUSES).nullable().optional(),
  isDefault: z.boolean().optional(),
};

type SaleFields = {
  price?: number | undefined;
  salePrice?: number | null | undefined;
  saleStartsAt?: Date | null | undefined;
  saleEndsAt?: Date | null | undefined;
};

/** Promoția nu depășește prețul și fereastra ei e ordonată (când ambele capete există). */
function checkSale(value: SaleFields, ctx: z.RefinementCtx): void {
  if (
    value.price !== undefined &&
    value.salePrice !== undefined &&
    value.salePrice !== null &&
    value.salePrice > value.price
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["salePrice"],
      message: "Prețul redus nu poate depăși prețul întreg",
    });
  }
  if (
    value.saleStartsAt &&
    value.saleEndsAt &&
    value.saleStartsAt.getTime() > value.saleEndsAt.getTime()
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["saleEndsAt"],
      message: "Promoția se termină înainte să înceapă",
    });
  }
}

export const variantInputSchema = z.strictObject(variantFields).superRefine(checkSale);

/** Modificarea unei variante: orice subset; verificarea față de valorile existente e în serviciu. */
export const variantUpdateSchema = z
  .strictObject(variantFields)
  .partial()
  .superRefine(checkSale)
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Nu a fost trimis niciun câmp de modificat",
  });

const productFields = {
  title: z.string().trim().min(1, "Titlul e obligatoriu").max(200),
  slug: slug.optional(),
  subtitle: optionalText(300),
  description: z.string().max(100_000).nullable().optional(),
  type: z.enum(PRODUCT_TYPES).optional(),
  status: z.enum(PRODUCT_STATUSES).optional(),
  brandId: z.string().min(1).nullable().optional(),
  shippingClass: z.enum(SHIPPING_CLASSES).optional(),
  requiresInstallation: z.boolean().optional(),
  manageStock: z.boolean().optional(),
  stockStatus: z.enum(STOCK_STATUSES).optional(),
  allowBackorder: z.boolean().optional(),
  expectedRestockDate: z.coerce.date().nullable().optional(),
  excludeFromGroupDiscount: z.boolean().optional(),
  energyClass: z.enum(ENERGY_CLASSES).nullable().optional(),
  eprelUrl: z
    .string()
    .trim()
    .regex(/^https:\/\/\S+$/, "Link-ul EPREL trebuie să înceapă cu https://")
    .max(500)
    .nullable()
    .optional(),
  gpsrManufacturerName: optionalText(200),
  gpsrManufacturerContact: optionalText(1000),
  gpsrResponsibleName: optionalText(200),
  gpsrResponsibleContact: optionalText(1000),
  safetyWarnings: optionalText(5000),
  seoTitle: optionalText(255),
  seoDescription: optionalText(500),
};

export const productCreateSchema = z.strictObject({
  ...productFields,
  variants: z
    .array(variantInputSchema)
    .min(1, "Produsul are nevoie de cel puțin o variantă")
    .max(100),
});

/** Modificarea produsului (fără variante: acelea au operațiile lor). Orice subset, cel puțin un câmp. */
export const productUpdateSchema = z
  .strictObject(productFields)
  .partial()
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Nu a fost trimis niciun câmp de modificat",
  });

export type ProductCreateInput = z.infer<typeof productCreateSchema>;
export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;
export type VariantInput = z.infer<typeof variantInputSchema>;
export type VariantUpdateInput = z.infer<typeof variantUpdateSchema>;

/**
 * Validează `input`; la eșec aruncă `ValidationError` cu doar calea și mesajul fiecărei probleme
 * (NICIODATĂ valoarea primită, ca un cost sau un text lung să nu ajungă în mesaje sau loguri).
 */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
  const summary = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ");
  throw new ValidationError(`Date invalide: ${summary}`, { issues });
}

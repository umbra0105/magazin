import { z } from "zod";
import { DomainError } from "@ecom/shared";
import type { PriceGroup } from "../pricing/engine";
import {
  GROUP_TONES,
  MAX_DISCOUNT_BPS,
  MAX_MARKUP_BPS,
  PRICING_TYPES,
  type GroupTone,
  type PricingType,
} from "./constants";

/**
 * Regulile pure ale grupurilor de clienți (Faza 15): validarea câmpurilor (tipul și procentul lui se potrivesc), conversia în
 * grupul înțeles de motorul de prețuri și proiecția care poate ajunge în vitrină. Fără baze de date și fără React.
 *
 * ⚠️ `markupBps` (adaosul unui grup `cost_plus`) NU ajunge în vitrină: împreună cu prețul de partener ar da costul de achiziție.
 */

export class CustomerError extends DomainError {}

export interface CustomerGroupRecord {
  id: string;
  name: string;
  slug: string;
  pricingType: PricingType;
  discountBps: number | null;
  markupBps: number | null;
  stacksWithSalePrice: boolean;
  earnsLoyaltyPoints: boolean;
  tone: GroupTone;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
}

const name = z
  .string()
  .trim()
  .min(1, "Numele e obligatoriu")
  .max(80, "Numele are cel mult 80 de caractere");
const bps = (max: number, label: string) =>
  z
    .number({ message: `${label} trebuie să fie un număr` })
    .int(`${label} trebuie să fie un număr întreg (în puncte de bază)`)
    .min(0, `${label} nu poate fi negativ`)
    .max(max, `${label} nu poate depăși ${max / 100}%`);

/** Câmpurile editabile ale unui grup (aceeași formă la creare și la editare). */
export const customerGroupFields = z.strictObject({
  name,
  pricingType: z.enum(PRICING_TYPES, { message: "Tipul de preț nu e valid" }),
  discountBps: bps(MAX_DISCOUNT_BPS, "Reducerea").nullable().optional(),
  markupBps: bps(MAX_MARKUP_BPS, "Adaosul").nullable().optional(),
  stacksWithSalePrice: z.boolean().default(false),
  earnsLoyaltyPoints: z.boolean().default(true),
  tone: z.enum(GROUP_TONES, { message: "Tonul badge-ului nu e valid" }).default("neutral"),
  isActive: z.boolean().default(true),
});

export type CustomerGroupFields = z.infer<typeof customerGroupFields>;

export interface GroupIssue {
  field: "discountBps" | "markupBps" | "stacksWithSalePrice" | "pricingType";
  message: string;
}

/** Potrivirea dintre tip și procente (aceeași regulă ca CHECK-ul din bază; mesajele sunt pentru formular). */
export function groupIssues(
  group: Pick<
    CustomerGroupFields,
    "pricingType" | "discountBps" | "markupBps" | "stacksWithSalePrice"
  >,
): GroupIssue[] {
  const issues: GroupIssue[] = [];
  const discount = group.discountBps ?? null;
  const markup = group.markupBps ?? null;
  if (group.pricingType === "none") {
    if (discount !== null)
      issues.push({ field: "discountBps", message: "«Prețul public» nu are reducere." });
    if (markup !== null)
      issues.push({ field: "markupBps", message: "«Prețul public» nu are adaos." });
  } else if (group.pricingType === "discount") {
    if (discount === null)
      issues.push({ field: "discountBps", message: "Alege procentul reducerii." });
    if (markup !== null)
      issues.push({ field: "markupBps", message: "Un grup cu reducere nu are adaos." });
  } else {
    if (markup === null) issues.push({ field: "markupBps", message: "Alege procentul adaosului." });
    if (discount !== null)
      issues.push({ field: "discountBps", message: "Un grup cu adaos nu are reducere." });
  }
  if (group.stacksWithSalePrice && group.pricingType !== "discount") {
    issues.push({
      field: "stacksWithSalePrice",
      message: "Cumularea cu promoția se poate doar la grupurile cu reducere.",
    });
  }
  return issues;
}

/** Validează câmpurile (schema + potrivirea tip/procente); aruncă `ValidationError` cu `CUSTOMER_GROUP_INVALID`. */
export function validateGroupFields(input: unknown): CustomerGroupFields {
  const parsed = customerGroupFields.safeParse(input);
  const issues: Array<{ path: string; message: string }> = parsed.success
    ? groupIssues(parsed.data).map((issue) => ({ path: issue.field, message: issue.message }))
    : parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
  if (!parsed.success || issues.length > 0) {
    throw new CustomerError(
      "CUSTOMER_GROUP_INVALID",
      `Date invalide: ${issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ")}`,
      { issues },
    );
  }
  return parsed.data;
}

/** Grupul așa cum îl înțelege motorul de prețuri. Fără grup (`null`) = «Client standard». */
export function toPriceGroup(
  group: Pick<
    CustomerGroupRecord,
    "pricingType" | "discountBps" | "markupBps" | "stacksWithSalePrice"
  > | null,
): PriceGroup {
  if (group === null || group.pricingType === "none") return { pricingType: "none" };
  if (group.pricingType === "discount") {
    if (group.discountBps === null) {
      throw new CustomerError("CUSTOMER_GROUP_INVALID", "Grupul cu reducere nu are procent.");
    }
    return {
      pricingType: "discount",
      discountBps: group.discountBps,
      stacksWithSalePrice: group.stacksWithSalePrice,
    };
  }
  if (group.markupBps === null) {
    throw new CustomerError("CUSTOMER_GROUP_INVALID", "Grupul cu adaos nu are procent.");
  }
  return { pricingType: "cost_plus", markupBps: group.markupBps };
}

/**
 * Ce află VITRINA despre grupul clientului: numele, tipul și, doar la reducere, procentul (ca «−5%» în badge). Adaosul unui
 * grup `cost_plus` nu se trimite niciodată (ar permite deducerea costului din prețul de partener).
 */
export interface PublicGroupView {
  name: string;
  pricingType: PricingType;
  /** Doar la `discount`; `null` altfel. */
  discountBps: number | null;
}

export function toPublicGroupView(
  group: Pick<CustomerGroupRecord, "name" | "pricingType" | "discountBps">,
): PublicGroupView {
  return {
    name: group.name,
    pricingType: group.pricingType,
    discountBps: group.pricingType === "discount" ? group.discountBps : null,
  };
}

/** Ce se păstrează pe comandă: grupul, procentul relevant și atât (niciun cost). */
export interface OrderGroupSnapshot {
  customerGroupId: string | null;
  groupPricingType: PricingType;
  groupDiscountBps: number | null;
  groupMarkupBps: number | null;
}

export function orderGroupSnapshot(
  group: Pick<CustomerGroupRecord, "id" | "pricingType" | "discountBps" | "markupBps"> | null,
): OrderGroupSnapshot {
  if (group === null) {
    return {
      customerGroupId: null,
      groupPricingType: "none",
      groupDiscountBps: null,
      groupMarkupBps: null,
    };
  }
  return {
    customerGroupId: group.id,
    groupPricingType: group.pricingType,
    groupDiscountBps: group.pricingType === "discount" ? group.discountBps : null,
    groupMarkupBps: group.pricingType === "cost_plus" ? group.markupBps : null,
  };
}

/** Cel mult atâția clienți într-o atribuire în masă. */
export const MAX_BULK_ASSIGN = 500;

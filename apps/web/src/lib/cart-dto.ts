import type { CartIssue, CartLineView, CartView } from "@ecom/core";

export { EMPTY_CART_VIEW } from "@ecom/core";
import {
  QUANTITY_FACTOR,
  formatQuantity,
  quantityFromTicks,
  stepsToQuantity,
  type Quantity,
} from "@ecom/shared";
import { getMessages } from "@/messages";
import { describeAvailability } from "./availability-text";
import { formatMoney } from "./money-input";
import { productHref } from "./storefront-urls";

/**
 * Cartea de vizită a coșului pentru interfață: toate textele (bani, cantități, mesaje) gata formatate pe SERVER, ca să nu ajungă
 * în JavaScript-ul clientului nicio regulă de preț și niciun calcul de sumă. Funcție PURĂ (testată pe valori): primește
 * vederea din `CartService` și formatul (moneda și limba din setări). Coșul nu arată nicio reducere: cât vitrina nu afișează
 * reduceri, motorul percepe prețul întreg, iar vederea nu are linii de reducere.
 */

const m = () => getMessages().storefront.cart;
const product = () => getMessages().storefront.catalog.product;

export interface CartFormat {
  currency: string;
  locale: string;
}

export type CartIssueAction =
  | { kind: "remove" }
  | { kind: "adjust"; quantityTicks: string; label: string }
  | { kind: "acknowledge"; label: string };

export interface CartIssueDto {
  type: CartIssue["type"];
  message: string;
  action: CartIssueAction | null;
}

export interface CartLineDto {
  variantId: string;
  href: string;
  title: string;
  variantLabel: string | null;
  sku: string;
  image: { src: string; width: number; height: number; alt: string } | null;
  energy: { value: string; label: string } | null;
  quantityTicks: string;
  stepTicks: string;
  /** Numărul de pași comandați (afișat în selector); cantitatea reală rămâne cea din `quantityTicks`. */
  steps: number;
  minSteps: number;
  quantityText: string;
  stepNote: string | null;
  minNote: string | null;
  unitPriceText: string | null;
  totalText: string | null;
  stateLabel: string;
  stateTone: "success" | "warning" | "info" | "problem";
  stateDetail: string | null;
  issues: CartIssueDto[];
  included: boolean;
  /** Produs digital (Faza 14c): fără selector de cantitate (maxim o bucată). */
  isDigital?: boolean;
}

export interface CartDto {
  lines: CartLineDto[];
  count: number;
  totals: { productsText: string; vatText: string; totalText: string } | null;
  /**
   * Prețul de grup (Faza 15): «Reducere client fidel (−5%)» sau «Avantaj partener», cu suma. Informativ: reducerea e deja în prețurile
   * liniilor. `null` fără grup cu preț special sau când produsele din coș nu au avantaj.
   */
  groupLineText: string | null;
  leadTimeText: string | null;
  freeShipping: { text: string; percent: number; reached: boolean } | null;
  /** Coșul poate trece la finalizare (are linii și nicio problemă care cere o decizie). */
  canCheckout: boolean;
  checkoutLabel: string;
  /** Explicația de sub butonul dezactivat (coșul are probleme de rezolvat). */
  checkoutBlockedNote: string;
  shippingNote: string;
}

function unitPriceText(line: CartLineView, format: CartFormat): string | null {
  if (!line.pricing) return null;
  const price = formatMoney(line.pricing.unitPriceMinor, format.currency, format.locale);
  const p = product();
  const symbol = line.unit.symbol;
  if (line.basis === "step") {
    const step = quantityFromTicks(BigInt(line.stepTicks));
    return `${price} ${p.perStep(line.stepLabel, formatQuantity(step), symbol)}`;
  }
  return `${price} ${p.perUnit(symbol)}`;
}

function issueOf(line: CartLineView, issue: CartIssue, format: CartFormat): CartIssueDto {
  const text = m();
  const step = quantityFromTicks(BigInt(line.stepTicks));
  const withUnit = (quantity: Quantity) => `${formatQuantity(quantity)} ${line.unit.symbol}`;
  switch (issue.type) {
    case "unavailable":
      return { type: issue.type, message: text.issueUnavailable, action: { kind: "remove" } };
    case "exceeds_available": {
      const available = stepsToQuantity(issue.maxSteps, step);
      return {
        type: issue.type,
        message: text.issueExceeds(withUnit(available)),
        action: {
          kind: "adjust",
          quantityTicks: available.toString(),
          label: text.issueAdjust(withUnit(available)),
        },
      };
    }
    case "invalid_quantity": {
      const wanted = quantityFromTicks(BigInt(line.quantityTicks));
      const floor = wanted / step;
      const steps = floor < BigInt(line.minSteps ?? 1) ? BigInt(line.minSteps ?? 1) : floor;
      const fixed = stepsToQuantity(steps, step);
      return {
        type: issue.type,
        message: text.issueInvalid,
        action: {
          kind: "adjust",
          quantityTicks: fixed.toString(),
          label: text.issueAdjust(withUnit(fixed)),
        },
      };
    }
    case "digital_quantity":
      return {
        type: issue.type,
        message: text.issueDigitalQuantity,
        action: {
          kind: "adjust",
          quantityTicks: step.toString(),
          label: text.issueDigitalKeepOne,
        },
      };
    case "price_changed":
      return {
        type: issue.type,
        message: text.issuePriceChanged(
          formatMoney(issue.fromMinor, format.currency, format.locale),
          formatMoney(issue.toMinor, format.currency, format.locale),
        ),
        action: { kind: "acknowledge", label: text.issueAcknowledge },
      };
    case "line_too_expensive":
      return { type: issue.type, message: text.issueTooExpensive, action: null };
  }
}

function lineDto(line: CartLineView, format: CartFormat): CartLineDto {
  const p = product();
  const text = m();
  const step = quantityFromTicks(BigInt(line.stepTicks));
  const quantity = quantityFromTicks(BigInt(line.quantityTicks));
  const symbol = line.unit.symbol;
  const oneUnit = BigInt(step) === QUANTITY_FACTOR;
  const stepsCount = quantity / step;
  const minSteps = line.minSteps ?? 1;
  // eticheta de disponibilitate vine din locul comun (Faza 14c, decizia 3); un produs digital e «Disponibil» doar cât linia e comandabilă
  const orderable = line.included && !line.issues.some((issue) => issue.type === "unavailable");
  const stateText = describeAvailability({
    state: line.state,
    remainingSteps: line.remainingSteps,
    leadTimeDays: line.leadTimeDays,
    purchasable: orderable,
    ...(line.isDigital === true ? { isDigital: true } : {}),
  });
  return {
    variantId: line.variantId,
    href: productHref(line.productSlug),
    title: line.productTitle,
    variantLabel: line.variantLabel,
    sku: line.sku,
    image: line.image,
    energy: line.energyClass
      ? { value: line.energyClass, label: p.energy.label(line.energyClass) }
      : null,
    quantityTicks: line.quantityTicks,
    stepTicks: line.stepTicks,
    steps: Number(stepsCount),
    minSteps,
    quantityText: `${formatQuantity(quantity)} ${symbol}`,
    stepNote: oneUnit ? null : text.stepNote(formatQuantity(step), symbol, line.stepLabel),
    minNote:
      minSteps > 1 ? text.minNote(formatQuantity(stepsToQuantity(minSteps, step)), symbol) : null,
    unitPriceText: unitPriceText(line, format),
    totalText: line.pricing
      ? formatMoney(line.pricing.totalMinor, format.currency, format.locale)
      : null,
    stateLabel: stateText.label,
    stateTone: stateText.tone,
    stateDetail: stateText.detail,
    issues: line.issues.map((issue) => issueOf(line, issue, format)),
    included: line.included,
    isDigital: line.isDigital === true,
  };
}

/** Linia informativă a prețului de grup: doar cu grup cu preț special și un avantaj real (> 0). Fără adaos sau cost. */
function groupLineText(view: CartView, money: (minor: number) => string): string | null {
  const group = view.group;
  const advantage = view.totals.groupAdvantageMinor;
  if (!group || advantage <= 0) return null;
  const text = m();
  if (group.pricingType === "discount" && group.discountBps !== null) {
    const percent = (group.discountBps / 100).toLocaleString("ro-RO", { maximumFractionDigits: 2 });
    return text.groupDiscount(group.name, percent, money(advantage));
  }
  return text.groupPartner(money(advantage));
}

export function toCartDto(view: CartView, format: CartFormat): CartDto {
  const text = m();
  const money = (minor: number) => formatMoney(minor, format.currency, format.locale);
  const priced = view.lines.some((line) => line.pricing !== null);
  const free = view.freeShipping;
  return {
    lines: view.lines.map((line) => lineDto(line, format)),
    count: view.lines.length,
    groupLineText: groupLineText(view, money),
    totals: priced
      ? {
          productsText: money(view.totals.totalMinor),
          vatText: money(view.totals.vatMinor),
          totalText: money(view.totals.totalMinor),
        }
      : null,
    leadTimeText: view.leadTime ? text.leadTime(view.leadTime.days) : null,
    freeShipping: free
      ? {
          text: free.reached
            ? text.freeShippingReached
            : text.freeShippingRemaining(money(free.remainingMinor)),
          percent: Math.min(100, Math.floor((view.totals.totalMinor * 100) / free.thresholdMinor)),
          reached: free.reached,
        }
      : null,
    canCheckout: view.canCheckout,
    checkoutLabel: text.checkout,
    checkoutBlockedNote: text.checkoutBlocked,
    shippingNote: text.shippingNote,
  };
}

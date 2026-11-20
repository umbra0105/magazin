import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "@ecom/db";
import {
  DomainError,
  ValidationError,
  formatQuantity,
  parseQuantity,
  quantityFromTicks,
} from "@ecom/shared";
import { z } from "zod";
import type { CartOwner, CartService } from "../cart/cart-service";
import { CartError } from "../cart/cart-service";
import { inTx, type Db } from "../db-tx";
import { notifyAdmins, offerContext } from "../notifications/admin-notifications";
import { CHECKOUT_TERMS_CONSENT } from "../orders/consent";
import {
  addressInputSchema,
  companyInputSchema,
  placeOrderInputSchema,
} from "../orders/checkout-input";
import type { CheckoutService } from "../orders/checkout-service";
import { OrderError } from "../orders/order-errors";
import { addOrderEvent } from "../orders/order-service";
import type { OrderTotals } from "../orders/order-totals";
import type { RateOffer } from "../shipping/types";

/**
 * Oferta de plată (Faza 11, decizia A din 2026-11-20): adminul compune o ofertă (produse, adresă, livrare) pentru un client care
 * a cerut-o prin telefon sau email; liniile și totalurile ÎNGHEAȚĂ ce a calculat motorul de prețuri (printr-un coș temporar al
 * adminului) și `ShippingService`. Clientul primește un link cu jeton aleatoriu de 256 de biți (în bază stă doar amprenta
 * SHA-256), bifează Termenii și plătește cu cardul. La plată serverul RECALCULEAZĂ: dacă prețul, transportul, TVA-ul sau stocul
 * diferă de ce a văzut clientul, oferta devine «stale» (nu se creează nimic); altfel devine o comandă reală prin ACELAȘI
 * `CheckoutService` (stocul se rezervă acolo), cu cheia de idempotență derivată din id-ul ofertei: o ofertă dă cel mult o comandă.
 *
 * Nu există reduceri manuale (decizie separată) și nici produse digitale (până la Faza 14b). Prețurile nu se calculează aici:
 * nimic din acest fișier nu înmulțește sau rotunjește bani.
 */

export const OFFER_ERROR_CODES = [
  "OFFER_INVALID",
  "OFFER_NOT_PAYABLE",
  "OFFER_DIGITAL_NOT_SUPPORTED",
  "OFFER_CARD_UNAVAILABLE",
  /** Jeton necunoscut, expirat, anulat sau stricat: același răspuns pentru toate, ca să nu se poată deosebi din afară. */
  "OFFER_UNAVAILABLE",
  "OFFER_STALE",
  "OFFER_STATE_INVALID",
  "OFFER_NOT_FOUND",
] as const;
export type OfferErrorCode = (typeof OFFER_ERROR_CODES)[number];

export class OfferError extends DomainError {
  constructor(code: OfferErrorCode, message: string, details?: unknown) {
    super(code, message, details);
  }
}

/** Mesajul identic pentru orice jeton care nu poate fi folosit (nu spune DE CE). */
const UNAVAILABLE_MESSAGE = "Această ofertă nu mai este disponibilă. Contactează magazinul.";

export type OfferStatus = "active" | "converted" | "expired" | "stale" | "cancelled";
export type StaleReason = "price" | "shipping" | "tax" | "stock" | "product";

export interface OfferSettings {
  /** `orders.offerValidityHours`. */
  validityHours: number;
  /** `orders.offerNumberPrefix`. */
  numberPrefix: string;
}

export interface OfferServiceDeps {
  db: Db;
  /** Coșul prin care adminul și conversia îți calculează prețurile (aceleași reguli ca la vitrină). */
  cart: CartService;
  checkout: CheckoutService;
  readSettings: () => Promise<OfferSettings>;
  now?: () => Date;
  generateToken?: () => string;
}

export interface OfferActor {
  id: string;
  label: string;
}

const contactSchema = placeOrderInputSchema.shape.contact;

export const offerDraftSchema = z.object({
  email: contactSchema.shape.email,
  phone: contactSchema.shape.phone,
  shipping: addressInputSchema,
  billing: placeOrderInputSchema.shape.billing,
  company: companyInputSchema.nullable().default(null),
  shippingOfferCode: z.string().min(1).max(100),
  lines: z
    .array(z.object({ variantId: z.string().min(1).max(40), quantity: z.string().min(1).max(24) }))
    .max(50),
});
export type OfferDraftInput = z.input<typeof offerDraftSchema>;
type OfferDraft = z.output<typeof offerDraftSchema>;

const consentSchema = z.object({ accepted: z.literal(true), version: z.string().min(1).max(50) });

export interface FrozenLine {
  variantId: string | null;
  sku: string;
  title: string;
  variantTitle: string | null;
  /** Text zecimal («2», «1,5»). */
  quantity: string;
  unitSymbol: string;
  unitPriceMinor: number;
  lineTotalMinor: number;
  vatMinor: number;
  state: "in_stock" | "limited" | "on_order";
  leadTimeDays: number | null;
}

export interface OfferTotalsView {
  subtotalMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
}

interface Quote {
  lines: Array<FrozenLine & { quantityTicks: string }>;
  offers: RateOffer[];
  selected: RateOffer;
  totals: OrderTotals;
  taxRateBps: number;
  destination: { countyName: string; localityName: string };
}

export interface OfferPreview {
  lines: FrozenLine[];
  offers: RateOffer[];
  selected: RateOffer | null;
  totals: OfferTotalsView | null;
  taxRateBps: number;
  destination: { countyName: string; localityName: string };
  cardAvailable: boolean;
  blocked: { code: string; message: string } | null;
}

export interface CreatedOffer {
  offerId: string;
  number: string;
  /** Jetonul în clar: se afișează o singură dată (și se trimite pe email); în bază stă doar amprenta. */
  token: string;
  expiresAt: Date;
  totals: OfferTotalsView;
}

export interface PublicOffer {
  number: string;
  status: "active" | "converted";
  expiresAt: Date;
  lines: FrozenLine[];
  totalMinor: number;
  subtotalMinor: number;
  shippingMinor: number;
  taxMinor: number;
  shippingKind: "courier" | "pickup";
  delivery: {
    fullName: string;
    street: string;
    postalCode: string;
    localityName: string;
    countyName: string;
  } | null;
  /**
   * Oferta e deja comandă, iar plata ei cu cardul e încă în așteptare, în fereastra de reîncercare: pagina poate oferi
   * «Continuă plata». Doar un indicator: comanda și plata nu se expun.
   */
  canContinuePayment: boolean;
}

export interface ConvertResult {
  orderId: string;
  number: string;
  replayed: boolean;
  /** Prima tentativă de plată cu cardul (de aici pornește inițierea la furnizor). */
  paymentId: string | null;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const hashOfferToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");
const newToken = (): string => randomBytes(32).toString("base64url");

/** UUID determinist (versiunea 5) din id-ul ofertei: cheia de idempotență a comenzii rezultate. */
export function offerIdempotencyKey(offerId: string): string {
  const bytes = createHash("sha256").update(`order-offer:${offerId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const STALE_MESSAGES: Record<StaleReason, string> = {
  price: "Prețul unui produs s-a schimbat",
  shipping: "Transportul s-a schimbat",
  tax: "Cota de TVA s-a schimbat",
  stock: "Stocul nu mai acoperă oferta",
  product: "Un produs nu mai poate fi comandat",
};

interface StoredAddress {
  fullName: string;
  phone: string;
  countyCode: number;
  localityCode: number;
  street: string;
  postalCode: string;
  country: string;
  countyName: string;
  localityName: string;
}

/** Ofertele active cu termenul trecut devin «expired» (jobul din worker nu are nevoie de coș sau de checkout). Idempotent. */
export async function expireDueOffers(db: Db, now: Date): Promise<number> {
  const due = await db.orderOffer.findMany({
    where: { status: "active", expiresAt: { lte: now } },
    select: { id: true },
  });
  let expired = 0;
  for (const { id } of due) {
    await inTx(db, async (tx) => {
      const changed = await tx.orderOffer.updateMany({
        where: { id, status: "active", expiresAt: { lte: now } },
        data: { status: "expired" },
      });
      if (changed.count !== 1) return;
      expired += 1;
      await tx.orderOfferEvent.create({
        data: { offerId: id, type: "offer.expired", message: "Oferta a expirat" },
      });
    });
  }
  return expired;
}

export class OfferService {
  private readonly now: () => Date;
  private readonly makeToken: () => string;

  constructor(private readonly deps: OfferServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.makeToken = deps.generateToken ?? newToken;
  }

  // ------------------------------------------------------------------------------------------------- calcul (coș temporar)

  /** Un coș temporar cu liniile date, șters la final (nu rămâne nimic în bază). */
  private async withCart<T>(
    lines: ReadonlyArray<{ variantId: string; quantity: string }>,
    fn: (owner: CartOwner) => Promise<T>,
  ): Promise<T> {
    let owner: CartOwner = { kind: "guest", token: null };
    try {
      for (const line of lines) {
        const mutation = await this.deps.cart.add(owner, {
          variantId: line.variantId,
          quantity: parseQuantity(line.quantity, { maxDecimals: 4 }),
        });
        if (mutation.newToken) owner = { kind: "guest", token: mutation.newToken };
      }
      return await fn(owner);
    } finally {
      if (owner.token) await this.deps.cart.clearAfterOrder(owner);
    }
  }

  private checkLines(lines: ReadonlyArray<{ variantId: string; quantity: string }>): void {
    if (lines.length === 0) {
      throw new OfferError("OFFER_INVALID", "Oferta trebuie să aibă cel puțin un produs");
    }
    const seen = new Set<string>();
    for (const line of lines) {
      if (seen.has(line.variantId)) {
        throw new OfferError(
          "OFFER_INVALID",
          "Același produs apare de două ori: unește cantitățile",
        );
      }
      seen.add(line.variantId);
    }
  }

  private async evaluate(
    owner: CartOwner,
    input: {
      destination: { countyCode: number; localityCode: number; postalCode: string };
      shippingOfferCode: string | null;
      vatId: string | null;
    },
  ) {
    return this.deps.checkout.preview({
      owner,
      destination: input.destination,
      offerCode: input.shippingOfferCode,
      paymentMethod: "card",
      vatId: input.vatId,
    });
  }

  /** Calculul strict (la creare și la conversie): orice problemă e o eroare cu motiv; `use` rulează cât coșul temporar există. */
  private async strictQuote<T>(
    draft: {
      lines: ReadonlyArray<{ variantId: string; quantity: string }>;
      destination: { countyCode: number; localityCode: number; postalCode: string };
      shippingOfferCode: string;
      vatId: string | null;
    },
    use: (quote: Quote, owner: CartOwner) => Promise<T>,
  ): Promise<T> {
    return this.withCart(draft.lines, async (owner) => {
      const preview = await this.evaluate(owner, draft);
      if (preview.blocked) {
        if (preview.blocked.code === "ORDER_DIGITAL_NOT_SUPPORTED") {
          throw new OfferError(
            "OFFER_DIGITAL_NOT_SUPPORTED",
            "Produsele digitale nu se pot include într-o ofertă de plată.",
          );
        }
        throw new OfferError("OFFER_NOT_PAYABLE", preview.blocked.message, { reason: "product" });
      }
      const selected = preview.selectedOffer;
      if (!selected || !preview.totals || !preview.destination) {
        throw new OfferError(
          "OFFER_NOT_PAYABLE",
          "Metoda de livrare aleasă nu mai este disponibilă",
          { reason: "shipping" },
        );
      }
      if (!preview.methods?.some((method) => method.method === "card" && method.available)) {
        throw new OfferError(
          "OFFER_CARD_UNAVAILABLE",
          "Plata cu cardul nu este disponibilă: oferta se plătește doar cu cardul.",
        );
      }
      const lines = preview.view.lines.map((line) => {
        const pricing = line.pricing;
        if (!pricing || line.state === "unavailable") {
          throw new OfferError("OFFER_NOT_PAYABLE", "Un produs nu mai poate fi comandat", {
            reason: "product",
          });
        }
        return {
          variantId: line.variantId,
          sku: line.sku,
          title: line.productTitle,
          variantTitle: line.variantLabel,
          quantityTicks: line.quantityTicks,
          quantity: formatQuantity(quantityFromTicks(BigInt(line.quantityTicks))),
          unitSymbol: line.unit.symbol,
          unitPriceMinor: pricing.unitPriceMinor,
          lineTotalMinor: pricing.totalMinor,
          vatMinor: pricing.vatMinor,
          state: line.state,
          leadTimeDays: line.state === "on_order" ? (line.leadTimeDays ?? 0) : null,
        };
      });
      const quote: Quote = {
        lines,
        offers: preview.shipping?.offers ?? [],
        selected,
        totals: preview.totals,
        taxRateBps: preview.taxRateBps,
        destination: preview.destination,
      };
      return use(quote, owner);
    });
  }

  /** Previzualizarea pentru ecranul de creare: nu scrie nimic și nu refuză la metoda de livrare lipsă (o arată ca opțiuni). */
  async preview(input: {
    lines: ReadonlyArray<{ variantId: string; quantity: string }>;
    destination: { countyCode: number; localityCode: number; postalCode: string };
    shippingOfferCode?: string | null;
    vatId?: string | null;
  }): Promise<OfferPreview> {
    this.checkLines(input.lines);
    return this.withCart(input.lines, async (owner) => {
      const preview = await this.evaluate(owner, {
        destination: input.destination,
        shippingOfferCode: input.shippingOfferCode ?? null,
        vatId: input.vatId ?? null,
      });
      const lines: FrozenLine[] = preview.view.lines.flatMap((line) => {
        const pricing = line.pricing;
        if (!pricing || line.state === "unavailable") return [];
        return [
          {
            variantId: line.variantId,
            sku: line.sku,
            title: line.productTitle,
            variantTitle: line.variantLabel,
            quantity: formatQuantity(quantityFromTicks(BigInt(line.quantityTicks))),
            unitSymbol: line.unit.symbol,
            unitPriceMinor: pricing.unitPriceMinor,
            lineTotalMinor: pricing.totalMinor,
            vatMinor: pricing.vatMinor,
            state: line.state,
            leadTimeDays: line.state === "on_order" ? (line.leadTimeDays ?? 0) : null,
          },
        ];
      });
      const totals = preview.totals;
      return {
        lines,
        offers: preview.shipping?.offers ?? [],
        selected: preview.selectedOffer,
        totals: totals
          ? {
              subtotalMinor: totals.subtotalMinor,
              shippingMinor: totals.shippingMinor,
              taxMinor: totals.taxMinor,
              totalMinor: totals.totalMinor,
            }
          : null,
        taxRateBps: preview.taxRateBps,
        destination: preview.destination ?? { countyName: "", localityName: "" },
        cardAvailable:
          preview.methods?.some((method) => method.method === "card" && method.available) ?? false,
        blocked: preview.blocked,
      };
    });
  }

  // -------------------------------------------------------------------------------------------------------------- creare

  async create(rawDraft: OfferDraftInput, actor: OfferActor): Promise<CreatedOffer> {
    const parsed = offerDraftSchema.safeParse(rawDraft);
    if (!parsed.success) {
      throw new ValidationError("Datele ofertei nu sunt valide", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    const draft: OfferDraft = parsed.data;
    this.checkLines(draft.lines);
    const settings = await this.deps.readSettings();
    const quote = await this.strictQuote(
      {
        lines: draft.lines,
        destination: {
          countyCode: draft.shipping.countyCode,
          localityCode: draft.shipping.localityCode,
          postalCode: draft.shipping.postalCode,
        },
        shippingOfferCode: draft.shippingOfferCode,
        vatId: draft.company?.vatId ?? null,
      },
      async (fresh) => fresh,
    );

    const now = this.now();
    const token = this.makeToken();
    const expiresAt = new Date(now.getTime() + settings.validityHours * 3_600_000);
    const shipping: StoredAddress = {
      ...draft.shipping,
      countyName: quote.destination.countyName,
      localityName: quote.destination.localityName,
    };
    const created = await inTx(this.deps.db, async (tx) => {
      const number = await this.allocateNumber(tx, settings.numberPrefix);
      const offer = await tx.orderOffer.create({
        select: { id: true },
        data: {
          number,
          tokenHash: hashOfferToken(token),
          expiresAt,
          creatorId: actor.id,
          creatorLabel: actor.label,
          email: draft.email,
          phone: draft.phone,
          shipping: shipping as unknown as Prisma.InputJsonValue,
          ...(draft.billing.sameAsShipping
            ? {}
            : { billing: draft.billing.address as unknown as Prisma.InputJsonValue }),
          ...(draft.company ? { company: draft.company as unknown as Prisma.InputJsonValue } : {}),
          shippingOfferCode: quote.selected.code,
          shippingKind: quote.selected.kind === "pickup" ? "pickup" : "courier",
          subtotalMinor: quote.totals.subtotalMinor,
          shippingMinor: quote.totals.shippingMinor,
          taxMinor: quote.totals.taxMinor,
          totalMinor: quote.totals.totalMinor,
          taxRateBps: quote.taxRateBps,
          lines: {
            create: quote.lines.map((line, position) => ({
              variantId: line.variantId,
              sku: line.sku,
              title: line.title,
              variantTitle: line.variantTitle,
              quantity: BigInt(line.quantityTicks),
              unitSymbol: line.unitSymbol,
              unitPriceMinor: line.unitPriceMinor,
              lineTotalMinor: line.lineTotalMinor,
              vatMinor: line.vatMinor,
              state: line.state,
              leadTimeDays: line.leadTimeDays,
              position,
            })),
          },
        },
      });
      await this.event(tx, offer.id, "offer.created", "Oferta a fost creată", actor.label, {
        totalMinor: quote.totals.totalMinor,
        lines: quote.lines.length,
      });
      return { offerId: offer.id, number };
    });
    return {
      ...created,
      token,
      expiresAt,
      totals: {
        subtotalMinor: quote.totals.subtotalMinor,
        shippingMinor: quote.totals.shippingMinor,
        taxMinor: quote.totals.taxMinor,
        totalMinor: quote.totals.totalMinor,
      },
    };
  }

  private async allocateNumber(tx: Db, prefix: string): Promise<string> {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO order_offer_counter (id, "lastValue", "updatedAt") VALUES ('offer', 0, now())
      ON CONFLICT (id) DO NOTHING`);
    const [row] = await tx.$queryRaw<Array<{ lastValue: number }>>(Prisma.sql`
      UPDATE order_offer_counter SET "lastValue" = "lastValue" + 1, "updatedAt" = now()
      WHERE id = 'offer' RETURNING "lastValue"`);
    if (!row) throw new Error("Contorul ofertelor nu a putut fi incrementat");
    return `${prefix}${String(row.lastValue).padStart(4, "0")}`;
  }

  private async event(
    tx: Db,
    offerId: string,
    type: string,
    message: string,
    actorLabel: string | null,
    data?: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.orderOfferEvent.create({
      data: {
        offerId,
        type,
        message,
        ...(actorLabel ? { actorLabel } : {}),
        ...(data !== undefined ? { data } : {}),
      },
    });
  }

  // ---------------------------------------------------------------------------------------------------------- citire publică

  private async findByToken(token: string) {
    if (!TOKEN_PATTERN.test(token)) return null;
    return this.deps.db.orderOffer.findUnique({
      where: { tokenHash: hashOfferToken(token) },
      include: { lines: { orderBy: { position: "asc" } } },
    });
  }

  /** Vederea pentru client; `null` pentru orice jeton care nu poate fi folosit (necunoscut, expirat, anulat, «stale»). */
  async publicView(token: string): Promise<PublicOffer | null> {
    const offer = await this.findByToken(token);
    if (!offer) return null;
    const usable =
      offer.status === "converted" ||
      (offer.status === "active" && offer.expiresAt.getTime() > this.now().getTime());
    if (!usable) return null;
    const address = offer.shipping as unknown as StoredAddress;
    const canContinuePayment = (await this.continuableOrderId(offer)) !== null;
    return {
      canContinuePayment,
      number: offer.number,
      status: offer.status === "converted" ? "converted" : "active",
      expiresAt: offer.expiresAt,
      lines: offer.lines.map((line) => this.lineView(line)),
      subtotalMinor: offer.subtotalMinor,
      shippingMinor: offer.shippingMinor,
      taxMinor: offer.taxMinor,
      totalMinor: offer.totalMinor,
      shippingKind: offer.shippingKind === "pickup" ? "pickup" : "courier",
      delivery:
        offer.shippingKind === "pickup"
          ? null
          : {
              fullName: address.fullName,
              street: address.street,
              postalCode: address.postalCode,
              localityName: address.localityName,
              countyName: address.countyName,
            },
    };
  }

  /**
   * Comanda în care oferta s-a transformat, DOAR dacă plata ei cu cardul se mai poate continua: oferta `converted`, comanda cu card
   * în așteptare (nici plătită, nici anulată), în fereastra de reîncercare fixată la plasare din `payment.cardRetryHours`
   * (`paymentRetryDeadlineAt`, aceeași regulă ca în `CardPaymentService`), fără plată confirmată și fără o plată care cere atenție.
   */
  private async continuableOrderId(offer: {
    status: string;
    convertedOrderId: string | null;
  }): Promise<string | null> {
    if (offer.status !== "converted" || !offer.convertedOrderId) return null;
    const order = await this.deps.db.order.findUnique({
      where: { id: offer.convertedOrderId },
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        paymentMethod: true,
        paymentRetryDeadlineAt: true,
        payments: {
          select: { status: true, attentionReason: true, attentionResolvedAt: true },
        },
      },
    });
    if (
      !order ||
      order.paymentMethod !== "card" ||
      order.status !== "pending" ||
      order.paymentStatus !== "pending" ||
      !order.paymentRetryDeadlineAt ||
      order.paymentRetryDeadlineAt.getTime() <= this.now().getTime()
    ) {
      return null;
    }
    const blocked = order.payments.some(
      (payment) =>
        payment.status === "paid" ||
        payment.status === "refunded" ||
        (payment.attentionReason !== null && payment.attentionResolvedAt === null),
    );
    return blocked ? null : order.id;
  }

  /**
   * Continuarea plății dintr-un link de ofertă deja convertită: întoarce comanda ei doar dacă plata se mai poate continua
   * (vezi `continuableOrderId`); pentru orice altceva (jeton necunoscut, ofertă activă, plătită, anulată, fereastră trecută)
   * întoarce `null`, fără a spune de ce. Apelantul emite jetonul «reîncearcă plata» din Faza 10; aici nu se creează nimic.
   */
  async paymentContinuation(token: string): Promise<{ orderId: string } | null> {
    const offer = await this.findByToken(token);
    if (!offer) return null;
    const orderId = await this.continuableOrderId(offer);
    return orderId ? { orderId } : null;
  }

  private lineView(line: {
    variantId: string | null;
    sku: string;
    title: string;
    variantTitle: string | null;
    quantity: bigint;
    unitSymbol: string;
    unitPriceMinor: number;
    lineTotalMinor: number;
    vatMinor: number;
    state: string;
    leadTimeDays: number | null;
  }): FrozenLine {
    return {
      variantId: line.variantId,
      sku: line.sku,
      title: line.title,
      variantTitle: line.variantTitle,
      quantity: formatQuantity(quantityFromTicks(line.quantity)),
      unitSymbol: line.unitSymbol,
      unitPriceMinor: line.unitPriceMinor,
      lineTotalMinor: line.lineTotalMinor,
      vatMinor: line.vatMinor,
      state: line.state === "limited" || line.state === "on_order" ? line.state : "in_stock",
      leadTimeDays: line.leadTimeDays,
    };
  }

  // ------------------------------------------------------------------------------------------------------------ conversie

  async convert(token: string, rawConsent: unknown): Promise<ConvertResult> {
    const offer = await this.findByToken(token);
    if (!offer) throw new OfferError("OFFER_UNAVAILABLE", UNAVAILABLE_MESSAGE);

    const consent = consentSchema.safeParse(rawConsent);
    if (!consent.success) {
      throw new ValidationError("Bifează acceptarea Termenilor și condițiilor pentru a plăti", {
        field: "consent",
      });
    }
    if (consent.data.version !== CHECKOUT_TERMS_CONSENT.version) {
      throw new ValidationError("Textul acordului s-a schimbat: citește-l din nou și bifează", {
        field: "consent",
      });
    }

    if (offer.status === "converted" && offer.convertedOrderId) {
      return this.existingResult(offer.convertedOrderId);
    }
    if (offer.status === "stale") {
      throw new OfferError("OFFER_STALE", UNAVAILABLE_MESSAGE);
    }
    if (offer.status !== "active" || offer.expiresAt.getTime() <= this.now().getTime()) {
      throw new OfferError("OFFER_UNAVAILABLE", UNAVAILABLE_MESSAGE);
    }

    const address = offer.shipping as unknown as StoredAddress;
    const company = offer.company as z.infer<typeof companyInputSchema> | null;
    const billing = offer.billing as z.infer<typeof addressInputSchema> | null;
    const lines = offer.lines.map((line) => ({
      variantId: line.variantId ?? "",
      quantity: formatQuantity(quantityFromTicks(line.quantity), { maxDecimals: 4 }),
    }));
    if (lines.some((line) => line.variantId === "")) {
      throw await this.markStale(offer.id, "product");
    }

    try {
      return await this.strictQuote(
        {
          lines,
          destination: {
            countyCode: address.countyCode,
            localityCode: address.localityCode,
            postalCode: address.postalCode,
          },
          shippingOfferCode: offer.shippingOfferCode,
          vatId: company?.vatId ?? null,
        },
        async (fresh, owner) => {
          const reason = this.staleReason(offer, fresh);
          if (reason) throw await this.markStale(offer.id, reason);
          const result = await this.placeOrder(offer, owner, {
            address,
            billing,
            company,
            consentVersion: consent.data.version,
          });
          return this.finalize(offer.id, offer.number, result);
        },
      );
    } catch (error) {
      if (error instanceof OfferError) {
        if (error.code === "OFFER_NOT_PAYABLE") {
          const reason = (error.details as { reason?: StaleReason } | undefined)?.reason;
          throw await this.markStale(offer.id, reason ?? "product");
        }
        throw error;
      }
      if (error instanceof CartError) {
        throw await this.markStale(
          offer.id,
          error.rejection.reason === "unavailable" ||
            error.rejection.reason === "exceeds_available" ||
            error.rejection.reason === "exceeds_limit"
            ? "stock"
            : "product",
        );
      }
      throw error;
    }
  }

  /** Comparația cu ce a văzut clientul: întoarce primul motiv pentru care oferta nu mai e valabilă, sau `null`. */
  private staleReason(
    offer: {
      lines: Array<{
        variantId: string | null;
        quantity: bigint;
        unitPriceMinor: number;
        lineTotalMinor: number;
        vatMinor: number;
        state: string;
        leadTimeDays: number | null;
      }>;
      taxRateBps: number;
      shippingMinor: number;
      shippingKind: string;
      taxMinor: number;
      totalMinor: number;
    },
    quote: Quote,
  ): StaleReason | null {
    if (quote.lines.length !== offer.lines.length) return "product";
    const fresh = new Map(quote.lines.map((line) => [line.variantId, line]));
    for (const frozen of offer.lines) {
      const now = frozen.variantId ? fresh.get(frozen.variantId) : undefined;
      if (!now || BigInt(now.quantityTicks) !== frozen.quantity) return "product";
      if (
        now.unitPriceMinor !== frozen.unitPriceMinor ||
        now.lineTotalMinor !== frozen.lineTotalMinor
      ) {
        return "price";
      }
      if (now.vatMinor !== frozen.vatMinor) return "tax";
      if (now.state !== frozen.state || now.leadTimeDays !== frozen.leadTimeDays) return "stock";
    }
    if (quote.taxRateBps !== offer.taxRateBps) return "tax";
    const kind = quote.selected.kind === "pickup" ? "pickup" : "courier";
    if (quote.totals.shippingMinor !== offer.shippingMinor || kind !== offer.shippingKind) {
      return "shipping";
    }
    if (quote.totals.taxMinor !== offer.taxMinor) return "tax";
    if (quote.totals.totalMinor !== offer.totalMinor) return "price";
    return null;
  }

  private async placeOrder(
    offer: {
      id: string;
      email: string;
      phone: string;
      shippingOfferCode: string;
      totalMinor: number;
    },
    owner: CartOwner,
    data: {
      address: StoredAddress;
      billing: z.infer<typeof addressInputSchema> | null;
      company: z.infer<typeof companyInputSchema> | null;
      consentVersion: string;
    },
  ) {
    try {
      return await this.deps.checkout.place(owner, {
        idempotencyKey: offerIdempotencyKey(offer.id),
        expectedTotalMinor: offer.totalMinor,
        contact: { email: offer.email, phone: offer.phone },
        shipping: {
          fullName: data.address.fullName,
          phone: data.address.phone,
          countyCode: data.address.countyCode,
          localityCode: data.address.localityCode,
          street: data.address.street,
          postalCode: data.address.postalCode,
          country: data.address.country,
        },
        billing: data.billing
          ? { sameAsShipping: false, address: data.billing }
          : { sameAsShipping: true },
        company: data.company,
        shippingOfferCode: offer.shippingOfferCode,
        paymentMethod: "card",
        consent: { accepted: true, version: data.consentVersion },
      });
    } catch (error) {
      if (error instanceof OrderError) {
        if (error.code === "ORDER_CARD_UNAVAILABLE") {
          throw new OfferError(
            "OFFER_CARD_UNAVAILABLE",
            "Plata cu cardul nu este disponibilă: oferta se plătește doar cu cardul.",
          );
        }
        if (error.code === "ORDER_TOTAL_CHANGED" || error.code === "ORDER_CART_CHANGED") {
          throw await this.markStale(offer.id, "price");
        }
        if (error.code === "ORDER_OFFER_UNAVAILABLE") {
          throw await this.markStale(offer.id, "shipping");
        }
      }
      if (error instanceof DomainError && error.code === "STOCK_INSUFFICIENT") {
        throw await this.markStale(offer.id, "stock");
      }
      throw error;
    }
  }

  /** Leagă oferta de comanda plasată; dacă o altă cerere a legat-o deja, rămâne cea dintâi (aceeași comandă, prin cheia derivată). */
  private async finalize(
    offerId: string,
    offerNumber: string,
    placed: { orderId: string; number: string; replayed: boolean; paymentId: string | null },
  ): Promise<ConvertResult> {
    const now = this.now();
    await inTx(this.deps.db, async (tx) => {
      // adevărul învinge: dacă între timp oferta a fost anulată sau a expirat, comanda există deja și oferta o oglindește
      const linked = await tx.orderOffer.updateMany({
        where: { id: offerId, convertedOrderId: null },
        data: { status: "converted", convertedOrderId: placed.orderId, convertedAt: now },
      });
      if (linked.count === 1) {
        await this.event(
          tx,
          offerId,
          "offer.converted",
          "Oferta a fost plătită și a devenit comandă",
          null,
          {
            orderNumber: placed.number,
          },
        );
        await addOrderEvent(tx, placed.orderId, {
          type: "order.from_offer",
          message: `Comandă creată din oferta ${offerNumber}`,
          data: { offerNumber },
        });
      }
    });
    return { ...placed };
  }

  private async existingResult(orderId: string): Promise<ConvertResult> {
    const order = await this.deps.db.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { id: true, number: true, paymentMethod: true },
    });
    const payment = await this.deps.db.payment.findFirst({
      where: { orderId },
      orderBy: { attemptNo: "asc" },
      select: { id: true },
    });
    return {
      orderId: order.id,
      number: order.number,
      replayed: true,
      paymentId: order.paymentMethod === "card" ? (payment?.id ?? null) : null,
    };
  }

  /** Marchează oferta «stale» (o singură dată, cu notificare) și întoarce eroarea de aruncat. */
  private async markStale(offerId: string, reason: StaleReason): Promise<OfferError> {
    const now = this.now();
    await inTx(this.deps.db, async (tx) => {
      const changed = await tx.orderOffer.updateMany({
        where: { id: offerId, status: "active" },
        data: { status: "stale", staleReason: reason, staleAt: now },
      });
      if (changed.count !== 1) return;
      const offer = await tx.orderOffer.findUniqueOrThrow({
        where: { id: offerId },
        select: { number: true },
      });
      await this.event(tx, offerId, "offer.stale", STALE_MESSAGES[reason], null, { reason });
      await notifyAdmins(tx, {
        kind: "offer_stale",
        title: "O ofertă nu mai poate fi plătită",
        context: offerContext(offer.number, STALE_MESSAGES[reason]),
        href: `/admin/comenzi/oferte/${offerId}`,
        permission: "orders.offers",
        dedupKey: `offer_stale:${offerId}`,
      });
    });
    return new OfferError("OFFER_STALE", UNAVAILABLE_MESSAGE);
  }

  // ------------------------------------------------------------------------------------------------------- ciclul de viață

  async cancel(offerId: string, actor: OfferActor): Promise<void> {
    const now = this.now();
    await inTx(this.deps.db, async (tx) => {
      const changed = await tx.orderOffer.updateMany({
        where: { id: offerId, status: "active" },
        data: { status: "cancelled", cancelledAt: now },
      });
      if (changed.count !== 1) await this.rejectState(tx, offerId, "poate fi anulată");
      await this.event(tx, offerId, "offer.cancelled", "Oferta a fost anulată", actor.label);
    });
  }

  private async rejectState(tx: Db, offerId: string, what: string): Promise<never> {
    const exists = await tx.orderOffer.findUnique({
      where: { id: offerId },
      select: { status: true },
    });
    if (!exists) throw new OfferError("OFFER_NOT_FOUND", "Oferta nu există");
    throw new OfferError(
      "OFFER_STATE_INVALID",
      `Oferta nu ${what}: starea ei este «${exists.status}»`,
      {
        status: exists.status,
      },
    );
  }

  /**
   * Jeton nou (cel vechi nu mai merge); valabilitatea ofertei NU se prelungește. Doar pentru o ofertă activă.
   *
   * `firstSendOnly` (butonul «Trimite linkul», când linkul nu a plecat încă pe email): jetonul nou se emite DOAR dacă oferta nu a
   * fost trimisă niciodată, iar în aceeași instrucțiune SQL trimiterea e «revendicată» (`lastSentAt`): două cereri simultane nu pot
   * emite două jetoane (emailul primului ar ajunge cu un link deja invalidat). Dacă emailul nu poate fi pus în coadă, apelantul
   * eliberează revendicarea cu `releaseFirstSend`.
   */
  async reissueToken(
    offerId: string,
    actor: OfferActor,
    options: { firstSendOnly?: boolean } = {},
  ): Promise<{ token: string; expiresAt: Date; claimedAt: Date }> {
    const now = this.now();
    const token = this.makeToken();
    const first = options.firstSendOnly === true;
    const expiresAt = await inTx(this.deps.db, async (tx) => {
      const changed = await tx.orderOffer.updateMany({
        where: {
          id: offerId,
          status: "active",
          expiresAt: { gt: now },
          ...(first ? { lastSentAt: null } : {}),
        },
        data: { tokenHash: hashOfferToken(token), ...(first ? { lastSentAt: now } : {}) },
      });
      if (changed.count !== 1) {
        await this.rejectState(
          tx,
          offerId,
          first ? "mai poate fi trimisă pentru prima dată" : "mai poate fi retrimisă",
        );
      }
      await this.event(
        tx,
        offerId,
        first ? "offer.link_issued" : "offer.link_reissued",
        first
          ? "Link generat pentru prima trimitere (cel din creare nu mai merge)"
          : "Link nou generat (cel vechi nu mai merge)",
        actor.label,
      );
      const row = await tx.orderOffer.findUniqueOrThrow({
        where: { id: offerId },
        select: { expiresAt: true },
      });
      return row.expiresAt;
    });
    return { token, expiresAt, claimedAt: now };
  }

  /** Eliberează revendicarea primei trimiteri (emailul n-a putut fi pus în coadă); nu atinge o trimitere făcută între timp. */
  async releaseFirstSend(offerId: string, claimedAt: Date): Promise<void> {
    await this.deps.db.orderOffer.updateMany({
      where: { id: offerId, status: "active", lastSentAt: claimedAt },
      data: { lastSentAt: null },
    });
  }

  /** Notează că linkul a fost pus la trimis pe email (fără adresă și fără jeton în jurnal). */
  async recordSend(offerId: string, actor: OfferActor): Promise<void> {
    const now = this.now();
    await inTx(this.deps.db, async (tx) => {
      await tx.orderOffer.update({ where: { id: offerId }, data: { lastSentAt: now } });
      await this.event(
        tx,
        offerId,
        "offer.link_queued",
        "Linkul a fost pus la trimis pe email",
        actor.label,
      );
    });
  }

  /** Jobul de expirare: ofertele active cu termenul trecut devin «expired». Idempotent. */
  async expireDue(): Promise<number> {
    return expireDueOffers(this.deps.db, this.now());
  }

  // ---------------------------------------------------------------------------------------------------------------- duplică

  /** «Duplică» din comandă: liniile, contactul și adresa comenzii, ca schiță pentru o ofertă nouă (prețurile se calculează acum). */
  async draftFromOrder(orderId: string): Promise<OfferDraft> {
    const order = await this.deps.db.order.findUnique({
      where: { id: orderId },
      select: {
        email: true,
        phone: true,
        shippingMethodCode: true,
        lines: { orderBy: { id: "asc" }, select: { variantId: true, quantity: true } },
        addresses: true,
      },
    });
    if (!order) throw new OrderError("ORDER_NOT_FOUND", "Comanda nu există", { orderId });
    if (order.lines.length === 0 || order.lines.some((line) => !line.variantId)) {
      throw new OfferError("OFFER_INVALID", "Un produs din comandă nu mai există în catalog");
    }
    const shipping = order.addresses.find((a) => a.kind === "shipping");
    const billing = order.addresses.find((a) => a.kind === "billing");
    if (!shipping) throw new OfferError("OFFER_INVALID", "Comanda nu are adresă de livrare");
    // adresa comenzii ține codurile SIRUTA; formularul de ofertă lucrează cu numărul județului (ca la checkout)
    const localities = await this.deps.db.sirutaUnit.findMany({
      where: { code: { in: order.addresses.map((address) => address.localitySirutaCode) } },
      select: { code: true, countyCode: true },
    });
    const countyOf = new Map(localities.map((unit) => [unit.code, unit.countyCode]));
    const toAddress = (a: typeof shipping) => ({
      fullName: a.fullName,
      phone: a.phone,
      countyCode: countyOf.get(a.localitySirutaCode) ?? a.countySirutaCode,
      localityCode: a.localitySirutaCode,
      street: a.street,
      postalCode: a.postalCode,
      country: a.country,
    });
    const shippingAddress = toAddress(shipping);
    const billingAddress = billing ? toAddress(billing) : null;
    const same =
      !billingAddress ||
      JSON.stringify({ ...billingAddress, fullName: "" }) ===
        JSON.stringify({ ...shippingAddress, fullName: "" });
    return {
      email: order.email,
      phone: order.phone,
      shipping: shippingAddress,
      billing:
        same || !billingAddress
          ? { sameAsShipping: true }
          : { sameAsShipping: false, address: billingAddress },
      company:
        billing?.vatId && billing.company
          ? {
              name: billing.company,
              vatId: billing.vatId,
              ...(billing.tradeRegisterNo ? { tradeRegisterNo: billing.tradeRegisterNo } : {}),
            }
          : null,
      shippingOfferCode: order.shippingMethodCode ?? "",
      lines: order.lines.map((line) => ({
        variantId: line.variantId as string,
        quantity: formatQuantity(quantityFromTicks(line.quantity)),
      })),
    };
  }
}

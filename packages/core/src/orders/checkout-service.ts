import { Prisma } from "@ecom/db";
import {
  DomainError,
  ValidationError,
  assertOrderQuantity,
  localDateTime,
  percentToBasisPoints,
  pluralRo,
  quantityFromTicks,
} from "@ecom/shared";
import type { CartOwner, CartService, CartView, CartLineView } from "../cart/cart-service";
import { inTx, type Db } from "../db-tx";
import { orderGroupSnapshot } from "../customers/group-rules";
import {
  NO_GROUP_PRICING,
  loadCustomerPricing,
  type CustomerPricing,
} from "../pricing/customer-pricing";
import { consentSnapshot } from "../digital/digital-rules";
import { readDigitalSettings } from "../digital/digital-settings";
import { reservationExpiresAt } from "../inventory/workdays";
import { ORDER_REF_TYPE } from "../inventory/constants";
import { StockService } from "../inventory/stock-service";
import { GeoService } from "../geo/siruta-store";
import { lockAccount, readBalance, redeemPoints, spendableBalance } from "../loyalty/ledger";
import { readLoyaltySettings, type LoyaltySettings } from "../loyalty/loyalty-settings";
import { earnedPoints, maxRedeemablePoints } from "../pricing/points";
import { buildParcel } from "../shipping/parcels";
import type { ShippingQuote, ShippingService } from "../shipping/shipping-service";
import type { Parcel, RateOffer, ShippingClass } from "../shipping/types";
import { CHECKOUT_TERMS_CONSENT } from "./consent";
import { placeOrderInputSchema, type AddressInput, type PlaceOrderInput } from "./checkout-input";
import { verifyCuiForCheckout, type CuiLookupPort } from "./cui-verification";
import { OrderError } from "./order-errors";
import { allocateOrderNumber } from "./order-number";
import { addOrderEvent, transitionOrder } from "./order-service";
import { computeOrderTotals, type OrderTotals } from "./order-totals";
import {
  assertPaymentMethodAllowed,
  availablePaymentMethods,
  isCompanyBuyer,
  type PaymentMethod,
  type PaymentMethodAvailability,
} from "./payment-rules";

/**
 * Checkout-ul (Faza 9): previzualizarea pentru interfață (livrare, metode de plată, totaluri) și plasarea comenzii, ATOMICĂ.
 *
 * Totalul comenzii vine DOAR din `CartService` (motorul de prețuri) + oferta de livrare: nimic nu se recalculează în altă parte.
 * Plasarea are două etape: A (fără tranzacție: validări, apeluri externe — tarife de livrare, ANAF —, totalul) și B (O SINGURĂ
 * tranzacție: blocarea coșului, verificarea că nu s-a schimbat, numărul de comandă, comanda cu liniile și adresele, stocul,
 * plata, evenimentele, golirea coșului). Orice eroare din B anulează TOT, inclusiv numărul de comandă (fără goluri).
 * Cheia de idempotență (dublu-click) e serializată cu un lock consultativ; o a doua cerere cu aceeași cheie întoarce comanda
 * existentă, fără alte efecte. Checkout-ul e doar pentru oaspete (`customerId` gol), cu ramburs sau transfer bancar.
 */

export interface CheckoutSettings {
  /** `tax.standardRate`, în procente. */
  taxStandardRate: number;
  allowedCountries: readonly string[];
  timeZone: string;
  nonWorkingDates: readonly string[];
  reservationMinutes: number;
  transferReservationWorkdays: number;
  orderNumberPrefix: string;
  orderNumberDigits: number;
  codMaxIndividualMinor: number;
  codMaxCompanyMinor: number;
  /** IBAN-ul magazinului e completat: fără el transferul bancar nu se poate oferi. */
  bankDetailsConfigured: boolean;
  guestCheckoutEnabled: boolean;
  /** Furnizorul activ al butonului «Card online» (Faza 10); `null` = cardul nu se oferă. */
  cardProvider: { code: "netopia" | "euplatesc" | "demo"; mode: "test" | "live" | "demo" } | null;
  /** Fereastra de reîncercare a plății cu cardul, în ore (`payment.cardRetryHours`). */
  cardRetryHours: number;
}

export interface CheckoutDeps {
  /** Clientul bazei (sau o tranzacție, în teste). */
  db: Db;
  createCart: (db: Db) => CartService;
  shipping: ShippingService;
  cui: CuiLookupPort;
  readSettings: () => Promise<CheckoutSettings>;
  now?: () => Date;
  /** Depozitul din care se ia stocul; implicit depozitul implicit (testele cu date proprii îl dau explicit). */
  warehouseId?: string;
}

export interface CheckoutDestinationInput {
  countyCode: number;
  localityCode: number;
  postalCode: string;
}

export interface CheckoutPreviewInput {
  owner: CartOwner;
  destination: CheckoutDestinationInput | null;
  offerCode?: string | null;
  paymentMethod?: PaymentMethod | null;
  /** Facturare pe firmă (CUI scris de client); doar pentru regula «persoană juridică» a limitei de ramburs. */
  vatId?: string | null;
  /** Punctele pe care clientul vrea să le folosească; se taie la maximul permis. */
  loyaltyPoints?: number;
}

/** Ce arată checkout-ul despre puncte (Faza 15b); prezent doar cu programul de loialitate activ. */
export interface CheckoutLoyaltyPreview {
  signedIn: boolean;
  /** Grupul cumpărătorului acumulează puncte (Partenerii nu). */
  earns: boolean;
  balance: number;
  /** Ce se poate folosi la comanda de față; `null` = punctele nu se pot folosi acum (oaspete, tratament TVA nesetat, sold mic). */
  redeem: { maxPoints: number; minPoints: number; pointValueMinor: number } | null;
  appliedPoints: number;
  /** Punctele pe care le-ar aduce comanda, cu punctele folosite scăzute (la oaspete: ce ar primi cu un cont). */
  earnEstimate: number;
}

export interface CheckoutPreview {
  view: CartView;
  /** Motivul pentru care coșul nu poate trece la plasare, sau `null`. */
  blocked: { code: string; message: string } | null;
  destination: { countyName: string; localityName: string } | null;
  shipping: ShippingQuote | null;
  selectedOffer: RateOffer | null;
  methods: PaymentMethodAvailability[] | null;
  totals: OrderTotals | null;
  taxRateBps: number;
  /**
   * Faza 14c: coșul are produse digitale (`present`) sau DOAR produse digitale (`only`: fără pas de livrare, fără adresă de
   * livrare, fără ramburs). Interfața ascunde livrarea și cere bifa legală după aceste indicatoare.
   */
  digital?: { present: boolean; only: boolean };
  /** Punctele de loialitate (Faza 15b); lipsește cât timp programul e oprit. */
  loyalty?: CheckoutLoyaltyPreview;
}

export interface PlaceOrderResult {
  orderId: string;
  number: string;
  /** Comanda exista deja pentru această cheie de idempotență (dublu-click, reîncercare). */
  replayed: boolean;
  /** Card: prima tentativă de plată (de aici pleacă inițierea la furnizor, în afara tranzacției); altfel `null`. */
  paymentId: string | null;
}

interface ParcelSource {
  variantId: string;
  productId: string;
  sku: string;
  isDigital: boolean;
  shippingClass: ShippingClass;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
}

const isShippingClass = (value: string): value is ShippingClass =>
  value === "standard" || value === "oversized" || value === "pallet";

/** Greutatea, dimensiunile, clasa de transport și tipul fiecărei variante din coș (datele de transport; fără date de achiziție). */
async function loadParcelSources(
  db: Db,
  variantIds: readonly string[],
): Promise<Map<string, ParcelSource>> {
  const rows = await db.productVariant.findMany({
    where: { id: { in: [...variantIds] } },
    select: {
      id: true,
      sku: true,
      weightGrams: true,
      lengthMm: true,
      widthMm: true,
      heightMm: true,
      product: { select: { id: true, type: true, shippingClass: true } },
    },
  });
  return new Map(
    rows.map((row) => [
      row.id,
      {
        variantId: row.id,
        productId: row.product.id,
        sku: row.sku,
        isDigital: row.product.type === "digital",
        shippingClass: isShippingClass(row.product.shippingClass)
          ? row.product.shippingClass
          : "standard",
        weightGrams: row.weightGrams,
        lengthMm: row.lengthMm,
        widthMm: row.widthMm,
        heightMm: row.heightMm,
      },
    ]),
  );
}

/** Amprenta coșului: dacă se schimbă între etapele A și B (sau între previzualizare și plasare), comanda nu se plasează. */
export function viewSignature(view: CartView): string {
  return JSON.stringify({
    lines: view.lines.map((line) => [
      line.variantId,
      line.quantityTicks,
      line.state,
      line.leadTimeDays,
      line.pricing?.unitPriceMinor ?? null,
      line.pricing?.totalMinor ?? null,
      line.pricing?.vatMinor ?? null,
    ]),
    totals: [view.totals.totalMinor, view.totals.vatMinor],
  });
}

const localDay = (instant: Date, timeZone: string): string => {
  const l = localDateTime(instant, timeZone);
  return `${l.year}-${String(l.month).padStart(2, "0")}-${String(l.day).padStart(2, "0")}`;
};

type PhysicalState = "in_stock" | "limited" | "on_order";

interface Context {
  settings: CheckoutSettings;
  view: CartView;
  sources: Map<string, ParcelSource>;
  parcels: Parcel[];
  taxRateBps: number;
  /** Cel puțin o linie digitală (Faza 14c). */
  hasDigital: boolean;
  /** TOATE liniile sunt digitale: fără livrare, fără transport, fără ramburs. */
  digitalOnly: boolean;
  /** Contul cumpărătorului (doar când coșul are linii digitale și proprietarul e un utilizator autentificat). */
  account: { userId: string; emailVerified: boolean } | null;
  /** Grupul de clienți al cumpărătorului (Faza 15): prețurile coșului îl includ deja; aici doar pentru regulile de plată. */
  pricing: CustomerPricing;
  /** Punctele de loialitate (Faza 15b). */
  loyalty: LoyaltySettings;
  /** Soldul și punctele care se pot cheltui acum (0 la oaspete sau cu programul oprit). */
  points: { balance: number; spendable: number };
}

/** Fără transport și fără taxă de ramburs: valorile coșului 100% digital (nu există ofertă de curier). */
const NO_SHIPPING = { priceMinor: 0, codFeeMinor: 0 } as const;

/** Codul metodei de livrare a unei comenzi 100% digitale; nu există curier, ofertă sau adresă de livrare. */
const DIGITAL_SHIPPING_CODE = "digital";
const DIGITAL_SHIPPING_SNAPSHOT = {
  code: DIGITAL_SHIPPING_CODE,
  kind: "digital",
  carrier: null,
  service: null,
  priceMinor: 0,
  estimatedDays: null,
  codFeeMinor: 0,
  source: "digital",
  demo: false,
  freeShipping: false,
} as const;

export class CheckoutService {
  private readonly now: () => Date;

  constructor(private readonly deps: CheckoutDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------------------------------------------------ context

  private async context(owner: CartOwner): Promise<Context> {
    const settings = await this.deps.readSettings();
    const view = await this.deps.createCart(this.deps.db).view(owner);
    const sources = await loadParcelSources(
      this.deps.db,
      view.lines.map((line) => line.variantId),
    );
    const parcels = view.lines.flatMap((line) => {
      const source = sources.get(line.variantId);
      if (!source || source.isDigital) return [];
      return [
        buildParcel({
          variantId: line.variantId,
          sku: line.sku,
          shippingClass: source.shippingClass,
          quantity: quantityFromTicks(BigInt(line.quantityTicks)),
          weightGrams: source.weightGrams,
          lengthMm: source.lengthMm,
          widthMm: source.widthMm,
          heightMm: source.heightMm,
        }),
      ];
    });
    const digitalFlags = view.lines.map((line) => sources.get(line.variantId)?.isDigital === true);
    const hasDigital = digitalFlags.some(Boolean);
    const pricing =
      owner.kind === "user"
        ? await loadCustomerPricing(this.deps.db, owner.userId)
        : NO_GROUP_PRICING;
    let account: Context["account"] = null;
    if (hasDigital && owner.kind === "user") {
      const user = await this.deps.db.user.findUnique({
        where: { id: owner.userId },
        select: { id: true, emailVerified: true },
      });
      account = user ? { userId: user.id, emailVerified: user.emailVerified } : null;
    }
    const loyalty = await readLoyaltySettings(this.deps.db);
    const points =
      loyalty.active && owner.kind === "user"
        ? {
            balance: await readBalance(this.deps.db, owner.userId),
            spendable: await spendableBalance(this.deps.db, owner.userId, this.now()),
          }
        : { balance: 0, spendable: 0 };
    return {
      loyalty,
      points,
      settings,
      view,
      sources,
      parcels,
      taxRateBps: percentToBasisPoints(settings.taxStandardRate),
      hasDigital,
      digitalOnly: hasDigital && digitalFlags.every(Boolean),
      account,
      pricing,
    };
  }

  /** Motivul pentru care coșul nu poate fi plasat ca comandă (verificat și la afișare, și la plasare). */
  private blockReason(ctx: Context): { code: string; message: string } | null {
    // comenzile cu produse digitale sunt mereu pe cont verificat: setarea «comenzi fără cont» nu le privește
    if (!ctx.settings.guestCheckoutEnabled && !ctx.hasDigital) {
      return {
        code: "ORDER_GUEST_CHECKOUT_DISABLED",
        message: "Comenzile fără cont nu sunt activate în acest magazin.",
      };
    }
    if (ctx.hasDigital) {
      if (!ctx.account) {
        return {
          code: "ORDER_LOGIN_REQUIRED",
          message:
            "Pentru produsele digitale ai nevoie de un cont. Autentifică-te sau creează un cont; coșul se păstrează.",
        };
      }
      if (!ctx.account.emailVerified) {
        return {
          code: "ORDER_EMAIL_NOT_VERIFIED",
          message: "Verifică adresa de email a contului ca să poți comanda produse digitale.",
        };
      }
      // maxim o bucată pe linie digitală (regula e și în coș; aici e verificată din nou, la afișare și la plasare)
      for (const line of ctx.view.lines) {
        if (
          ctx.sources.get(line.variantId)?.isDigital &&
          BigInt(line.quantityTicks) > BigInt(line.stepTicks)
        ) {
          return {
            code: "ORDER_DIGITAL_QUANTITY",
            message: "Un produs digital se cumpără o singură dată: păstrează o bucată în coș.",
          };
        }
      }
    }
    if (!ctx.view.canCheckout) {
      return {
        code: "ORDER_CART_NOT_READY",
        message: "Coșul are produse care cer o decizie: revino în coș și verifică-le.",
      };
    }
    for (const line of ctx.view.lines) {
      try {
        assertOrderQuantity(quantityFromTicks(BigInt(line.quantityTicks)), {
          step: quantityFromTicks(BigInt(line.stepTicks)),
          minSteps: line.minSteps,
        });
      } catch {
        return {
          code: "ORDER_QUANTITY_INVALID",
          message: "Cantitatea unui produs nu este un multiplu valid al pasului de vânzare.",
        };
      }
    }
    return null;
  }

  /** Liniile FIZICE ale coșului (pentru transport și pragul de transport gratuit); cele digitale nu intră niciodată aici. */
  private physicalLines(ctx: Context): Array<{ productId: string; shippingClass: ShippingClass }> {
    return ctx.view.lines.flatMap((line) => {
      const source = ctx.sources.get(line.variantId);
      return source && !source.isDigital
        ? [{ productId: source.productId, shippingClass: source.shippingClass }]
        : [];
    });
  }

  /**
   * Valoarea produselor FIZICE, pentru pragul de transport gratuit (Faza 14c): liniile digitale nu o influențează. Fără linii
   * digitale e chiar totalul coșului (aceeași valoare ca înainte); cu ele, suma totalurilor liniilor fizice (rotunjite pe linie).
   */
  private physicalSubtotalMinor(ctx: Context): number {
    if (!ctx.hasDigital) return ctx.view.totals.totalMinor;
    return ctx.view.lines.reduce(
      (sum, line) =>
        ctx.sources.get(line.variantId)?.isDigital ? sum : sum + (line.pricing?.totalMinor ?? 0),
      0,
    );
  }

  private async destinationOf(ctx: Context, input: CheckoutDestinationInput) {
    const geo = new GeoService(this.deps.db);
    const names = await geo.resolveLocation(input.countyCode, input.localityCode);
    return {
      county: { code: input.countyCode, name: names.countyName },
      locality: { code: input.localityCode, name: names.localityName },
      postalCode: input.postalCode,
      ctx,
    };
  }

  private stateOf(line: CartLineView): PhysicalState {
    // linia nu poate fi «unavailable» aici: coșul cu o astfel de linie nu are `canCheckout`
    return line.state === "unavailable"
      ? "on_order"
      : line.state === "limited"
        ? "limited"
        : line.state;
  }

  // ------------------------------------------------------------------------------------------------------------ puncte

  /** Câte puncte se pot folosi la comanda cu transportul dat (0 dacă nu se pot folosi deloc). */
  private redeemLimit(ctx: Context, owner: CartOwner, shippingMinor: number): number {
    if (!ctx.loyalty.redeemAvailable || owner.kind !== "user") return 0;
    return maxRedeemablePoints({
      productsMinor: ctx.view.totals.totalMinor,
      shippingMinor,
      balancePoints: ctx.points.spendable,
      rules: {
        pointValueMinor: ctx.loyalty.pointValue,
        minCashMinor: ctx.loyalty.minCashAmount,
        maxRedeemPercent: ctx.loyalty.maxRedeemPercent,
        minRedeemPoints: ctx.loyalty.minRedeemPoints,
      },
    });
  }

  /** Coșul cu reducerea din puncte pusă de motorul de prețuri pe linii; fără puncte, coșul neschimbat. */
  private async withPoints(ctx: Context, db: Db, owner: CartOwner, points: number) {
    if (points === 0) return ctx.view;
    return this.deps
      .createCart(db)
      .view(owner, { pointsDiscountMinor: points * ctx.loyalty.pointValue });
  }

  /** Linia contează la acumulare: produsele la promoție pot fi excluse din setări. */
  private earnEligible(ctx: Context, line: CartLineView): boolean {
    return ctx.loyalty.earnOnDiscountedItems || line.pricing?.onSale !== true;
  }

  /** Punctele aduse de banii plătiți pe liniile care contează, fără transport și fără partea plătită cu puncte. */
  private earnOf(ctx: Context, view: CartView): number {
    const cash = view.lines.reduce(
      (sum, line) =>
        line.pricing && this.earnEligible(ctx, line)
          ? sum + line.pricing.totalMinor - (line.pricing.pointsDiscountMinor ?? 0)
          : sum,
      0,
    );
    return earnedPoints(cash, ctx.loyalty.earnRate);
  }

  private loyaltyPreview(
    ctx: Context,
    owner: CartOwner,
    view: CartView,
    maxPoints: number,
    appliedPoints: number,
  ): { loyalty?: CheckoutLoyaltyPreview } {
    if (!ctx.loyalty.active) return {};
    const earns = ctx.pricing.record?.earnsLoyaltyPoints ?? true;
    return {
      loyalty: {
        signedIn: owner.kind === "user",
        earns,
        balance: ctx.points.balance,
        redeem:
          maxPoints > 0
            ? {
                maxPoints,
                minPoints: ctx.loyalty.minRedeemPoints,
                pointValueMinor: ctx.loyalty.pointValue,
              }
            : null,
        appliedPoints,
        earnEstimate: earns ? this.earnOf(ctx, view) : 0,
      },
    };
  }

  /** Punctele cerute, tăiate la ce se permite: peste maxim = maximul; sub minimul de folosit = niciunul. */
  private clampPoints(ctx: Context, requested: number | undefined, maxPoints: number): number {
    if (!requested || !Number.isSafeInteger(requested) || requested < 0) return 0;
    const points = Math.min(requested, maxPoints);
    return points < ctx.loyalty.minRedeemPoints ? 0 : points;
  }

  private methodsFor(
    ctx: Context,
    offer: { priceMinor: number; codFeeMinor: number },
    isCompany: boolean,
    pointsDiscountMinor = 0,
  ): PaymentMethodAvailability[] {
    // limita de ramburs se compară cu ce încasează curierul: DUPĂ reducerea din puncte (decizia 2026-11-25)
    const payable =
      ctx.view.totals.totalMinor - pointsDiscountMinor + offer.priceMinor + offer.codFeeMinor;
    const methods = availablePaymentMethods({
      lines: ctx.view.lines.map((line) => ({ stockState: this.stateOf(line) })),
      payableOnDeliveryMinor: payable,
      isCompany,
      codMaxIndividualMinor: ctx.settings.codMaxIndividualMinor,
      codMaxCompanyMinor: ctx.settings.codMaxCompanyMinor,
      cardAvailable: ctx.settings.cardProvider !== null,
      ...(ctx.digitalOnly ? { digitalOnly: true } : {}),
    });
    return methods;
  }

  // ------------------------------------------------------------------------------------------------------- previzualizare

  async preview(input: CheckoutPreviewInput): Promise<CheckoutPreview> {
    const ctx = await this.context(input.owner);
    const blocked = this.blockReason(ctx);
    const empty = {
      view: ctx.view,
      blocked,
      destination: null,
      shipping: null,
      selectedOffer: null,
      methods: null,
      totals: null,
      taxRateBps: ctx.taxRateBps,
      digital: { present: ctx.hasDigital, only: ctx.digitalOnly },
      ...this.loyaltyPreview(ctx, input.owner, ctx.view, 0, 0),
    } satisfies CheckoutPreview;
    if (blocked) return empty;

    // coș 100% digital: nu există destinație, tarife de livrare sau ofertă; totalul e al produselor, fără transport și fără ramburs
    if (ctx.digitalOnly) {
      const isCompany = isCompanyBuyer({
        vatId: input.vatId ?? null,
        groupPricingType: ctx.pricing.record?.pricingType ?? "none",
      });
      const maxPoints = this.redeemLimit(ctx, input.owner, NO_SHIPPING.priceMinor);
      const applied = this.clampPoints(ctx, input.loyaltyPoints, maxPoints);
      const priced = await this.withPoints(ctx, this.deps.db, input.owner, applied);
      return {
        ...empty,
        ...this.loyaltyPreview(ctx, input.owner, priced, maxPoints, applied),
        methods: this.methodsFor(
          ctx,
          NO_SHIPPING,
          isCompany,
          priced.totals.pointsDiscountMinor ?? 0,
        ),
        totals: input.paymentMethod
          ? computeOrderTotals({
              cart: priced.totals,
              shippingMinor: NO_SHIPPING.priceMinor,
              codFeeMinor: NO_SHIPPING.codFeeMinor,
              paymentMethod: input.paymentMethod,
              taxRateBps: ctx.taxRateBps,
            })
          : null,
      };
    }
    if (!input.destination) return empty;

    const destination = await this.destinationOf(ctx, input.destination);
    const shipping = await this.deps.shipping.quote({
      parcels: ctx.parcels,
      lines: this.physicalLines(ctx),
      subtotalMinor: this.physicalSubtotalMinor(ctx),
      destination: {
        county: destination.county,
        locality: destination.locality,
        postalCode: destination.postalCode,
      },
    });
    const selected = input.offerCode
      ? (shipping.offers.find((offer) => offer.code === input.offerCode) ?? null)
      : null;
    const reference = selected ?? shipping.offers[0] ?? null;
    const isCompany = isCompanyBuyer({
      vatId: input.vatId ?? null,
      groupPricingType: ctx.pricing.record?.pricingType ?? "none",
    });
    const maxPoints = reference ? this.redeemLimit(ctx, input.owner, reference.priceMinor) : 0;
    const applied = this.clampPoints(ctx, input.loyaltyPoints, maxPoints);
    const priced = await this.withPoints(ctx, this.deps.db, input.owner, applied);
    const methods = reference
      ? this.methodsFor(ctx, reference, isCompany, priced.totals.pointsDiscountMinor ?? 0)
      : null;
    const totals =
      selected && input.paymentMethod
        ? computeOrderTotals({
            cart: priced.totals,
            shippingMinor: selected.priceMinor,
            codFeeMinor: selected.codFeeMinor,
            paymentMethod: input.paymentMethod,
            taxRateBps: ctx.taxRateBps,
          })
        : null;
    return {
      ...empty,
      ...this.loyaltyPreview(ctx, input.owner, priced, maxPoints, applied),
      destination: { countyName: destination.county.name, localityName: destination.locality.name },
      shipping,
      selectedOffer: selected,
      methods,
      totals,
    };
  }

  // ------------------------------------------------------------------------------------------------------------ plasare

  async place(owner: CartOwner, rawInput: unknown): Promise<PlaceOrderResult> {
    const parsed = placeOrderInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ValidationError("Datele comenzii nu sunt valide", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    const input = parsed.data;
    if (input.consent.version !== CHECKOUT_TERMS_CONSENT.version) {
      throw new ValidationError("Textul acordului s-a schimbat: citește-l din nou și bifează", {
        field: "consent",
      });
    }

    const early = await this.findByKey(input.idempotencyKey);
    if (early) return early;

    const prepared = await this.prepare(owner, input);
    try {
      return await this.commit(owner, input, prepared);
    } catch (error) {
      // O cerere simultană cu aceeași cheie poate fi câștigat: dacă există deja comanda, întoarcem comanda ei.
      const winner = await this.findByKey(input.idempotencyKey).catch(() => null);
      if (winner) return winner;
      throw error;
    }
  }

  private async findByKey(key: string): Promise<PlaceOrderResult | null> {
    const found = await this.deps.db.order.findUnique({
      where: { idempotencyKey: key },
      select: { id: true, number: true, paymentMethod: true },
    });
    if (!found) return null;
    return {
      orderId: found.id,
      number: found.number,
      replayed: true,
      paymentId: await this.firstCardPaymentId(this.deps.db, found.id, found.paymentMethod),
    };
  }

  private async firstCardPaymentId(
    db: Db,
    orderId: string,
    method: string,
  ): Promise<string | null> {
    if (method !== "card") return null;
    const payment = await db.payment.findFirst({
      where: { orderId },
      orderBy: { attemptNo: "asc" },
      select: { id: true },
    });
    return payment?.id ?? null;
  }

  /** Etapa A: validări și calcule fără tranzacție (aici sunt apelurile externe: tarife de livrare, ANAF). */
  private async prepare(owner: CartOwner, input: PlaceOrderInput) {
    const ctx = await this.context(owner);
    const blocked = this.blockReason(ctx);
    if (blocked) throw new OrderError(blocked.code as never, blocked.message);

    const { settings } = ctx;

    // bifa legală (Faza 14c): separată de Termeni, obligatorie pe server când coșul are linii digitale; textul vine de pe server
    let digitalConsent: ReturnType<typeof consentSnapshot> | null = null;
    if (ctx.hasDigital) {
      const snapshot = consentSnapshot((await readDigitalSettings(this.deps.db)).consentText);
      if (
        input.digitalConsent?.accepted !== true ||
        input.digitalConsent.version !== snapshot.version
      ) {
        throw new OrderError(
          "ORDER_DIGITAL_CONSENT_REQUIRED",
          "Bifează solicitarea de livrare imediată a conținutului digital (și renunțarea la dreptul de retragere) ca să poți comanda.",
          { field: "digitalConsent" },
        );
      }
      digitalConsent = snapshot;
    }

    // adresa de livrare: doar la comenzile cu linii fizice (coșul 100% digital nu are livrare, doar facturare)
    let shippingInput: AddressInput | null = null;
    let shippingOfferCode: string | null = null;
    if (ctx.digitalOnly) {
      // fără livrare, facturarea nu poate fi «aceeași cu livrarea»; adresa și oferta de livrare trimise se ignoră
      if (input.billing.sameAsShipping) {
        throw new ValidationError("Datele comenzii nu sunt valide", {
          issues: [
            { path: "billing", message: "Adresa de facturare e obligatorie: nu există livrare" },
          ],
        });
      }
    } else {
      if (!input.shipping || !input.shippingOfferCode) {
        throw new ValidationError("Datele comenzii nu sunt valide", {
          issues: [
            ...(input.shipping
              ? []
              : [{ path: "shipping", message: "Adresa de livrare lipsește" }]),
            ...(input.shippingOfferCode
              ? []
              : [{ path: "shippingOfferCode", message: "Alege metoda de livrare" }]),
          ],
        });
      }
      shippingInput = input.shipping;
      shippingOfferCode = input.shippingOfferCode;
    }
    const billingAddress = input.billing.sameAsShipping ? shippingInput : input.billing.address;
    if (!billingAddress) {
      throw new ValidationError("Datele comenzii nu sunt valide", {
        issues: [{ path: "billing", message: "Adresa de facturare lipsește" }],
      });
    }
    for (const country of [shippingInput?.country, billingAddress.country]) {
      if (country !== undefined && !settings.allowedCountries.includes(country)) {
        throw new OrderError(
          "ORDER_COUNTRY_NOT_ALLOWED",
          "Vindem doar în țările permise de magazin; adresa aleasă nu este permisă.",
          { country },
        );
      }
    }

    const geo = new GeoService(this.deps.db);
    const shippingNames = shippingInput
      ? await geo.resolveLocation(shippingInput.countyCode, shippingInput.localityCode)
      : null;
    const billingNames =
      input.billing.sameAsShipping && shippingNames
        ? shippingNames
        : await geo.resolveLocation(billingAddress.countyCode, billingAddress.localityCode);

    const now = this.now();
    let company: {
      name: string;
      vatId: string;
      verification: "verified" | "unverified";
      tradeRegisterNo: string | null;
    } | null = null;
    if (input.company) {
      const checked = await verifyCuiForCheckout(
        input.company.vatId,
        this.deps.cui,
        localDay(now, settings.timeZone),
      );
      if (!checked.ok) {
        throw new OrderError("ORDER_CUI_INVALID", "CUI-ul nu este valid", {
          reason: checked.reason,
        });
      }
      company = {
        name: input.company.name,
        vatId: checked.digits,
        verification: checked.verification,
        tradeRegisterNo:
          input.company.tradeRegisterNo?.trim() || checked.company?.tradeRegisterNo || null,
      };
    }

    // coșul 100% digital nu are livrare: fără apel de tarife, fără ofertă (transport 0, fără taxă de ramburs)
    let offer: RateOffer | null = null;
    if (shippingInput && shippingNames) {
      const shipping = await this.deps.shipping.quote({
        parcels: ctx.parcels,
        lines: this.physicalLines(ctx),
        subtotalMinor: this.physicalSubtotalMinor(ctx),
        destination: {
          county: { code: shippingInput.countyCode, name: shippingNames.countyName },
          locality: { code: shippingInput.localityCode, name: shippingNames.localityName },
          postalCode: shippingInput.postalCode,
        },
      });
      offer = shipping.offers.find((candidate) => candidate.code === shippingOfferCode) ?? null;
      if (!offer) {
        throw new OrderError(
          "ORDER_OFFER_UNAVAILABLE",
          "Metoda de livrare aleasă nu mai este disponibilă",
          { offer: shippingOfferCode },
        );
      }

      // ridicarea personală e doar de la adresa magazinului: fără ea comanda nu se plasează (regulă pe server, nu doar în interfață)
      if (offer.kind === "pickup" && !offer.pickupAddress) {
        throw new OrderError(
          "ORDER_OFFER_UNAVAILABLE",
          "Ridicarea personală nu este disponibilă: magazinul nu are adresa completată",
          { offer: shippingOfferCode },
        );
      }
    }
    const charged = offer ?? NO_SHIPPING;

    // punctele: cerute de client, verificate AICI (nu se taie în tăcere), cu transportul ofertei alese
    const loyaltyPoints = input.loyaltyPoints ?? 0;
    if (loyaltyPoints > 0) {
      if (!ctx.loyalty.redeemAvailable || owner.kind !== "user") {
        throw new OrderError(
          "ORDER_POINTS_UNAVAILABLE",
          "Punctele de loialitate nu pot fi folosite la această comandă",
          { field: "loyaltyPoints" },
        );
      }
      const maxPoints = this.redeemLimit(ctx, owner, charged.priceMinor);
      if (loyaltyPoints > maxPoints || loyaltyPoints < ctx.loyalty.minRedeemPoints) {
        throw new OrderError(
          "ORDER_POINTS_INVALID",
          "Numărul de puncte ales nu mai poate fi folosit: verifică suma și confirmă din nou",
          { field: "loyaltyPoints", maxPoints, minPoints: ctx.loyalty.minRedeemPoints },
        );
      }
    }
    const priced = await this.withPoints(ctx, this.deps.db, owner, loyaltyPoints);
    const pointsDiscountMinor = priced.totals.pointsDiscountMinor ?? 0;

    const isCompany = isCompanyBuyer({
      vatId: company?.vatId ?? null,
      groupPricingType: ctx.pricing.record?.pricingType ?? "none",
    });
    assertPaymentMethodAllowed(
      {
        lines: ctx.view.lines.map((line) => ({ stockState: this.stateOf(line) })),
        payableOnDeliveryMinor:
          ctx.view.totals.totalMinor -
          pointsDiscountMinor +
          charged.priceMinor +
          charged.codFeeMinor,
        isCompany,
        codMaxIndividualMinor: settings.codMaxIndividualMinor,
        codMaxCompanyMinor: settings.codMaxCompanyMinor,
        cardAvailable: settings.cardProvider !== null,
        ...(ctx.digitalOnly ? { digitalOnly: true } : {}),
      },
      input.paymentMethod,
    );
    if (input.paymentMethod === "bank_transfer" && !settings.bankDetailsConfigured) {
      throw new OrderError(
        "ORDER_BANK_DETAILS_MISSING",
        "Transferul bancar nu este disponibil: datele bancare ale magazinului nu sunt completate",
      );
    }

    const totals = computeOrderTotals({
      cart: priced.totals,
      shippingMinor: charged.priceMinor,
      codFeeMinor: charged.codFeeMinor,
      paymentMethod: input.paymentMethod,
      taxRateBps: ctx.taxRateBps,
    });
    if (totals.totalMinor !== input.expectedTotalMinor) {
      throw new OrderError(
        "ORDER_TOTAL_CHANGED",
        "Totalul comenzii s-a schimbat față de cel afișat: verifică-l și confirmă din nou",
        { expectedMinor: input.expectedTotalMinor, actualMinor: totals.totalMinor },
      );
    }
    return {
      ctx,
      offer,
      totals,
      loyaltyPoints,
      company,
      shippingInput,
      shippingNames,
      billingNames,
      billingAddress,
      digitalConsent,
      signature: viewSignature(ctx.view),
    };
  }

  /** Etapa B: o singură tranzacție. */
  private async commit(
    owner: CartOwner,
    input: PlaceOrderInput,
    prepared: Awaited<ReturnType<CheckoutService["prepare"]>>,
  ): Promise<PlaceOrderResult> {
    const { ctx, offer, totals, company } = prepared;
    const { settings } = ctx;
    const now = this.now();

    return inTx(this.deps.db, async (tx) => {
      // dublu-click: cererile cu aceeași cheie se serializează; a doua vede comanda primei
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${input.idempotencyKey}))`,
      );
      const existing = await tx.order.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true, number: true, paymentMethod: true },
      });
      if (existing) {
        return {
          orderId: existing.id,
          number: existing.number,
          replayed: true,
          paymentId: await this.firstCardPaymentId(tx, existing.id, existing.paymentMethod),
        };
      }

      const cart = this.deps.createCart(tx);
      if (!(await cart.lockForCheckout(owner))) {
        throw new OrderError("ORDER_CART_NOT_READY", "Coșul este gol sau a expirat");
      }
      const view = await cart.view(owner);
      if (!view.canCheckout || viewSignature(view) !== prepared.signature) {
        throw new OrderError(
          "ORDER_CART_CHANGED",
          "Coșul s-a schimbat în timp ce plasai comanda: verifică-l și confirmă din nou",
        );
      }

      // punctele: contul se blochează ÎNAINTEA stocului (aceeași ordine ca la anulare: comandă, cont, stoc), apoi reducerea se
      // repartizează pe liniile coșului verificat mai sus
      const { loyaltyPoints } = prepared;
      const buyerId = owner.kind === "user" ? owner.userId : null;
      if (loyaltyPoints > 0 && buyerId) await lockAccount(tx, buyerId);
      const priced = await this.withPoints(ctx, tx, owner, loyaltyPoints);
      const pricedLines = new Map(priced.lines.map((line) => [line.variantId, line.pricing]));

      const number = await allocateOrderNumber(tx, {
        prefix: settings.orderNumberPrefix,
        digits: settings.orderNumberDigits,
      });
      const channel = await tx.salesChannel.findUnique({
        where: { code: "web" },
        select: { id: true },
      });
      if (!channel)
        throw new DomainError("ORDER_CHANNEL_MISSING", "Canalul de vânzare «web» lipsește");

      // digitalul nu are stoc, rezervări sau mișcări (Faza 14c): stocul privește doar liniile fizice
      const stockViewLines = view.lines.filter(
        (line) => !ctx.sources.get(line.variantId)?.isDigital,
      );

      const isTransfer = input.paymentMethod === "bank_transfer";
      const isCard = input.paymentMethod === "card";
      const cardProvider = settings.cardProvider;
      if (isCard && !cardProvider) {
        throw new OrderError("ORDER_CARD_UNAVAILABLE", "Plata cu cardul nu este disponibilă");
      }
      // transfer: până la a N-a zi lucrătoare; card: `inventory.reservationMinutes` minute de la inițierea plății
      const reservationEnd =
        isTransfer || isCard
          ? reservationExpiresAt(isCard ? "card" : "transfer", now, {
              reservationMinutes: settings.reservationMinutes,
              transferReservationWorkdays: settings.transferReservationWorkdays,
              timeZone: settings.timeZone,
              nonWorkingDates: settings.nonWorkingDates,
            })
          : null;
      const retryDeadline = isCard
        ? new Date(now.getTime() + settings.cardRetryHours * 3_600_000)
        : null;

      // grupul clientului la plasare, ca snapshot (id, tip, procent) și avantajul calculat de motor; fără cost
      const groupPricing =
        owner.kind === "user" ? await loadCustomerPricing(tx, owner.userId) : NO_GROUP_PRICING;
      // instantaneul punctelor: doar cu programul activ și un cumpărător autentificat; partenerii nu acumulează
      const earns =
        ctx.loyalty.active && buyerId !== null && (groupPricing.record?.earnsLoyaltyPoints ?? true);
      const loyaltySnapshot =
        buyerId !== null && (earns || loyaltyPoints > 0)
          ? {
              loyaltyCustomerId: buyerId,
              ...(loyaltyPoints > 0
                ? {
                    discountMinor: totals.discountMinor ?? 0,
                    loyaltyPointsUsed: loyaltyPoints,
                    loyaltyPointValueMinor: ctx.loyalty.pointValue,
                    loyaltyVatMode: ctx.loyalty.vatMode,
                  }
                : {}),
              ...(earns
                ? {
                    loyaltyEarnRateMinor: ctx.loyalty.earnRate,
                    loyaltyPointsToEarn: this.earnOf(ctx, priced),
                  }
                : {}),
            }
          : {};
      const order = await tx.order.create({
        select: { id: true },
        data: {
          number,
          ...loyaltySnapshot,
          ...orderGroupSnapshot(groupPricing.record),
          groupAdvantageMinor: view.totals.groupAdvantageMinor,
          channelId: channel.id,
          email: input.contact.email,
          phone: input.contact.phone,
          subtotalMinor: totals.subtotalMinor,
          shippingMinor: totals.shippingMinor,
          codFeeMinor: totals.codFeeMinor,
          shippingTaxMinor: totals.shippingTaxMinor,
          codFeeTaxMinor: totals.codFeeTaxMinor,
          taxMinor: totals.taxMinor,
          totalMinor: totals.totalMinor,
          taxRateBps: ctx.taxRateBps,
          shippingMethodCode: offer ? offer.code : DIGITAL_SHIPPING_CODE,
          shippingSnapshot: offer
            ? {
                code: offer.code,
                kind: offer.kind,
                carrier: offer.carrier,
                service: offer.service,
                priceMinor: offer.priceMinor,
                estimatedDays: offer.estimatedDays,
                codFeeMinor: offer.codFeeMinor,
                source: offer.source,
                demo: offer.demo,
                freeShipping: offer.freeShipping,
                // ridicare: adresa MAGAZINULUI de la momentul comenzii (snapshot imuabil); adresa clientului nu intră aici
                ...(offer.kind === "pickup" && offer.pickupAddress
                  ? {
                      pickupAddress: {
                        street: offer.pickupAddress.street,
                        city: offer.pickupAddress.city,
                        county: offer.pickupAddress.county,
                        postalCode: offer.pickupAddress.postalCode,
                        country: offer.pickupAddress.country,
                        text: offer.pickupAddress.text,
                      },
                    }
                  : {}),
              }
            : DIGITAL_SHIPPING_SNAPSHOT,
          paymentMethod: input.paymentMethod,
          // comanda cu produse digitale e legată de contul cumpărătorului și poartă bifa legală (text, versiune, moment): ca DATE
          ...(ctx.hasDigital && ctx.account && prepared.digitalConsent
            ? {
                customerId: ctx.account.userId,
                digitalConsentAt: now,
                digitalConsentText: prepared.digitalConsent.text,
                digitalConsentVersion: prepared.digitalConsent.version,
              }
            : {}),
          ...(input.customerNote ? { customerNote: input.customerNote } : {}),
          installationRequested: input.installation.requested,
          ...(input.installation.requested
            ? { installationStatus: "requested", installationStatusAt: now }
            : {}),
          ...(input.installation.requested && input.installation.note
            ? { installationNote: input.installation.note }
            : {}),
          termsAcceptedAt: now,
          termsConsentText: CHECKOUT_TERMS_CONSENT.text,
          termsConsentVersion: CHECKOUT_TERMS_CONSENT.version,
          reservationExpiresAt: reservationEnd,
          paymentRetryDeadlineAt: retryDeadline,
          idempotencyKey: input.idempotencyKey,
          placedAt: now,
        },
      });

      const addressData = (
        kind: "shipping" | "billing",
        address: AddressInput,
        names: {
          countyName: string;
          localityName: string;
          countySirutaCode: number;
          localitySirutaCode: number;
        },
        withCompany: boolean,
      ) => ({
        orderId: order.id,
        kind,
        fullName: address.fullName,
        phone: address.phone,
        countySirutaCode: names.countySirutaCode,
        countyName: names.countyName,
        localitySirutaCode: names.localitySirutaCode,
        localityName: names.localityName,
        street: address.street,
        postalCode: address.postalCode,
        country: address.country,
        ...(withCompany && company
          ? {
              company: company.name,
              vatId: company.vatId,
              vatIdVerification: company.verification,
              ...(company.tradeRegisterNo ? { tradeRegisterNo: company.tradeRegisterNo } : {}),
            }
          : {}),
      });
      // coșul 100% digital are doar adresa de facturare
      if (prepared.shippingInput && prepared.shippingNames) {
        await tx.address.create({
          data: addressData("shipping", prepared.shippingInput, prepared.shippingNames, false),
        });
      }
      await tx.address.create({
        data: addressData("billing", prepared.billingAddress, prepared.billingNames, true),
      });

      for (const line of view.lines) {
        const source = ctx.sources.get(line.variantId);
        const pricing = line.pricing;
        if (!source || !pricing) {
          throw new OrderError("ORDER_CART_CHANGED", "Un produs din coș nu mai poate fi comandat");
        }
        const state = this.stateOf(line);
        await tx.orderLine.create({
          data: {
            orderId: order.id,
            variantId: line.variantId,
            sku: line.sku,
            title: line.productTitle,
            variantTitle: line.variantLabel,
            imageUrl: line.image?.src ?? null,
            quantity: BigInt(line.quantityTicks),
            unitSymbol: line.unit.symbol,
            unitDecimals: line.unit.decimals,
            unitPriceMinor: pricing.unitPriceMinor,
            lineTotalMinor: pricing.totalMinor,
            netMinor: pricing.netMinor,
            taxMinor: pricing.vatMinor,
            taxRateBps: pricing.taxRateBps,
            loyaltyDiscountMinor: pricedLines.get(line.variantId)?.pointsDiscountMinor ?? 0,
            loyaltyDiscountTaxMinor: pricedLines.get(line.variantId)?.pointsDiscountVatMinor ?? 0,
            loyaltyEarnEligible: this.earnEligible(ctx, line),
            stockState: state,
            leadTimeDays: state === "on_order" ? (line.leadTimeDays ?? 0) : null,
            shippingClass: source.shippingClass,
            isDigital: source.isDigital,
            // ⚠️ fără date de achiziție: instantaneul conține doar ce vede și clientul
            productSnapshot: {
              productId: line.productId,
              productSlug: line.productSlug,
              variantId: line.variantId,
              title: line.productTitle,
              variantLabel: line.variantLabel,
              sku: line.sku,
              unit: line.unit,
              basis: line.basis,
              stepLabel: line.stepLabel,
              energyClass: line.energyClass,
            },
          },
        });
      }

      // stocul: ramburs angajează direct; transferul rezervă până la termen. Fără stoc negativ (CHECK + comandă condiționată).
      const stock = new StockService({ db: tx, now: () => now });
      const ref = { refType: ORDER_REF_TYPE, refId: order.id };
      const stockLines = stockViewLines.map((line) => ({
        variantId: line.variantId,
        ...(this.deps.warehouseId ? { warehouseId: this.deps.warehouseId } : {}),
        quantity: quantityFromTicks(BigInt(line.quantityTicks)),
      }));
      if (stockLines.length > 0) {
        if ((isTransfer || isCard) && reservationEnd) {
          await stock.reserve(ref, stockLines, reservationEnd);
        } else await stock.commitDirect(ref, stockLines);
      }

      // punctele se rezervă în ACEEAȘI tranzacție cu stocul; un sold insuficient (altă comandă simultană) anulează tot
      if (loyaltyPoints > 0 && buyerId) {
        await redeemPoints(tx, {
          customerId: buyerId,
          orderId: order.id,
          points: loyaltyPoints,
          now,
        });
        await addOrderEvent(tx, order.id, {
          type: "loyalty.redeemed",
          message: `Clientul a folosit ${pluralRo(loyaltyPoints, "punct", "puncte", "de puncte")} de loialitate`,
          data: { points: loyaltyPoints, discountMinor: totals.discountMinor ?? 0 },
        });
      }

      const payment = await tx.payment.create({
        select: { id: true },
        data: {
          orderId: order.id,
          provider: isCard && cardProvider ? cardProvider.code : input.paymentMethod,
          method: input.paymentMethod,
          amountMinor: totals.totalMinor,
          ...(isCard && cardProvider
            ? {
                attemptNo: 1,
                mode: cardProvider.mode,
                idempotencyKey: `card:${order.id}:1`,
              }
            : {}),
        },
      });
      await addOrderEvent(tx, order.id, {
        type: "order.placed",
        message: "Comanda a fost plasată",
        data: {
          paymentMethod: input.paymentMethod,
          shippingOffer: offer ? offer.code : DIGITAL_SHIPPING_CODE,
          totalMinor: totals.totalMinor,
        },
      });
      if (input.paymentMethod === "cod") {
        await transitionOrder(
          tx,
          order.id,
          { status: "confirmed" },
          {
            type: "order.confirmed",
            message: "Comandă confirmată (plata se face la livrare); stocul a fost angajat",
          },
          now,
        );
      } else if (reservationEnd && stockLines.length > 0) {
        await addOrderEvent(tx, order.id, {
          type: "stock.reserved",
          message: isCard
            ? "Stoc rezervat cât se încearcă plata cu cardul"
            : "Stoc rezervat până la termenul de plată prin transfer bancar",
          data: { reservationExpiresAt: reservationEnd.toISOString() },
        });
      }

      await cart.clearAfterOrder(owner);
      return { orderId: order.id, number, replayed: false, paymentId: isCard ? payment.id : null };
    });
  }
}

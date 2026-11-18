import { Prisma } from "@ecom/db";
import {
  DomainError,
  ValidationError,
  assertOrderQuantity,
  localDateTime,
  percentToBasisPoints,
  quantityFromTicks,
} from "@ecom/shared";
import type { CartOwner, CartService, CartView, CartLineView } from "../cart/cart-service";
import { inTx, type Db } from "../db-tx";
import { reservationExpiresAt } from "../inventory/workdays";
import { ORDER_REF_TYPE } from "../inventory/constants";
import { StockService } from "../inventory/stock-service";
import { GeoService } from "../geo/siruta-store";
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
}

export interface CheckoutDeps {
  /** Clientul bazei (sau o tranzacție, în teste). */
  db: Db;
  createCart: (db: Db) => CartService;
  shipping: ShippingService;
  cui: CuiLookupPort;
  readSettings: () => Promise<CheckoutSettings>;
  now?: () => Date;
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
}

export interface PlaceOrderResult {
  orderId: string;
  number: string;
  /** Comanda exista deja pentru această cheie de idempotență (dublu-click, reîncercare). */
  replayed: boolean;
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
}

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
    return {
      settings,
      view,
      sources,
      parcels,
      taxRateBps: percentToBasisPoints(settings.taxStandardRate),
    };
  }

  /** Motivul pentru care coșul nu poate fi plasat ca comandă (verificat și la afișare, și la plasare). */
  private blockReason(ctx: Context): { code: string; message: string } | null {
    if (!ctx.settings.guestCheckoutEnabled) {
      return {
        code: "ORDER_GUEST_CHECKOUT_DISABLED",
        message: "Comenzile fără cont nu sunt activate în acest magazin.",
      };
    }
    if (!ctx.view.canCheckout) {
      return {
        code: "ORDER_CART_NOT_READY",
        message: "Coșul are produse care cer o decizie: revino în coș și verifică-le.",
      };
    }
    for (const line of ctx.view.lines) {
      if (ctx.sources.get(line.variantId)?.isDigital) {
        return {
          code: "ORDER_DIGITAL_NOT_SUPPORTED",
          message: "Produsele digitale nu se pot comanda încă.",
        };
      }
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

  private physicalLines(ctx: Context): Array<{ productId: string; shippingClass: ShippingClass }> {
    return ctx.view.lines.flatMap((line) => {
      const source = ctx.sources.get(line.variantId);
      return source ? [{ productId: source.productId, shippingClass: source.shippingClass }] : [];
    });
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

  private methodsFor(
    ctx: Context,
    offer: RateOffer,
    isCompany: boolean,
  ): PaymentMethodAvailability[] {
    const payable = ctx.view.totals.totalMinor + offer.priceMinor + offer.codFeeMinor;
    const methods = availablePaymentMethods({
      lines: ctx.view.lines.map((line) => ({ stockState: this.stateOf(line) })),
      payableOnDeliveryMinor: payable,
      isCompany,
      codMaxIndividualMinor: ctx.settings.codMaxIndividualMinor,
      codMaxCompanyMinor: ctx.settings.codMaxCompanyMinor,
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
    } satisfies CheckoutPreview;
    if (blocked || !input.destination) return empty;

    const destination = await this.destinationOf(ctx, input.destination);
    const shipping = await this.deps.shipping.quote({
      parcels: ctx.parcels,
      lines: this.physicalLines(ctx),
      subtotalMinor: ctx.view.totals.totalMinor,
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
    const isCompany = isCompanyBuyer({ vatId: input.vatId ?? null, groupPricingType: "none" });
    const methods = reference ? this.methodsFor(ctx, reference, isCompany) : null;
    const totals =
      selected && input.paymentMethod
        ? computeOrderTotals({
            cart: ctx.view.totals,
            shippingMinor: selected.priceMinor,
            codFeeMinor: selected.codFeeMinor,
            paymentMethod: input.paymentMethod,
            taxRateBps: ctx.taxRateBps,
          })
        : null;
    return {
      ...empty,
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
      select: { id: true, number: true },
    });
    return found ? { orderId: found.id, number: found.number, replayed: true } : null;
  }

  /** Etapa A: validări și calcule fără tranzacție (aici sunt apelurile externe: tarife de livrare, ANAF). */
  private async prepare(owner: CartOwner, input: PlaceOrderInput) {
    const ctx = await this.context(owner);
    const blocked = this.blockReason(ctx);
    if (blocked) throw new OrderError(blocked.code as never, blocked.message);

    const { settings } = ctx;
    const shippingCountry = input.shipping.country;
    const billingAddress = input.billing.sameAsShipping ? input.shipping : input.billing.address;
    for (const country of [shippingCountry, billingAddress.country]) {
      if (!settings.allowedCountries.includes(country)) {
        throw new OrderError(
          "ORDER_COUNTRY_NOT_ALLOWED",
          "Vindem doar în țările permise de magazin; adresa aleasă nu este permisă.",
          { country },
        );
      }
    }

    const geo = new GeoService(this.deps.db);
    const shippingNames = await geo.resolveLocation(
      input.shipping.countyCode,
      input.shipping.localityCode,
    );
    const billingNames = input.billing.sameAsShipping
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

    const shipping = await this.deps.shipping.quote({
      parcels: ctx.parcels,
      lines: this.physicalLines(ctx),
      subtotalMinor: ctx.view.totals.totalMinor,
      destination: {
        county: { code: input.shipping.countyCode, name: shippingNames.countyName },
        locality: { code: input.shipping.localityCode, name: shippingNames.localityName },
        postalCode: input.shipping.postalCode,
      },
    });
    const offer = shipping.offers.find((candidate) => candidate.code === input.shippingOfferCode);
    if (!offer) {
      throw new OrderError(
        "ORDER_OFFER_UNAVAILABLE",
        "Metoda de livrare aleasă nu mai este disponibilă",
        { offer: input.shippingOfferCode },
      );
    }

    const isCompany = isCompanyBuyer({ vatId: company?.vatId ?? null, groupPricingType: "none" });
    assertPaymentMethodAllowed(
      {
        lines: ctx.view.lines.map((line) => ({ stockState: this.stateOf(line) })),
        payableOnDeliveryMinor: ctx.view.totals.totalMinor + offer.priceMinor + offer.codFeeMinor,
        isCompany,
        codMaxIndividualMinor: settings.codMaxIndividualMinor,
        codMaxCompanyMinor: settings.codMaxCompanyMinor,
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
      cart: ctx.view.totals,
      shippingMinor: offer.priceMinor,
      codFeeMinor: offer.codFeeMinor,
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
      company,
      shippingNames,
      billingNames,
      billingAddress,
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
        select: { id: true, number: true },
      });
      if (existing) return { orderId: existing.id, number: existing.number, replayed: true };

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

      const isTransfer = input.paymentMethod === "bank_transfer";
      const reservationEnd = isTransfer
        ? reservationExpiresAt("transfer", now, {
            reservationMinutes: settings.reservationMinutes,
            transferReservationWorkdays: settings.transferReservationWorkdays,
            timeZone: settings.timeZone,
            nonWorkingDates: settings.nonWorkingDates,
          })
        : null;

      const order = await tx.order.create({
        select: { id: true },
        data: {
          number,
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
          shippingMethodCode: offer.code,
          shippingSnapshot: {
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
          },
          paymentMethod: input.paymentMethod,
          ...(input.customerNote ? { customerNote: input.customerNote } : {}),
          installationRequested: input.installation.requested,
          ...(input.installation.requested && input.installation.note
            ? { installationNote: input.installation.note }
            : {}),
          termsAcceptedAt: now,
          termsConsentText: CHECKOUT_TERMS_CONSENT.text,
          termsConsentVersion: CHECKOUT_TERMS_CONSENT.version,
          reservationExpiresAt: reservationEnd,
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
      await tx.address.create({
        data: addressData("shipping", input.shipping, prepared.shippingNames, false),
      });
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
            stockState: state,
            leadTimeDays: state === "on_order" ? (line.leadTimeDays ?? 0) : null,
            shippingClass: source.shippingClass,
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
      const stockLines = view.lines.map((line) => ({
        variantId: line.variantId,
        quantity: quantityFromTicks(BigInt(line.quantityTicks)),
      }));
      if (isTransfer && reservationEnd) await stock.reserve(ref, stockLines, reservationEnd);
      else await stock.commitDirect(ref, stockLines);

      await tx.payment.create({
        data: {
          orderId: order.id,
          provider: input.paymentMethod,
          method: input.paymentMethod,
          amountMinor: totals.totalMinor,
        },
      });
      await addOrderEvent(tx, order.id, {
        type: "order.placed",
        message: "Comanda a fost plasată",
        data: {
          paymentMethod: input.paymentMethod,
          shippingOffer: offer.code,
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
      } else if (reservationEnd) {
        await addOrderEvent(tx, order.id, {
          type: "stock.reserved",
          message: "Stoc rezervat până la termenul de plată prin transfer bancar",
          data: { reservationExpiresAt: reservationEnd.toISOString() },
        });
      }

      await cart.clearAfterOrder(owner);
      return { orderId: order.id, number, replayed: false };
    });
  }
}

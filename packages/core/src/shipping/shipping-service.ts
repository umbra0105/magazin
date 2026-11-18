import type { Db } from "../db-tx";
import { lastResortOffer } from "./demo-rates";
import { filterOffersForParcels } from "./easybox";
import { fallbackOffers, type FallbackZone } from "./fallback-tariffs";
import {
  applyFreeShipping,
  freeShippingEligibility,
  type FreeShippingEligibility,
} from "./free-shipping";
import { chargeableGramsTotal } from "./parcels";
import type { Parcel, RateOffer, RateRequest, ShippingClass, ShippingRateProvider } from "./types";

/**
 * Oferte de livrare pentru checkout. Ordinea: furnizorul de tarife (cu timp limită) → dacă eșuează, depășește timpul sau nu dă
 * nicio ofertă: tarifele pe zonă din admin → dacă nici zona județului nu are tarif: oferta DEMO de ultimă instanță. CHECKOUT-UL
 * NU SE BLOCHEAZĂ NICIODATĂ din cauza livrării. Apoi: easybox (ascuns în Faza 9; blocat de produsele oversized/pallet), pragul de
 * transport gratuit (pe clasă și pe produs) și ridicarea personală de la sediu.
 */

export interface ShippingRuntimeSettings {
  /** `checkout.freeShippingThreshold` (bani) sau `null`. */
  freeShippingThresholdMinor: number | null;
  /** `checkout.freeShippingClasses`. */
  freeShippingClasses: readonly ShippingClass[];
  /** `shipping.pickupEnabled`. */
  pickupEnabled: boolean;
  /** `shipping.easyboxEnabled` (Faza 9: oprit; fără hartă). */
  easyboxEnabled: boolean;
  /** `shipping.quoteTimeoutMs`. */
  quoteTimeoutMs: number;
}

export interface ShippingStore {
  zones(): Promise<FallbackZone[]>;
  excludedProductIds(): Promise<string[]>;
}

export interface ShippingQuoteInput {
  parcels: readonly Parcel[];
  /** Liniile fizice ale comenzii, pentru pragul de transport gratuit. */
  lines: ReadonlyArray<{ productId: string; shippingClass: ShippingClass }>;
  /** Subtotalul produselor fizice (bani, după reduceri, fără transport). */
  subtotalMinor: number;
  destination: {
    county: { code: number; name: string };
    locality: { code: number; name: string };
    postalCode: string;
  };
  /** Suma de ramburs (bani); 0 dacă plata nu e rambursul. */
  codAmountMinor?: number;
}

export interface ShippingQuote {
  offers: RateOffer[];
  /** Ofertele vin din tarifele pe zonă sau din ultima instanță, nu de la furnizor. */
  fallbackUsed: boolean;
  /** Motivul pentru care furnizorul nu a dat oferte (`timeout`, mesajul erorii, `empty`), sau `null`. */
  providerProblem: string | null;
  freeShipping: FreeShippingEligibility;
  /** Un colet nu are greutate sau dimensiuni: tariful poate fi subestimat. */
  incomplete: boolean;
}

export interface ShippingServiceDeps {
  provider: ShippingRateProvider;
  store: ShippingStore;
  readSettings: () => Promise<ShippingRuntimeSettings>;
}

const PICKUP_OFFER: RateOffer = {
  code: "pickup",
  kind: "pickup",
  carrier: "Ridicare personală",
  service: "de la sediu",
  priceMinor: 0,
  estimatedDays: 0,
  codFeeMinor: 0,
  source: "pickup",
  demo: false,
  freeShipping: false,
};

export class ShippingService {
  constructor(private readonly deps: ShippingServiceDeps) {}

  private async fromProvider(
    request: RateRequest,
    timeoutMs: number,
  ): Promise<{ offers: RateOffer[]; problem: string | null }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("timeout"));
      }, timeoutMs);
    });
    try {
      const offers = await Promise.race([
        this.deps.provider.quote(request, controller.signal),
        timeout,
      ]);
      return { offers, problem: offers.length === 0 ? "empty" : null };
    } catch (error) {
      return { offers: [], problem: error instanceof Error ? error.message : "unknown" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async quote(input: ShippingQuoteInput): Promise<ShippingQuote> {
    const settings = await this.deps.readSettings();
    const request: RateRequest = {
      parcels: input.parcels,
      county: input.destination.county,
      locality: input.destination.locality,
      postalCode: input.destination.postalCode,
      codAmountMinor: input.codAmountMinor ?? 0,
    };

    const provided = await this.fromProvider(request, settings.quoteTimeoutMs);
    let offers = provided.offers;
    let fallbackUsed = false;
    if (offers.length === 0) {
      fallbackUsed = true;
      offers = fallbackOffers({
        zones: await this.deps.store.zones(),
        countyCode: input.destination.county.code,
        chargeableGrams: chargeableGramsTotal(input.parcels),
        subtotalMinor: input.subtotalMinor,
      });
      if (offers.length === 0) offers = [lastResortOffer()];
    }

    offers = filterOffersForParcels(offers, input.parcels, {
      easyboxEnabled: settings.easyboxEnabled,
    });

    const freeShipping = freeShippingEligibility({
      thresholdMinor: settings.freeShippingThresholdMinor,
      enabledClasses: settings.freeShippingClasses,
      excludedProductIds: await this.deps.store.excludedProductIds(),
      subtotalMinor: input.subtotalMinor,
      lines: input.lines,
    });
    offers = applyFreeShipping(offers, freeShipping.eligible);

    if (settings.pickupEnabled) offers = [...offers, PICKUP_OFFER];
    offers.sort((a, b) => a.priceMinor - b.priceMinor || a.code.localeCompare(b.code));

    return {
      offers,
      fallbackUsed,
      providerProblem: provided.problem,
      freeShipping,
      incomplete: input.parcels.some((p) => p.incomplete),
    };
  }
}

/** Zonele de livrare și produsele excluse, citite din baza de date. */
export function createPrismaShippingStore(db: Db): ShippingStore {
  return {
    async zones() {
      const zones = await db.shippingZone.findMany({
        where: { isActive: true },
        orderBy: [{ position: "asc" }, { name: "asc" }],
        include: { methods: { where: { isActive: true }, orderBy: [{ position: "asc" }] } },
      });
      return zones.map((zone) => ({
        id: zone.id,
        name: zone.name,
        isActive: zone.isActive,
        countyCodes: zone.countyCodes,
        methods: zone.methods.map((method) => ({
          id: method.id,
          code: method.code,
          name: method.name,
          carrier: method.carrier,
          type: method.type as "flat" | "weight" | "pickup",
          priceMinor: method.priceMinor,
          rules: method.rules,
          freeAboveMinor: method.freeAboveMinor,
          codFeeMinor: method.codFeeMinor,
          estimatedDays: method.estimatedDays,
          isActive: method.isActive,
        })),
      }));
    },
    async excludedProductIds() {
      const rows = await db.freeShippingExclusion.findMany({ select: { productId: true } });
      return rows.map((r) => r.productId);
    },
  };
}

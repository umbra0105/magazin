import {
  IntegrationError,
  type CarrierAwbRequest,
  type CarrierAwbResult,
  type CarrierLabel,
  type CarrierPickupPoint,
  type CarrierQuote,
  type CarrierQuoteRequest,
  type CarrierShipmentRef,
  type CarrierTracking,
  type ConnectionTestResult,
  type LabelFormat,
  type ShippingCarrier,
} from "@ecom/shared";
import {
  RateRefusedError,
  type RateOffer,
  type RateRequest,
  type ShippingRateProvider,
} from "./types";

/**
 * Protecția apelurilor către curieri (Faza 12): ÎNTRERUPĂTOR DE CIRCUIT («curier picat ≠ comandă pierdută») și CACHE scurt de
 * tarife. Căderile de infrastructură (timp depășit, curier de neatins, autentificare refuzată, răspuns invalid) se numără; după
 * `threshold` căderi la rând întrerupătorul se deschide și refuză imediat (`SHIPPING_CIRCUIT_OPEN`) timp de `openMs`, apoi
 * lasă UN apel de probă. Un refuz al unei cereri (`SHIPPING_REFUSED`, `SHIPPING_REJECTED`, localitate nemapată, nesuportat) NU e
 * o cădere a curierului și nu deschide întrerupătorul. Starea e în memorie, pe proces: suficient ca să nu ținem checkout-ul
 * așteptând un curier picat; o repornire o resetează.
 */
const INFRASTRUCTURE_FAILURES: ReadonlySet<string> = new Set([
  "SHIPPING_PROVIDER_TIMEOUT",
  "SHIPPING_PROVIDER_UNREACHABLE",
  "SHIPPING_AUTH_FAILED",
  "SHIPPING_BAD_RESPONSE",
]);

export interface CircuitBreakerOptions {
  /** Căderi consecutive după care se deschide. */
  threshold: number;
  /** Cât rămâne deschis înainte de apelul de probă, în ms. */
  openMs: number;
  now?: () => number;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private probing = false;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Întrerupătorul refuză acum apelurile (deschis și fereastra nu a trecut, sau o probă e în curs). */
  isOpen(): boolean {
    if (this.openedAt === null) return false;
    return !(this.now() - this.openedAt >= this.options.openMs && !this.probing);
  }

  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.openedAt !== null) {
      if (this.isOpen()) {
        throw new IntegrationError(
          "SHIPPING_CIRCUIT_OPEN",
          "Curierul nu răspunde: apelurile sunt oprite temporar",
        );
      }
      this.probing = true; // un singur apel de probă după fereastra de așteptare
    }
    try {
      const result = await action();
      this.failures = 0;
      this.openedAt = null;
      return result;
    } catch (error) {
      const infrastructure =
        error instanceof IntegrationError && INFRASTRUCTURE_FAILURES.has(error.code);
      if (infrastructure) {
        this.failures += 1;
        if (this.openedAt !== null || this.failures >= this.options.threshold) {
          this.openedAt = this.now();
        }
      } else if (this.openedAt !== null) {
        // proba a ajuns la curier și a primit un răspuns (chiar și un refuz): curierul e în picioare
        this.failures = 0;
        this.openedAt = null;
      }
      throw error;
    } finally {
      this.probing = false;
    }
  }
}

/** Curierul înfășurat în întrerupător: fiecare apel trece prin el. */
export class GuardedCarrier implements ShippingCarrier {
  constructor(
    private readonly inner: ShippingCarrier,
    private readonly breaker: CircuitBreaker,
  ) {}

  get code(): ShippingCarrier["code"] {
    return this.inner.code;
  }
  get label(): string {
    return this.inner.label;
  }
  quote(request: CarrierQuoteRequest, signal?: AbortSignal): Promise<CarrierQuote[]> {
    return this.breaker.run(() => this.inner.quote(request, signal));
  }
  createAwb(request: CarrierAwbRequest): Promise<CarrierAwbResult> {
    return this.breaker.run(() => this.inner.createAwb(request));
  }
  getLabel(ref: CarrierShipmentRef, format: LabelFormat): Promise<CarrierLabel> {
    return this.breaker.run(() => this.inner.getLabel(ref, format));
  }
  track(ref: CarrierShipmentRef): Promise<CarrierTracking> {
    return this.breaker.run(() => this.inner.track(ref));
  }
  cancel(ref: CarrierShipmentRef): Promise<void> {
    return this.breaker.run(() => this.inner.cancel(ref));
  }
  createReturnAwb(
    parent: CarrierShipmentRef,
    request: CarrierAwbRequest,
  ): Promise<CarrierAwbResult> {
    return this.breaker.run(() => this.inner.createReturnAwb(parent, request));
  }
  listPickupPoints(filter: {
    countyName: string;
    localityName?: string;
  }): Promise<CarrierPickupPoint[]> {
    return this.breaker.run(() => this.inner.listPickupPoints(filter));
  }
  testConnection(): Promise<ConnectionTestResult> {
    return this.inner.testConnection();
  }
}

export interface CarrierRateProviderOptions {
  carrier: ShippingCarrier;
  /** Lipsă = apelurile curierului sunt deja protejate (curier înfășurat în `GuardedCarrier`). */
  breaker?: CircuitBreaker;
  /** Cât se păstrează un tarif în cache (secunde); 0 = fără cache. */
  cacheSeconds: number;
  now?: () => number;
}

const CACHE_LIMIT = 200;

/**
 * Implementarea `ShippingRateProvider` peste un curier: tarife în timp real, cu cache scurt și întrerupător. Un refuz al
 * curierului devine `RateRefusedError` (serviciul de transport oferă atunci paletizat sau rezerva pe zone); orice altă eroare
 * (cădere, localitate nemapată) se propagă, iar serviciul cade pe tarifele pe zonă.
 */
export class CarrierRateProvider implements ShippingRateProvider {
  readonly name: string;
  private readonly cache = new Map<string, { expiresAt: number; quotes: CarrierQuote[] }>();
  private readonly now: () => number;

  constructor(private readonly options: CarrierRateProviderOptions) {
    this.name = options.carrier.code;
    this.now = options.now ?? (() => Date.now());
  }

  async quote(request: RateRequest, signal: AbortSignal): Promise<RateOffer[]> {
    const carrierRequest: CarrierQuoteRequest = {
      parcels: request.parcels.map((parcel) => ({
        // se tarifează pe cea mai mare dintre greutatea reală și cea volumetrică, calculată pe LINIE (parcels.ts);
        // dimensiunile unitare nu se trimit: ar fi înmulțite greșit cu numărul de bucăți
        weightGrams: parcel.chargeableGrams,
        lengthMm: null,
        widthMm: null,
        heightMm: null,
      })),
      destination: {
        countyName: request.county.name,
        localityName: request.locality.name,
        postalCode: request.postalCode,
      },
      codAmountMinor: request.codAmountMinor,
    };
    const quotes = await this.cached(carrierRequest, signal);
    const code = this.options.carrier.code;
    return quotes.map((quote) => ({
      code: `${code}:${quote.serviceCode}`,
      kind: quote.kind,
      carrier: quote.courier,
      service: quote.service,
      priceMinor: quote.priceMinor,
      estimatedDays: quote.estimatedDays,
      codFeeMinor: quote.codFeeMinor,
      source: "provider",
      demo: code === "demo",
      freeShipping: false,
    }));
  }

  private async cached(request: CarrierQuoteRequest, signal: AbortSignal): Promise<CarrierQuote[]> {
    const ttl = this.options.cacheSeconds * 1000;
    const key = JSON.stringify(request);
    const now = this.now();
    const hit = this.cache.get(key);
    if (ttl > 0 && hit && hit.expiresAt > now) return hit.quotes;
    try {
      const call = () => this.options.carrier.quote(request, signal);
      const quotes = this.options.breaker ? await this.options.breaker.run(call) : await call();
      if (ttl > 0) {
        if (this.cache.size >= CACHE_LIMIT)
          this.cache.delete(this.cache.keys().next().value as string);
        this.cache.set(key, { expiresAt: now + ttl, quotes });
      }
      return quotes;
    } catch (error) {
      if (error instanceof IntegrationError && error.code === "SHIPPING_REFUSED") {
        throw new RateRefusedError();
      }
      throw error;
    }
  }
}

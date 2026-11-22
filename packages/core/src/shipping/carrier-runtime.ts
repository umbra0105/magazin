import type { ShippingCarrier, ShippingMode, ShippingProviderCode } from "@ecom/shared";
import { CarrierRateProvider, CircuitBreaker, GuardedCarrier } from "./carrier-guard";
import { DemoShippingRateProvider } from "./demo-rates";
import type { RateOffer, RateRequest, ShippingRateProvider } from "./types";

/**
 * Curierii în execuție (Faza 12): un singur loc care ține, pe proces, câte UN întrerupător de circuit pe curier și instanțele
 * curierilor (cu tokenul și nomenclatoarele lor în memorie), reconstruite la cel mult `instanceTtlMs` ca o schimbare de
 * credențiale să se aplice. Folosit de aplicația web (tarife la checkout, AWB, etichete) și de job (sincronizarea stării).
 */
export interface CarrierSource {
  activeCarrier(): Promise<{ code: ShippingProviderCode; mode: ShippingMode } | null>;
  getCarrier(code: string): Promise<ShippingCarrier | null>;
}

export interface CarrierRuntimeOptions {
  source: CarrierSource;
  /** `shipping.rateCacheSeconds`, citit la fiecare cerere. */
  readCacheSeconds: () => Promise<number>;
  /** Căderi la rând după care întrerupătorul se deschide (implicit 3). */
  threshold?: number;
  /** Cât rămâne deschis, în ms (implicit 60 s). */
  openMs?: number;
  /** Cât trăiește o instanță de curier, în ms (implicit 5 minute). */
  instanceTtlMs?: number;
  now?: () => number;
}

export class CarrierRuntime {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly instances = new Map<string, { carrier: ShippingCarrier; builtAt: number }>();
  private readonly providers = new Map<string, CarrierRateProvider>();
  private readonly now: () => number;

  constructor(private readonly options: CarrierRuntimeOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  private breaker(code: string): CircuitBreaker {
    let breaker = this.breakers.get(code);
    if (!breaker) {
      breaker = new CircuitBreaker({
        threshold: this.options.threshold ?? 3,
        openMs: this.options.openMs ?? 60_000,
        now: this.now,
      });
      this.breakers.set(code, breaker);
    }
    return breaker;
  }

  /** Curierul (cu întrerupător) pentru un cod, sau `null` dacă nu e configurat. */
  async carrier(code: string): Promise<ShippingCarrier | null> {
    const ttl = this.options.instanceTtlMs ?? 300_000;
    const cached = this.instances.get(code);
    if (cached && this.now() - cached.builtAt < ttl) return cached.carrier;
    const built = await this.options.source.getCarrier(code);
    if (!built) {
      this.instances.delete(code);
      this.providers.delete(code);
      return null;
    }
    const guarded = new GuardedCarrier(built, this.breaker(code));
    this.instances.set(code, { carrier: guarded, builtAt: this.now() });
    this.providers.delete(code);
    return guarded;
  }

  /** Curierul activ al magazinului (ales, activ, configurat), sau `null`. */
  async activeCarrier(): Promise<ShippingCarrier | null> {
    const active = await this.options.source.activeCarrier();
    return active ? this.carrier(active.code) : null;
  }

  /** Reconstruiește instanțele la următorul apel (după o schimbare de credențiale în acest proces). */
  invalidate(): void {
    this.instances.clear();
    this.providers.clear();
  }

  /**
   * Furnizorul de tarife pentru checkout: curierul activ (cu cache scurt și întrerupător) sau, fără curier activ, furnizorul DEMO
   * de tarife (marcat «DEMO»), ca până în Faza 12. Alegerea se face la fiecare cerere.
   */
  rateProvider(): ShippingRateProvider {
    const demo = new DemoShippingRateProvider();
    return {
      name: "runtime",
      quote: async (request: RateRequest, signal: AbortSignal): Promise<RateOffer[]> => {
        const active = await this.options.source.activeCarrier();
        if (!active) return demo.quote(request);
        const carrier = await this.carrier(active.code);
        if (!carrier) return demo.quote(request);
        let provider = this.providers.get(active.code);
        if (!provider) {
          provider = new CarrierRateProvider({
            carrier,
            cacheSeconds: await this.options.readCacheSeconds(),
            now: this.now,
          });
          this.providers.set(active.code, provider);
        }
        return provider.quote(request, signal);
      },
    };
  }
}

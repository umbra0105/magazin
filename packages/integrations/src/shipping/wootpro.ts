import {
  IntegrationError,
  type CarrierAwbRequest,
  type CarrierAwbResult,
  type CarrierLabel,
  type CarrierParcel,
  type CarrierPickupPoint,
  type CarrierQuote,
  type CarrierQuoteRequest,
  type CarrierShipmentRef,
  type CarrierTracking,
  type CarrierTrackingEvent,
  type ConnectionTestResult,
  type LabelFormat,
  type ShipmentStatus,
  type ShippingCarrier,
} from "@ecom/shared";
import {
  bytesFromBase64,
  callCarrier,
  carrierMessage,
  decimalToMinor,
  isRecord,
  minorToDecimal,
  normalizePlaceName,
  type CarrierCall,
  type FetchLike,
} from "./http";

/**
 * Adaptorul wootPRO (woot.ro), agregator de curieri. ⚠️ ÎNCĂ NETESTAT CU CONT REAL: construit după specificația publică
 * OpenAPI (`https://ws.woot.ro/latest/assets/webservice.json`, citită pe 2026-11-22) și verificat DOAR cu răspunsuri simulate
 * (teste de contract pe fixture-uri). Ce NU e confirmat în documentație și e PRESUPUS aici, de verificat în sandbox:
 *  - forma obiectului inline `receiver` (name, phone, city_id, zipcode, address) și parametrii listelor `/general/cities`,
 *    `/general/counties` (nume și structură);
 *  - motivul de anulare implicit (`reason_id` 5, «altul»);
 *  - maparea codurilor de stare dincolo de exemplele din specificație (0 anulată, 1 primită, 2 procesată, 3 ridicată, 10 livrată);
 *  - nu există AWB de retur în API (`createReturnAwb` refuză cu «nesuportat»; returul se introduce manual) și nici etichetă ZPL;
 *  - nu există taxă de ramburs în răspunsul de tarife (`codFeeMinor` = 0);
 *  - nu există webhook-uri: starea se citește prin sondare (jobul de sincronizare).
 */
export const WOOTPRO_PRODUCTION_URL = "https://ws.woot.ro/latest";
export const WOOTPRO_STAGING_URL = "https://ws.woot.ro/test";
const ROMANIA_COUNTRY_ID = 189;
const CANCEL_REASON_OTHER = 5;

export interface WootproCredentials {
  publicKey: string;
  secretKey: string;
  /** Adresa de expeditor (ridicare) din contul wootPRO, ca număr. */
  senderAddressId: string;
}

export interface WootproOptions {
  credentials: WootproCredentials;
  mode: "test" | "live";
  fetch?: FetchLike;
  now?: () => Date;
}

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const kilograms = (g: number): number => Math.max(0.001, Math.ceil(g) / 1000);
const centimeters = (mm: number | null): number => Math.max(1, Math.ceil((mm ?? 100) / 10));

function parcelBody(p: CarrierParcel): Record<string, unknown> {
  return {
    type: "package",
    weight: kilograms(p.weightGrams),
    length: centimeters(p.lengthMm),
    width: centimeters(p.widthMm),
    height: centimeters(p.heightMm),
  };
}

/** Starea normalizată din codul wootPRO (exemplele din specificație; necunoscut = în tranzit). */
export function wootproStatus(statusId: number): ShipmentStatus {
  if (statusId === 0) return "cancelled";
  if (statusId === 1 || statusId === 2) return "created";
  if (statusId === 3) return "picked_up";
  if (statusId === 10) return "delivered";
  return "in_transit";
}

export class WootproCarrier implements ShippingCarrier {
  readonly code = "wootpro" as const;
  readonly label = "wootPRO";
  private token: { value: string; expiresAt: number } | null = null;
  private counties: Map<string, number> | null = null;
  private readonly cities = new Map<string, Map<string, number>>();
  private readonly now: () => Date;

  constructor(private readonly options: WootproOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private get base(): string {
    return this.options.mode === "live" ? WOOTPRO_PRODUCTION_URL : WOOTPRO_STAGING_URL;
  }

  private async authorize(): Promise<string> {
    const cached = this.token;
    if (cached && cached.expiresAt > this.now().getTime() + 30_000) return cached.value;
    const result = await callCarrier(this.options.fetch, `${this.base}/account/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        public_key: this.options.credentials.publicKey,
        secret_key: this.options.credentials.secretKey,
      }),
    });
    const json = result.json;
    if (!result.ok || !isRecord(json) || typeof json["token"] !== "string") {
      throw new IntegrationError(
        "SHIPPING_AUTH_FAILED",
        "wootPRO a refuzat cheile (verifică cheia publică și cea secretă)",
      );
    }
    const seconds = asNumber(json["expire"]) ?? 3600;
    this.token = { value: json["token"], expiresAt: this.now().getTime() + seconds * 1000 };
    return json["token"];
  }

  private async api(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<CarrierCall> {
    const token = await this.authorize();
    const result = await callCarrier(
      this.options.fetch,
      `${this.base}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      signal,
    );
    if (result.status === 401) {
      this.token = null;
      throw new IntegrationError("SHIPPING_AUTH_FAILED", "wootPRO a refuzat autentificarea");
    }
    return result;
  }

  private fail(result: CarrierCall, fallback: string): never {
    const message = carrierMessage(result.json);
    throw new IntegrationError(
      "SHIPPING_REJECTED",
      message ? `wootPRO: ${message}` : `wootPRO: ${fallback}`,
    );
  }

  private static idMap(rows: unknown): Map<string, number> {
    const map = new Map<string, number>();
    if (!Array.isArray(rows)) return map;
    for (const row of rows as unknown[]) {
      if (!isRecord(row)) continue;
      const id = asNumber(row["id"]);
      if (id !== null) map.set(normalizePlaceName(asString(row["name"])), id);
    }
    return map;
  }

  /** Nomenclatorul de județe (nume normalizat → id), citit o singură dată pe instanță. */
  private async countyId(name: string): Promise<number> {
    if (!this.counties) {
      const result = await this.api("GET", `/general/counties?country_id=${ROMANIA_COUNTRY_ID}`);
      if (!result.ok || !Array.isArray(result.json)) {
        this.fail(result, "lista de județe nu a putut fi citită");
      }
      this.counties = WootproCarrier.idMap(result.json);
    }
    const id = this.counties.get(normalizePlaceName(name));
    if (id === undefined) {
      throw new IntegrationError(
        "SHIPPING_LOCATION_UNMAPPED",
        "Județul nu a fost găsit în nomenclatorul wootPRO",
      );
    }
    return id;
  }

  private async cityId(countyName: string, localityName: string): Promise<number> {
    const countyKey = normalizePlaceName(countyName);
    let map = this.cities.get(countyKey);
    if (!map) {
      const county = await this.countyId(countyName);
      const result = await this.api(
        "GET",
        `/general/cities?country_id=${ROMANIA_COUNTRY_ID}&county_id=${county}`,
      );
      if (!result.ok || !Array.isArray(result.json)) {
        this.fail(result, "lista de localități nu a putut fi citită");
      }
      map = WootproCarrier.idMap(result.json);
      this.cities.set(countyKey, map);
    }
    const id = map.get(normalizePlaceName(localityName));
    if (id === undefined) {
      throw new IntegrationError(
        "SHIPPING_LOCATION_UNMAPPED",
        "Localitatea nu a fost găsită în nomenclatorul wootPRO",
      );
    }
    return id;
  }

  private sender(): Record<string, unknown> {
    return { address_id: Number(this.options.credentials.senderAddressId) };
  }

  async quote(request: CarrierQuoteRequest, signal?: AbortSignal): Promise<CarrierQuote[]> {
    const cityId = await this.cityId(
      request.destination.countyName,
      request.destination.localityName,
    );
    const result = await this.api(
      "POST",
      "/orders/prices",
      {
        sender: this.sender(),
        receiver: { city_id: cityId, zipcode: request.destination.postalCode },
        parcels: request.parcels.map(parcelBody),
        ...(request.codAmountMinor > 0
          ? { repayment: minorToDecimal(request.codAmountMinor) }
          : {}),
      },
      signal,
    );
    if (!result.ok || !Array.isArray(result.json)) {
      this.fail(result, "tarifele nu au putut fi citite");
    }
    const quotes: CarrierQuote[] = [];
    let refused = 0;
    for (const row of result.json as unknown[]) {
      if (!isRecord(row)) continue;
      const errors = Array.isArray(row["errors"]) ? (row["errors"] as unknown[]) : [];
      const price = decimalToMinor(row["final_total"] ?? row["total"]);
      const id = asNumber(row["service_id"]);
      if (errors.length > 0 || price === null || id === null) {
        refused += 1;
        continue;
      }
      quotes.push({
        serviceCode: String(id),
        courier: asString(row["courier_name"]) || "Curier",
        service: asString(row["service_name"]),
        kind: asString(row["service_delivery"]) === "location" ? "easybox" : "courier",
        priceMinor: price,
        estimatedDays: null,
        codFeeMinor: 0,
      });
    }
    if (quotes.length === 0 && refused > 0) {
      throw new IntegrationError(
        "SHIPPING_REFUSED",
        "wootPRO nu oferă un serviciu pentru aceste colete",
      );
    }
    return quotes;
  }

  async createAwb(request: CarrierAwbRequest): Promise<CarrierAwbResult> {
    if (!request.serviceCode) {
      throw new IntegrationError(
        "SHIPPING_REJECTED",
        "Lipsește serviciul wootPRO ales la checkout",
      );
    }
    const cityId = await this.cityId(request.recipient.countyName, request.recipient.localityName);
    const result = await this.api("POST", "/orders", {
      service_id: Number(request.serviceCode),
      sender: this.sender(),
      receiver: {
        name: request.recipient.name,
        ...(request.recipient.company ? { company: request.recipient.company } : {}),
        phone: request.recipient.phone,
        ...(request.recipient.email ? { email: request.recipient.email } : {}),
        city_id: cityId,
        zipcode: request.recipient.postalCode,
        address: request.recipient.street,
        ...(request.pickupPointId ? { location_id: Number(request.pickupPointId) } : {}),
      },
      parcels: request.parcels.map(parcelBody),
      ...(request.codAmountMinor > 0 ? { repayment: minorToDecimal(request.codAmountMinor) } : {}),
      ...(request.declaredValueMinor > 0
        ? { insurance: minorToDecimal(request.declaredValueMinor) }
        : {}),
      payment_method: "credit",
    });
    const json = result.json;
    if (!result.ok || !isRecord(json) || json["success"] === false) {
      this.fail(result, "AWB-ul nu a putut fi creat");
    }
    const record = json as Record<string, unknown>;
    const orderId = asNumber(record["order_id"]);
    const rawAwb = record["awb_number"];
    const awb = typeof rawAwb === "number" ? String(rawAwb) : asString(rawAwb);
    if (orderId === null || awb === "") {
      throw new IntegrationError("SHIPPING_BAD_RESPONSE", "wootPRO a răspuns fără număr de AWB");
    }
    return {
      awb,
      providerRef: String(orderId),
      trackingUrl: null,
      parcelCount: request.parcels.length || 1,
    };
  }

  private orderRef(ref: CarrierShipmentRef): string {
    if (!ref.providerRef) {
      throw new IntegrationError("SHIPPING_REJECTED", "Lipsește referința comenzii wootPRO");
    }
    return encodeURIComponent(ref.providerRef);
  }

  async getLabel(ref: CarrierShipmentRef, format: LabelFormat): Promise<CarrierLabel> {
    if (format === "zpl") {
      throw new IntegrationError("SHIPPING_UNSUPPORTED", "wootPRO nu oferă etichete ZPL, doar PDF");
    }
    const result = await this.api("GET", `/orders/${this.orderRef(ref)}/awb?format=A6`);
    const json = result.json;
    if (!result.ok || !isRecord(json) || typeof json["pdf"] !== "string") {
      this.fail(result, "eticheta nu a putut fi descărcată");
    }
    return {
      format: "pdf",
      contentType: "application/pdf",
      bytes: bytesFromBase64((json as Record<string, unknown>)["pdf"] as string),
    };
  }

  async track(ref: CarrierShipmentRef): Promise<CarrierTracking> {
    const result = await this.api("GET", `/orders/${this.orderRef(ref)}/history`);
    if (!result.ok || !Array.isArray(result.json))
      this.fail(result, "istoricul nu a putut fi citit");
    const events: CarrierTrackingEvent[] = [];
    for (const row of result.json as unknown[]) {
      if (!isRecord(row)) continue;
      const statusId = asNumber(row["status_id"]);
      const at = new Date(asString(row["updated"]) || asString(row["added"]));
      if (statusId === null || Number.isNaN(at.getTime())) continue;
      events.push({
        key: asString(row["hash"]) || `id:${String(row["id"])}`,
        code: String(statusId),
        label: asString(row["comment"]) || `Stare ${statusId}`,
        occurredAt: at,
        status: wootproStatus(statusId),
      });
    }
    events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const last = events[events.length - 1];
    return { status: last ? last.status : "created", events };
  }

  async cancel(ref: CarrierShipmentRef): Promise<void> {
    const result = await this.api("DELETE", `/orders/${this.orderRef(ref)}`, {
      reason_id: CANCEL_REASON_OTHER,
    });
    if (!result.ok) this.fail(result, "AWB-ul nu a putut fi anulat");
  }

  createReturnAwb(): Promise<CarrierAwbResult> {
    return Promise.reject(
      new IntegrationError(
        "SHIPPING_UNSUPPORTED",
        "wootPRO nu oferă AWB de retur prin API: introdu returul manual",
      ),
    );
  }

  async listPickupPoints(filter: {
    countyName: string;
    localityName?: string;
  }): Promise<CarrierPickupPoint[]> {
    const county = await this.countyId(filter.countyName);
    const result = await this.api(
      "GET",
      `/general/locations?country_id=${ROMANIA_COUNTRY_ID}&county_id=${county}&receiver=1`,
    );
    if (!result.ok || !Array.isArray(result.json)) {
      this.fail(result, "punctele de ridicare nu au putut fi citite");
    }
    const wanted = filter.localityName ? normalizePlaceName(filter.localityName) : null;
    const points: CarrierPickupPoint[] = [];
    for (const row of result.json as unknown[]) {
      if (!isRecord(row)) continue;
      const id = asNumber(row["id"]);
      const city = asString(row["city"]);
      if (id === null) continue;
      if (wanted !== null && normalizePlaceName(city) !== wanted) continue;
      points.push({
        id: String(id),
        name: asString(row["name"]),
        countyName: asString(row["county"]) || filter.countyName,
        localityName: city,
        address: asString(row["address"]),
      });
    }
    return points;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      this.token = null;
      await this.authorize();
      return { ok: true, message: "Conectat la wootPRO (autentificare reușită)." };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof IntegrationError ? error.message : "wootPRO nu poate fi contactat",
      };
    }
  }
}

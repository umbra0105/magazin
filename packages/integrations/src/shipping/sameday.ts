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
 * Adaptorul Sameday direct (clienți cu contract propriu, easybox). ⚠️ ÎNCĂ NETESTAT CU CONT REAL și cu documentație oficială
 * INCOMPLETĂ: `docs.sameday.ro` nu a putut fi citit pe 2026-11-22. Citit: SDK-ul oficial PHP (`sameday-courier/php-sdk`,
 * 2.4.4): adresele de bază (producție `https://api.sameday.ro`, demo `https://sameday-api.demo.zitec.com`), autentificarea
 * (`POST /api/authenticate` cu antetele `X-AUTH-USERNAME` / `X-AUTH-PASSWORD`, răspuns `token` și `expire_at`, apoi antetul
 * `X-AUTH-TOKEN`), numele cererilor și ale câmpurilor lor. PRESUPUS din memorie (NECONFIRMAT, de verificat în demo înainte de
 * orice test real): căile `POST /api/awb`, `POST /api/awb/estimation`, `GET /api/awb/download/{awb}/{A4|A6}`,
 * `DELETE /api/awb/{awb}`, `GET /api/client/parcel/{awb}/status-history`, `GET /api/geolocation/county`,
 * `GET /api/geolocation/city`, `GET /api/client/lockers`; forma răspunsurilor (`awbNumber`, `amount`, `expeditionHistory`,
 * `statusId`, `statusLabel`, `statusDate`); corpul AWB ca formular cu chei în paranteze pătrate; maparea stărilor după eticheta
 * lor (cuvinte-cheie), pentru că lista de coduri nu a fost citită. Nu există AWB de retur prin API aici (se introduce manual);
 * etichetele: doar PDF (A6); fără webhook-uri documentate.
 */
export const SAMEDAY_PRODUCTION_URL = "https://api.sameday.ro";
export const SAMEDAY_DEMO_URL = "https://sameday-api.demo.zitec.com";

export interface SamedayCredentials {
  username: string;
  password: string;
  /** Punctul de ridicare al contului (număr), din lista de puncte de ridicare. */
  pickupPointId: string;
  /** Serviciul implicit (număr), dacă oferta nu poartă unul. */
  defaultServiceId: string;
}

export interface SamedayOptions {
  credentials: SamedayCredentials;
  mode: "test" | "live";
  fetch?: FetchLike;
  now?: () => Date;
}

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const kilograms = (g: number): string => String(Math.max(0.001, Math.ceil(g) / 1000));
const centimeters = (mm: number | null): string => String(Math.max(1, Math.ceil((mm ?? 100) / 10)));

/** Stare normalizată după eticheta stării Sameday (lista de coduri nu a fost citită; necunoscut = în tranzit). */
export function samedayStatus(label: string): ShipmentStatus {
  const text = normalizePlaceName(label);
  if (/\b(anulat|sters)\b/.test(text)) return "cancelled";
  if (/\bretur/.test(text)) return "returned";
  if (/\blivrat\b/.test(text) && !/\bnelivrat\b/.test(text)) return "delivered";
  if (/\b(preluat|ridicat)\b/.test(text)) return "picked_up";
  if (/\b(creat|inregistrat|asteptare)\b/.test(text)) return "created";
  return "in_transit";
}

/** Codifică un obiect ca formular (`a[b][0]=c`), cum cere SDK-ul pentru corpul AWB. */
export function encodeForm(value: Record<string, unknown>): string {
  const pairs: string[] = [];
  const walk = (prefix: string, v: unknown): void => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) {
      v.forEach((item, index) => walk(`${prefix}[${index}]`, item));
    } else if (isRecord(v)) {
      for (const [k, inner] of Object.entries(v)) walk(prefix ? `${prefix}[${k}]` : k, inner);
    } else {
      pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(v))}`);
    }
  };
  walk("", value);
  return pairs.join("&");
}

interface Place {
  id: number;
}

export class SamedayCarrier implements ShippingCarrier {
  readonly code = "sameday" as const;
  readonly label = "Sameday";
  private token: { value: string; expiresAt: number } | null = null;
  private counties: Map<string, Place> | null = null;
  private readonly cities = new Map<string, Map<string, Place>>();
  private readonly now: () => Date;

  constructor(private readonly options: SamedayOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private get base(): string {
    return this.options.mode === "live" ? SAMEDAY_PRODUCTION_URL : SAMEDAY_DEMO_URL;
  }

  private async authenticate(): Promise<string> {
    const cached = this.token;
    if (cached && cached.expiresAt > this.now().getTime() + 30_000) return cached.value;
    const result = await callCarrier(this.options.fetch, `${this.base}/api/authenticate`, {
      method: "POST",
      headers: {
        "x-auth-username": this.options.credentials.username,
        "x-auth-password": this.options.credentials.password,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: "remember_me=true",
    });
    const json = result.json;
    if (!result.ok || !isRecord(json) || typeof json["token"] !== "string") {
      throw new IntegrationError(
        "SHIPPING_AUTH_FAILED",
        "Sameday a refuzat datele de acces (verifică utilizatorul și parola)",
      );
    }
    const expire = new Date(`${asString(json["expire_at"]).replace(" ", "T")}:00Z`).getTime();
    this.token = {
      value: json["token"],
      expiresAt: Number.isNaN(expire) ? this.now().getTime() + 10 * 60_000 : expire,
    };
    return json["token"];
  }

  private async api(
    method: string,
    path: string,
    form?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CarrierCall> {
    const send = async (): Promise<CarrierCall> =>
      callCarrier(
        this.options.fetch,
        `${this.base}${path}`,
        {
          method,
          headers: {
            "x-auth-token": await this.authenticate(),
            accept: "application/json",
            ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          },
          ...(form ? { body: encodeForm(form) } : {}),
        },
        signal,
      );
    let result = await send();
    if (result.status === 401 || result.status === 403) {
      this.token = null; // cum face SDK-ul: o singură reîncercare după reautentificare
      result = await send();
      if (result.status === 401 || result.status === 403) {
        throw new IntegrationError("SHIPPING_AUTH_FAILED", "Sameday a refuzat autentificarea");
      }
    }
    return result;
  }

  private fail(result: CarrierCall, fallback: string): never {
    const message = carrierMessage(result.json);
    throw new IntegrationError(
      "SHIPPING_REJECTED",
      message ? `Sameday: ${message}` : `Sameday: ${fallback}`,
    );
  }

  private static placeMap(json: unknown): Map<string, Place> {
    const map = new Map<string, Place>();
    const rows = isRecord(json) && Array.isArray(json["data"]) ? (json["data"] as unknown[]) : [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const id = asNumber(row["id"]);
      if (id !== null) map.set(normalizePlaceName(asString(row["name"])), { id });
    }
    return map;
  }

  private async countyId(name: string): Promise<number> {
    if (!this.counties) {
      const result = await this.api("GET", "/api/geolocation/county?countPerPage=100");
      if (!result.ok) this.fail(result, "lista de județe nu a putut fi citită");
      this.counties = SamedayCarrier.placeMap(result.json);
    }
    const found = this.counties.get(normalizePlaceName(name));
    if (!found) {
      throw new IntegrationError(
        "SHIPPING_LOCATION_UNMAPPED",
        "Județul nu a fost găsit în nomenclatorul Sameday",
      );
    }
    return found.id;
  }

  private async cityId(countyName: string, localityName: string): Promise<number> {
    const key = normalizePlaceName(countyName);
    let map = this.cities.get(key);
    if (!map) {
      const county = await this.countyId(countyName);
      const result = await this.api(
        "GET",
        `/api/geolocation/city?county=${county}&countPerPage=1000`,
      );
      if (!result.ok) this.fail(result, "lista de localități nu a putut fi citită");
      map = SamedayCarrier.placeMap(result.json);
      this.cities.set(key, map);
    }
    const found = map.get(normalizePlaceName(localityName));
    if (!found) {
      throw new IntegrationError(
        "SHIPPING_LOCATION_UNMAPPED",
        "Localitatea nu a fost găsită în nomenclatorul Sameday",
      );
    }
    return found.id;
  }

  private parcels(parcels: readonly CarrierParcel[]): Record<string, unknown>[] {
    return parcels.map((p) => ({
      weight: kilograms(p.weightGrams),
      length: centimeters(p.lengthMm),
      width: centimeters(p.widthMm),
      height: centimeters(p.heightMm),
    }));
  }

  async quote(request: CarrierQuoteRequest, signal?: AbortSignal): Promise<CarrierQuote[]> {
    const county = await this.countyId(request.destination.countyName);
    const city = await this.cityId(
      request.destination.countyName,
      request.destination.localityName,
    );
    const serviceId = this.options.credentials.defaultServiceId;
    const result = await this.api(
      "POST",
      "/api/awb/estimation",
      {
        pickupPoint: this.options.credentials.pickupPointId,
        packageType: "0",
        parcels: this.parcels(request.parcels),
        service: serviceId,
        awbPayment: "1",
        awbRecipient: {
          county,
          city,
          postalCode: request.destination.postalCode,
          personType: "0",
        },
        insuredValue: "0",
        ...(request.codAmountMinor > 0
          ? { cashOnDelivery: String(minorToDecimal(request.codAmountMinor)) }
          : {}),
      },
      signal,
    );
    const json = result.json;
    if (result.status === 400) {
      throw new IntegrationError(
        "SHIPPING_REFUSED",
        "Sameday nu oferă un serviciu pentru aceste colete",
      );
    }
    if (!result.ok || !isRecord(json)) this.fail(result, "tariful nu a putut fi citit");
    const price = decimalToMinor((json as Record<string, unknown>)["amount"]);
    if (price === null) {
      throw new IntegrationError("SHIPPING_BAD_RESPONSE", "Sameday a răspuns fără tarif");
    }
    return [
      {
        serviceCode: serviceId,
        courier: "Sameday",
        service: "Standard",
        kind: "courier",
        priceMinor: price,
        estimatedDays: null,
        codFeeMinor: 0,
      },
    ];
  }

  async createAwb(request: CarrierAwbRequest): Promise<CarrierAwbResult> {
    const county = await this.countyId(request.recipient.countyName);
    const city = await this.cityId(request.recipient.countyName, request.recipient.localityName);
    const result = await this.api("POST", "/api/awb", {
      pickupPoint: this.options.credentials.pickupPointId,
      packageType: "0",
      packageNumber: String(request.parcels.length || 1),
      parcels: this.parcels(request.parcels),
      service: request.serviceCode ?? this.options.credentials.defaultServiceId,
      awbPayment: "1",
      cashOnDelivery: String(minorToDecimal(request.codAmountMinor)),
      insuredValue: String(minorToDecimal(request.declaredValueMinor)),
      thirdPartyPickup: "0",
      clientInternalReference: request.reference,
      observation: request.observation ?? "",
      ...(request.pickupPointId ? { lockerLastMile: request.pickupPointId } : {}),
      awbRecipient: {
        name: request.recipient.name,
        phoneNumber: request.recipient.phone,
        personType: request.recipient.company ? "1" : "0",
        ...(request.recipient.company ? { companyName: request.recipient.company } : {}),
        postalCode: request.recipient.postalCode,
        address: request.recipient.street,
        county,
        city,
        ...(request.recipient.email ? { email: request.recipient.email } : {}),
      },
    });
    const json = result.json;
    if (!result.ok || !isRecord(json)) this.fail(result, "AWB-ul nu a putut fi creat");
    const awb = asString((json as Record<string, unknown>)["awbNumber"]);
    if (awb === "") {
      throw new IntegrationError("SHIPPING_BAD_RESPONSE", "Sameday a răspuns fără număr de AWB");
    }
    return {
      awb,
      providerRef: awb,
      trackingUrl: `https://sameday.ro/#awb=${encodeURIComponent(awb)}`,
      parcelCount: request.parcels.length || 1,
    };
  }

  async getLabel(ref: CarrierShipmentRef, format: LabelFormat): Promise<CarrierLabel> {
    if (format === "zpl") {
      throw new IntegrationError(
        "SHIPPING_UNSUPPORTED",
        "Sameday: formatul ZPL nu e confirmat în documentația citită; folosește PDF",
      );
    }
    const token = await this.authenticate();
    const result = await callCarrier(
      this.options.fetch,
      `${this.base}/api/awb/download/${encodeURIComponent(ref.awb)}/A6`,
      { method: "GET", headers: { "x-auth-token": token } },
    );
    if (!result.ok || result.bytes.length === 0) {
      this.fail(result, "eticheta nu a putut fi descărcată");
    }
    // răspunsul e PDF binar (presupus; dacă vine JSON cu câmpul `pdf` în base64, se decodifică)
    const json = result.json;
    const pdf =
      isRecord(json) && typeof json["pdf"] === "string"
        ? bytesFromBase64(json["pdf"])
        : result.bytes;
    return { format: "pdf", contentType: "application/pdf", bytes: pdf };
  }

  async track(ref: CarrierShipmentRef): Promise<CarrierTracking> {
    const result = await this.api(
      "GET",
      `/api/client/parcel/${encodeURIComponent(ref.awb)}/status-history`,
    );
    const json = result.json;
    if (!result.ok || !isRecord(json)) this.fail(result, "istoricul nu a putut fi citit");
    const history = (json as Record<string, unknown>)["expeditionHistory"];
    const events: CarrierTrackingEvent[] = [];
    for (const row of Array.isArray(history) ? (history as unknown[]) : []) {
      if (!isRecord(row)) continue;
      const label = asString(row["statusLabel"]) || asString(row["status"]);
      const at = new Date(asString(row["statusDate"]));
      const id = row["statusId"];
      if (label === "" || Number.isNaN(at.getTime())) continue;
      events.push({
        key: `${String(id)}@${at.toISOString()}`,
        code: String(id ?? ""),
        label,
        occurredAt: at,
        status: samedayStatus(label),
      });
    }
    events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const last = events[events.length - 1];
    return { status: last ? last.status : "created", events };
  }

  async cancel(ref: CarrierShipmentRef): Promise<void> {
    const result = await this.api("DELETE", `/api/awb/${encodeURIComponent(ref.awb)}`);
    if (!result.ok) this.fail(result, "AWB-ul nu a putut fi anulat");
  }

  createReturnAwb(): Promise<CarrierAwbResult> {
    return Promise.reject(
      new IntegrationError(
        "SHIPPING_UNSUPPORTED",
        "Sameday: AWB-ul de retur nu e implementat prin API; introdu returul manual",
      ),
    );
  }

  async listPickupPoints(filter: {
    countyName: string;
    localityName?: string;
  }): Promise<CarrierPickupPoint[]> {
    const result = await this.api("GET", "/api/client/lockers?countPerPage=1000");
    if (!result.ok) this.fail(result, "punctele easybox nu au putut fi citite");
    const rows =
      isRecord(result.json) && Array.isArray(result.json["data"])
        ? (result.json["data"] as unknown[])
        : [];
    const county = normalizePlaceName(filter.countyName);
    const locality = filter.localityName ? normalizePlaceName(filter.localityName) : null;
    const points: CarrierPickupPoint[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const id = asNumber(row["lockerId"]) ?? asNumber(row["id"]);
      if (id === null) continue;
      if (normalizePlaceName(asString(row["county"])) !== county) continue;
      const city = asString(row["city"]);
      if (locality !== null && normalizePlaceName(city) !== locality) continue;
      points.push({
        id: String(id),
        name: asString(row["name"]),
        countyName: asString(row["county"]),
        localityName: city,
        address: asString(row["address"]),
      });
    }
    return points;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      this.token = null;
      await this.authenticate();
      return { ok: true, message: "Conectat la Sameday (autentificare reușită)." };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof IntegrationError ? error.message : "Sameday nu poate fi contactat",
      };
    }
  }
}

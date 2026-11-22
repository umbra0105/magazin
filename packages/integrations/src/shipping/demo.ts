import { randomInt } from "node:crypto";
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
  type CarrierTrackingEvent,
  type ConnectionTestResult,
  type LabelFormat,
  type ShipmentStatus,
  type ShippingCarrier,
} from "@ecom/shared";
import { isDemoPaymentAllowed, type DemoGuardEnv } from "../payments/demo-guard";

/**
 * Curierul FALS «DEMO» (Faza 12): AWB-uri, etichete și urmărire simulate, DOAR pentru dezvoltare și teste. Aceeași gardă ca la
 * plățile DEMO (`isDemoPaymentAllowed`): construirea aruncă într-o instalare de producție. Fără stare: numărul AWB poartă
 * momentul creării (`DEMO<secunde><3 cifre>`), iar urmărirea derivă starea din timpul scurs (creat → ridicat după 2 minute →
 * în tranzit după 5 → livrat după 10). NU sunt tarife sau expedieri reale ale vreunui curier.
 */
export const DEMO_CARRIER_LABEL = "DEMO";
const PICKED_UP_AFTER_SECONDS = 120;
const IN_TRANSIT_AFTER_SECONDS = 300;
const DELIVERED_AFTER_SECONDS = 600;

export interface DemoCarrierOptions {
  env: DemoGuardEnv;
  now?: () => Date;
}

/** Secundele de la creare, din numărul AWB DEMO; `null` dacă nu e un AWB DEMO. */
export function demoAwbCreatedAt(awb: string): Date | null {
  const match = /^DEMO(\d{10})\d{3}$/.exec(awb);
  return match?.[1] ? new Date(Number(match[1]) * 1000) : null;
}

const MINIMAL_PDF = (title: string): Uint8Array => {
  const text = title.replace(/[()\\]/g, "");
  const stream = `BT /F1 18 Tf 40 780 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 595] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
};

const STATUS_LABELS: Record<ShipmentStatus, string> = {
  created: "AWB creat (DEMO)",
  picked_up: "Colet preluat de curier (DEMO)",
  in_transit: "Colet în tranzit (DEMO)",
  delivered: "Colet livrat (DEMO)",
  returned: "Colet returnat (DEMO)",
  cancelled: "AWB anulat (DEMO)",
};

export class DemoCarrier implements ShippingCarrier {
  readonly code = "demo" as const;
  readonly label = DEMO_CARRIER_LABEL;
  private readonly now: () => Date;

  constructor(options: DemoCarrierOptions) {
    if (!isDemoPaymentAllowed(options.env)) {
      throw new IntegrationError(
        "SHIPPING_UNSUPPORTED",
        "Curierul DEMO nu este disponibil în această instalare",
      );
    }
    this.now = options.now ?? (() => new Date());
  }

  quote(request: CarrierQuoteRequest): Promise<CarrierQuote[]> {
    const grams = request.parcels.reduce((sum, parcel) => sum + parcel.weightGrams, 0);
    const extraKg = Math.ceil(Math.max(0, grams - 5000) / 1000);
    return Promise.resolve([
      {
        serviceCode: "demo-standard",
        courier: "Curier DEMO",
        service: "Standard (DEMO)",
        kind: "courier",
        priceMinor: 2500 + extraKg * 400,
        estimatedDays: 2,
        codFeeMinor: 500,
      },
    ]);
  }

  createAwb(request: CarrierAwbRequest): Promise<CarrierAwbResult> {
    const seconds = Math.floor(this.now().getTime() / 1000);
    const awb = `DEMO${String(seconds).padStart(10, "0")}${String(randomInt(0, 1000)).padStart(3, "0")}`;
    void request;
    return Promise.resolve({
      awb,
      providerRef: awb,
      trackingUrl: null,
      parcelCount: request.parcels.length || 1,
    });
  }

  getLabel(ref: CarrierShipmentRef, format: LabelFormat): Promise<CarrierLabel> {
    if (format === "zpl") {
      const zpl = `^XA^FO40,40^A0N,40,40^FD${ref.awb}^FS^FO40,100^A0N,28,28^FDDEMO - nu e o eticheta reala^FS^XZ`;
      return Promise.resolve({
        format: "zpl",
        contentType: "application/octet-stream",
        bytes: new Uint8Array(Buffer.from(zpl, "utf8")),
      });
    }
    return Promise.resolve({
      format: "pdf",
      contentType: "application/pdf",
      bytes: MINIMAL_PDF(`AWB ${ref.awb} (DEMO - nu e o eticheta reala)`),
    });
  }

  track(ref: CarrierShipmentRef): Promise<CarrierTracking> {
    const created = demoAwbCreatedAt(ref.awb);
    if (!created) return Promise.resolve({ status: "created", events: [] });
    const elapsed = (this.now().getTime() - created.getTime()) / 1000;
    const steps: Array<[number, ShipmentStatus]> = [
      [0, "created"],
      [PICKED_UP_AFTER_SECONDS, "picked_up"],
      [IN_TRANSIT_AFTER_SECONDS, "in_transit"],
      [DELIVERED_AFTER_SECONDS, "delivered"],
    ];
    const events: CarrierTrackingEvent[] = [];
    for (const [after, status] of steps) {
      if (elapsed < after) break;
      events.push({
        key: `${ref.awb}:${status}`,
        code: status,
        label: STATUS_LABELS[status],
        occurredAt: new Date(created.getTime() + after * 1000),
        status,
      });
    }
    const last = events[events.length - 1];
    return Promise.resolve({ status: last ? last.status : "created", events });
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  createReturnAwb(
    parent: CarrierShipmentRef,
    request: CarrierAwbRequest,
  ): Promise<CarrierAwbResult> {
    void parent;
    return this.createAwb(request);
  }

  listPickupPoints(filter: {
    countyName: string;
    localityName?: string;
  }): Promise<CarrierPickupPoint[]> {
    return Promise.resolve(
      demoPickupPoints().filter(
        (point) =>
          point.countyName.toLowerCase() === filter.countyName.toLowerCase() &&
          (!filter.localityName ||
            point.localityName.toLowerCase() === filter.localityName.toLowerCase()),
      ),
    );
  }

  testConnection(): Promise<ConnectionTestResult> {
    return Promise.resolve({
      ok: true,
      message: "Curier DEMO: nu se contactează niciun serviciu real.",
    });
  }
}

/** Puncte easybox SIMULATE (nu sunt lockere reale), pentru lista căutabilă din checkout și pentru teste. */
export function demoPickupPoints(): CarrierPickupPoint[] {
  const rows: Array<[string, string, string, string]> = [
    ["Alba", "Alba Iulia", "easybox Demo Alba Iulia Centru", "Str. Exemplu 1"],
    ["Alba", "Alba Iulia", "easybox Demo Alba Iulia Gară", "Piața Gării 2"],
    ["Alba", "Sebeș", "easybox Demo Sebeș", "Str. Demo 10"],
    ["Cluj", "Cluj-Napoca", "easybox Demo Cluj Mărăști", "Str. Demo 22"],
    ["Cluj", "Cluj-Napoca", "easybox Demo Cluj Gheorgheni", "Str. Demo 31"],
    ["Cluj", "Turda", "easybox Demo Turda", "Str. Demo 4"],
    ["București", "București", "easybox Demo București Titan", "Bd. Demo 100"],
    ["București", "București", "easybox Demo București Militari", "Bd. Demo 200"],
    ["Brașov", "Brașov", "easybox Demo Brașov Centru", "Str. Demo 7"],
    ["Timiș", "Timișoara", "easybox Demo Timișoara Iosefin", "Str. Demo 9"],
  ];
  return rows.map(([countyName, localityName, name, address], index) => ({
    id: `demo-${index + 1}`,
    name,
    countyName,
    localityName,
    address,
  }));
}

import type { Prisma } from "@ecom/db";
import {
  DomainError,
  IntegrationError,
  quantityFromTicks,
  type CarrierAwbRequest,
  type CarrierLabel,
  type CarrierTracking,
  type LabelFormat,
  type ShipmentStatus,
  type ShippingCarrier,
  type ShippingProviderCode,
} from "@ecom/shared";
import { inTx, type Db } from "../db-tx";
import { OrderError } from "../orders/order-errors";
import { addOrderEvent, lockOrder, transitionOrder } from "../orders/order-service";
import type { FulfillmentStatus } from "../orders/order-state";
import { buildParcel } from "./parcels";

/**
 * Expedierile unei comenzi (Faza 12): AWB creat prin API la un curier SAU introdus manual (transportul paletizat), etichete,
 * anulare, AWB de retur și aplicarea urmăririi (jobul de sincronizare). Fiecare scriere:
 *  - blochează comanda (`FOR UPDATE`) și trece starea de livrare EXCLUSIV prin `transitionOrder` (state machine validat);
 *  - scrie `OrderEvent` (`shipment.created` la AWB, `order.shipped` la predarea către curier, `order.delivered` la livrare;
 *    ultimele două declanșează emailurile existente prin outbox, o singură dată pe eveniment);
 *  - auditul din admin îl scrie acțiunea (`apps/web`), nu serviciul.
 * Comenzile cu ridicare personală NU au expediere. Apelul către curier se face ÎNAINTE de tranzacție (niciodată în ea): dacă
 * scrierea eșuează după ce AWB-ul există la curier, AWB-ul se anulează (compensare). Curier picat ≠ comandă pierdută: comanda
 * rămâne neexpediată, iar adminul poate reîncerca sau introduce AWB-ul manual.
 *
 * Simplificări declarate: un singur colet pe AWB, cu greutatea totală tarifabilă a liniilor fizice (fără împachetare reală);
 * starea comenzii (`status`) nu se schimbă la livrare (doar `fulfillmentStatus`).
 */
export const SHIPMENT_ERROR_CODES = [
  "SHIPMENT_ORDER_NOT_FOUND",
  "SHIPMENT_NOT_FOUND",
  "SHIPMENT_ORDER_STATE",
  "SHIPMENT_PICKUP",
  "SHIPMENT_EXISTS",
  "SHIPMENT_INVALID",
  "SHIPMENT_PALLET_MANUAL_ONLY",
  "SHIPMENT_NO_PHYSICAL_LINES",
  "SHIPMENT_NO_ADDRESS",
  "SHIPMENT_NO_SERVICE",
  "SHIPMENT_CANNOT_CANCEL",
  "SHIPMENT_NOT_DELIVERED",
] as const;

export class ShipmentError extends DomainError {
  constructor(code: (typeof SHIPMENT_ERROR_CODES)[number], message: string, details?: unknown) {
    super(code, message, details);
  }
}

export const CARRIER_NAME_MAX = 80;
export const AWB_MAX = 60;
export const TRACKING_URL_MAX = 300;

/** Stările de comandă din care se poate expedia: confirmată (plătită sau cu ramburs) sau în procesare. */
const SHIPPABLE_STATUSES: ReadonlySet<string> = new Set(["confirmed", "processing"]);

const STATUS_RANK: Readonly<Record<string, number>> = {
  created: 0,
  picked_up: 1,
  in_transit: 2,
  delivered: 3,
};

interface Actor {
  actorLabel: string;
  now: Date;
}

// ---------------------------------------------------------------------------------------------------------------- intrări

export interface ManualShipmentInput extends Actor {
  carrier: string;
  awb: string;
  trackingUrl?: string | null;
}

function cleanManual(input: { carrier: string; awb: string; trackingUrl?: string | null }) {
  const carrier = input.carrier.trim();
  const awb = input.awb.trim();
  const trackingUrl = input.trackingUrl?.trim() ? input.trackingUrl.trim() : null;
  if (carrier.length < 2 || carrier.length > CARRIER_NAME_MAX) {
    throw new ShipmentError(
      "SHIPMENT_INVALID",
      `Transportatorul are între 2 și ${CARRIER_NAME_MAX} de caractere`,
      { field: "carrier" },
    );
  }
  if (awb.length < 2 || awb.length > AWB_MAX || /[\r\n]/.test(awb)) {
    throw new ShipmentError(
      "SHIPMENT_INVALID",
      `Numărul AWB/documentului are între 2 și ${AWB_MAX} de caractere`,
      { field: "awb" },
    );
  }
  if (trackingUrl !== null) {
    let valid = trackingUrl.length <= TRACKING_URL_MAX;
    try {
      const url = new URL(trackingUrl);
      valid = valid && (url.protocol === "https:" || url.protocol === "http:");
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new ShipmentError("SHIPMENT_INVALID", "Linkul de urmărire nu e o adresă web validă", {
        field: "trackingUrl",
      });
    }
  }
  return { carrier, awb, trackingUrl };
}

// ------------------------------------------------------------------------------------------- avansarea stării de livrare

type ShipTarget = "fulfilled" | "in_transit" | "delivered";
const PATH: readonly FulfillmentStatus[] = ["unfulfilled", "fulfilled", "in_transit", "delivered"];

interface ShipData {
  awb: string;
  carrier: string;
  trackingUrl: string | null;
}

/**
 * Duce starea de livrare a comenzii (blocată de apelant) până la `target`, prin tranzițiile validate, cu evenimentele fiecărui
 * pas. Pașii deja trecuți nu se repetă (idempotent): o comandă deja în tranzit nu scrie încă un `order.shipped`.
 */
async function advanceFulfillment(
  tx: Db,
  orderId: string,
  target: ShipTarget,
  data: ShipData,
  actor: Actor,
): Promise<void> {
  const states = await lockOrder(tx, orderId);
  if (!states) throw new OrderError("ORDER_NOT_FOUND", "Comanda nu există", { orderId });
  let at = PATH.indexOf(states.fulfillmentStatus);
  if (at < 0) return; // returnată sau anulată: nu se mai avansează
  const payload: Prisma.InputJsonValue = {
    awb: data.awb,
    carrier: data.carrier,
    ...(data.trackingUrl ? { trackingUrl: data.trackingUrl } : {}),
  };
  while (at < PATH.indexOf(target)) {
    const next = PATH[at + 1] as ShipTarget;
    const event =
      next === "fulfilled"
        ? {
            type: "shipment.created",
            message: `AWB ${data.awb} (${data.carrier}) a fost creat pentru comandă`,
          }
        : next === "in_transit"
          ? {
              type: "order.shipped",
              message: `Comanda a fost expediată cu ${data.carrier}, AWB ${data.awb}`,
            }
          : { type: "order.delivered", message: `Comanda a fost livrată (AWB ${data.awb})` };
    await transitionOrder(
      tx,
      orderId,
      { fulfillmentStatus: next },
      { ...event, data: payload, actorLabel: actor.actorLabel },
      actor.now,
    );
    at += 1;
  }
}

// ---------------------------------------------------------------------------------------------------- verificări de comandă

interface OrderForShipping {
  id: string;
  number: string;
  email: string;
  phone: string;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  totalMinor: number;
  subtotalMinor: number;
  snapshotKind: string;
  snapshotCode: string;
}

async function loadOrderForShipping(db: Db, orderId: string): Promise<OrderForShipping> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      number: true,
      email: true,
      phone: true,
      status: true,
      paymentMethod: true,
      paymentStatus: true,
      totalMinor: true,
      subtotalMinor: true,
      shippingMethodCode: true,
      shippingSnapshot: true,
    },
  });
  if (!order) throw new ShipmentError("SHIPMENT_ORDER_NOT_FOUND", "Comanda nu există", { orderId });
  const snapshot =
    typeof order.shippingSnapshot === "object" &&
    order.shippingSnapshot !== null &&
    !Array.isArray(order.shippingSnapshot)
      ? (order.shippingSnapshot as Record<string, unknown>)
      : {};
  return {
    id: order.id,
    number: order.number,
    email: order.email,
    phone: order.phone,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    totalMinor: order.totalMinor,
    subtotalMinor: order.subtotalMinor,
    snapshotKind: typeof snapshot["kind"] === "string" ? snapshot["kind"] : "courier",
    snapshotCode: order.shippingMethodCode,
  };
}

function assertShippable(order: OrderForShipping): void {
  if (order.snapshotKind === "pickup") {
    throw new ShipmentError(
      "SHIPMENT_PICKUP",
      "Comanda cu ridicare personală nu primește AWB și nu are destinație de livrare",
    );
  }
  if (!SHIPPABLE_STATUSES.has(order.status)) {
    throw new ShipmentError(
      "SHIPMENT_ORDER_STATE",
      "Comanda trebuie să fie confirmată (plătită sau cu ramburs) ca să poată fi expediată",
      { status: order.status },
    );
  }
}

async function assertNoActive(db: Db, orderId: string): Promise<void> {
  const active = await db.shipment.findFirst({
    where: { orderId, kind: "outbound", status: { not: "cancelled" } },
    select: { id: true },
  });
  if (active) {
    throw new ShipmentError("SHIPMENT_EXISTS", "Comanda are deja o expediere activă", {
      shipmentId: active.id,
    });
  }
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  ((error as { code?: unknown }).code === "P2002" ||
    String((error as { message?: unknown }).message ?? "").includes("shipment_one_active"));

// ------------------------------------------------------------------------------------------------------------- AWB manual

export interface ShipmentResult {
  shipmentId: string;
  awb: string;
}

/**
 * AWB MANUAL (transportul paletizat, fără API): adminul alege transportatorul și introduce numărul AWB/documentului și,
 * opțional, linkul de urmărire. Comanda trece la «expediată» (`order.shipped`, cu AWB-ul, declanșează emailul existent).
 */
export async function createManualShipment(
  db: Db,
  orderId: string,
  input: ManualShipmentInput,
): Promise<ShipmentResult> {
  const clean = cleanManual(input);
  const order = await loadOrderForShipping(db, orderId);
  assertShippable(order);
  try {
    return await inTx(db, async (tx) => {
      const locked = await lockOrder(tx, orderId);
      if (!locked) throw new OrderError("ORDER_NOT_FOUND", "Comanda nu există", { orderId });
      if (locked.fulfillmentStatus !== "unfulfilled") {
        throw new ShipmentError("SHIPMENT_ORDER_STATE", "Comanda a fost deja expediată", {
          fulfillmentStatus: locked.fulfillmentStatus,
        });
      }
      await assertNoActive(tx, orderId);
      const shipment = await tx.shipment.create({
        data: {
          orderId,
          kind: "outbound",
          mode: "manual",
          carrier: clean.carrier,
          awb: clean.awb,
          trackingUrl: clean.trackingUrl,
          status: "in_transit",
          codAmountMinor: 0,
          creatorLabel: input.actorLabel,
        },
      });
      await advanceFulfillment(
        tx,
        orderId,
        "in_transit",
        { awb: clean.awb, carrier: clean.carrier, trackingUrl: clean.trackingUrl },
        input,
      );
      return { shipmentId: shipment.id, awb: clean.awb };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ShipmentError("SHIPMENT_EXISTS", "Comanda are deja o expediere activă");
    }
    throw error;
  }
}

/** «Livrată» marcată de admin (la AWB manual sau când curierul nu raportează): comanda trece la «livrată» (`order.delivered`). */
export async function markShipmentDelivered(
  db: Db,
  shipmentId: string,
  actor: Actor,
): Promise<{ alreadyDelivered: boolean }> {
  const shipment = await db.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new ShipmentError("SHIPMENT_NOT_FOUND", "Expedierea nu există");
  if (shipment.kind !== "outbound" || shipment.status === "cancelled") {
    throw new ShipmentError("SHIPMENT_CANNOT_CANCEL", "Expedierea nu poate fi marcată livrată");
  }
  if (shipment.status === "delivered") return { alreadyDelivered: true };
  return inTx(db, async (tx) => {
    await lockOrder(tx, shipment.orderId);
    const fresh = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    if (fresh.status === "delivered") return { alreadyDelivered: true };
    if (fresh.status === "cancelled" || fresh.status === "returned") {
      throw new ShipmentError("SHIPMENT_CANNOT_CANCEL", "Expedierea nu poate fi marcată livrată");
    }
    await tx.shipment.update({
      where: { id: shipmentId },
      data: { status: "delivered", deliveredAt: actor.now },
    });
    await advanceFulfillment(
      tx,
      shipment.orderId,
      "delivered",
      { awb: shipment.awb, carrier: shipment.carrier, trackingUrl: shipment.trackingUrl },
      actor,
    );
    return { alreadyDelivered: false };
  });
}

// ------------------------------------------------------------------------------------------------------ AWB prin curier

export interface CarrierShipmentInput extends Actor {
  carrier: ShippingCarrier;
}

async function buildAwbRequest(
  db: Db,
  order: OrderForShipping,
  carrier: ShippingCarrier,
): Promise<CarrierAwbRequest & { serviceCode: string | null }> {
  const address = await db.address.findFirst({ where: { orderId: order.id, kind: "shipping" } });
  if (!address) {
    throw new ShipmentError("SHIPMENT_NO_ADDRESS", "Comanda nu are adresă de livrare");
  }
  const lines = await db.orderLine.findMany({
    where: { orderId: order.id },
    select: {
      quantity: true,
      sku: true,
      variantId: true,
      shippingClass: true,
      variant: {
        select: {
          weightGrams: true,
          lengthMm: true,
          widthMm: true,
          heightMm: true,
          product: { select: { type: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  const physical = lines.filter((line) => line.variant?.product.type !== "digital");
  if (physical.length === 0) {
    throw new ShipmentError(
      "SHIPMENT_NO_PHYSICAL_LINES",
      "Comanda nu are produse fizice de expediat",
    );
  }
  const grams = physical.reduce((sum, line) => {
    const parcel = buildParcel({
      variantId: line.variantId ?? line.sku,
      sku: line.sku,
      shippingClass:
        line.shippingClass === "pallet" || line.shippingClass === "oversized"
          ? line.shippingClass
          : "standard",
      quantity: quantityFromTicks(line.quantity),
      weightGrams: line.variant?.weightGrams ?? null,
      lengthMm: line.variant?.lengthMm ?? null,
      widthMm: line.variant?.widthMm ?? null,
      heightMm: line.variant?.heightMm ?? null,
    });
    return sum + parcel.chargeableGrams;
  }, 0);
  const prefix = `${carrier.code}:`;
  const serviceCode = order.snapshotCode.startsWith(prefix)
    ? order.snapshotCode.slice(prefix.length)
    : null;
  const cod = order.paymentMethod === "cod" && order.paymentStatus === "pending";
  return {
    reference: order.number,
    recipient: {
      name: address.fullName,
      company: address.company,
      phone: address.phone || order.phone,
      email: order.email,
      street: address.street,
      countyName: address.countyName,
      localityName: address.localityName,
      postalCode: address.postalCode,
    },
    // simplificare declarată: un singur colet, cu greutatea totală tarifabilă a liniilor fizice
    parcels: [{ weightGrams: Math.max(100, grams), lengthMm: null, widthMm: null, heightMm: null }],
    codAmountMinor: cod ? order.totalMinor : 0,
    declaredValueMinor: order.subtotalMinor,
    serviceCode,
  };
}

/** Serviciul curierului pentru o comandă plasată cu rezerva pe zone sau cu alt furnizor: cel mai ieftin curier al lui. */
async function resolveServiceCode(
  carrier: ShippingCarrier,
  request: CarrierAwbRequest & { serviceCode: string | null },
): Promise<string | null> {
  if (request.serviceCode) return request.serviceCode;
  if (carrier.code === "demo") return null;
  const quotes = await carrier.quote({
    parcels: request.parcels,
    destination: {
      countyName: request.recipient.countyName,
      localityName: request.recipient.localityName,
      postalCode: request.recipient.postalCode,
    },
    codAmountMinor: request.codAmountMinor,
  });
  const cheapest = quotes
    .filter((quote) => quote.kind === "courier")
    .sort((a, b) => a.priceMinor - b.priceMinor)[0];
  if (!cheapest) {
    throw new ShipmentError(
      "SHIPMENT_NO_SERVICE",
      "Curierul nu oferă un serviciu pentru această comandă",
    );
  }
  return cheapest.serviceCode;
}

/**
 * AWB prin API la curier. Rambursul (dacă plata e ramburs și încă neîncasată) se transmite curierului. Apelul la curier e în
 * afara tranzacției; dacă scrierea eșuează după aceea, AWB-ul se anulează la curier.
 */
export async function createCarrierShipment(
  db: Db,
  orderId: string,
  input: CarrierShipmentInput,
): Promise<ShipmentResult> {
  const order = await loadOrderForShipping(db, orderId);
  assertShippable(order);
  if (order.snapshotKind === "pallet") {
    throw new ShipmentError(
      "SHIPMENT_PALLET_MANUAL_ONLY",
      "Transportul paletizat se expediază manual (AWB introdus de admin)",
    );
  }
  await assertNoActive(db, orderId);
  const request = await buildAwbRequest(db, order, input.carrier);
  const serviceCode = await resolveServiceCode(input.carrier, request);
  const created = await input.carrier.createAwb({ ...request, serviceCode });
  try {
    return await inTx(db, async (tx) => {
      const locked = await lockOrder(tx, orderId);
      if (!locked || locked.fulfillmentStatus !== "unfulfilled") {
        throw new ShipmentError("SHIPMENT_ORDER_STATE", "Comanda a fost expediată între timp");
      }
      await assertNoActive(tx, orderId);
      const shipment = await tx.shipment.create({
        data: {
          orderId,
          kind: "outbound",
          mode: "provider",
          provider: input.carrier.code,
          carrier: input.carrier.label,
          awb: created.awb,
          trackingUrl: created.trackingUrl,
          providerRef: created.providerRef,
          status: "created",
          codAmountMinor: request.codAmountMinor,
          parcelCount: created.parcelCount,
          weightGrams: request.parcels.reduce((sum, p) => sum + p.weightGrams, 0),
          creatorLabel: input.actorLabel,
        },
      });
      await advanceFulfillment(
        tx,
        orderId,
        "fulfilled",
        { awb: created.awb, carrier: input.carrier.label, trackingUrl: created.trackingUrl },
        input,
      );
      return { shipmentId: shipment.id, awb: created.awb };
    });
  } catch (error) {
    // compensare: AWB-ul există la curier, dar nu l-am putut scrie la noi
    await input.carrier
      .cancel({ awb: created.awb, providerRef: created.providerRef })
      .catch(() => undefined);
    if (isUniqueViolation(error)) {
      throw new ShipmentError("SHIPMENT_EXISTS", "Comanda are deja o expediere activă");
    }
    throw error;
  }
}

export interface BulkShipmentOutcome {
  orderId: string;
  ok: boolean;
  /** Cod stabil al erorii dacă `ok` e fals (niciodată mesajul curierului, care poate conține date). */
  code: string | null;
  awb: string | null;
}

/** AWB în masă: pe rând, fiecare comandă independent; o eroare nu le oprește pe celelalte. */
export async function createCarrierShipmentsBulk(
  db: Db,
  orderIds: readonly string[],
  input: CarrierShipmentInput,
  limit = 50,
): Promise<BulkShipmentOutcome[]> {
  const unique = [...new Set(orderIds)].slice(0, limit);
  const outcomes: BulkShipmentOutcome[] = [];
  for (const orderId of unique) {
    try {
      const result = await createCarrierShipment(db, orderId, input);
      outcomes.push({ orderId, ok: true, code: null, awb: result.awb });
    } catch (error) {
      const code =
        error instanceof DomainError || error instanceof IntegrationError
          ? error.code
          : "SHIPMENT_FAILED";
      outcomes.push({ orderId, ok: false, code, awb: null });
    }
  }
  return outcomes;
}

// ----------------------------------------------------------------------------------------------------------- etichetă

export async function getShipmentLabel(
  db: Db,
  carrier: ShippingCarrier,
  shipmentId: string,
  format: LabelFormat,
): Promise<CarrierLabel> {
  const shipment = await db.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new ShipmentError("SHIPMENT_NOT_FOUND", "Expedierea nu există");
  if (shipment.mode !== "provider" || shipment.provider !== carrier.code) {
    throw new ShipmentError("SHIPMENT_INVALID", "Expedierea nu are etichetă de la acest curier");
  }
  if (shipment.status === "cancelled") {
    throw new ShipmentError("SHIPMENT_CANNOT_CANCEL", "AWB-ul e anulat");
  }
  return carrier.getLabel({ awb: shipment.awb, providerRef: shipment.providerRef }, format);
}

// ------------------------------------------------------------------------------------------------------------- anulare

/**
 * Anulează o expediere: la curier (dacă e prin API), apoi la noi: expedierea devine «anulată», iar comanda revine la
 * «neexpediată» ca să poată fi expediată din nou. Doar înainte de livrare. Dacă curierul refuză anularea, nu se schimbă nimic.
 */
export async function cancelShipment(
  db: Db,
  shipmentId: string,
  input: Actor & { carrier: ShippingCarrier | null; reason?: string },
): Promise<{ alreadyCancelled: boolean }> {
  const shipment = await db.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new ShipmentError("SHIPMENT_NOT_FOUND", "Expedierea nu există");
  if (shipment.status === "cancelled") return { alreadyCancelled: true };
  if (shipment.status === "delivered" || shipment.status === "returned") {
    throw new ShipmentError("SHIPMENT_CANNOT_CANCEL", "Expedierea e deja livrată sau returnată");
  }
  if (shipment.mode === "provider") {
    if (!input.carrier || input.carrier.code !== shipment.provider) {
      throw new ShipmentError("SHIPMENT_CANNOT_CANCEL", "Curierul expedierii nu e configurat");
    }
    await input.carrier.cancel({ awb: shipment.awb, providerRef: shipment.providerRef });
  }
  return inTx(db, async (tx) => {
    const states = await lockOrder(tx, shipment.orderId);
    const fresh = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    if (fresh.status === "cancelled") return { alreadyCancelled: true };
    if (fresh.status === "delivered" || fresh.status === "returned") {
      throw new ShipmentError("SHIPMENT_CANNOT_CANCEL", "Expedierea e deja livrată sau returnată");
    }
    await tx.shipment.update({
      where: { id: shipmentId },
      data: { status: "cancelled", cancelledAt: input.now },
    });
    if (
      fresh.kind === "outbound" &&
      states &&
      (states.fulfillmentStatus === "fulfilled" || states.fulfillmentStatus === "in_transit")
    ) {
      await transitionOrder(
        tx,
        shipment.orderId,
        { fulfillmentStatus: "unfulfilled" },
        {
          type: "shipment.cancelled",
          message: `AWB ${shipment.awb} (${shipment.carrier}) a fost anulat; comanda se poate expedia din nou`,
          data: { awb: shipment.awb, carrier: shipment.carrier },
          actorLabel: input.actorLabel,
        },
        input.now,
      );
    } else {
      await addOrderEvent(tx, shipment.orderId, {
        type: "shipment.cancelled",
        message: `AWB ${shipment.awb} (${shipment.carrier}) a fost anulat`,
        data: { awb: shipment.awb, carrier: shipment.carrier },
        actorLabel: input.actorLabel,
      });
    }
    return { alreadyCancelled: false };
  });
}

// ---------------------------------------------------------------------------------------------------------------- retur

async function assertReturnable(db: Db, parentId: string) {
  const parent = await db.shipment.findUnique({ where: { id: parentId } });
  if (!parent || parent.kind !== "outbound") {
    throw new ShipmentError("SHIPMENT_NOT_FOUND", "Expedierea nu există");
  }
  if (parent.status !== "delivered") {
    throw new ShipmentError(
      "SHIPMENT_NOT_DELIVERED",
      "AWB-ul de retur se creează doar pentru o expediere livrată",
    );
  }
  const active = await db.shipment.findFirst({
    where: { parentId, kind: "return", status: { not: "cancelled" } },
    select: { id: true },
  });
  if (active) throw new ShipmentError("SHIPMENT_EXISTS", "Există deja un AWB de retur activ");
  return parent;
}

async function writeReturn(
  db: Db,
  parentId: string,
  orderId: string,
  data: {
    mode: "provider" | "manual";
    provider: ShippingProviderCode | null;
    carrier: string;
    awb: string;
    trackingUrl: string | null;
    providerRef: string | null;
  },
  actor: Actor,
): Promise<ShipmentResult> {
  try {
    return await inTx(db, async (tx) => {
      await lockOrder(tx, orderId);
      const created = await tx.shipment.create({
        data: {
          orderId,
          kind: "return",
          parentId,
          mode: data.mode,
          provider: data.provider,
          carrier: data.carrier,
          awb: data.awb,
          trackingUrl: data.trackingUrl,
          providerRef: data.providerRef,
          status: "created",
          creatorLabel: actor.actorLabel,
        },
      });
      await addOrderEvent(tx, orderId, {
        type: "shipment.return_created",
        message: `AWB de retur ${data.awb} (${data.carrier})`,
        data: { awb: data.awb, carrier: data.carrier },
        actorLabel: actor.actorLabel,
      });
      return { shipmentId: created.id, awb: data.awb };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ShipmentError("SHIPMENT_EXISTS", "Există deja un AWB de retur activ");
    }
    throw error;
  }
}

/** AWB de retur prin curier (dacă îl oferă; altfel `SHIPPING_UNSUPPORTED` și adminul îl introduce manual). */
export async function createCarrierReturn(
  db: Db,
  parentId: string,
  input: CarrierShipmentInput,
): Promise<ShipmentResult> {
  const parent = await assertReturnable(db, parentId);
  if (parent.mode !== "provider" || parent.provider !== input.carrier.code) {
    throw new ShipmentError(
      "SHIPMENT_INVALID",
      "Returul prin API cere același curier ca expedierea",
    );
  }
  const order = await loadOrderForShipping(db, parent.orderId);
  const request = await buildAwbRequest(db, order, input.carrier);
  // returul pleacă de la client: ramburs 0, aceeași referință
  const created = await input.carrier.createReturnAwb(
    { awb: parent.awb, providerRef: parent.providerRef },
    { ...request, codAmountMinor: 0, reference: `${order.number}-RETUR` },
  );
  return writeReturn(
    db,
    parentId,
    parent.orderId,
    {
      mode: "provider",
      provider: input.carrier.code,
      carrier: input.carrier.label,
      awb: created.awb,
      trackingUrl: created.trackingUrl,
      providerRef: created.providerRef,
    },
    input,
  );
}

export async function createManualReturn(
  db: Db,
  parentId: string,
  input: ManualShipmentInput,
): Promise<ShipmentResult> {
  const clean = cleanManual(input);
  const parent = await assertReturnable(db, parentId);
  return writeReturn(
    db,
    parentId,
    parent.orderId,
    {
      mode: "manual",
      provider: null,
      carrier: clean.carrier,
      awb: clean.awb,
      trackingUrl: clean.trackingUrl,
      providerRef: null,
    },
    input,
  );
}

// -------------------------------------------------------------------------------------------------------------- urmărire

export interface TrackingOutcome {
  changed: boolean;
  status: ShipmentStatus;
  newEvents: number;
}

/**
 * Aplică urmărirea unui curier pe o expediere. IDEMPOTENTĂ: evenimentele au cheie unică (aceleași evenimente primite a doua oară
 * nu se scriu din nou), starea nu coboară (livrat nu revine în tranzit), iar emailurile «expediată» și «livrată» pleacă o singură
 * dată (`advanceFulfillment` nu repetă pașii deja făcuți, iar outbox-ul are cheie unică pe eveniment).
 */
export async function applyTrackingUpdate(
  db: Db,
  shipmentId: string,
  tracking: CarrierTracking,
  now: Date,
): Promise<TrackingOutcome> {
  const first = await db.shipment.findUnique({ where: { id: shipmentId } });
  if (!first) throw new ShipmentError("SHIPMENT_NOT_FOUND", "Expedierea nu există");
  return inTx(db, async (tx) => {
    await lockOrder(tx, first.orderId);
    const shipment = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    const written = tracking.events.length
      ? await tx.shipmentEvent.createMany({
          data: tracking.events.map((event) => ({
            shipmentId,
            eventKey: event.key,
            code: event.code.slice(0, 40),
            label: event.label.slice(0, 200),
            occurredAt: event.occurredAt,
          })),
          skipDuplicates: true,
        })
      : { count: 0 };
    const current = shipment.status;
    let next: ShipmentStatus = current as ShipmentStatus;
    if (current !== "cancelled" && current !== "returned" && current !== "delivered") {
      const incoming = tracking.status;
      if (incoming === "returned" || incoming === "cancelled") next = incoming;
      else if ((STATUS_RANK[incoming] ?? 0) > (STATUS_RANK[current] ?? 0)) next = incoming;
    }
    const actor: Actor = { actorLabel: `Curier ${shipment.carrier}`, now };
    const data: ShipData = {
      awb: shipment.awb,
      carrier: shipment.carrier,
      trackingUrl: shipment.trackingUrl,
    };
    if (next !== current) {
      await tx.shipment.update({
        where: { id: shipmentId },
        data: {
          status: next,
          lastSyncedAt: now,
          ...(next === "delivered" ? { deliveredAt: now } : {}),
          ...(next === "cancelled" ? { cancelledAt: now } : {}),
        },
      });
      if (shipment.kind === "outbound") {
        if (next === "picked_up" || next === "in_transit") {
          await advanceFulfillment(tx, shipment.orderId, "in_transit", data, actor);
        } else if (next === "delivered") {
          await advanceFulfillment(tx, shipment.orderId, "delivered", data, actor);
        } else if (next === "returned") {
          const states = await lockOrder(tx, shipment.orderId);
          if (
            states &&
            ["fulfilled", "in_transit", "delivered"].includes(states.fulfillmentStatus)
          ) {
            await transitionOrder(
              tx,
              shipment.orderId,
              { fulfillmentStatus: "returned" },
              {
                type: "order.returned_to_sender",
                message: `Coletul AWB ${shipment.awb} s-a întors la expeditor`,
                data: { awb: shipment.awb, carrier: shipment.carrier },
                actorLabel: actor.actorLabel,
              },
              now,
            );
          }
        } else if (next === "cancelled") {
          const states = await lockOrder(tx, shipment.orderId);
          if (states && ["fulfilled", "in_transit"].includes(states.fulfillmentStatus)) {
            await transitionOrder(
              tx,
              shipment.orderId,
              { fulfillmentStatus: "unfulfilled" },
              {
                type: "shipment.cancelled",
                message: `AWB ${shipment.awb} a fost anulat la curier`,
                data: { awb: shipment.awb, carrier: shipment.carrier },
                actorLabel: actor.actorLabel,
              },
              now,
            );
          }
        }
      }
    } else {
      await tx.shipment.update({ where: { id: shipmentId }, data: { lastSyncedAt: now } });
    }
    return { changed: next !== current, status: next, newEvents: written.count };
  });
}

export interface SyncResult {
  checked: number;
  changed: number;
  failed: number;
  /** Mai sunt expedieri de verificat (lot plin): următoarea rulare le preia. */
  more: boolean;
}

/**
 * Sincronizarea statusului (jobul la 10 minute): pentru expedierile prin API încă deschise, cele mai demult verificate întâi.
 * O expediere a cărei urmărire eșuează (curier picat, întrerupător deschis) nu le oprește pe celelalte și nu schimbă nimic la
 * ea; se reîncearcă la rularea următoare. Niciun mesaj de eroare cu date nu se păstrează.
 */
export async function syncShipmentStatuses(
  db: Db,
  resolveCarrier: (provider: string) => Promise<ShippingCarrier | null>,
  options: { now: Date; limit?: number },
): Promise<SyncResult> {
  const limit = options.limit ?? 100;
  const open = await db.shipment.findMany({
    where: { mode: "provider", status: { in: ["created", "picked_up", "in_transit"] } },
    orderBy: [{ lastSyncedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: limit + 1,
  });
  const carriers = new Map<string, ShippingCarrier | null>();
  let changed = 0;
  let failed = 0;
  for (const shipment of open.slice(0, limit)) {
    const provider = shipment.provider ?? "";
    if (!carriers.has(provider)) carriers.set(provider, await resolveCarrier(provider));
    const carrier = carriers.get(provider);
    if (!carrier) {
      failed += 1;
      continue;
    }
    try {
      const tracking = await carrier.track({
        awb: shipment.awb,
        providerRef: shipment.providerRef,
      });
      const outcome = await applyTrackingUpdate(db, shipment.id, tracking, options.now);
      if (outcome.changed) changed += 1;
    } catch {
      failed += 1;
    }
  }
  return { checked: Math.min(open.length, limit), changed, failed, more: open.length > limit };
}

// -------------------------------------------------------------------------------------------------------------- citire

export interface ShipmentView {
  id: string;
  kind: "outbound" | "return";
  mode: "provider" | "manual";
  provider: string | null;
  carrier: string;
  awb: string;
  trackingUrl: string | null;
  status: ShipmentStatus;
  codAmountMinor: number;
  parentId: string | null;
  createdAt: Date;
  lastSyncedAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  creatorLabel: string | null;
  events: Array<{ code: string; label: string; occurredAt: Date }>;
}

export async function listOrderShipments(db: Db, orderId: string): Promise<ShipmentView[]> {
  const rows = await db.shipment.findMany({
    where: { orderId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: { events: { orderBy: { occurredAt: "asc" } } },
  });
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind === "return" ? "return" : "outbound",
    mode: row.mode === "provider" ? "provider" : "manual",
    provider: row.provider,
    carrier: row.carrier,
    awb: row.awb,
    trackingUrl: row.trackingUrl,
    status: row.status as ShipmentStatus,
    codAmountMinor: row.codAmountMinor,
    parentId: row.parentId,
    createdAt: row.createdAt,
    lastSyncedAt: row.lastSyncedAt,
    deliveredAt: row.deliveredAt,
    cancelledAt: row.cancelledAt,
    creatorLabel: row.creatorLabel,
    events: row.events.map((event) => ({
      code: event.code,
      label: event.label,
      occurredAt: event.occurredAt,
    })),
  }));
}

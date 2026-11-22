"use server";

import { z } from "zod";
import {
  cancelShipment,
  createCarrierReturn,
  createCarrierShipment,
  createCarrierShipmentsBulk,
  createManualReturn,
  createManualShipment,
  markCodCollected,
  markShipmentDelivered,
  type BulkShipmentOutcome,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { getAudit } from "@/lib/admin-writes";
import { errorCodeOf } from "@/lib/error-code";
import { parseMoneyInput } from "@/lib/money-input";
import { getCarrierRuntime } from "@/lib/shipping";
import { withPermission } from "@/lib/session";

/**
 * Acțiunile adminului de expediere și de reconciliere a rambursului (Faza 12). Fiecare cere permisiunea ei (verificată din nou pe
 * server, la fiecare apel), validează intrarea cu Zod, apelează serviciul din `packages/core` (care scrie `OrderEvent` în aceeași
 * tranzacție și trece starea prin state machine) și scrie auditul: actorul, acțiunea, AWB-ul și transportatorul, NICIODATĂ adresa,
 * telefonul sau emailul clientului. Rezultatul e un cod stabil, tradus în mesaj de interfață. Apelul la curier se face în serviciu,
 * în afara tranzacției; un curier picat lasă comanda neexpediată.
 */
type Fail = { ok: false; code: string };

const id = z.string().min(1).max(64);
const text = (max: number) => z.string().max(max);

const SHIPPING_PREFIXES = ["SHIPMENT_", "SHIPPING_", "ORDER_"] as const;

function failure(error: unknown): Fail {
  return { ok: false, code: errorCodeOf(error, SHIPPING_PREFIXES) ?? "failed" };
}

const auditShipment = (
  subject: { userId: string; email: string },
  action: string,
  orderId: string,
  after: Record<string, unknown>,
) =>
  getAudit().record({
    actorId: subject.userId,
    actorLabel: subject.email,
    action,
    entity: "order",
    entityId: orderId,
    after,
  });

// --- AWB manual (transport paletizat) ----------------------------------------------------------------------------------

const manualForm = z.strictObject({
  orderId: id,
  carrier: text(200),
  awb: text(200),
  trackingUrl: text(500).optional(),
});

export type ShipmentActionResult = { ok: true; awb?: string } | Fail;

export const createManualShipmentAction = withPermission(
  "orders.fulfill",
  async (raw: unknown, subject): Promise<ShipmentActionResult> => {
    const parsed = manualForm.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      const result = await createManualShipment(getDb(), parsed.data.orderId, {
        carrier: parsed.data.carrier,
        awb: parsed.data.awb,
        trackingUrl: parsed.data.trackingUrl ?? null,
        actorLabel: subject.email,
        now: new Date(),
      });
      await auditShipment(subject, "shipment.create-manual", parsed.data.orderId, {
        shipmentId: result.shipmentId,
        awb: result.awb,
        carrier: parsed.data.carrier.trim(),
      });
      return { ok: true, awb: result.awb };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "shipment.create-manual", entity: "order" },
);

// --- AWB prin curier ----------------------------------------------------------------------------------------------------

const orderForm = z.strictObject({ orderId: id });

export const createCarrierShipmentAction = withPermission(
  "orders.fulfill",
  async (raw: unknown, subject): Promise<ShipmentActionResult> => {
    const parsed = orderForm.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      const carrier = await getCarrierRuntime().activeCarrier();
      if (!carrier) return { ok: false, code: "SHIPMENT_NO_SERVICE" };
      const result = await createCarrierShipment(getDb(), parsed.data.orderId, {
        carrier,
        actorLabel: subject.email,
        now: new Date(),
      });
      await auditShipment(subject, "shipment.create-carrier", parsed.data.orderId, {
        shipmentId: result.shipmentId,
        awb: result.awb,
        provider: carrier.code,
      });
      return { ok: true, awb: result.awb };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "shipment.create-carrier", entity: "order" },
);

const bulkForm = z.strictObject({ orderIds: z.array(id).min(1).max(50) });

export type BulkShipmentResult = { ok: true; outcomes: BulkShipmentOutcome[] } | Fail;

export const createBulkShipmentsAction = withPermission(
  "orders.fulfill",
  async (raw: unknown, subject): Promise<BulkShipmentResult> => {
    const parsed = bulkForm.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      const carrier = await getCarrierRuntime().activeCarrier();
      if (!carrier) return { ok: false, code: "SHIPMENT_NO_SERVICE" };
      const outcomes = await createCarrierShipmentsBulk(getDb(), parsed.data.orderIds, {
        carrier,
        actorLabel: subject.email,
        now: new Date(),
      });
      // câte o înregistrare de audit pe comandă expediată, fără nicio dată personală
      for (const outcome of outcomes) {
        if (outcome.ok) {
          await auditShipment(subject, "shipment.create-carrier", outcome.orderId, {
            awb: outcome.awb,
            provider: carrier.code,
            bulk: true,
          });
        }
      }
      return { ok: true, outcomes };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "shipment.create-bulk", entity: "order" },
);

// --- livrată, anulare, retur --------------------------------------------------------------------------------------------

const shipmentForm = z.strictObject({ shipmentId: id, orderId: id });

export const markShipmentDeliveredAction = withPermission(
  "orders.fulfill",
  async (raw: unknown, subject): Promise<ShipmentActionResult> => {
    const parsed = shipmentForm.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      const result = await markShipmentDelivered(getDb(), parsed.data.shipmentId, {
        actorLabel: subject.email,
        now: new Date(),
      });
      if (!result.alreadyDelivered) {
        await auditShipment(subject, "shipment.delivered", parsed.data.orderId, {
          shipmentId: parsed.data.shipmentId,
        });
      }
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "shipment.delivered", entity: "order" },
);

async function carrierFor(provider: string | null) {
  return provider ? getCarrierRuntime().carrier(provider) : null;
}

export const cancelShipmentAction = withPermission(
  "orders.fulfill",
  async (raw: unknown, subject): Promise<ShipmentActionResult> => {
    const parsed = shipmentForm.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      const db = getDb();
      const shipment = await db.shipment.findUnique({
        where: { id: parsed.data.shipmentId },
        select: { provider: true, awb: true },
      });
      const result = await cancelShipment(db, parsed.data.shipmentId, {
        carrier: await carrierFor(shipment?.provider ?? null),
        actorLabel: subject.email,
        now: new Date(),
      });
      if (!result.alreadyCancelled) {
        await auditShipment(subject, "shipment.cancel", parsed.data.orderId, {
          shipmentId: parsed.data.shipmentId,
          awb: shipment?.awb ?? null,
        });
      }
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "shipment.cancel", entity: "order" },
);

const returnForm = z.strictObject({
  shipmentId: id,
  orderId: id,
  mode: z.enum(["carrier", "manual"]),
  carrier: text(200).optional(),
  awb: text(200).optional(),
  trackingUrl: text(500).optional(),
});

export const createReturnShipmentAction = withPermission(
  "orders.fulfill",
  async (raw: unknown, subject): Promise<ShipmentActionResult> => {
    const parsed = returnForm.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    const data = parsed.data;
    try {
      const db = getDb();
      const actor = { actorLabel: subject.email, now: new Date() };
      let result;
      if (data.mode === "manual") {
        result = await createManualReturn(db, data.shipmentId, {
          carrier: data.carrier ?? "",
          awb: data.awb ?? "",
          trackingUrl: data.trackingUrl ?? null,
          ...actor,
        });
      } else {
        const parent = await db.shipment.findUnique({
          where: { id: data.shipmentId },
          select: { provider: true },
        });
        const carrier = await carrierFor(parent?.provider ?? null);
        if (!carrier) return { ok: false, code: "SHIPMENT_NO_SERVICE" };
        result = await createCarrierReturn(db, data.shipmentId, { carrier, ...actor });
      }
      await auditShipment(subject, "shipment.return", data.orderId, {
        shipmentId: result.shipmentId,
        awb: result.awb,
        mode: data.mode,
      });
      return { ok: true, awb: result.awb };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "shipment.return", entity: "order" },
);

// --- reconcilierea rambursului ------------------------------------------------------------------------------------------

const codForm = z.strictObject({
  orderId: id,
  amount: text(40),
  reference: text(200),
  /** AAAA-LL-ZZ, în ora magazinului (sfârșitul zilei UTC, limitat la momentul curent: o dată de azi nu se respinge din cauza orei). */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  acceptDifference: z.boolean(),
});

export type CollectCodResult = { ok: true; already: boolean; differenceMinor: number } | Fail;

export const markCodCollectedAction = withPermission(
  "orders.mark_paid",
  async (raw: unknown, subject): Promise<CollectCodResult> => {
    const parsed = codForm.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    const amountMinor = parseMoneyInput(parsed.data.amount);
    if (amountMinor === null || amountMinor < 1) {
      return { ok: false, code: "ORDER_PAYMENT_AMOUNT_INVALID" };
    }
    const collectedAt = new Date(`${parsed.data.date}T23:59:59.000Z`);
    if (Number.isNaN(collectedAt.getTime()))
      return { ok: false, code: "ORDER_PAYMENT_DATE_INVALID" };
    const now = new Date();
    try {
      const result = await markCodCollected(getDb(), parsed.data.orderId, {
        amountMinor,
        reference: parsed.data.reference,
        // sfârșitul zilei alese, dar niciodată în viitor
        collectedAt: collectedAt.getTime() > now.getTime() ? now : collectedAt,
        acceptDifference: parsed.data.acceptDifference,
        actorLabel: subject.email,
        now,
      });
      if (!result.alreadyPaid) {
        await auditShipment(subject, "order.cod-collected", parsed.data.orderId, {
          receivedMinor: amountMinor,
          differenceMinor: result.differenceMinor,
          acceptedDifference: parsed.data.acceptDifference,
        });
      }
      return { ok: true, already: result.alreadyPaid, differenceMinor: result.differenceMinor };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "order.cod-collected", entity: "order" },
);

import type { Prisma } from "@ecom/db";
import type { Db } from "../db-tx";
import {
  decideGrant,
  decideRevocation,
  generateAccessToken,
  type GrantReason,
} from "./digital-rules";

/**
 * Acordarea și retragerea accesului digital (Faza 14b), legate de EVENIMENTELE comenzii: `scheduleDigitalAccess` se apelează din
 * `addOrderEvent`, în aceeași tranzacție cu evenimentul, ca facturile și emailurile. Nu există altă cale de acordare automată.
 *
 * Acordare (regulile în `digital-rules.ts`, decizia 1): card și transfer la plata confirmată, ramburs mixt la livrarea confirmată.
 * Idempotență: un drept de acces e unic pe linia de comandă (`orderLineId`), iar `INSERT … ON CONFLICT DO NOTHING` face ca două
 * evenimente simultane (plată + livrare, sau același eveniment procesat de două ori) să dea UN SINGUR drept; evenimentul de
 * acordare (`digital.granted`, care declanșează emailul «Produsul tău e gata», prin outbox) se scrie doar pentru drepturile
 * efectiv create. Niciun efect extern aici: emailul pleacă din coadă, nu din tranzacție.
 *
 * Retragere: la rambursare integrală, chargeback sau anulare, pentru toată comanda; la rambursarea unei LINII (cheia de
 * idempotență `digital-line:<linie>` a rambursării cerute din ecranul comenzii), doar pentru acea linie. O rambursare parțială fără
 * cheie de linie nu retrage nimic (nu se știe ce linie).
 */
export const DIGITAL_LINE_REFUND_KEY_PREFIX = "digital-line:";

export const GRANT_TRIGGER_EVENT_TYPES: readonly string[] = [
  "payment.confirmed",
  "order.delivered",
  "order.picked_up",
];
export const REVOKE_TRIGGER_EVENT_TYPES: readonly string[] = [
  "payment.refunded",
  "order.cancelled",
  "order.auto_cancelled",
];

/**
 * Scrie un eveniment al comenzii. Îl dă apelantul (`addOrderEvent`), ca acest modul să nu importe `order-service` (care îl importă pe el):
 * fără import circular.
 */
export type EmitOrderEvent = (
  tx: Db,
  orderId: string,
  event: { type: string; message: string; data?: Prisma.InputJsonValue },
) => Promise<void>;

/**
 * Ce îi dă `addOrderEvent` acestui modul (fără import circular): scrierea unui eveniment și trecerea comenzii 100% digitale în
 * «fulfilled» la acordarea accesului (singura cale de schimbare a stării de livrare e `transitionOrder`).
 */
export interface DigitalPorts {
  emit: EmitOrderEvent;
  fulfill: (tx: Db, orderId: string, now: Date) => Promise<void>;
}

export interface DigitalEvent {
  id: string;
  type: string;
  data?: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

interface DigitalOrderFacts {
  paymentMethod: "cod" | "bank_transfer" | "card";
  paymentStatus: string;
  status: string;
  fulfillmentStatus: string;
  customerId: string | null;
  digitalLines: Array<{ id: string; productId: string | null }>;
  physicalLineCount: number;
}

async function loadFacts(tx: Db, orderId: string): Promise<DigitalOrderFacts | null> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      paymentMethod: true,
      paymentStatus: true,
      status: true,
      fulfillmentStatus: true,
      customerId: true,
      lines: {
        select: {
          id: true,
          isDigital: true,
          productSnapshot: true,
          variant: { select: { productId: true } },
        },
      },
    },
  });
  if (!order) return null;
  const method = order.paymentMethod;
  if (method !== "cod" && method !== "bank_transfer" && method !== "card") return null;
  const digital = order.lines.filter((line) => line.isDigital);
  return {
    paymentMethod: method,
    paymentStatus: order.paymentStatus,
    status: order.status,
    fulfillmentStatus: order.fulfillmentStatus,
    customerId: order.customerId,
    digitalLines: digital.map((line) => {
      const snapshotId = asRecord(line.productSnapshot)["productId"];
      return {
        id: line.id,
        productId: line.variant?.productId ?? (typeof snapshotId === "string" ? snapshotId : null),
      };
    }),
    physicalLineCount: order.lines.length - digital.length,
  };
}

/** Acordă drepturile lipsă ale comenzii; întoarce câte au fost create (0 la o a doua apelare). */
export async function grantEntitlements(
  tx: Db,
  orderId: string,
  facts: Pick<
    DigitalOrderFacts,
    "customerId" | "digitalLines" | "physicalLineCount" | "fulfillmentStatus"
  >,
  reason: GrantReason,
  now: Date,
  ports: DigitalPorts,
): Promise<number> {
  const { emit } = ports;
  if (!facts.customerId) {
    // fără cont nu există cui să-i acorzi accesul; checkout-ul nu poate produce o astfel de comandă digitală
    const already = await tx.orderEvent.count({
      where: { orderId, type: "digital.grant_blocked" },
    });
    if (already === 0) {
      await emit(tx, orderId, {
        type: "digital.grant_blocked",
        message: "Accesul digital nu s-a putut acorda: comanda nu are un cont de client",
      });
    }
    return 0;
  }
  const lines = facts.digitalLines.filter(
    (line): line is { id: string; productId: string } => line.productId !== null,
  );
  if (lines.length === 0) return 0;
  const products = await tx.digitalProduct.findMany({
    where: { productId: { in: [...new Set(lines.map((line) => line.productId))] } },
    select: { productId: true, maxDownloads: true },
  });
  const limitOf = new Map(products.map((p) => [p.productId, p.maxDownloads]));
  const created = await tx.digitalEntitlement.createManyAndReturn({
    data: lines.map((line) => ({
      orderId,
      orderLineId: line.id,
      customerId: facts.customerId as string,
      productId: line.productId,
      accessToken: generateAccessToken(),
      grantReason: reason,
      grantedAt: now,
      maxDownloads: limitOf.get(line.productId) ?? null,
    })),
    skipDuplicates: true,
    select: { id: true },
  });
  if (created.length > 0) {
    // comanda doar cu produse digitale nu are nimic de expediat: accesul acordat o încheie (fulfilled). Comenzile MIXTE nu se ating:
    // starea lor de livrare e a părții fizice, iar digitalul se vede în panoul «Acces digital».
    if (facts.physicalLineCount === 0 && facts.fulfillmentStatus === "unfulfilled") {
      await ports.fulfill(tx, orderId, now);
    }
    await emit(tx, orderId, {
      type: "digital.granted",
      message:
        reason === "delivery"
          ? "Acces digital acordat la livrarea confirmată a comenzii"
          : "Acces digital acordat după confirmarea plății",
      data: { count: created.length, reason },
    });
  }
  return created.length;
}

/** Retrage accesul activ al comenzii (sau al unei singure linii); întoarce câte drepturi s-au retras. */
export async function revokeEntitlements(
  tx: Db,
  orderId: string,
  options: { reason: string; revokedBy: string | null; orderLineId?: string; now: Date },
  emit: EmitOrderEvent,
): Promise<number> {
  const result = await tx.digitalEntitlement.updateMany({
    where: {
      orderId,
      revokedAt: null,
      ...(options.orderLineId ? { orderLineId: options.orderLineId } : {}),
    },
    data: { revokedAt: options.now, revokedReason: options.reason, revokedBy: options.revokedBy },
  });
  if (result.count > 0) {
    await emit(tx, orderId, {
      type: "digital.revoked",
      message: `Acces digital retras: ${options.reason}`,
      data: { count: result.count },
    });
  }
  return result.count;
}

async function refundedLineId(tx: Db, event: DigitalEvent): Promise<string | null> {
  const refundId = asRecord(event.data)["refundId"];
  if (typeof refundId !== "string") return null;
  const refund = await tx.refund.findUnique({
    where: { id: refundId },
    select: { status: true, idempotencyKey: true },
  });
  if (!refund || refund.status !== "confirmed") return null;
  if (!refund.idempotencyKey.startsWith(DIGITAL_LINE_REFUND_KEY_PREFIX)) return null;
  const lineId = refund.idempotencyKey.slice(DIGITAL_LINE_REFUND_KEY_PREFIX.length).split(":")[0];
  return lineId ? lineId : null;
}

/**
 * Punctul de intrare din `addOrderEvent`: decide dacă evenimentul acordă sau retrage accesul. Evenimentele fără legătură cu
 * accesul nu costă nimic (o comparație de șiruri).
 */
export async function scheduleDigitalAccess(
  tx: Db,
  orderId: string,
  event: DigitalEvent,
  ports: DigitalPorts,
  now: Date = new Date(),
): Promise<void> {
  const { emit } = ports;
  const isGrant = GRANT_TRIGGER_EVENT_TYPES.includes(event.type);
  const isRevoke = REVOKE_TRIGGER_EVENT_TYPES.includes(event.type);
  if (!isGrant && !isRevoke) return;
  const facts = await loadFacts(tx, orderId);
  if (!facts || facts.digitalLines.length === 0) return;

  if (isRevoke) {
    const reason = decideRevocation(facts);
    if (reason) {
      await revokeEntitlements(tx, orderId, { reason, revokedBy: null, now }, emit);
      return;
    }
    const lineId = event.type === "payment.refunded" ? await refundedLineId(tx, event) : null;
    if (lineId) {
      await revokeEntitlements(
        tx,
        orderId,
        { reason: "Linia a fost rambursată", revokedBy: null, orderLineId: lineId, now },
        emit,
      );
    }
    return;
  }

  const decision = decideGrant({
    paymentMethod: facts.paymentMethod,
    paymentStatus: facts.paymentStatus,
    status: facts.status,
    fulfillmentStatus: facts.fulfillmentStatus,
    hasDigital: true,
    hasPhysical: facts.physicalLineCount > 0,
  });
  if (decision.grant) await grantEntitlements(tx, orderId, facts, decision.reason, now, ports);
}

import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@ecom/db";
import type {
  CreatePaymentResult,
  PaymentMode,
  PaymentProvider,
  PaymentProviderCode,
} from "@ecom/shared";
import { quantityFromTicks } from "@ecom/shared";
import { inTx, type Db } from "../db-tx";
import { ORDER_REF_TYPE } from "../inventory/constants";
import { StockError } from "../inventory/stock-errors";
import { StockService } from "../inventory/stock-service";
import { reservationExpiresAt } from "../inventory/workdays";
import {
  addOrderEvent,
  lockOrder,
  setReservationExpiry,
  transitionOrder,
} from "../orders/order-service";
import { lockPayment } from "./payment-db";
import { PaymentError } from "./payment-errors";

/**
 * Plata cu cardul pe partea comenzii (Faza 10): inițierea la furnizor (în afara tranzacției, cu timp limită), «reîncearcă
 * plata» (link valabil 24 h, jeton aleatoriu cu amprentă în bază), anularea automată la sfârșitul ferestrei și starea
 * citită de paginile de retur și de așteptare.
 *
 * CICLUL DE VIAȚĂ (comandă / rezervare / reîncercare), fără goluri:
 *  1. plasare: comanda `pending/pending`, rezervare de `inventory.reservationMinutes` minute, tentativa 1 (`pending`),
 *     fereastra de reîncercare = `payment.cardRetryHours` ore de la plasare (`paymentRetryDeadlineAt`);
 *  2. inițierea: dacă furnizorul nu răspunde sau refuză, tentativa devine `failed`, stocul se eliberează, comanda RĂMÂNE în
 *     așteptare, cu «reîncearcă plata» disponibil;
 *  3. plata confirmată (notificare): comanda `confirmed/paid` (vezi `payment-processor`); plata eșuată/anulată de client:
 *     tentativa `failed`, rezervarea eliberată, comanda rămâne în așteptare;
 *  4. «reîncearcă plata»: tentativă nouă; stocul se RE-VALIDEAZĂ și se rezervă din nou DOAR dacă există (altfel mesaj clar, fără
 *     supravânzare); tentativele anterioare încă în așteptare se anulează;
 *  5. rezervarea expiră singură după 15 minute (`stock-expire-reservations`); comanda NU se anulează atunci (clientul poate
 *     reîncerca), iar o plată confirmată târziu re-rezervă atomic dacă mai e stoc, altfel se rambursează;
 *  6. la sfârșitul ferestrei, jobul `order-expire-card` anulează comanda (fără tentative recente și fără plăți care cer atenție).
 */

export interface CardSettings {
  reservationMinutes: number;
  transferReservationWorkdays: number;
  timeZone: string;
  nonWorkingDates: readonly string[];
  cardRetryHours: number;
  /** Furnizorul activ al cardului acum (sau `null`). */
  cardProvider: { code: PaymentProviderCode; mode: PaymentMode } | null;
}

export interface CardPaymentDeps {
  db: Db;
  getProvider: (code: string) => Promise<PaymentProvider | null>;
  readSettings: () => Promise<CardSettings>;
  now: () => Date;
  /** Adresele publice ale aplicației (fără parametri secreți). */
  returnUrl: (paymentId: string) => string;
  notifyUrl: (provider: string) => string;
  /** 32 de octeți aleatorii; testele îl înlocuiesc. */
  randomBytes?: (size: number) => Buffer;
}

export type InitiateResult =
  | { kind: "redirect"; redirect: CreatePaymentResult["redirect"] }
  | { kind: "failed"; reason: "unavailable" | "provider_error" | "not_pending" };

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function splitName(fullName: string): { firstName: string; lastName: string } {
  const trimmed = fullName.trim();
  const index = trimmed.indexOf(" ");
  return index === -1
    ? { firstName: trimmed, lastName: "-" }
    : { firstName: trimmed.slice(0, index), lastName: trimmed.slice(index + 1).trim() || "-" };
}

export class CardPaymentService {
  constructor(private readonly deps: CardPaymentDeps) {}

  /**
   * Inițiază plata unei tentative `pending`: apel la furnizor cu timp limită, în afara oricărei tranzacții. La eșec comanda
   * NU se pierde: tentativa devine `failed`, stocul se eliberează, iar clientul are «reîncearcă plata».
   */
  async initiate(paymentId: string): Promise<InitiateResult> {
    const { db } = this.deps;
    const payment = await db.payment.findUnique({
      where: { id: paymentId },
      include: {
        order: {
          include: { addresses: true },
        },
      },
    });
    if (!payment) throw new PaymentError("PAYMENT_NOT_FOUND", "Plata nu există");
    const order = payment.order;
    if (
      payment.status !== "pending" ||
      payment.providerRef !== null ||
      order.status !== "pending" ||
      order.paymentStatus !== "pending" ||
      payment.method !== "card"
    ) {
      return { kind: "failed", reason: "not_pending" };
    }
    const provider = await this.deps.getProvider(payment.provider);
    if (!provider) {
      await this.failInitiation(payment.id, order.id, "provider_not_configured");
      return { kind: "failed", reason: "unavailable" };
    }
    const billing = order.addresses.find((a) => a.kind === "billing");
    const shipping = order.addresses.find((a) => a.kind === "shipping") ?? billing;
    const address = billing ?? shipping;
    const { firstName, lastName } = splitName(address?.fullName ?? "Client");
    try {
      const result = await provider.createPayment({
        paymentRef: payment.id,
        orderNumber: order.number,
        amountMinor: payment.amountMinor,
        currency: "RON",
        description: `Comanda ${order.number}`,
        customer: {
          firstName,
          lastName,
          email: order.email,
          phone: order.phone,
          street: address?.street ?? "",
          city: address?.localityName ?? "",
          county: address?.countyName ?? "",
          postalCode: address?.postalCode ?? "",
        },
        returnUrl: this.deps.returnUrl(payment.id),
        notifyUrl: this.deps.notifyUrl(payment.provider),
      });
      await db.payment.updateMany({
        where: { id: payment.id, status: "pending" },
        data: result.providerRef ? { providerRef: result.providerRef } : {},
      });
      await addOrderEvent(db, order.id, {
        type: "payment.initiated",
        message: "Clientul a fost trimis la pagina procesatorului de plăți",
        data: { provider: payment.provider, attempt: payment.attemptNo },
      });
      return { kind: "redirect", redirect: result.redirect };
    } catch {
      await this.failInitiation(payment.id, order.id, "provider_error");
      return { kind: "failed", reason: "provider_error" };
    }
  }

  private async failInitiation(paymentId: string, orderId: string, code: string): Promise<void> {
    const now = this.deps.now();
    await inTx(this.deps.db, async (tx) => {
      const states = await lockOrder(tx, orderId);
      await lockPayment(tx, paymentId);
      const updated = await tx.payment.updateMany({
        where: { id: paymentId, status: "pending" },
        data: { status: "failed", failureCode: code },
      });
      if (updated.count === 1 && states?.status === "pending") {
        await new StockService({ db: tx, now: () => now }).release({
          refType: ORDER_REF_TYPE,
          refId: orderId,
        });
        await addOrderEvent(tx, orderId, {
          type: "payment.initiation_failed",
          message:
            "Plata cu cardul nu a putut fi pornită; comanda rămâne în așteptare și plata se poate reîncerca",
          data: { code },
        });
      }
    });
  }

  // ------------------------------------------------------------------------------------------------ reîncearcă plata

  /** Jetonul nou pentru «reîncearcă plata» (cel vechi se invalidează). Întoarce jetonul în clar o singură dată. */
  async issueRetryToken(orderId: string): Promise<{ token: string; expiresAt: Date }> {
    return issueRetryTokenFor(this.deps, orderId);
  }

  /** Comanda din spatele unui jeton valid, sau `null` (jeton necunoscut, invalidat sau expirat; fără detalii despre motiv). */
  async resolveRetryToken(token: string): Promise<{ orderId: string } | null> {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
    const row = await this.deps.db.paymentRetryToken.findUnique({
      where: { tokenHash: sha256Hex(token) },
    });
    if (!row || row.usedAt !== null || row.expiresAt <= this.deps.now()) return null;
    return { orderId: row.orderId };
  }

  /**
   * Pornește o tentativă nouă pentru comanda din spatele jetonului: re-validează stocul și rezervă DOAR dacă există;
   * anulează tentativele anterioare rămase în așteptare; creează tentativa. Inițierea la furnizor o face apelantul
   * (`initiate`), în afara tranzacției.
   */
  async startRetry(token: string): Promise<{ orderId: string; paymentId: string }> {
    const resolved = await this.resolveRetryToken(token);
    if (!resolved) {
      throw new PaymentError("PAYMENT_RETRY_UNAVAILABLE", "Linkul de plată nu mai este valabil");
    }
    const settings = await this.deps.readSettings();
    if (!settings.cardProvider) {
      throw new PaymentError(
        "PAYMENT_CARD_UNAVAILABLE",
        "Plata cu cardul nu este disponibilă acum",
      );
    }
    const provider = settings.cardProvider;
    const at = this.deps.now();
    return inTx(this.deps.db, async (tx) => {
      const states = await lockOrder(tx, resolved.orderId);
      const order = await tx.order.findUnique({
        where: { id: resolved.orderId },
        include: { lines: true },
      });
      if (
        !states ||
        !order ||
        order.paymentMethod !== "card" ||
        states.status !== "pending" ||
        states.paymentStatus !== "pending"
      ) {
        throw new PaymentError(
          "PAYMENT_RETRY_UNAVAILABLE",
          "Plata acestei comenzi nu mai poate fi reîncercată",
        );
      }
      if (!order.paymentRetryDeadlineAt || order.paymentRetryDeadlineAt <= at) {
        throw new PaymentError(
          "PAYMENT_RETRY_EXPIRED",
          "Fereastra de reîncercare a plății a expirat",
        );
      }
      const paid = await tx.payment.count({
        where: { orderId: order.id, status: { in: ["paid", "refunded"] } },
      });
      if (paid > 0) {
        throw new PaymentError("PAYMENT_RETRY_UNAVAILABLE", "Comanda este deja plătită");
      }
      // re-rezervare: doar dacă stocul există (tot-sau-nimic); altfel mesaj clar, fără supravânzare
      const reservationEnd = reservationExpiresAt("card", at, {
        reservationMinutes: settings.reservationMinutes,
        transferReservationWorkdays: settings.transferReservationWorkdays,
        timeZone: settings.timeZone,
        nonWorkingDates: settings.nonWorkingDates,
      });
      const lines = order.lines.map((line) => {
        if (!line.variantId) {
          throw new PaymentError("PAYMENT_RETRY_NO_STOCK", "Un produs din comandă nu mai există");
        }
        return { variantId: line.variantId, quantity: quantityFromTicks(line.quantity) };
      });
      try {
        await new StockService({ db: tx, now: () => at }).reserve(
          { refType: ORDER_REF_TYPE, refId: order.id },
          lines,
          reservationEnd,
        );
      } catch (error) {
        if (error instanceof StockError && error.code === "STOCK_INSUFFICIENT") {
          throw new PaymentError(
            "PAYMENT_RETRY_NO_STOCK",
            "Produsele din comandă nu mai sunt în stoc în cantitatea comandată",
          );
        }
        throw error;
      }
      // tentativele rămase în așteptare nu mai sunt valabile
      await tx.payment.updateMany({
        where: { orderId: order.id, status: "pending" },
        data: { status: "cancelled" },
      });
      const last = await tx.payment.aggregate({
        where: { orderId: order.id },
        _max: { attemptNo: true },
      });
      const attemptNo = (last._max.attemptNo ?? 0) + 1;
      const payment = await tx.payment.create({
        select: { id: true },
        data: {
          orderId: order.id,
          provider: provider.code,
          method: "card",
          amountMinor: order.totalMinor,
          attemptNo,
          mode: provider.mode,
          idempotencyKey: `card:${order.id}:${attemptNo}`,
        },
      });
      await setReservationExpiry(tx, order.id, reservationEnd);
      await addOrderEvent(tx, order.id, {
        type: "payment.retry_started",
        message: "Clientul a reîncercat plata cu cardul; stocul a fost rezervat din nou",
        data: { attempt: attemptNo, reservationExpiresAt: reservationEnd.toISOString() },
      });
      return { orderId: order.id, paymentId: payment.id };
    });
  }

  // ----------------------------------------------------------------------------------------------- starea pentru pagini

  /** Starea plății unei comenzi, pentru pagina de retur/așteptare (citește DOAR baza noastră, actualizată de notificări). */
  async stateOfOrder(orderId: string): Promise<CardPaymentView | null> {
    return readCardPaymentView(this.deps.db, orderId, this.deps.now());
  }
}

/** După cât timp fără răspuns de la procesator se oferă «reîncearcă plata» și cât timp încă «se verifică». */
export const RETRY_AFTER_PENDING_SECONDS = 120;

export type CardPaymentState =
  | "checking" // se așteaptă confirmarea procesatorului
  | "paid"
  | "failed" // refuzată sau anulată de client: se poate reîncerca
  | "cancelled" // comandă anulată (expirată sau de admin)
  | "stock_lost" // plată primită, dar produsele nu mai sunt în stoc: anulată, suma se returnează
  | "attention"; // suma/moneda nu corespund: o verificăm noi

export interface CardPaymentView {
  orderNumber: string;
  /** Ultima tentativă de plată (pagina de retur/așteptare pornește de la ea). */
  paymentId: string | null;
  state: CardPaymentState;
  canRetry: boolean;
  retryDeadlineAt: Date | null;
  attemptNo: number | null;
  /** Secunde de la inițierea tentativei curente (pagina de așteptare arată un mesaj în plus după un timp). */
  pendingSeconds: number | null;
}

export async function readCardPaymentView(
  db: Db,
  orderId: string,
  now: Date,
): Promise<CardPaymentView | null> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      number: true,
      status: true,
      paymentStatus: true,
      paymentMethod: true,
      paymentRetryDeadlineAt: true,
      events: { where: { type: "payment.stock_lost" }, select: { id: true }, take: 1 },
      payments: { orderBy: { attemptNo: "desc" }, take: 1 },
    },
  });
  if (!order || order.paymentMethod !== "card") return null;
  const last = order.payments[0] ?? null;
  const retryOpen =
    order.status === "pending" &&
    order.paymentStatus === "pending" &&
    order.paymentRetryDeadlineAt !== null &&
    order.paymentRetryDeadlineAt > now;
  let state: CardPaymentState;
  if (order.events.length > 0) state = "stock_lost";
  else if (order.status === "cancelled") state = "cancelled";
  else if (order.paymentStatus === "paid" || order.paymentStatus === "partially_refunded")
    state = "paid";
  else if (last?.attentionReason && !last.attentionResolvedAt) state = "attention";
  else if (last?.status === "failed" || last?.status === "cancelled") state = "failed";
  else state = "checking";
  const pendingSeconds =
    state === "checking" && last
      ? Math.max(0, Math.floor((now.getTime() - last.createdAt.getTime()) / 1000))
      : 0;
  return {
    orderNumber: order.number,
    paymentId: last?.id ?? null,
    state,
    canRetry:
      retryOpen &&
      (state === "failed" ||
        (state === "checking" && pendingSeconds >= RETRY_AFTER_PENDING_SECONDS)),
    retryDeadlineAt: order.paymentRetryDeadlineAt,
    attemptNo: last?.attemptNo ?? null,
    pendingSeconds: state === "checking" && last ? pendingSeconds : null,
  };
}

// ------------------------------------------------------------------------------------------------ anularea automată

export interface ExpireCardResult {
  cancelled: number;
  failed: number;
  more: boolean;
}

/**
 * Anularea AUTOMATĂ a comenzilor cu card al căror termen de reîncercare a trecut fără plată: tranziție validată, `OrderEvent`,
 * rezervarea eliberată, tentativele rămase în așteptare anulate, jetoanele invalidate. Nu atinge: comenzi cu o plată care cere
 * atenție (decide adminul), comenzi cu o tentativă începută în ultimele `graceMs` (clientul poate fi chiar în pagina
 * procesatorului). Idempotentă și sigură la mai multe instanțe (blocare + re-verificare).
 */
export async function expireDueCardOrders(
  db: Db,
  options: { now: Date; limit?: number; graceMs?: number },
): Promise<ExpireCardResult> {
  const limit = options.limit ?? 50;
  const grace = new Date(options.now.getTime() - (options.graceMs ?? 30 * 60_000));
  const due = await db.order.findMany({
    where: {
      paymentMethod: "card",
      status: "pending",
      paymentStatus: "pending",
      paymentRetryDeadlineAt: { lte: options.now },
      payments: {
        none: {
          OR: [
            { attentionReason: { not: null }, attentionResolvedAt: null },
            { status: "pending", createdAt: { gt: grace } },
          ],
        },
      },
    },
    orderBy: [{ paymentRetryDeadlineAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: { id: true },
  });
  let cancelled = 0;
  let failed = 0;
  for (const { id } of due.slice(0, limit)) {
    try {
      const done = await inTx(db, async (tx) => {
        const states = await lockOrder(tx, id);
        if (!states || states.status !== "pending" || states.paymentStatus !== "pending")
          return false;
        const order = await tx.order.findUniqueOrThrow({
          where: { id },
          select: { paymentRetryDeadlineAt: true },
        });
        if (!order.paymentRetryDeadlineAt || order.paymentRetryDeadlineAt > options.now)
          return false;
        const blocking = await tx.payment.count({
          where: {
            orderId: id,
            OR: [
              { status: { in: ["paid", "refunded"] } },
              { attentionReason: { not: null }, attentionResolvedAt: null },
              { status: "pending", createdAt: { gt: grace } },
            ],
          },
        });
        if (blocking > 0) return false;
        await transitionOrder(
          tx,
          id,
          { status: "cancelled", paymentStatus: "cancelled", fulfillmentStatus: "cancelled" },
          {
            type: "order.auto_cancelled",
            message:
              "Comandă anulată automat: plata cu cardul nu s-a finalizat în fereastra de reîncercare",
            data: {
              retryDeadlineAt: order.paymentRetryDeadlineAt.toISOString(),
            } satisfies Prisma.InputJsonObject,
          },
          options.now,
        );
        const released = await new StockService({ db: tx, now: () => options.now }).release({
          refType: ORDER_REF_TYPE,
          refId: id,
        });
        await tx.payment.updateMany({
          where: { orderId: id, status: "pending" },
          data: { status: "cancelled" },
        });
        await tx.paymentRetryToken.updateMany({
          where: { orderId: id, usedAt: null },
          data: { usedAt: options.now },
        });
        if (released > 0) {
          await addOrderEvent(tx, id, {
            type: "stock.released",
            message: "Rezervarea de stoc a fost eliberată",
            data: { released },
          });
        }
        return true;
      });
      if (done) cancelled += 1;
    } catch {
      failed += 1;
    }
  }
  return { cancelled, failed, more: due.length > limit };
}

/**
 * Jetonul «reîncearcă plata» al unei comenzi cu card în așteptare (cel vechi se invalidează). Funcție independentă, ca emailul
 * «plată eșuată» (workerul, Faza 11) să-l poată emite fără să construiască tot serviciul de plată.
 */
export async function issueRetryTokenFor(
  deps: Pick<CardPaymentDeps, "db" | "now" | "randomBytes">,
  orderId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const { db, now } = deps;
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      status: true,
      paymentStatus: true,
      paymentMethod: true,
      paymentRetryDeadlineAt: true,
    },
  });
  const at = now();
  if (
    !order ||
    order.paymentMethod !== "card" ||
    order.status !== "pending" ||
    order.paymentStatus !== "pending" ||
    !order.paymentRetryDeadlineAt
  ) {
    throw new PaymentError(
      "PAYMENT_RETRY_UNAVAILABLE",
      "Plata acestei comenzi nu mai poate fi reîncercată",
    );
  }
  if (order.paymentRetryDeadlineAt <= at) {
    throw new PaymentError("PAYMENT_RETRY_EXPIRED", "Fereastra de reîncercare a plății a expirat");
  }
  const token = (deps.randomBytes ?? randomBytes)(32).toString("base64url");
  await inTx(db, async (tx) => {
    await tx.paymentRetryToken.updateMany({
      where: { orderId, usedAt: null },
      data: { usedAt: at },
    });
    await tx.paymentRetryToken.create({
      data: {
        orderId,
        tokenHash: sha256Hex(token),
        expiresAt: order.paymentRetryDeadlineAt as Date,
      },
    });
  });
  return { token, expiresAt: order.paymentRetryDeadlineAt };
}

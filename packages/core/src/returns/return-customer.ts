import { Prisma } from "@ecom/db";
import { QuantityError, parseQuantity, type Quantity } from "@ecom/shared";
import { inTx, type Db } from "../db-tx";
import { notifyAdmins, orderContext } from "../notifications/admin-notifications";
import { ownedOrderWhere, type AccountUser } from "../account/order-ownership";
import {
  CUSTOMER_CANCELLABLE_STATUSES,
  RETURN_CLIENT_KEY_MAX,
  RETURN_NOTE_MAX,
  RETURN_REASON_CODES,
  RETURN_REASON_TEXT_MAX,
  RETURN_SEND_MODES,
  type ReturnReasonCode,
  type ReturnSendMode,
  type ReturnStatus,
} from "./return-constants";
import { resolveReturnWindow } from "./return-delivery";
import { checkReturnQuantity } from "./return-eligibility";
import { ReturnError } from "./return-errors";
import { loadReturnableLines } from "./return-lines";
import { addReturnEvent, lockReturn, transitionReturn } from "./return-transition";

/**
 * Acțiunile CLIENTULUI asupra retururilor: inițierea și anularea. Fiecare primește clientul autentificat și verifică proprietatea
 * (comanda e a lui, returul e al lui); un retur sau o comandă străină se comportă exact ca unul inexistent (fără să trădeze că
 * există). Validare completă pe server: proprietate, livrare consemnată, fereastra, cantități, motive, idempotență.
 */

export interface ReturnItemInput {
  orderLineId: string;
  /** Cantitatea, ca text («2» sau «2,5»), cu atâtea zecimale câte permite unitatea. */
  quantity: string;
  reasonCode: string;
  reasonText?: string;
}

export interface InitiateReturnInput {
  orderId: string;
  /** Cheia de idempotență a formularului (dublu-click întoarce același retur). */
  clientKey: string;
  items: readonly ReturnItemInput[];
  customerNote?: string;
  sendMode?: string;
}

export interface InitiateReturnResult {
  returnId: string;
  number: number;
  created: boolean;
}

const isReasonCode = (value: string): value is ReturnReasonCode =>
  (RETURN_REASON_CODES as readonly string[]).includes(value);
const isSendMode = (value: string): value is ReturnSendMode =>
  (RETURN_SEND_MODES as readonly string[]).includes(value);

const invalid = (message: string, details?: unknown): ReturnError =>
  new ReturnError("RETURN_INPUT_INVALID", message, details);

const isQuantityTrigger = (error: unknown): boolean =>
  String((error as { message?: unknown } | null)?.message ?? "").includes(
    "return_quantity_exceeded",
  ) || JSON.stringify(error ?? "").includes("return_quantity_exceeded");

export async function initiateReturn(
  db: Db,
  user: AccountUser,
  input: InitiateReturnInput,
  now: Date,
): Promise<InitiateReturnResult> {
  const clientKey = input.clientKey.trim();
  if (clientKey === "" || clientKey.length > RETURN_CLIENT_KEY_MAX) {
    throw invalid("Cheia cererii lipsește");
  }
  const customerNote = input.customerNote?.trim() || null;
  if (customerNote && customerNote.length > RETURN_NOTE_MAX) {
    throw invalid(`Comentariul are cel mult ${RETURN_NOTE_MAX} de caractere`);
  }
  const sendMode = input.sendMode ?? "courier";
  if (!isSendMode(sendMode)) throw invalid("Modul de trimitere nu este valid");
  if (input.items.length === 0) {
    throw new ReturnError("RETURN_NOTHING_RETURNABLE", "Alege cel puțin un produs de returnat");
  }

  return inTx(db, async (tx) => {
    // aceeași cerere repetată (dublu-click): întoarce returul existent, fără alt efect
    const existing = await tx.returnRequest.findUnique({
      where: { userId_clientKey: { userId: user.id, clientKey } },
      select: { id: true, number: true },
    });
    if (existing) return { returnId: existing.id, number: existing.number, created: false };

    const order = await tx.order.findFirst({
      where: ownedOrderWhere(user, input.orderId),
      select: { id: true, number: true, status: true },
    });
    if (!order) throw new ReturnError("RETURN_NOT_FOUND", "Comanda nu există");

    const window = await resolveReturnWindow(tx, order.id, now);
    if (!window.deliveredAt) {
      throw new ReturnError(
        "RETURN_ORDER_NOT_ELIGIBLE",
        "Comanda nu are o livrare consemnată: returul se poate cere după livrare",
      );
    }
    if (!window.open) {
      throw new ReturnError("RETURN_WINDOW_EXPIRED", "Fereastra de retur a expirat", {
        windowDays: window.windowDays,
      });
    }

    const lines = new Map((await loadReturnableLines(tx, order.id)).map((l) => [l.orderLineId, l]));
    const seen = new Set<string>();
    const prepared: Array<{
      orderLineId: string;
      quantity: Quantity;
      reasonCode: ReturnReasonCode;
      reasonText: string | null;
    }> = [];
    for (const item of input.items) {
      if (seen.has(item.orderLineId)) throw invalid("Un produs apare de două ori în cerere");
      seen.add(item.orderLineId);
      const line = lines.get(item.orderLineId);
      if (!line) throw invalid("Produsul nu face parte din comandă");
      if (!isReasonCode(item.reasonCode)) throw invalid("Alege un motiv din listă");
      const reasonText = item.reasonText?.trim() || null;
      if (reasonText && reasonText.length > RETURN_REASON_TEXT_MAX) {
        throw invalid(`Explicația are cel mult ${RETURN_REASON_TEXT_MAX} de caractere`);
      }
      if (item.reasonCode === "other" && !reasonText) {
        throw invalid("Descrie motivul returului");
      }
      let quantity: Quantity;
      try {
        quantity = parseQuantity(item.quantity, { maxDecimals: line.unitDecimals });
      } catch (error) {
        if (error instanceof QuantityError) {
          throw new ReturnError("RETURN_QUANTITY_INVALID", error.message, { line: line.sku });
        }
        throw error;
      }
      const problem = checkReturnQuantity(quantity, line.returnable, line.step);
      if (problem === "not_positive" || problem === "not_step_multiple") {
        throw new ReturnError("RETURN_QUANTITY_INVALID", "Cantitatea nu este validă", {
          line: line.sku,
          problem,
        });
      }
      if (problem === "exceeds_returnable") {
        throw new ReturnError(
          "RETURN_QUANTITY_EXCEEDED",
          "Cantitatea depășește ce a rămas de returnat din această linie",
          { line: line.sku },
        );
      }
      prepared.push({
        orderLineId: line.orderLineId,
        quantity,
        reasonCode: item.reasonCode,
        reasonText,
      });
    }

    try {
      const created = await tx.returnRequest.create({
        data: {
          orderId: order.id,
          userId: user.id,
          clientKey,
          sendMode,
          ...(customerNote ? { customerNote } : {}),
          items: {
            create: prepared.map((p) => ({
              orderLineId: p.orderLineId,
              requestedQty: p.quantity,
              reasonCode: p.reasonCode,
              ...(p.reasonText ? { reasonText: p.reasonText } : {}),
            })),
          },
        },
        select: { id: true, number: true },
      });
      await addReturnEvent(tx, created.id, {
        type: "return.requested",
        message: "Cererea de retur a fost primită",
      });
      await notifyAdmins(tx, {
        kind: "return_requested",
        title: "Cerere nouă de retur",
        context: orderContext(order.number, `Retur R-${created.number}`),
        href: `/admin/comenzi/retururi/${created.id}`,
        permission: "returns.view",
        dedupKey: `return-requested:${created.id}`,
      });
      return { returnId: created.id, number: created.number, created: true };
    } catch (error) {
      // a doua cerere simultană pentru ultima bucată: garanția din bază
      if (isQuantityTrigger(error)) {
        throw new ReturnError(
          "RETURN_QUANTITY_EXCEEDED",
          "Cantitatea depășește ce a rămas de returnat din această linie",
        );
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        // aceeași cheie, comisă între timp de o altă cerere
        const again = await tx.returnRequest.findUnique({
          where: { userId_clientKey: { userId: user.id, clientKey } },
          select: { id: true, number: true },
        });
        if (again) return { returnId: again.id, number: again.number, created: false };
      }
      throw error;
    }
  });
}

/** Clientul își anulează returul cât timp e `requested` sau `approved`. */
export async function cancelReturnByCustomer(
  db: Db,
  user: AccountUser,
  returnId: string,
  now: Date,
): Promise<void> {
  await inTx(db, async (tx) => {
    const locked = await lockReturn(tx, returnId);
    // un retur străin se comportă ca unul inexistent
    if (!locked || locked.userId !== user.id) {
      throw new ReturnError("RETURN_NOT_FOUND", "Returul nu există");
    }
    if (!(CUSTOMER_CANCELLABLE_STATUSES as readonly ReturnStatus[]).includes(locked.status)) {
      throw new ReturnError(
        "RETURN_STATE_INVALID",
        "Returul nu mai poate fi anulat din cont: contactează-ne",
        { status: locked.status },
      );
    }
    await transitionReturn(
      tx,
      returnId,
      "cancelled",
      {},
      { type: "return.cancelled", message: "Returul a fost anulat de client" },
      now,
    );
  });
}

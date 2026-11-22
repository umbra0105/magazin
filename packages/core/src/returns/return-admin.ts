import {
  QuantityError,
  compareQuantity,
  isMultipleOf,
  parseQuantity,
  quantityFromTicks,
} from "@ecom/shared";
import { inTx, type Db } from "../db-tx";
import { effectiveSaleStep } from "../inventory/sale-config";
import {
  RETURN_ADMIN_NOTE_MAX,
  RETURN_AWB_MAX,
  RETURN_CARRIER_MAX,
  RETURN_CONDITIONS,
  RETURN_REJECT_REASON_MAX,
  RETURN_TRACKING_URL_MAX,
  type ReturnCondition,
} from "./return-constants";
import { ReturnError } from "./return-errors";
import { addReturnEvent, lockReturn, transitionReturn } from "./return-transition";

/**
 * Acțiunile ADMINULUI asupra unui retur (aprobare, respingere, AWB manual, recepție, inspecție). Fiecare trece prin
 * `transitionReturn` (state machine explicit + jurnal). Auditul îl scrie acțiunea de server care le apelează. Nota internă
 * (`adminNote`) nu intră niciodată într-un eveniment vizibil clientului și nu ajunge în emailuri.
 */
export interface AdminActor {
  label: string;
}

const clean = (text: string | undefined): string => (text ?? "").trim();

function assertSafeUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ReturnError("RETURN_AWB_INVALID", "Linkul de urmărire nu este o adresă validă");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ReturnError(
      "RETURN_AWB_INVALID",
      "Linkul de urmărire trebuie să înceapă cu https://",
    );
  }
}

export async function approveReturn(
  db: Db,
  returnId: string,
  actor: AdminActor,
  now: Date,
  adminNote?: string,
): Promise<void> {
  const note = clean(adminNote);
  if (note.length > RETURN_ADMIN_NOTE_MAX) {
    throw new ReturnError(
      "RETURN_INPUT_INVALID",
      `Nota are cel mult ${RETURN_ADMIN_NOTE_MAX} de caractere`,
    );
  }
  await inTx(db, async (tx) => {
    await transitionReturn(
      tx,
      returnId,
      "approved",
      {},
      { type: "return.approved", message: "Returul a fost aprobat", actorLabel: actor.label },
      now,
    );
    if (note) await tx.returnRequest.update({ where: { id: returnId }, data: { adminNote: note } });
  });
}

/** Respingere din `requested` sau, după inspecție, din `inspected`; motivul e obligatoriu și VIZIBIL clientului. */
export async function rejectReturn(
  db: Db,
  returnId: string,
  actor: AdminActor,
  reason: string,
  now: Date,
): Promise<void> {
  const text = clean(reason);
  if (text.length < 3 || text.length > RETURN_REJECT_REASON_MAX) {
    throw new ReturnError(
      "RETURN_INPUT_INVALID",
      `Motivul respingerii are între 3 și ${RETURN_REJECT_REASON_MAX} de caractere`,
    );
  }
  await inTx(db, async (tx) => {
    await transitionReturn(
      tx,
      returnId,
      "rejected",
      { rejectReason: text },
      { type: "return.rejected", message: "Returul a fost respins", actorLabel: actor.label },
      now,
    );
  });
}

export interface ReturnAwbInput {
  carrier: string;
  awb: string;
  trackingUrl?: string;
}

/**
 * AWB-ul de retur introdus de admin (decizia 2026-11-22: fără API de curier). Merge cât returul e aprobat sau așteaptă coletul
 * (se poate corecta până la recepție); din `approved` returul trece în `awaiting_shipment`.
 */
export async function setReturnAwb(
  db: Db,
  returnId: string,
  actor: AdminActor,
  input: ReturnAwbInput,
  now: Date,
): Promise<void> {
  const carrier = clean(input.carrier);
  const awb = clean(input.awb);
  const trackingUrl = clean(input.trackingUrl);
  if (carrier === "" || carrier.length > RETURN_CARRIER_MAX) {
    throw new ReturnError("RETURN_AWB_INVALID", "Scrie numele curierului");
  }
  if (awb === "" || awb.length > RETURN_AWB_MAX) {
    throw new ReturnError("RETURN_AWB_INVALID", "Scrie numărul AWB");
  }
  if (trackingUrl) {
    if (trackingUrl.length > RETURN_TRACKING_URL_MAX) {
      throw new ReturnError("RETURN_AWB_INVALID", "Linkul de urmărire e prea lung");
    }
    assertSafeUrl(trackingUrl);
  }
  await inTx(db, async (tx) => {
    const locked = await lockReturn(tx, returnId);
    if (!locked) throw new ReturnError("RETURN_NOT_FOUND", "Returul nu există");
    if (locked.status !== "approved" && locked.status !== "awaiting_shipment") {
      throw new ReturnError(
        "RETURN_STATE_INVALID",
        "AWB-ul de retur se introduce după aprobare și înainte de recepție",
        { status: locked.status },
      );
    }
    await tx.returnRequest.update({
      where: { id: returnId },
      data: {
        returnCarrier: carrier,
        returnAwb: awb,
        returnTrackingUrl: trackingUrl || null,
        returnAwbAt: now,
      },
    });
    const event = {
      type: "return.awb_set",
      message: `AWB de retur: ${carrier}, ${awb}`,
      data: { carrier, awb, ...(trackingUrl ? { trackingUrl } : {}) },
      actorLabel: actor.label,
    };
    if (locked.status === "approved") {
      await transitionReturn(tx, returnId, "awaiting_shipment", {}, event, now);
    } else {
      await addReturnEvent(tx, returnId, event);
    }
  });
}

/** Fără AWB (clientul aduce coletul la sediu): returul trece în «așteaptă coletul». */
export async function markAwaitingShipment(
  db: Db,
  returnId: string,
  actor: AdminActor,
  now: Date,
): Promise<void> {
  await inTx(db, async (tx) => {
    await transitionReturn(
      tx,
      returnId,
      "awaiting_shipment",
      {},
      {
        type: "return.awaiting_shipment",
        message: "Așteptăm coletul returnat",
        actorLabel: actor.label,
      },
      now,
    );
  });
}

export async function markReturnReceived(
  db: Db,
  returnId: string,
  actor: AdminActor,
  now: Date,
): Promise<void> {
  await inTx(db, async (tx) => {
    await transitionReturn(
      tx,
      returnId,
      "received",
      {},
      {
        type: "return.received",
        message: "Coletul returnat a fost primit",
        actorLabel: actor.label,
      },
      now,
    );
  });
}

export interface InspectionLineInput {
  returnItemId: string;
  /** Cantitatea acceptată (text, cu zecimalele unității), între 0 și cea cerută. */
  acceptedQuantity: string;
  condition: string;
  resellable: boolean;
}

const isCondition = (value: string): value is ReturnCondition =>
  (RETURN_CONDITIONS as readonly string[]).includes(value);

/**
 * Inspecția pe linie: cantitatea acceptată, starea constatată și dacă produsul se poate revinde. Toate liniile returului se
 * inspectează odată; apoi returul trece în `inspected`. Cantitatea acceptată e multiplu EXACT al pasului de vânzare.
 */
export async function inspectReturn(
  db: Db,
  returnId: string,
  actor: AdminActor,
  lines: readonly InspectionLineInput[],
  now: Date,
  adminNote?: string,
): Promise<void> {
  const note = clean(adminNote);
  if (note.length > RETURN_ADMIN_NOTE_MAX) {
    throw new ReturnError(
      "RETURN_INPUT_INVALID",
      `Nota are cel mult ${RETURN_ADMIN_NOTE_MAX} de caractere`,
    );
  }
  await inTx(db, async (tx) => {
    const locked = await lockReturn(tx, returnId);
    if (!locked) throw new ReturnError("RETURN_NOT_FOUND", "Returul nu există");
    if (locked.status !== "received") {
      throw new ReturnError("RETURN_STATE_INVALID", "Inspecția se face după recepția coletului", {
        status: locked.status,
      });
    }
    const items = await tx.returnItem.findMany({
      where: { returnId },
      select: {
        id: true,
        requestedQty: true,
        orderLine: {
          select: {
            unitDecimals: true,
            variant: { select: { saleStep: true, product: { select: { saleStep: true } } } },
          },
        },
      },
    });
    if (
      lines.length !== items.length ||
      new Set(lines.map((l) => l.returnItemId)).size !== items.length
    ) {
      throw new ReturnError(
        "RETURN_INSPECTION_INVALID",
        "Inspectează toate liniile returului, o singură dată",
      );
    }
    for (const line of lines) {
      const item = items.find((i) => i.id === line.returnItemId);
      if (!item) throw new ReturnError("RETURN_INSPECTION_INVALID", "Linia nu aparține returului");
      if (!isCondition(line.condition)) {
        throw new ReturnError("RETURN_INSPECTION_INVALID", "Alege starea constatată din listă");
      }
      let accepted;
      try {
        accepted = parseQuantity(line.acceptedQuantity, {
          maxDecimals: item.orderLine.unitDecimals,
        });
      } catch (error) {
        if (error instanceof QuantityError) {
          throw new ReturnError("RETURN_INSPECTION_INVALID", error.message);
        }
        throw error;
      }
      const requested = quantityFromTicks(item.requestedQty);
      if (compareQuantity(accepted, requested) > 0) {
        throw new ReturnError(
          "RETURN_INSPECTION_INVALID",
          "Cantitatea acceptată nu poate depăși cantitatea cerută",
        );
      }
      const step = quantityFromTicks(
        effectiveSaleStep(
          item.orderLine.variant?.saleStep,
          item.orderLine.variant?.product.saleStep,
        ),
      );
      if (!isMultipleOf(accepted, step)) {
        throw new ReturnError(
          "RETURN_INSPECTION_INVALID",
          "Cantitatea acceptată trebuie să fie un multiplu exact al pasului de vânzare",
        );
      }
      if (line.resellable && compareQuantity(accepted, quantityFromTicks(0n)) === 0) {
        throw new ReturnError(
          "RETURN_INSPECTION_INVALID",
          "O linie fără nicio bucată acceptată nu se poate marca «revandabilă»",
        );
      }
      await tx.returnItem.update({
        where: { id: line.returnItemId },
        data: { acceptedQty: accepted, condition: line.condition, resellable: line.resellable },
      });
    }
    if (note) await tx.returnRequest.update({ where: { id: returnId }, data: { adminNote: note } });
    await transitionReturn(
      tx,
      returnId,
      "inspected",
      {},
      {
        type: "return.inspected",
        message: "Inspecția returului s-a încheiat",
        actorLabel: actor.label,
      },
      now,
    );
  });
}

/** Nota internă a returului (nu e vizibilă clientului, nu intră în emailuri). */
export async function setReturnAdminNote(
  db: Db,
  returnId: string,
  actor: AdminActor,
  note: string,
): Promise<void> {
  const text = clean(note);
  if (text.length > RETURN_ADMIN_NOTE_MAX) {
    throw new ReturnError(
      "RETURN_INPUT_INVALID",
      `Nota are cel mult ${RETURN_ADMIN_NOTE_MAX} de caractere`,
    );
  }
  await inTx(db, async (tx) => {
    const locked = await lockReturn(tx, returnId);
    if (!locked) throw new ReturnError("RETURN_NOT_FOUND", "Returul nu există");
    await tx.returnRequest.update({ where: { id: returnId }, data: { adminNote: text || null } });
    await addReturnEvent(tx, returnId, {
      type: "return.note",
      message: "Nota internă a fost actualizată",
      actorLabel: actor.label,
    });
  });
}

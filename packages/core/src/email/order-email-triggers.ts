import type { Prisma } from "@ecom/db";
import type { Db } from "../db-tx";
import { enqueueDispatches, type DispatchInput } from "./dispatch";

/**
 * Regulile care leagă un `OrderEvent` de emailurile lui (Faza 11). Se apelează din `addOrderEvent`, în aceeași tranzacție cu
 * evenimentul: se scriu DOAR rânduri `EmailDispatch` (outbox), niciun email nu pleacă de aici. Unicitatea din bază
 * (`eventKey`, șablon, destinatar) face ca același eveniment procesat de două ori să dea un singur email.
 *
 * Evenimentele fără regulă nu costă nimic (o căutare într-un tabel mic). Comenzile de pe canale externe (`externalId`, eMAG)
 * nu primesc emailuri către client de la magazin.
 */
interface Rule {
  template: string;
  /** Doar la plata prin acea metodă; lipsă = toate. */
  onlyMethod?: "cod" | "bank_transfer" | "card";
}

/** Eveniment → șabloane pentru CLIENT. */
const CUSTOMER_RULES: Readonly<Record<string, readonly Rule[]>> = {
  "order.placed": [
    { template: "order.confirmation" },
    { template: "order.proforma", onlyMethod: "bank_transfer" },
  ],
  "payment.confirmed": [{ template: "order.payment_received" }],
  "payment.failed": [{ template: "order.payment_failed" }],
  "payment.stock_lost": [{ template: "order.stock_lost" }],
  "payment.refunded": [{ template: "order.refunded" }],
  "order.processing": [{ template: "order.processing" }],
  "order.shipped": [{ template: "order.shipped" }],
  "order.delivered": [{ template: "order.delivered" }],
  "order.cancelled": [{ template: "order.cancelled" }],
  "order.auto_cancelled": [{ template: "order.cancelled" }],
};

/** Tipurile de eveniment care declanșează cel puțin un email (pentru teste și documentație). */
export const EMAIL_TRIGGER_EVENT_TYPES: readonly string[] = [
  ...new Set([...Object.keys(CUSTOMER_RULES), "order.placed"]),
];

export const INTERNAL_RECIPIENTS_SETTING = "email.internalRecipients";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface TriggerEvent {
  id: string;
  type: string;
  data?: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Datele mici, ne-sensibile, de care are nevoie șablonul și pe care nu le poate reciti din comandă. */
function dataFor(type: string, event: TriggerEvent, paid: boolean): Prisma.InputJsonValue {
  const d = asRecord(event.data);
  const out: Record<string, Prisma.InputJsonValue> = { eventType: type };
  if (typeof d["amountMinor"] === "number") out["amountMinor"] = d["amountMinor"];
  if (typeof d["refundId"] === "string") out["refundId"] = d["refundId"];
  if (typeof d["awb"] === "string") out["awb"] = d["awb"].slice(0, 80);
  if (typeof d["carrier"] === "string") out["carrier"] = d["carrier"].slice(0, 80);
  if (type === "order.cancelled" || type === "order.auto_cancelled") {
    out["reason"] =
      type === "order.auto_cancelled"
        ? "auto"
        : typeof d["reason"] === "string"
          ? d["reason"].slice(0, 300)
          : "";
    out["paid"] = paid;
  }
  return out;
}

async function internalRecipients(tx: Db): Promise<string[]> {
  const row = await tx.setting.findUnique({ where: { key: INTERNAL_RECIPIENTS_SETTING } });
  const value = row?.value;
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const email = item.trim().toLowerCase();
    if (EMAIL_SHAPE.test(email)) seen.add(email);
  }
  return [...seen].sort();
}

/** Variantele gestionate ale comenzii care au rămas fără stoc disponibil (după rezervarea sau angajarea acestei comenzi). */
async function soldOutVariants(tx: Db, orderId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ variantId: string }[]>`
    SELECT DISTINCT l."variantId" AS "variantId"
    FROM order_line l
    JOIN inventory_item i ON i."variantId" = l."variantId"
    WHERE l."orderId" = ${orderId}
      AND l."variantId" IS NOT NULL
      AND i.physical - i.committed - i.reserved - i."safetyBuffer" <= 0
    ORDER BY l."variantId"`;
  return rows.map((row) => row.variantId);
}

/** Scrie rândurile de trimis pentru un eveniment, în tranzacția apelantului. Nu face nimic dacă evenimentul nu are reguli. */
export async function scheduleOrderEmails(
  tx: Db,
  orderId: string,
  event: TriggerEvent,
): Promise<void> {
  const rules = CUSTOMER_RULES[event.type];
  if (!rules) return;
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      email: true,
      paymentMethod: true,
      paymentStatus: true,
      externalId: true,
      installationRequested: true,
    },
  });
  if (!order) return;
  const inputs: DispatchInput[] = [];
  const recipient = order.email.trim().toLowerCase();
  if (order.externalId === null && EMAIL_SHAPE.test(recipient)) {
    const data = dataFor(event.type, event, order.paymentStatus === "paid");
    for (const rule of rules) {
      if (rule.onlyMethod && rule.onlyMethod !== order.paymentMethod) continue;
      inputs.push({
        template: rule.template,
        eventKey: `event:${event.id}`,
        recipient,
        audience: "customer",
        orderId,
        data,
      });
    }
  }
  if (event.type === "order.placed" && order.externalId === null) {
    const recipients = await internalRecipients(tx);
    if (recipients.length > 0) {
      for (const to of recipients) {
        inputs.push({
          template: "internal.order_new",
          eventKey: `event:${event.id}`,
          recipient: to,
          audience: "internal",
          orderId,
          data: { eventType: event.type },
        });
      }
      if (order.installationRequested) {
        for (const to of recipients) {
          inputs.push({
            template: "internal.installation_request",
            eventKey: `event:${event.id}`,
            recipient: to,
            audience: "internal",
            orderId,
            data: { eventType: event.type },
          });
        }
      }
      for (const variantId of await soldOutVariants(tx, orderId)) {
        for (const to of recipients) {
          inputs.push({
            template: "internal.stock_out",
            eventKey: `event:${event.id}:stock:${variantId}`,
            recipient: to,
            audience: "internal",
            orderId,
            data: { eventType: event.type, variantId },
          });
        }
      }
    }
  }
  await enqueueDispatches(tx, inputs);
}

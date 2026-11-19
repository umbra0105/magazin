import { z } from "zod";
import { inTx, type Db } from "../db-tx";
import { normalizeRoPhone } from "./checkout-input";
import { OrderError } from "./order-errors";
import { addOrderEvent, lockOrder, updateOrderAnnotations } from "./order-service";

/**
 * «Editează» pe o comandă PLASATĂ (decizia din 2026-11-19, punctul d): DOAR date de contact (email, telefon) și corectarea
 * greșelilor de tastare din adresă (nume, telefon, stradă, cod poștal). NU se schimbă linii, prețuri, sume, județul sau
 * localitatea (zona și tariful), firma sau CUI-ul (facturarea vine în Faza 13): triggerul din bază le păzește pe toate.
 * Fiecare corectare scrie `OrderEvent` cu CÂMPURILE schimbate, nu cu valorile (datele personale nu intră în timeline).
 * Liniile se editează doar pe comenzi DRAFT, prin aceleași servicii de preț și stoc (pasul «draft order»).
 */
const EDITABLE_STATUSES: readonly string[] = ["pending", "confirmed", "processing"];

export const contactCorrectionSchema = z.object({
  email: z.string().trim().toLowerCase().email("Adresa de email nu este validă").max(254),
  phone: z
    .string()
    .trim()
    .transform((value, ctx) => {
      const normalized = normalizeRoPhone(value);
      if (!normalized) {
        ctx.addIssue({ code: "custom", message: "Numărul de telefon nu este valid" });
        return z.NEVER;
      }
      return normalized;
    }),
});

export const addressCorrectionSchema = z.object({
  fullName: z.string().trim().min(2, "Scrie numele complet").max(120),
  phone: contactCorrectionSchema.shape.phone,
  street: z.string().trim().min(3, "Scrie strada și numărul").max(200),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Codul poștal are 6 cifre"),
});
export type AddressCorrection = z.infer<typeof addressCorrectionSchema>;

function assertEditable(status: string): void {
  if (!EDITABLE_STATUSES.includes(status)) {
    throw new OrderError("ORDER_EDIT_INVALID", "Această comandă nu se mai poate edita", { status });
  }
}

export async function correctOrderContact(
  db: Db,
  orderId: string,
  input: { email: string; phone: string; actorLabel: string },
): Promise<{ changed: string[] }> {
  const parsed = contactCorrectionSchema.safeParse({ email: input.email, phone: input.phone });
  if (!parsed.success) {
    throw new OrderError("ORDER_EDIT_INVALID", "Datele de contact nu sunt valide", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return inTx(db, async (tx) => {
    const states = await lockOrder(tx, orderId);
    if (!states) throw new OrderError("ORDER_NOT_FOUND", "Comanda nu există", { orderId });
    assertEditable(states.status);
    const current = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { email: true, phone: true },
    });
    const changed: string[] = [];
    if (current.email !== parsed.data.email) changed.push("email");
    if (current.phone !== parsed.data.phone) changed.push("phone");
    if (changed.length === 0) return { changed };
    await updateOrderAnnotations(tx, orderId, {
      email: parsed.data.email,
      phone: parsed.data.phone,
    });
    await addOrderEvent(tx, orderId, {
      type: "order.contact_corrected",
      message: "Datele de contact au fost corectate",
      data: { fields: changed },
      actorLabel: input.actorLabel,
    });
    return { changed };
  });
}

export async function correctOrderAddress(
  db: Db,
  orderId: string,
  kind: "shipping" | "billing",
  input: AddressCorrection,
  actorLabel: string,
): Promise<{ changed: string[] }> {
  const parsed = addressCorrectionSchema.safeParse(input);
  if (!parsed.success) {
    throw new OrderError("ORDER_EDIT_INVALID", "Adresa nu este validă", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return inTx(db, async (tx) => {
    const states = await lockOrder(tx, orderId);
    if (!states) throw new OrderError("ORDER_NOT_FOUND", "Comanda nu există", { orderId });
    assertEditable(states.status);
    const address = await tx.address.findUnique({ where: { orderId_kind: { orderId, kind } } });
    if (!address) throw new OrderError("ORDER_EDIT_INVALID", "Comanda nu are această adresă");
    const changed = (["fullName", "phone", "street", "postalCode"] as const).filter(
      (field) => address[field] !== parsed.data[field],
    );
    if (changed.length === 0) return { changed: [] };
    await tx.address.update({
      where: { id: address.id },
      data: {
        fullName: parsed.data.fullName,
        phone: parsed.data.phone,
        street: parsed.data.street,
        postalCode: parsed.data.postalCode,
      },
    });
    await addOrderEvent(tx, orderId, {
      type: "order.address_corrected",
      message:
        kind === "shipping"
          ? "Adresa clientului a fost corectată"
          : "Adresa de facturare a fost corectată",
      data: { kind, fields: [...changed] },
      actorLabel,
    });
    return { changed: [...changed] };
  });
}

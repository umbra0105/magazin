"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import {
  accountDeleteBlockers,
  addToWishlist,
  anonymizeAccount,
  cancelReturnByCustomer,
  getAccountOrder,
  initiateReturn,
  removeFromWishlist,
  setMarketingConsent,
  updateProfile,
  verifyPassword,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { DomainError, getLogger, quantityFromTicks } from "@ecom/shared";
import { allowAccountRequest, getAddressBook, getCustomer, requireFlag } from "@/lib/account";
import { getCartService, resolveOwnerForWrite, setCartCookie } from "@/lib/cart";
import { getGeoService } from "@/lib/checkout";
import { getAudit } from "@/lib/admin-writes";
import { getAuth } from "@/lib/services";

/**
 * Acțiunile contului clientului (Faza 14). Fiecare: (1) cere clientul autentificat, (2) validează intrarea cu Zod, (3) apelează un
 * serviciu din `@ecom/core` care verifică proprietatea, (4) întoarce un cod stabil, tradus în română de interfață. Nicio acțiune nu
 * primește identificatorul clientului din formular: vine DOAR din sesiune. Limitele de cereri sunt pe client, pe tip de operație.
 */
export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; code: string };

const failure = (code: string): { ok: false; code: string } => ({ ok: false, code });

function codeOf(error: unknown): string {
  if (error instanceof DomainError) return error.code;
  getLogger().error({ err: error }, "acțiune de cont eșuată");
  return "failed";
}

const orderId = z.string().min(1).max(64);

// ------------------------------------------------------------------------------------------------ comandă din nou

export async function reorderAction(
  raw: unknown,
): Promise<ActionResult<{ added: number; skipped: number }>> {
  const parsed = z.object({ orderId }).safeParse(raw);
  if (!parsed.success) return failure("invalid");
  const customer = await getCustomer();
  if (!customer) return failure("unauthenticated");
  try {
    const order = await getAccountOrder(getDb(), customer.user, parsed.data.orderId, new Date());
    const { owner } = await resolveOwnerForWrite();
    const cart = getCartService();
    let added = 0;
    let skipped = 0;
    for (const line of order.lines) {
      if (!line.variantId) {
        skipped += 1;
        continue;
      }
      try {
        // doar adaugă în coș, prin serviciul coșului: prețul îl calculează motorul de prețuri, nu această acțiune
        const result = await cart.add(owner, {
          variantId: line.variantId,
          quantity: quantityFromTicks(line.quantity),
        });
        if (result.newToken) await setCartCookie(result.newToken);
        added += 1;
      } catch {
        skipped += 1;
      }
    }
    revalidatePath("/cos");
    return { ok: true, added, skipped };
  } catch (error) {
    return failure(codeOf(error));
  }
}

// ------------------------------------------------------------------------------------------------------ retururi

const returnInput = z.object({
  orderId,
  clientKey: z.string().min(8).max(80),
  sendMode: z.enum(["courier", "drop_off"]).default("courier"),
  customerNote: z.string().max(1000).optional(),
  items: z
    .array(
      z.object({
        orderLineId: z.string().min(1).max(64),
        quantity: z.string().max(40),
        reasonCode: z.string().max(40),
        reasonText: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(100),
});

export async function initiateReturnAction(
  raw: unknown,
): Promise<ActionResult<{ returnId: string }>> {
  const parsed = returnInput.safeParse(raw);
  if (!parsed.success) return failure("RETURN_INPUT_INVALID");
  const customer = await getCustomer();
  if (!customer) return failure("unauthenticated");
  if (!(await allowAccountRequest("return", customer.user.id))) return failure("rate_limited");
  try {
    const result = await initiateReturn(getDb(), customer.user, parsed.data, new Date());
    revalidatePath("/cont/retururi");
    revalidatePath(`/cont/comenzi/${parsed.data.orderId}`);
    return { ok: true, returnId: result.returnId };
  } catch (error) {
    return failure(codeOf(error));
  }
}

export async function cancelReturnAction(raw: unknown): Promise<ActionResult> {
  const parsed = z.object({ returnId: z.string().min(1).max(64) }).safeParse(raw);
  if (!parsed.success) return failure("invalid");
  const customer = await getCustomer();
  if (!customer) return failure("unauthenticated");
  if (!(await allowAccountRequest("return", customer.user.id))) return failure("rate_limited");
  try {
    await cancelReturnByCustomer(getDb(), customer.user, parsed.data.returnId, new Date());
    revalidatePath("/cont/retururi");
    revalidatePath(`/cont/retururi/${parsed.data.returnId}`);
    return { ok: true };
  } catch (error) {
    return failure(codeOf(error));
  }
}

// ------------------------------------------------------------------------------------------------------- adrese

const addressId = z.string().min(1).max(64);

export async function saveAddressAction(raw: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = z.object({ id: addressId.optional(), address: z.unknown() }).safeParse(raw);
  if (!parsed.success) return failure("ACCOUNT_ADDRESS_INVALID");
  const customer = await getCustomer();
  if (!customer) return failure("unauthenticated");
  if (!(await allowAccountRequest("address", customer.user.id))) return failure("rate_limited");
  try {
    const book = getAddressBook();
    const saved = parsed.data.id
      ? await book.update(customer.user.id, parsed.data.id, parsed.data.address)
      : await book.create(customer.user.id, parsed.data.address);
    revalidatePath("/cont/adrese");
    return { ok: true, id: saved.id };
  } catch (error) {
    return failure(codeOf(error));
  }
}

export async function removeAddressAction(raw: unknown): Promise<ActionResult> {
  const parsed = z.object({ id: addressId }).safeParse(raw);
  if (!parsed.success) return failure("invalid");
  const customer = await getCustomer();
  if (!customer) return failure("unauthenticated");
  if (!(await allowAccountRequest("address", customer.user.id))) return failure("rate_limited");
  try {
    await getAddressBook().remove(customer.user.id, parsed.data.id);
    revalidatePath("/cont/adrese");
    return { ok: true };
  } catch (error) {
    return failure(codeOf(error));
  }
}

export async function setDefaultAddressAction(raw: unknown): Promise<ActionResult> {
  const parsed = z.object({ id: addressId, kind: z.enum(["shipping", "billing"]) }).safeParse(raw);
  if (!parsed.success) return failure("invalid");
  const customer = await getCustomer();
  if (!customer) return failure("unauthenticated");
  if (!(await allowAccountRequest("address", customer.user.id))) return failure("rate_limited");
  try {
    await getAddressBook().setDefault(customer.user.id, parsed.data.id, parsed.data.kind);
    revalidatePath("/cont/adrese");
    return { ok: true };
  } catch (error) {
    return failure(codeOf(error));
  }
}

// ------------------------------------------------------------------------------------------------------ favorite

export async function toggleWishlistAction(
  raw: unknown,
): Promise<ActionResult<{ saved: boolean }>> {
  const parsed = z
    .object({ variantId: z.string().min(1).max(64), save: z.boolean() })
    .safeParse(raw);
  if (!parsed.success) return failure("invalid");
  await requireFlag("wishlist"); // flag oprit: 404, nicio scriere
  const customer = await getCustomer();
  if (!customer) return failure("unauthenticated");
  if (!(await allowAccountRequest("wishlist", customer.user.id))) return failure("rate_limited");
  try {
    if (parsed.data.save) await addToWishlist(getDb(), customer.user.id, parsed.data.variantId);
    else await removeFromWishlist(getDb(), customer.user.id, parsed.data.variantId);
    revalidatePath("/cont/favorite");
    return { ok: true, saved: parsed.data.save };
  } catch (error) {
    return failure(codeOf(error));
  }
}

// -------------------------------------------------------------------------------------------------- date personale

export async function updateProfileAction(raw: unknown): Promise<ActionResult> {
  const customer = await getCustomer();
  if (!customer) return failure("unauthenticated");
  try {
    await updateProfile(getDb(), customer.user.id, raw);
    revalidatePath("/cont/date-personale");
    return { ok: true };
  } catch (error) {
    return failure(codeOf(error));
  }
}

export async function setMarketingAction(raw: unknown): Promise<ActionResult> {
  const parsed = z.object({ optIn: z.boolean() }).safeParse(raw);
  if (!parsed.success) return failure("invalid");
  const customer = await getCustomer();
  if (!customer) return failure("unauthenticated");
  try {
    await setMarketingConsent(getDb(), customer.user.id, parsed.data.optIn, new Date());
    revalidatePath("/cont/date-personale");
    return { ok: true };
  } catch (error) {
    return failure(codeOf(error));
  }
}

/**
 * Ștergerea contului = anonimizarea lui (D4): cere parola, refuză cu comenzi nefinalizate sau retur deschis. Jurnalul de audit
 * primește DOAR identificatorul intern (emailul clientului nu intră în jurnalul imuabil).
 */
export async function deleteAccountAction(raw: unknown): Promise<ActionResult> {
  const parsed = z.object({ password: z.string().min(1).max(1024) }).safeParse(raw);
  if (!parsed.success) return failure("invalid");
  const customer = await getCustomer();
  if (!customer) return failure("unauthenticated");
  if (!(await allowAccountRequest("delete", customer.user.id))) return failure("rate_limited");
  try {
    const blockers = await accountDeleteBlockers(getDb(), customer.user);
    if (blockers.unfinishedOrders > 0) return failure("blocked_orders");
    if (blockers.openReturns > 0) return failure("blocked_returns");
    if (customer.isStaff) return failure("blocked_staff");
    const credential = await getDb().account.findFirst({
      where: { userId: customer.user.id, providerId: "credential" },
      select: { password: true },
    });
    const valid =
      credential?.password != null &&
      (await verifyPassword({ hash: credential.password, password: parsed.data.password }));
    if (!valid) return failure("wrong_password");
    // sesiunile (inclusiv cele din Redis) se revocă ÎNAINTE de anonimizare
    const auth = await getAuth();
    await auth.api.revokeSessions({ headers: await headers() });
    await anonymizeAccount(getDb(), customer.user, new Date());
    await getAudit().record({
      actorId: customer.user.id,
      actorLabel: `client:${customer.user.id}`,
      action: "account.anonymized",
      entity: "user",
      entityId: customer.user.id,
      after: { anonymized: true },
    });
    return { ok: true };
  } catch (error) {
    const code = codeOf(error);
    return failure(code === "ACCOUNT_DELETE_BLOCKED" ? "blocked_orders" : code);
  }
}

// ------------------------------------------------------------------------------------------------- localități

export async function getAccountLocalitiesAction(
  raw: unknown,
): Promise<Array<{ code: number; label: string }> | null> {
  const parsed = z.number().int().positive().safeParse(raw);
  if (!parsed.success) return null;
  const customer = await getCustomer();
  if (!customer) return null;
  if (!(await allowAccountRequest("address", customer.user.id))) return null;
  const rows = await getGeoService().localities(parsed.data);
  return rows.map((r) => ({ code: r.code, label: r.label }));
}

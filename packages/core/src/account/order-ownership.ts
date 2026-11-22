import type { Prisma } from "@ecom/db";

/**
 * Proprietatea unei comenzi în contul clientului (decizia 2026-11-22, D3): o comandă e a clientului DOAR dacă are `customerId` egal
 * cu contul SAU email-ul comenzii coincide (normalizat ca la checkout: fără spații, litere mici) cu cel al contului ȘI email-ul
 * contului e VERIFICAT. Un cont fără email verificat nu primește comenzile de oaspete; un cont anonimizat nu mai primește nimic.
 *
 * Singurul loc care construiește condiția: orice interogare a clientului pe comenzi trece pe aici.
 */
export interface AccountUser {
  id: string;
  email: string;
  emailVerified: boolean;
  anonymizedAt?: Date | null;
}

/** Email-ul normalizat ca la checkout (`trim`, litere mici). */
export const normalizeAccountEmail = (email: string): string => email.trim().toLowerCase();

export function ownedOrdersWhere(user: AccountUser): Prisma.OrderWhereInput {
  if (user.anonymizedAt) return { id: { in: [] } };
  const byEmail: Prisma.OrderWhereInput[] = user.emailVerified
    ? [{ email: { equals: normalizeAccountEmail(user.email), mode: "insensitive" } }]
    : [];
  return { OR: [{ customerId: user.id }, ...byEmail] };
}

/** Aceeași regulă pentru o singură comandă: `{ id, ...proprietate }`. */
export function ownedOrderWhere(user: AccountUser, orderId: string): Prisma.OrderWhereInput {
  return { AND: [{ id: orderId }, ownedOrdersWhere(user)] };
}

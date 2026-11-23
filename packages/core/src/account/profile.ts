import { z } from "zod";
import { ValidationError } from "@ecom/shared";
import type { Db } from "../db-tx";
import { normalizeRoPhone } from "../orders/checkout-input";
import { AccountError } from "./account-errors";

/**
 * Profilul și preferințele de comunicare ale clientului (Faza 14). Emailurile despre comenzi sunt de SERVICIU: mereu active, nu se
 * pot opri și nu apar ca opțiune. «Oferte și noutăți» e un consimțământ de MARKETING, implicit OPRIT; la fiecare decizie se salvează
 * momentul și textul EXACT arătat clientului (Faza 17 le va folosi; această fază nu trimite nimic de marketing).
 */
export const MARKETING_CONSENT_TEXT =
  "Vreau să primesc pe email oferte și noutăți de la magazin. Mă pot dezabona oricând din cont.";

export const profileInputSchema = z.object({
  name: z.string().trim().min(2, "Scrie numele").max(120),
  phone: z
    .string()
    .trim()
    .max(30)
    .transform((value, ctx) => {
      if (value === "") return null;
      const normalized = normalizeRoPhone(value);
      if (!normalized) {
        ctx.addIssue({ code: "custom", message: "Numărul de telefon nu este valid" });
        return z.NEVER;
      }
      return normalized;
    })
    .default(""),
});
export type ProfileInput = z.input<typeof profileInputSchema>;

export interface ProfileView {
  name: string;
  email: string;
  emailVerified: boolean;
  phone: string | null;
  marketingOptIn: boolean;
  marketingDecisionAt: Date | null;
}

export async function getProfile(db: Db, userId: string): Promise<ProfileView> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      name: true,
      email: true,
      emailVerified: true,
      preference: { select: { phone: true, marketingOptIn: true, marketingDecisionAt: true } },
    },
  });
  if (!user) throw new AccountError("ACCOUNT_PROFILE_INVALID", "Contul nu există");
  return {
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    phone: user.preference?.phone ?? null,
    marketingOptIn: user.preference?.marketingOptIn ?? false,
    marketingDecisionAt: user.preference?.marketingDecisionAt ?? null,
  };
}

/** Numele și telefonul; emailul NU se schimbă din această fază. */
export async function updateProfile(db: Db, userId: string, raw: unknown): Promise<void> {
  const parsed = profileInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Datele nu sunt valide");
  }
  const { name, phone } = parsed.data;
  await db.user.update({ where: { id: userId }, data: { name } });
  await db.customerPreference.upsert({
    where: { userId },
    create: { userId, phone },
    update: { phone },
  });
}

/** Decizia despre «oferte și noutăți»: salvează valoarea, momentul și textul exact arătat. */
export async function setMarketingConsent(
  db: Db,
  userId: string,
  optIn: boolean,
  now: Date,
): Promise<void> {
  const decision = {
    marketingOptIn: optIn,
    marketingDecisionAt: now,
    marketingDecisionText: MARKETING_CONSENT_TEXT,
  };
  await db.customerPreference.upsert({
    where: { userId },
    create: { userId, ...decision },
    update: decision,
  });
}

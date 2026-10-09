import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@ecom/db";
import { DomainError, ValidationError } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { OWNER_ROLE_KEY } from "../rbac/can";
import { settingGroups } from "../settings/registry";
import { hashPassword } from "./password";

const MAX_PASSWORD_LENGTH = 128;

type Db = Pick<PrismaClient, "user" | "account" | "role" | "userRole" | "auditLog" | "setting">;

export const createOwnerSchema = (minPasswordLength: number) =>
  z.object({
    email: z
      .string()
      .trim()
      .pipe(z.email("Email invalid"))
      .transform((e) => e.toLowerCase()),
    name: z.string().trim().min(1, "Numele e obligatoriu").max(100, "Numele e prea lung"),
    // Fără reguli de compoziție: contează lungimea.
    password: z
      .string()
      .min(minPasswordLength, `Parola trebuie să aibă cel puțin ${minPasswordLength} caractere`)
      .max(MAX_PASSWORD_LENGTH, `Parola poate avea cel mult ${MAX_PASSWORD_LENGTH} de caractere`),
  });

export type CreateOwnerInput = z.input<ReturnType<typeof createOwnerSchema>>;

export interface CreateOwnerOptions {
  /** Permite un al doilea Owner. Implicit, dacă există unul, crearea e refuzată. */
  allowAnotherOwner?: boolean;
  /** Etichetă pentru jurnalul de audit (cine a făcut acțiunea). */
  actorLabel?: string;
}

/** Lungimea minimă a parolei din setări (sau valoarea implicită din registru dacă setarea lipsește). */
export async function loadMinPasswordLength(db: Pick<PrismaClient, "setting">): Promise<number> {
  const row = await db.setting.findUnique({ where: { key: "auth.minPasswordLength" } });
  const parsed = settingGroups.auth.minPasswordLength.safeParse(row?.value);
  return parsed.success ? parsed.data : settingGroups.auth.minPasswordLength.parse(undefined);
}

export async function ownerExists(db: Pick<PrismaClient, "userRole">): Promise<boolean> {
  return (await db.userRole.count({ where: { role: { key: OWNER_ROLE_KEY } } })) > 0;
}

/**
 * Creează contul de administrator (Owner): email marcat verificat, parolă argon2id, rolul Owner.
 * Fără parolă implicită nicăieri: parola vine doar din apelant (în CLI, dintr-un prompt fără echo).
 * Se apelează într-o tranzacție (`db.$transaction`) ca să nu rămână un cont fără rol.
 * Parola nu se scrie în audit, loguri sau erori.
 */
export async function createOwnerAccount(
  db: Db,
  input: CreateOwnerInput,
  options: CreateOwnerOptions = {},
): Promise<{ userId: string; email: string }> {
  const minLength = await loadMinPasswordLength(db);
  const parsed = createOwnerSchema(minLength).safeParse(input);
  if (!parsed.success) {
    // Mesajele vin din schemă și nu conțin valorile introduse.
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  }
  const { email, name, password } = parsed.data;

  const ownerRole = await db.role.findUnique({ where: { key: OWNER_ROLE_KEY } });
  if (!ownerRole) {
    throw new DomainError(
      "ADMIN_ROLE_MISSING",
      "Rolul Owner nu există în baza de date. Rulează întâi `pnpm db:seed`.",
    );
  }
  if (!options.allowAnotherOwner && (await ownerExists(db))) {
    throw new DomainError(
      "ADMIN_OWNER_EXISTS",
      "Există deja un cont Owner. Pentru un al doilea Owner folosește --force.",
    );
  }
  if (await db.user.findUnique({ where: { email }, select: { id: true } })) {
    throw new DomainError("ADMIN_EMAIL_TAKEN", "Există deja un utilizator cu acest email.");
  }

  const userId = randomBytes(16).toString("hex");
  const passwordHash = await hashPassword(password);
  await db.user.create({ data: { id: userId, name, email, emailVerified: true } });
  await db.account.create({
    data: {
      id: randomBytes(16).toString("hex"),
      accountId: userId,
      providerId: "credential",
      userId,
      password: passwordHash,
    },
  });
  await db.userRole.create({ data: { userId, roleId: ownerRole.id } });

  await new AuditService(createPrismaAuditStore(db)).record({
    actorId: "cli",
    actorLabel: options.actorLabel ?? "cli:admin:create",
    action: "admin.account_created",
    entity: "user",
    entityId: userId,
    after: { email, role: OWNER_ROLE_KEY, emailVerified: true },
  });
  return { userId, email };
}

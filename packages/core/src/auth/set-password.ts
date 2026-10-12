import { z } from "zod";
import type { PrismaClient } from "@ecom/db";
import { DomainError, ValidationError } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { createOwnerSchema, loadMinPasswordLength } from "./create-admin";
import { hashPassword } from "./password";
import type { AuthSecondaryStorage } from "./redis-storage";

type Db = Pick<PrismaClient, "user" | "account" | "session" | "auditLog" | "setting">;

export const SET_PASSWORD_REASON = "schimbare din CLI";

export interface SetPasswordResult {
  userId: string;
  email: string;
  /** Tokenurile sesiunilor închise în DB; de folosit la curățarea cache-ului Redis DUPĂ commit. */
  sessionTokens: string[];
}

/**
 * Schimbă parola unui cont existent (argon2id), închide TOATE sesiunile lui din DB și scrie în
 * audit, fără parolă și fără hash. Se apelează într-o tranzacție. Sesiunile au și o copie în cache-ul
 * Redis: după commit, apelantul trebuie să cheme `revokeCachedSessions` cu tokenurile întoarse,
 * altfel o sesiune în cache ar rămâne validă până expiră cache-ul.
 * Pentru recuperare când emailul nu e configurat (`pnpm admin:set-password`).
 */
export async function setAccountPassword(
  db: Db,
  input: { email: string; password: string },
  options: { actorLabel?: string } = {},
): Promise<SetPasswordResult> {
  const minLength = await loadMinPasswordLength(db);
  const email = z.string().trim().pipe(z.email()).safeParse(input.email);
  if (!email.success) throw new ValidationError("Email invalid");
  const password = createOwnerSchema(minLength).shape.password.safeParse(input.password);
  if (!password.success) {
    throw new ValidationError(password.error.issues.map((i) => i.message).join("; "));
  }
  const normalized = email.data.toLowerCase();

  const user = await db.user.findUnique({ where: { email: normalized }, select: { id: true } });
  if (!user) {
    throw new DomainError("ADMIN_USER_NOT_FOUND", "Nu există niciun utilizator cu acest email.");
  }
  const account = await db.account.findFirst({
    where: { userId: user.id, providerId: "credential" },
    select: { id: true },
  });
  if (!account) {
    throw new DomainError(
      "ADMIN_NO_PASSWORD_ACCOUNT",
      "Contul nu folosește autentificarea cu parolă; nu am ce schimba.",
    );
  }

  const sessions = await db.session.findMany({
    where: { userId: user.id },
    select: { token: true },
  });
  await db.account.update({
    where: { id: account.id },
    data: { password: await hashPassword(password.data) },
  });
  await db.session.deleteMany({ where: { userId: user.id } });

  await new AuditService(createPrismaAuditStore(db)).record({
    actorId: "cli",
    actorLabel: options.actorLabel ?? "cli:admin:set-password",
    action: "auth.password_changed",
    entity: "user",
    entityId: user.id,
    after: { reason: SET_PASSWORD_REASON, sessionsRevoked: sessions.length },
  });

  return { userId: user.id, email: normalized, sessionTokens: sessions.map((x) => x.token) };
}

/** Șterge din cache-ul Redis sesiunile închise. `false` dacă Redis nu a răspuns (cache-ul expiră singur). */
export async function revokeCachedSessions(
  storage: AuthSecondaryStorage,
  userId: string,
  sessionTokens: readonly string[],
): Promise<boolean> {
  try {
    for (const token of sessionTokens) await storage.delete(token);
    await storage.delete(`active-sessions-${userId}`);
    return true;
  } catch {
    return false;
  }
}

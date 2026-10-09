import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { createAuthMiddleware } from "better-auth/api";
import type { PrismaClient } from "@ecom/db";
import type { SettingGroupValue } from "../settings";
import { hashPassword, verifyPassword } from "./password";
import type { AuthSecondaryStorage } from "./redis-storage";

export type AuthSettings = SettingGroupValue<"auth">;

export interface AuthEmailSender {
  sendVerification(data: { email: string; name: string; url: string }): Promise<void>;
  sendPasswordReset(data: { email: string; name: string; url: string }): Promise<void>;
}

export interface CreateAuthDeps {
  db: PrismaClient;
  secondaryStorage: AuthSecondaryStorage;
  /** `APP_URL` și secretul derivat din `APP_KEY`; nu vin din setări. */
  appUrl: string;
  secret: string;
  isProduction: boolean;
  settings: AuthSettings;
  /** Trimiterea emailurilor (coadă) se leagă în punctul de emailuri; până atunci lipsește. */
  email?: AuthEmailSender;
}

const DAY_SECONDS = 24 * 60 * 60;

/**
 * Instanța Better Auth. Politica de securitate stă aici, într-un singur loc:
 * parole argon2id, minim 12 caractere, sesiuni în DB cu cache Redis, cookie httpOnly/lax,
 * toate sesiunile revocate la schimbarea sau resetarea parolei.
 * Rate limiting-ul propriu al Better Auth e oprit: îl înlocuiește limitatorul din `rate-limit`.
 */
export function createAuth(deps: CreateAuthDeps) {
  const { settings, email } = deps;

  return betterAuth({
    appName: "ecom",
    baseURL: deps.appUrl,
    secret: deps.secret,
    database: prismaAdapter(deps.db, { provider: "postgresql" }),
    secondaryStorage: deps.secondaryStorage,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: settings.minPasswordLength,
      requireEmailVerification: settings.requireEmailVerification,
      revokeSessionsOnPasswordReset: true,
      password: { hash: hashPassword, verify: verifyPassword },
      ...(email && {
        sendResetPassword: async ({ user, url }) =>
          email.sendPasswordReset({ email: user.email, name: user.name, url }),
      }),
    },
    emailVerification: {
      sendOnSignUp: settings.requireEmailVerification,
      ...(email && {
        sendVerificationEmail: async ({ user, url }) =>
          email.sendVerification({ email: user.email, name: user.name, url }),
      }),
    },
    session: {
      expiresIn: settings.customerSessionDays * DAY_SECONDS,
      updateAge: DAY_SECONDS,
      // Sursa rămâne DB (listare/revocare); Redis e doar cache.
      storeSessionInDatabase: true,
    },
    advanced: {
      useSecureCookies: deps.isProduction,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: deps.isProduction },
    },
    rateLimit: { enabled: false },
    hooks: {
      // La schimbarea parolei se închid mereu celelalte sesiuni, indiferent ce trimite clientul.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/change-password") {
          return { context: { ...ctx, body: { ...ctx.body, revokeOtherSessions: true } } };
        }
        return undefined;
      }),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

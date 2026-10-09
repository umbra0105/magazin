import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import type { PrismaClient } from "@ecom/db";
import type { SettingGroupValue } from "../settings";
import { RateLimitedError, type AuthGuard } from "./auth-guard";
import { resolveClientIp } from "./client-ip";
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
  guard: AuthGuard;
  /** Apelat când un cont tocmai a fost blocat (audit, alertă). Nu primește parole. */
  onAccountLocked?: (data: { email: string; lockoutMinutes: number }) => Promise<void> | void;
  /** Trimiterea emailurilor (coadă) se leagă în punctul de emailuri; până atunci lipsește. */
  email?: AuthEmailSender;
}

const DAY_SECONDS = 24 * 60 * 60;

/** Același răspuns pentru email inexistent, parolă greșită și cont blocat (fără enumerare). */
const invalidCredentials = () =>
  new APIError("UNAUTHORIZED", {
    code: "INVALID_EMAIL_OR_PASSWORD",
    message: "Invalid email or password",
  });

const tooManyRequests = (error: RateLimitedError) =>
  new APIError(
    "TOO_MANY_REQUESTS",
    { code: error.code, message: error.message },
    { "Retry-After": String(error.retryAfterSeconds) },
  );

const emailOf = (body: unknown): string | null => {
  const email = (body as { email?: unknown } | null)?.email;
  return typeof email === "string" && email.length > 0 ? email : null;
};

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
      before: createAuthMiddleware(async (ctx) => {
        // La schimbarea parolei se închid mereu celelalte sesiuni, indiferent ce trimite clientul.
        if (ctx.path === "/change-password") {
          return { context: { ...ctx, body: { ...ctx.body, revokeOtherSessions: true } } };
        }
        const email = emailOf(ctx.body);
        if (!email) return undefined;
        const ip = resolveClientIp(ctx.headers ?? ctx.request?.headers, settings.trustedProxyHops);
        try {
          if (ctx.path === "/sign-in/email") {
            await deps.guard.checkLogin(email, ip);
            if ((await deps.guard.lockRemainingSeconds(email)) > 0) {
              // Cont blocat: se parcurge aceeași muncă (hash) și se întoarce același răspuns ca la
              // parolă greșită, ca blocarea să nu se vadă din exterior nici după timp, nici după mesaj.
              const password = (ctx.body as { password?: unknown }).password;
              await hashPassword(typeof password === "string" ? password : "");
              throw invalidCredentials();
            }
          } else if (ctx.path === "/sign-up/email") {
            await deps.guard.checkRegister(email, ip);
          } else if (
            ctx.path === "/request-password-reset" ||
            ctx.path === "/send-verification-email"
          ) {
            await deps.guard.checkPasswordReset(email, ip);
          }
        } catch (error) {
          if (error instanceof RateLimitedError) throw tooManyRequests(error);
          throw error;
        }
        return undefined;
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email") return;
        const email = emailOf(ctx.body);
        if (!email) return;
        const returned = ctx.context.returned;
        if (isAPIError(returned)) {
          // Contează doar credențialele greșite; limitările (429) și "email neverificat" (parola era
          // corectă) nu sunt eșecuri de parolă.
          if (
            (returned.body as { code?: string } | undefined)?.code !== "INVALID_EMAIL_OR_PASSWORD"
          )
            return;
          if (await deps.guard.recordLoginFailure(email)) {
            await deps.onAccountLocked?.({ email, lockoutMinutes: settings.lockoutMinutes });
          }
        } else if (ctx.context.newSession) {
          await deps.guard.recordLoginSuccess(email);
        }
      }),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

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

/**
 * Trimiterea emailurilor tranzacționale. Implementarea (coada) stă în aplicație. Un email care nu
 * pleacă NU trebuie să strice înregistrarea sau cererea de resetare, nici să dea un răspuns diferit
 * pentru un cont existent față de unul inexistent: erorile se înghit aici (și se loghează fără
 * conținut de către implementare).
 */
export interface AuthEmailSender {
  /** Emite tokenul de verificare (24h, unică folosință) și pune emailul în coadă. */
  sendVerification(data: { userId: string; email: string; name: string }): Promise<void>;
  /** `token` e tokenul de resetare al Better Auth (1h, unică folosință). */
  sendPasswordReset(data: { email: string; name: string; token: string }): Promise<void>;
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

/** Lungimea maximă a unei adrese de email (RFC 5321). Hook-ul rulează pe corpul BRUT, înainte de validarea Zod. */
const MAX_EMAIL_LENGTH = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

/** Same răspuns ca la un email greșit al Better Auth: nu depinde de existența contului. */
const invalidEmail = () =>
  new APIError("BAD_REQUEST", { code: "INVALID_EMAIL", message: "Invalid email" });

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
    // Tokenurile (resetarea parolei) se păstrează hash-uite: cine citește Redis sau fișierul AOF nu poate folosi un token
    // în viață (C-11). Fără asta cheia era `verification:reset-password:<token>`, adică tokenul în clar.
    verification: { storeIdentifier: "hashed" },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: settings.minPasswordLength,
      requireEmailVerification: settings.requireEmailVerification,
      revokeSessionsOnPasswordReset: true,
      password: { hash: hashPassword, verify: verifyPassword },
      // Resetarea: tokenul Better Auth (stocat în `verification`, se șterge la folosire = unică folosință).
      resetPasswordTokenExpiresIn: settings.passwordResetMinutes * 60,
      ...(email && {
        sendResetPassword: async ({ user, token }) => {
          try {
            await email.sendPasswordReset({ email: user.email, name: user.name, token });
          } catch {
            // Nu dăm erori diferite pentru cont existent/inexistent și nu blocăm cererea.
          }
        },
      }),
    },
    emailVerification: {
      sendOnSignUp: settings.requireEmailVerification,
      // Linkul Better Auth (JWT, reutilizabil) NU se folosește: `EmailVerificationService` emite un
      // token de unică folosință, iar `sendVerification` îl pune în coadă.
      ...(email && {
        sendVerificationEmail: async ({ user }) => {
          try {
            await email.sendVerification({ userId: user.id, email: user.email, name: user.name });
          } catch {
            // un email care nu pleacă nu blochează înregistrarea
          }
        },
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
        // Emailul din corpul brut intră în chei de contor: se validează ÎNAINTE (lungime, formă), ca o intrare de
        // megabytes să nu devină chei Redis de megabytes și să nu ajungă în nicio muncă costisitoare (C-07).
        if (email.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(email)) throw invalidEmail();
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

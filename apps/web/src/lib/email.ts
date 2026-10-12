import { EmailVerificationService, redactSecrets, type AuthEmailSender } from "@ecom/core";
import { loadEnv } from "@ecom/config";
import { getDb } from "@ecom/db";
import { createEmailQueue, enqueueEmail, type EmailQueue } from "@ecom/jobs";
import { getLogger } from "@ecom/shared";
import { getSettings } from "./services";

const globalForEmail = globalThis as unknown as { __ecomEmailQueue?: EmailQueue };

const ENQUEUE_TIMEOUT_MS = 5000;

/** O singură coadă (și conexiune Redis) per proces. */
function getEmailQueue(): EmailQueue {
  if (!globalForEmail.__ecomEmailQueue) {
    const queue = createEmailQueue(loadEnv().REDIS_URL);
    // Fără handler, o eroare de conexiune ar opri procesul; enqueue-ul are propriul timeout.
    queue.on("error", () => undefined);
    globalForEmail.__ecomEmailQueue = queue;
  }
  return globalForEmail.__ecomEmailQueue;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout la punerea în coadă")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Rulează `task` în fundal, fără să aștepte și fără să arunce. Folosit la emailuri: un email care
 * nu pleacă nu trebuie să blocheze înregistrarea sau resetarea, iar timpul de răspuns nu trebuie să
 * depindă de existența contului. În log intră doar un mesaj curățat (fără token, link, adresă).
 */
function inBackground(label: string, secrets: readonly string[], task: () => Promise<void>): void {
  void task().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    getLogger().warn(
      { reason: redactSecrets(message, secrets) },
      `email: nu am putut pune în coadă (${label})`,
    );
  });
}

/** Trimiterea emailurilor de autentificare, prin coada BullMQ (workerul le trimite prin SMTP). */
export function createAuthEmailSender(): AuthEmailSender {
  return {
    async sendVerification({ userId, email, name }) {
      inBackground("verificare", [email, name], async () => {
        const { emailVerificationHours } = await getSettings().getGroup("auth");
        const token = await new EmailVerificationService(getDb()).issue(
          userId,
          emailVerificationHours,
        );
        await withTimeout(
          enqueueEmail(getEmailQueue(), loadEnv().APP_KEY, {
            kind: "verify-email",
            to: email,
            name,
            token,
            validForHours: emailVerificationHours,
          }),
          ENQUEUE_TIMEOUT_MS,
        );
      });
    },
    async sendPasswordReset({ email, name, token }) {
      inBackground("resetare", [email, name, token], async () => {
        const { passwordResetMinutes } = await getSettings().getGroup("auth");
        await withTimeout(
          enqueueEmail(getEmailQueue(), loadEnv().APP_KEY, {
            kind: "reset-password",
            to: email,
            name,
            token,
            validForMinutes: passwordResetMinutes,
          }),
          ENQUEUE_TIMEOUT_MS,
        );
      });
    },
  };
}

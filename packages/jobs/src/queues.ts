import { createHash } from "node:crypto";
import { Queue, type JobsOptions } from "bullmq";
import { sealEmailPayload, type EmailPayload, type SealedEmailJob } from "@ecom/core";
import { redisConnectionFromUrl } from "./connection";

export const EMAIL_QUEUE_NAME = "emails";

/**
 * Retry cu backoff exponențial: 5 încercări, la ~10s, 20s, 40s, 80s după primul eșec. Joburile
 * reușite se șterg imediat; cele eșuate rămân 24h (payload-ul lor e criptat, nu conține nimic în
 * clar) ca să poată fi diagnosticate.
 */
export const EMAIL_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: true,
  removeOnFail: { age: 24 * 3600 },
};

export type EmailQueue = Queue<SealedEmailJob>;

export function createEmailQueue(
  redisUrl: string,
  options: { backoffDelayMs?: number; queueName?: string } = {},
) {
  const defaultJobOptions: JobsOptions = {
    ...EMAIL_JOB_OPTIONS,
    ...(options.backoffDelayMs !== undefined && {
      backoff: { type: "exponential", delay: options.backoffDelayMs },
    }),
  };
  return new Queue<SealedEmailJob>(options.queueName ?? EMAIL_QUEUE_NAME, {
    connection: redisConnectionFromUrl(redisUrl),
    defaultJobOptions,
  });
}

/**
 * Pune în coadă emailul «Anunță-mă când revine» pentru o cerere. Jobul poartă doar identificatorul cererii (adresa nu
 * ajunge în Redis), iar `jobId`-ul e derivat din el: cât timp jobul există (în așteptare, activ, în reîncercare sau eșuat,
 * 24 h), o a doua punere în coadă a aceleiași cereri, din orice instanță, e ignorată de BullMQ.
 */
export async function enqueueBackInStock(
  queue: EmailQueue,
  appKey: string,
  alertId: string,
): Promise<void> {
  await queue.add("send", sealEmailPayload(appKey, { kind: "back-in-stock", alertId }), {
    jobId: `back-in-stock-${alertId}`,
  });
}

/**
 * Pune în coadă emailul unui rând `EmailDispatch` (Faza 11). `jobId`-ul e derivat din rând: cât timp jobul există, o a doua
 * punere în coadă a aceluiași rând (măturătorul, mai multe instanțe) e ignorată de BullMQ; oricum, trimiterea se
 * «revendică» atomic în bază.
 */
export async function enqueueOrderEmail(
  queue: EmailQueue,
  appKey: string,
  dispatchId: string,
): Promise<void> {
  await queue.add("send", sealEmailPayload(appKey, { kind: "order-email", dispatchId }), {
    jobId: `order-email-${dispatchId}`,
  });
}

/**
 * Pune în coadă linkul unei oferte (Faza 11). Jetonul e sigilat în payload (nu stă în baza de date, doar amprenta lui); `jobId`-ul
 * e derivat din ofertă și din amprenta jetonului, deci aceeași trimitere nu se dublează, iar o retrimitere (jeton nou) e alt job.
 */
export async function enqueueOfferLink(
  queue: EmailQueue,
  appKey: string,
  input: { offerId: string; to: string; token: string },
): Promise<void> {
  const fingerprint = createHash("sha256").update(input.token).digest("hex").slice(0, 16);
  await queue.add("send", sealEmailPayload(appKey, { kind: "offer-link", ...input }), {
    jobId: `offer-link-${input.offerId}-${fingerprint}`,
  });
}

/** Pune un email în coadă, cu payload-ul criptat cu o cheie derivată din `APP_KEY`. */
export async function enqueueEmail(
  queue: EmailQueue,
  appKey: string,
  payload: EmailPayload,
): Promise<void> {
  await queue.add("send", sealEmailPayload(appKey, payload));
}

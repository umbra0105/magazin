import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import type { JobLogger } from "./email-processor";
import {
  PAYMENT_MAX_ATTEMPTS,
  createPaymentQueue,
  enqueuePaymentEvent,
  startPaymentWorker,
  type PaymentQueue,
} from "./payment-queue";

/**
 * Coada `payment-events` pe Redis REAL (baza de test): același eveniment pus în coadă de două ori se procesează o singură dată,
 * o eroare se reîncearcă cu backoff, iar în Redis nu rămâne mesajul original al erorii.
 */
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379/1";
const logger: JobLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function setup(queueName: string, process: (id: string) => Promise<void>) {
  const queue: PaymentQueue = createPaymentQueue(REDIS_URL, { queueName, backoffDelayMs: 20 });
  queue.on("error", () => undefined);
  const worker: Worker = startPaymentWorker({ redisUrl: REDIS_URL, queueName, process, logger });
  cleanups.push(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
  });
  return queue;
}

const until = async (condition: () => boolean, ms = 8_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timp depășit la așteptare");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("coada payment-events", () => {
  it("același eveniment pus de două ori în coadă se procesează o singură dată (jobId)", async () => {
    const seen: string[] = [];
    const queue = setup(`test-payments-${randomUUID()}`, async (id) => {
      seen.push(id);
    });
    await enqueuePaymentEvent(queue, "ev-1");
    await enqueuePaymentEvent(queue, "ev-1");
    await enqueuePaymentEvent(queue, "ev-2");
    await until(() => seen.length >= 2);
    await new Promise((r) => setTimeout(r, 200));
    expect(seen.sort()).toEqual(["ev-1", "ev-2"]);
  });

  it("o eroare se reîncearcă cu backoff până reușește; mesajul original nu rămâne în Redis", async () => {
    let attempts = 0;
    const queue = setup(`test-payments-${randomUUID()}`, async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("PAYMENT_NOT_FOUND detaliu-cu-referinta-de-plata-XYZ123");
    });
    await enqueuePaymentEvent(queue, "ev-retry");
    await until(() => attempts >= 3);
    expect(attempts).toBe(3);
    expect(PAYMENT_MAX_ATTEMPTS).toBe(6);
  });

  it("după epuizarea încercărilor jobul rămâne eșuat (dead-letter) cu doar un cod scurt", async () => {
    let attempts = 0;
    const queue = setup(`test-payments-${randomUUID()}`, async () => {
      attempts += 1;
      throw new Error("PAYMENT_NOT_FOUND ref-secreta-777");
    });
    await enqueuePaymentEvent(queue, "ev-dead");
    await until(() => attempts >= PAYMENT_MAX_ATTEMPTS, 15_000);
    await new Promise((r) => setTimeout(r, 300));
    const failed = await queue.getFailed();
    expect(failed).toHaveLength(1);
    // doar codul (PAYMENT_NOT_FOUND) rămâne în Redis: nici motivul, nici stack-ul nu conțin restul mesajului original
    expect(failed[0]?.failedReason).toBe("PAYMENT_NOT_FOUND");
    expect(JSON.stringify(failed[0]?.stacktrace ?? [])).not.toContain("ref-secreta-777");
  });
});

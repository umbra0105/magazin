import { randomUUID } from "node:crypto";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { redisConnectionFromUrl } from "./connection";
import {
  createImageImportQueue,
  enqueueImageImport,
  type ImageImportQueue,
} from "./image-import-queue";
import { createImportQueue, enqueueProductImport, type ImportQueue } from "./import-queue";

/**
 * Blocul C, C-17, pe Redis REAL: `jobId` fix + `removeOnFail: 24 h`. Dacă `runQueued` arunca înainte de propriul try/catch,
 * jobul eșuat rămânea 24 de ore, iar un `add` repetat cu același `jobId` era ignorat de BullMQ: importul rămânea blocat fără
 * ieșire («Reia imaginile» nu făcea nimic). Acum un job EȘUAT (sau terminat) cu același id se scoate înainte de `add`, iar unul
 * în așteptare/în lucru se lasă (fără dublare).
 */

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379/1";
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});
afterAll(() => redis.disconnect());

/** Un worker care eșuează jobul; întoarce când jobul a ajuns în `failed`. */
async function failFirstJob(
  queueName: string,
  jobId: string,
  queue: ImportQueue | ImageImportQueue,
) {
  const worker = new Worker(
    queueName,
    async () => {
      throw new Error("eșec injectat înainte de try/catch");
    },
    { connection: redisConnectionFromUrl(REDIS_URL) },
  );
  closers.push(() => worker.close());
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("jobul nu a eșuat în timp util")), 10_000);
    worker.on("failed", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await worker.close();
  expect(await (await queue.getJob(jobId))?.getState()).toBe("failed");
}

describe("re-enqueue după un job eșuat (Redis real)", () => {
  it("importul de produse: după un job eșuat, un nou enqueue pune din nou jobul în așteptare", async () => {
    const queueName = `test-import-${randomUUID().slice(0, 8)}`;
    const queue = createImportQueue(REDIS_URL, { queueName });
    closers.push(async () => {
      await queue.obliterate({ force: true });
      await queue.close();
    });
    const importId = `imp-${randomUUID().slice(0, 8)}`;
    await enqueueProductImport(queue, importId);
    await failFirstJob(queueName, `import-${importId}`, queue);

    await enqueueProductImport(queue, importId);
    const state = await (await queue.getJob(`import-${importId}`))?.getState();
    expect(state).toBe("waiting");
  });

  it("importul de imagini: la fel", async () => {
    const queueName = `test-images-${randomUUID().slice(0, 8)}`;
    const queue = createImageImportQueue(REDIS_URL, { queueName });
    closers.push(async () => {
      await queue.obliterate({ force: true });
      await queue.close();
    });
    const importId = `img-${randomUUID().slice(0, 8)}`;
    await enqueueImageImport(queue, importId);
    await failFirstJob(queueName, `import-images-${importId}`, queue);

    await enqueueImageImport(queue, importId);
    expect(await (await queue.getJob(`import-images-${importId}`))?.getState()).toBe("waiting");
  });

  it("un job încă în așteptare nu se dublează la un al doilea enqueue (idempotent)", async () => {
    const queueName = `test-import-${randomUUID().slice(0, 8)}`;
    const queue = createImportQueue(REDIS_URL, { queueName });
    closers.push(async () => {
      await queue.obliterate({ force: true });
      await queue.close();
    });
    const importId = `imp-${randomUUID().slice(0, 8)}`;
    await enqueueProductImport(queue, importId);
    await enqueueProductImport(queue, importId);
    expect(await queue.getWaitingCount()).toBe(1);
  });
});

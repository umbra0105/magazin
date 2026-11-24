import { randomUUID } from "node:crypto";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { redisConnectionFromUrl } from "./connection";
import { createNirImportQueue, enqueueNirImport, nirJobQueue } from "./nir-queue";

/**
 * Coada importului NIR pe Redis REAL: jobul poartă doar identificatorul importului (nu coduri sau costuri), `jobId` e fix (aceeași
 * cerere repetată nu dublează jobul), iar un job eșuat se scoate înainte de un nou `enqueue` (importul nu rămâne blocat).
 */
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379/1";
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});
afterAll(() => redis.disconnect());

function freshQueue() {
  const queueName = `test-nir-${randomUUID().slice(0, 8)}`;
  const queue = createNirImportQueue(REDIS_URL, { queueName });
  closers.push(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
  });
  return { queue, queueName };
}

describe("coada «nir-import» (Redis real)", () => {
  it("jobul poartă doar identificatorul importului", async () => {
    const { queue } = freshQueue();
    const importId = `nir-${randomUUID().slice(0, 8)}`;
    await enqueueNirImport(queue, importId);
    const job = await queue.getJob(`nir-import-${importId}`);
    expect(job?.data).toEqual({ importId });
    expect(job?.opts.attempts).toBe(1);
  });

  it("aceeași cerere repetată nu dublează jobul", async () => {
    const { queue } = freshQueue();
    const importId = `nir-${randomUUID().slice(0, 8)}`;
    await enqueueNirImport(queue, importId);
    await enqueueNirImport(queue, importId);
    expect(await queue.getWaitingCount()).toBe(1);
  });

  it("după un job eșuat, un nou enqueue îl pune din nou în așteptare", async () => {
    const { queue, queueName } = freshQueue();
    const importId = `nir-${randomUUID().slice(0, 8)}`;
    await enqueueNirImport(queue, importId);
    const worker = new Worker(
      queueName,
      async () => {
        throw new Error("eșec injectat");
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
    expect(await (await queue.getJob(`nir-import-${importId}`))?.getState()).toBe("failed");
    await enqueueNirImport(queue, importId);
    expect(await (await queue.getJob(`nir-import-${importId}`))?.getState()).toBe("waiting");
  });

  it("adaptorul pentru serviciu pune importul în coadă", async () => {
    const { queue } = freshQueue();
    const importId = `nir-${randomUUID().slice(0, 8)}`;
    await nirJobQueue(queue).enqueue(importId);
    expect((await queue.getJob(`nir-import-${importId}`))?.data).toEqual({ importId });
  });
});

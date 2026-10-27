import { randomBytes } from "node:crypto";
import type { Worker } from "bullmq";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { BackInStockService, type BackInStockSettings, type MailerConfig } from "@ecom/core";
import { getDb } from "@ecom/db";
import type { EmailTheme } from "@ecom/emails";
import { parseQuantity } from "@ecom/shared";
// Fixture-urile de stoc stau în core (precedent: scripts/dev-stock-jobs.ts); ca testele de concurență ale stocului,
// lucrează pe date COMISE, curățate la final.
import {
  addStockProduct,
  createStockContext,
  purgeStockContext,
  purgeStockLeftovers,
  type StockContext,
} from "../../core/src/test-utils/stock-fixtures";
import type { JobLogger, OutgoingMessage } from "./email-processor";
import { createEmailQueue, enqueueBackInStock, type EmailQueue } from "./queues";
import { BACK_IN_STOCK_BATCH, createBackInStockDispatcher } from "./stock-jobs";
import { startEmailWorker } from "./worker";

/**
 * Faza 5, punctul 11b: de la cererea din baza de date până la email, cu Postgres și Redis REALE, coada și workerul reale
 * (doar SMTP-ul e înlocuit de o funcție care păstrează mesajele). Dovedește: un singur email per cerere, cererea se
 * șterge DUPĂ trimitere, la eșec revine în așteptare, iar adresa nu ajunge în Redis, în jurnale sau în motivul eșecului.
 */
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379/1";
const APP_KEY = Buffer.alloc(32, 13).toString("base64");
const APP_URL = "https://magazin.example";
const MAILER: MailerConfig = {
  host: "smtp.test",
  port: 587,
  secure: false,
  fromName: "Magazin",
  fromAddress: "noreply@magazin.test",
};
const THEME: EmailTheme = {
  storeName: "Magazin",
  logoUrl: null,
  colors: {
    bg: "#ffffff",
    fg: "#111111",
    muted: "#555555",
    border: "#dddddd",
    primary: "#0b5fff",
    primaryFg: "#ffffff",
  },
  fontFamily: "Arial, sans-serif",
  radiusPx: 6,
};
const SETTINGS: BackInStockSettings = {
  lowStockSteps: 2,
  defaultLeadTimeDays: 14,
  maxPerEmail: 10,
  maxPerVariant: 1000,
};
const ADDRESS = "ana.cerere@exemplu.test";

const pool = getDb();

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});
afterAll(async () => {
  await purgeStockLeftovers(pool);
  await pool.$disconnect();
});

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout așteptând condiția");
    await new Promise((r) => setTimeout(r, 40));
  }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Env {
  ctx: StockContext;
  service: BackInStockService;
  queue: EmailQueue;
  queueName: string;
  sent: OutgoingMessage[];
  logs: string[];
  sendAttempts: { count: number };
  variant: () => Promise<string>;
  setPhysical: (variantId: string, value: string) => Promise<void>;
  dispatch: () => Promise<{ found: number; enqueued: number; failed: number }>;
  startWorker: () => Worker;
}

async function withEnv(
  options: { sendMail?: (message: OutgoingMessage, attempt: number) => Promise<void> },
  fn: (env: Env) => Promise<void>,
): Promise<void> {
  await purgeStockLeftovers(pool);
  const ctx = await createStockContext(pool);
  const queueName = `emails-test-${randomBytes(4).toString("hex")}`;
  const queue = createEmailQueue(REDIS_URL, { queueName, backoffDelayMs: 40 });
  const workers: Worker[] = [];
  try {
    const service = new BackInStockService({
      db: pool,
      readSettings: async () => SETTINGS,
      warehouseId: ctx.warehouseId,
    });
    const sent: OutgoingMessage[] = [];
    const logs: string[] = [];
    const sendAttempts = { count: 0 };
    const logger: JobLogger = {
      info: (o, m) => logs.push(JSON.stringify({ ...o, m })),
      warn: (o, m) => logs.push(JSON.stringify({ ...o, m })),
      error: (o, m) => logs.push(JSON.stringify({ ...o, m })),
    };
    const dispatcher = createBackInStockDispatcher({
      service,
      enqueue: (alertId) => enqueueBackInStock(queue, APP_KEY, alertId),
    });
    await fn({
      ctx,
      service,
      queue,
      queueName,
      sent,
      logs,
      sendAttempts,
      variant: async () =>
        (await addStockProduct(pool, ctx, { status: "active", variants: [{ physical: "0" }] }))
          .variants[0]!.id,
      setPhysical: async (variantId, value) => {
        await pool.inventoryItem.update({
          where: { variantId_warehouseId: { variantId, warehouseId: ctx.warehouseId } },
          data: { physical: parseQuantity(value) },
        });
      },
      dispatch: () => dispatcher.dispatch(),
      startWorker: () => {
        const worker = startEmailWorker({
          redisUrl: REDIS_URL,
          queueName,
          logger,
          concurrency: 2,
          deps: {
            appKey: APP_KEY,
            appUrl: APP_URL,
            loadMailer: async () => MAILER,
            loadTheme: async () => THEME,
            sendMail: async (_config, message) => {
              sendAttempts.count += 1;
              if (options.sendMail) await options.sendMail(message, sendAttempts.count);
              sent.push(message);
            },
            logger,
            backInStock: service,
          },
        });
        workers.push(worker);
        return worker;
      },
    });
  } finally {
    for (const worker of workers) await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await purgeStockContext(pool, ctx);
  }
}

const pendingCount = (variantId: string) =>
  pool.backInStockAlert.count({ where: { variantId, notifiedAt: null } });
const totalCount = (variantId: string) => pool.backInStockAlert.count({ where: { variantId } });

describe("«Anunță-mă când revine»: de la cerere la email (Postgres și Redis reale)", () => {
  it("stoc 0 → nimic; stoc adăugat → exact un email la adresa cererii, cererea dispare, iar un al doilea tur nu mai trimite", async () => {
    await withEnv({}, async (env) => {
      const id = await env.variant();
      await env.service.subscribe({ variantId: id, email: ADDRESS });
      env.startWorker();

      expect(await env.dispatch()).toEqual({ found: 0, enqueued: 0, failed: 0 });
      await pause(300);
      expect(env.sent).toHaveLength(0);
      expect(await pendingCount(id)).toBe(1);

      await env.setPhysical(id, "5");
      expect(await env.dispatch()).toEqual({ found: 1, enqueued: 1, failed: 0 });
      await waitFor(() => env.sent.length === 1);
      await waitFor(async () => (await totalCount(id)) === 0);

      const message = env.sent[0] as OutgoingMessage;
      expect(message.to).toBe(ADDRESS);
      expect(message.from.address).toBe("noreply@magazin.test");
      expect(message.subject).toMatch(/^Magazin: .+ e din nou în stoc$/);
      expect(message.html).toContain(`href="${APP_URL}/produs/`);

      expect(await env.dispatch()).toEqual({ found: 0, enqueued: 0, failed: 0 });
      await pause(400);
      expect(env.sent).toHaveLength(1);
    });
  });

  it("5 dispecere deodată și 2 workeri pe aceeași coadă: tot un singur email (jobId deduplicat + claim atomic)", async () => {
    await withEnv({}, async (env) => {
      const id = await env.variant();
      await env.service.subscribe({ variantId: id, email: ADDRESS });
      await env.setPhysical(id, "5");
      env.startWorker();
      env.startWorker();

      await Promise.all(Array.from({ length: 5 }, () => env.dispatch()));
      await waitFor(() => env.sent.length >= 1);
      await waitFor(async () => (await totalCount(id)) === 0);
      await pause(500);
      expect(env.sent).toHaveLength(1);
    });
  });

  it("aceeași cerere pusă de două ori în coadă înainte de procesare rămâne un singur job", async () => {
    await withEnv({}, async (env) => {
      const id = await env.variant();
      await env.service.subscribe({ variantId: id, email: ADDRESS });
      await env.setPhysical(id, "5");
      // fără worker: joburile rămân în coadă
      await env.dispatch();
      await env.dispatch();
      const counts = await env.queue.getJobCounts("waiting", "delayed", "active");
      expect(counts["waiting"]).toBe(1);
    });
  });

  it("adresa nu ajunge în Redis: nici în datele jobului, nici în numele lui", async () => {
    await withEnv({}, async (env) => {
      const id = await env.variant();
      await env.service.subscribe({ variantId: id, email: ADDRESS });
      await env.setPhysical(id, "5");
      await env.dispatch();
      const jobs = await env.queue.getJobs(["waiting", "delayed", "active", "failed", "completed"]);
      expect(jobs).toHaveLength(1);
      const dump = JSON.stringify(jobs.map((j) => ({ id: j.id, name: j.name, data: j.data })));
      expect(dump).not.toContain(ADDRESS);
      expect(dump).not.toContain("ana.cerere");
      expect(dump).not.toContain("@");
    });
  });

  it("SMTP cade la prima încercare: cererea revine în așteptare, a doua încercare trimite, în total un email și nicio cerere rămasă", async () => {
    await withEnv(
      {
        sendMail: async (_message, attempt) => {
          if (attempt === 1)
            throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
        },
      },
      async (env) => {
        const id = await env.variant();
        await env.service.subscribe({ variantId: id, email: ADDRESS });
        await env.setPhysical(id, "5");
        env.startWorker();
        await env.dispatch();
        await waitFor(() => env.sent.length === 1);
        await waitFor(async () => (await totalCount(id)) === 0);
        expect(env.sendAttempts.count).toBe(2);
        await pause(300);
        expect(env.sent).toHaveLength(1);
      },
    );
  });

  it("SMTP cade definitiv: cererea rămâne în așteptare (nu se pierde), motivul eșecului și jurnalele nu conțin adresa", async () => {
    await withEnv(
      {
        sendMail: async (message) => {
          throw Object.assign(new Error(`550 5.1.1 <${message.to}> rejected`), {
            code: "EENVELOPE",
          });
        },
      },
      async (env) => {
        const id = await env.variant();
        await env.service.subscribe({ variantId: id, email: ADDRESS });
        await env.setPhysical(id, "5");
        env.startWorker();
        await env.dispatch();
        await waitFor(async () => (await env.queue.getFailedCount()) === 1);
        expect(env.sent).toHaveLength(0);
        expect(await pendingCount(id)).toBe(1);
        const failed = await env.queue.getFailed();
        const reason = failed.map((j) => j.failedReason).join(" ");
        expect(reason).toContain("EENVELOPE");
        expect(reason).not.toContain(ADDRESS);
        expect(env.logs.join("\n")).not.toContain(ADDRESS);
      },
    );
  });

  it("stocul dispare între punerea în coadă și procesare: niciun email, cererea rămâne; la revenire, un email", async () => {
    await withEnv({}, async (env) => {
      const id = await env.variant();
      await env.service.subscribe({ variantId: id, email: ADDRESS });
      await env.setPhysical(id, "5");
      await env.dispatch(); // în coadă, fără worker
      await env.setPhysical(id, "0");
      env.startWorker();
      await waitFor(
        async () => (await env.queue.getJobCounts("waiting", "active"))["waiting"] === 0,
      );
      await pause(300);
      expect(env.sent).toHaveLength(0);
      expect(await pendingCount(id)).toBe(1);

      await env.setPhysical(id, "5");
      await env.dispatch();
      await waitFor(() => env.sent.length === 1);
      await waitFor(async () => (await totalCount(id)) === 0);
    });
  });

  it("cererile se trimit câte una: două adrese pe aceeași variantă primesc fiecare propriul email", async () => {
    await withEnv({}, async (env) => {
      const id = await env.variant();
      await env.service.subscribe({ variantId: id, email: ADDRESS });
      await env.service.subscribe({ variantId: id, email: "bogdan.cerere@exemplu.test" });
      await env.setPhysical(id, "5");
      env.startWorker();
      expect(await env.dispatch()).toMatchObject({ found: 2, enqueued: 2 });
      await waitFor(() => env.sent.length === 2);
      await waitFor(async () => (await totalCount(id)) === 0);
      expect(env.sent.map((m) => m.to).sort()).toEqual([ADDRESS, "bogdan.cerere@exemplu.test"]);
    });
  });

  it("dispecerul cere cel mult un lot pe tur", async () => {
    expect(BACK_IN_STOCK_BATCH).toBeGreaterThan(0);
    expect(BACK_IN_STOCK_BATCH).toBeLessThanOrEqual(500);
  });
});

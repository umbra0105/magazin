import { randomBytes } from "node:crypto";
import type { Worker } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";
import type { EmailPayload, MailerConfig } from "@ecom/core";
import type { EmailTheme } from "@ecom/emails";
import { createEmailQueue, enqueueEmail, type EmailQueue } from "./queues";
import type { EmailProcessorDeps, JobLogger, OutgoingMessage } from "./email-processor";
import { startEmailWorker } from "./worker";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379/1";
const APP_KEY = Buffer.alloc(32, 11).toString("base64");
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

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** Coadă și worker cu nume unic (nu se amestecă cu coada `emails` a aplicației). */
function setup(options: {
  sendMail: EmailProcessorDeps["sendMail"];
  loadMailer?: EmailProcessorDeps["loadMailer"];
}) {
  const queueName = `emails-test-${randomBytes(4).toString("hex")}`;
  const queue: EmailQueue = createEmailQueue(REDIS_URL, { queueName, backoffDelayMs: 40 });
  const logs: string[] = [];
  const logger: JobLogger = {
    info: (o, m) => logs.push(JSON.stringify({ ...o, m })),
    warn: (o, m) => logs.push(JSON.stringify({ ...o, m })),
    error: (o, m) => logs.push(JSON.stringify({ ...o, m })),
  };
  const worker: Worker = startEmailWorker({
    redisUrl: REDIS_URL,
    queueName,
    logger,
    concurrency: 1,
    deps: {
      appKey: APP_KEY,
      appUrl: "https://magazin.example",
      loadMailer: options.loadMailer ?? (async () => MAILER),
      loadTheme: async () => THEME,
      sendMail: options.sendMail,
      logger,
    },
  });
  cleanups.push(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
  });
  return { queue, worker, logs, queueName };
}

const reset = (): EmailPayload => ({
  kind: "reset-password",
  to: "client@example.test",
  name: "Ana",
  token: randomBytes(32).toString("base64url"),
  validForMinutes: 60,
});

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout așteptând condiția");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("coada de emailuri (Redis real)", () => {
  it("în Redis payload-ul e criptat: nu apar token, adresă sau nume în clar", async () => {
    const { queue } = setup({ sendMail: async () => undefined });
    await queue.pause();
    const payload = reset();
    await enqueueEmail(queue, APP_KEY, payload);
    const [stored] = await queue.getJobs(["waiting"]);
    const text = JSON.stringify(stored?.data);
    expect(text).toContain("reset-password");
    for (const secret of [payload.token, payload.to, payload.name]) {
      expect(text).not.toContain(secret);
    }
  });

  it("reîncearcă cu backoff: eșuează de 2 ori, a 3-a reușește, emailul pleacă o singură dată", async () => {
    const sent: OutgoingMessage[] = [];
    let calls = 0;
    const { queue, logs } = setup({
      sendMail: async (_config, message) => {
        calls += 1;
        if (calls < 3) {
          throw Object.assign(new Error(`451 temporar pentru ${message.to}`), { code: "ESOCKET" });
        }
        sent.push(message);
      },
    });
    const payload = reset();
    await enqueueEmail(queue, APP_KEY, payload);

    await waitFor(() => sent.length === 1);
    expect(calls).toBe(3);
    expect(sent[0]?.to).toBe(payload.to);
    // Nimic de aflat despre eșecurile intermediare în loguri.
    const text = logs.join("\n");
    expect(text).toContain("email: trimiterea a eșuat");
    expect(text).not.toContain(payload.token);
    expect(text).not.toContain(payload.to);
    // Jobul reușit se șterge.
    await waitFor(
      async () =>
        (await queue.getJobCounts("completed", "failed", "waiting", "delayed", "active")) !==
        undefined,
    );
    await waitFor(
      async () =>
        (await queue.getJobs(["completed", "failed", "waiting", "delayed", "active"])).length === 0,
    );
  });

  it("SMTP neconfigurat: jobul eșuează o singură dată (fără reîncercări) și rămâne diagnosticabil", async () => {
    let calls = 0;
    const { queue } = setup({
      sendMail: async () => {
        calls += 1;
      },
      loadMailer: async () => null,
    });
    await enqueueEmail(queue, APP_KEY, reset());

    await waitFor(async () => (await queue.getJobs(["failed"])).length === 1);
    const [failed] = await queue.getJobs(["failed"]);
    expect(failed?.attemptsMade).toBe(1);
    expect(failed?.failedReason).toBe("EMAIL_NOT_CONFIGURED");
    expect(calls).toBe(0);
  });

  it("după toate încercările, jobul rămâne în „failed” cu motivul curățat (fără link sau adresă)", async () => {
    const payload = reset();
    const { queue } = setup({
      sendMail: async (_c, message) => {
        throw Object.assign(new Error(`rejected ${message.to} ${message.text.slice(0, 200)}`), {
          code: "EENVELOPE",
        });
      },
    });
    await enqueueEmail(queue, APP_KEY, payload);

    await waitFor(async () => (await queue.getJobs(["failed"])).length === 1, 30_000);
    const [failed] = await queue.getJobs(["failed"]);
    expect(failed?.attemptsMade).toBe(5);
    const reason = failed?.failedReason ?? "";
    expect(reason).toContain("EENVELOPE");
    for (const secret of [payload.token, payload.to, "resetare-parola"]) {
      expect(reason).not.toContain(secret);
    }
  });
});

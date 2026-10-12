import { randomBytes } from "node:crypto";
import { UnrecoverableError } from "bullmq";
import { describe, expect, it } from "vitest";
import { sealEmailPayload, type EmailPayload, type MailerConfig } from "@ecom/core";
import type { EmailTheme } from "@ecom/emails";
import { createLogger } from "@ecom/shared";
import {
  createEmailProcessor,
  type EmailProcessorDeps,
  type JobLogger,
  type OutgoingMessage,
} from "./email-processor";

const APP_KEY = Buffer.alloc(32, 5).toString("base64");
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

function makePayload(): EmailPayload {
  return {
    kind: "reset-password",
    to: "client@example.test",
    name: "Ana Popescu",
    token: randomBytes(32).toString("base64url"),
    validForMinutes: 60,
  };
}

function capturingLogger() {
  const lines: string[] = [];
  const record = (level: string) => (obj: object, msg: string) => {
    lines.push(JSON.stringify({ level, ...obj, msg }));
  };
  const logger: JobLogger = { info: record("info"), warn: record("warn"), error: record("error") };
  return { logger, lines, text: () => lines.join("\n") };
}

function setup(overrides: Partial<EmailProcessorDeps> = {}) {
  const log = capturingLogger();
  const sent: OutgoingMessage[] = [];
  const deps: EmailProcessorDeps = {
    appKey: APP_KEY,
    appUrl: APP_URL,
    loadMailer: async () => MAILER,
    loadTheme: async () => THEME,
    sendMail: async (_config, message) => {
      sent.push(message);
    },
    logger: log.logger,
    ...overrides,
  };
  return { process: createEmailProcessor(deps), sent, log };
}

const job = (payload: EmailPayload, attemptsMade = 0) => ({
  id: "job-1",
  data: sealEmailPayload(APP_KEY, payload),
  attemptsMade,
});

describe("procesorul de emailuri", () => {
  it("trimite emailul: expeditor din setări, linkul din APP_URL cu tokenul în fragment", async () => {
    const payload = makePayload();
    const { process, sent } = setup();
    await process(job(payload));

    expect(sent).toHaveLength(1);
    const message = sent[0] as OutgoingMessage;
    expect(message.to).toBe(payload.to);
    expect(message.from).toEqual({ name: "Magazin", address: "noreply@magazin.test" });
    expect(message.subject).toBe("Resetarea parolei – Magazin");
    const expected = `${APP_URL}/resetare-parola#token=${encodeURIComponent(payload.token)}`;
    expect(message.html).toContain(expected);
    expect(message.text).toContain(expected);
  });

  it("logurile conțin doar jobId, tip și încercare: niciun token, link, adresă, nume sau corp", async () => {
    const payload = makePayload();
    const { process, sent, log } = setup();
    await process(job(payload));
    const text = log.text();
    expect(text).toContain("job-1");
    expect(text).toContain("reset-password");
    const message = sent[0] as OutgoingMessage;
    for (const secret of [
      payload.token,
      payload.to,
      payload.name,
      "resetare-parola#token",
      message.html.slice(0, 60),
      "Alege o parolă nouă",
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("la eșec SMTP, eroarea aruncată și logurile NU conțin token, link, adresă sau corp", async () => {
    const payload = makePayload();
    const link = `${APP_URL}/resetare-parola#token=${encodeURIComponent(payload.token)}`;
    const { process, log } = setup({
      sendMail: async (_c, message) => {
        // Un SMTP care repetă destinatarul, linkul și o parte din corp în mesajul de eroare.
        throw Object.assign(
          new Error(
            `550 5.1.1 <${message.to}> rejected; body: ${link}; ${message.text.slice(0, 80)}`,
          ),
          { code: "EENVELOPE" },
        );
      },
    });

    const error = await process(job(payload)).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    const thrown = `${(error as Error).name} ${(error as Error).message} ${(error as Error).stack ?? ""}`;
    for (const secret of [payload.token, payload.to, link, "Ana Popescu"]) {
      expect(thrown, secret).not.toContain(secret);
    }
    expect((error as Error).message).toContain("EENVELOPE");
    for (const secret of [payload.token, payload.to, link]) {
      expect(log.text(), secret).not.toContain(secret);
    }
  });

  it("SMTP neconfigurat sau inactiv: eroare nerecuperabilă (fără reîncercări), nimic trimis", async () => {
    const { process, sent } = setup({ loadMailer: async () => null });
    const error = await process(job(makePayload())).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(sent).toHaveLength(0);
  });

  it("payload alterat: eroare nerecuperabilă", async () => {
    const { process, sent } = setup();
    const tampered = {
      ...job(makePayload()),
      data: { kind: "reset-password" as const, sealed: "v1:x:y:z" },
    };
    expect(await process(tampered).catch((e: unknown) => e)).toBeInstanceOf(UnrecoverableError);
    expect(sent).toHaveLength(0);
  });

  it("o eroare temporară (rețea) NU e nerecuperabilă: BullMQ o reîncearcă", async () => {
    const { process } = setup({
      sendMail: async () => {
        throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
      },
    });
    const error = await process(job(makePayload())).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toContain("ETIMEDOUT");
  });
});

describe("redactarea din loggerul aplicației", () => {
  it("câmpurile token, link, html și password sunt ascunse chiar dacă cineva le loghează din greșeală", () => {
    const chunks: string[] = [];
    const logger = createLogger({
      level: "info",
      destination: { write: (chunk: string) => void chunks.push(chunk) },
    });
    const secrets = {
      token: "tok_" + randomBytes(16).toString("hex"),
      link: `${APP_URL}/resetare-parola#token=abcdefghijklmnop`,
      html: "<p>Corp de email cu date personale</p>",
      resetLink: `${APP_URL}/resetare-parola#token=zzzzzzzzzzzzzzzz`,
    };
    logger.info(
      { ...secrets, nested: { token: secrets.token, verifyLink: secrets.link }, jobId: "j1" },
      "test",
    );
    const output = chunks.join("");
    expect(output).toContain("j1");
    for (const value of [secrets.token, secrets.link, secrets.html, secrets.resetLink]) {
      expect(output, value).not.toContain(value);
    }
    expect(output).toContain("[ascuns]");
  });
});

describe("configurarea cozii", () => {
  it("joburile se reîncearcă cu backoff exponențial (5 încercări)", async () => {
    const { EMAIL_JOB_OPTIONS } = await import("./queues");
    expect(EMAIL_JOB_OPTIONS.attempts).toBe(5);
    expect(EMAIL_JOB_OPTIONS.backoff).toEqual({ type: "exponential", delay: 10_000 });
    expect(EMAIL_JOB_OPTIONS.removeOnComplete).toBe(true);
  });
});

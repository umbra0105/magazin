import { randomBytes } from "node:crypto";
import { UnrecoverableError } from "bullmq";
import { describe, expect, it } from "vitest";
import {
  sealEmailPayload,
  type ClaimResult,
  type EmailPayload,
  type MailerConfig,
} from "@ecom/core";
import type { EmailTheme } from "@ecom/emails";
import { createLogger } from "@ecom/shared";
import {
  createEmailProcessor,
  type BackInStockDelivery,
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

function makePayload(): Extract<EmailPayload, { kind: "reset-password" }> {
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

describe("procesorul: «Anunță-mă când revine» (claim → trimitere → ștergere)", () => {
  const ALERT_ID = "cm9x2k1a30000abcd1234efgh";
  const ADDRESS = "ana.client@exemplu.test";
  const TITLE = "Pompă de căldură 12 kW";
  const PRODUCT_LINK = `${APP_URL}/produs/pompa-caldura-12`;

  const alertJob = (attemptsMade = 0) => ({
    id: `back-in-stock-${ALERT_ID}`,
    data: sealEmailPayload(APP_KEY, { kind: "back-in-stock", alertId: ALERT_ID }),
    attemptsMade,
  });

  function delivery(claim?: () => Promise<ClaimResult>) {
    const calls: string[] = [];
    const impl: BackInStockDelivery = {
      claim: async (id) => {
        calls.push(`claim:${id}`);
        return claim
          ? claim()
          : {
              status: "claimed",
              alert: {
                id,
                email: ADDRESS,
                productTitle: TITLE,
                productSlug: "pompa-caldura-12",
                variantLabel: "Alb · 230 V",
              },
            };
      },
      release: async (id) => {
        calls.push(`release:${id}`);
        return true;
      },
      complete: async (id) => {
        calls.push(`complete:${id}`);
        return true;
      },
    };
    return { impl, calls };
  }

  function arrange(
    options: {
      claim?: () => Promise<ClaimResult>;
      sendMail?: EmailProcessorDeps["sendMail"];
      loadMailer?: EmailProcessorDeps["loadMailer"];
      withDelivery?: boolean;
    } = {},
  ) {
    const d = delivery(options.claim);
    const log = capturingLogger();
    const sent: OutgoingMessage[] = [];
    const deps: EmailProcessorDeps = {
      appKey: APP_KEY,
      appUrl: APP_URL,
      loadMailer: options.loadMailer ?? (async () => MAILER),
      loadTheme: async () => THEME,
      sendMail:
        options.sendMail ??
        (async (_config, message) => {
          d.calls.push("send");
          sent.push(message);
        }),
      logger: log.logger,
      ...(options.withDelivery === false ? {} : { backInStock: d.impl }),
    };
    return { process: createEmailProcessor(deps), sent, log, calls: d.calls };
  }

  it("trimite un singur email la adresa din cerere, cu linkul spre produs, și abia apoi șterge cererea", async () => {
    const { process, sent, calls } = arrange();
    await process(alertJob());
    expect(sent).toHaveLength(1);
    const message = sent[0] as OutgoingMessage;
    expect(message.to).toBe(ADDRESS);
    expect(message.from).toEqual({ name: "Magazin", address: "noreply@magazin.test" });
    expect(message.subject).toBe(`Magazin: ${TITLE} e din nou în stoc`);
    expect(message.html).toContain(`href="${PRODUCT_LINK}"`);
    expect(message.text).toContain(PRODUCT_LINK);
    expect(message.text).toContain("Vezi produsul");
    // ordinea contează: cererea se ia ÎNAINTE de trimitere și se șterge DUPĂ
    expect(calls).toEqual([`claim:${ALERT_ID}`, "send", `complete:${ALERT_ID}`]);
  });

  it("cererea nu mai există sau a fost deja luată: niciun email, nicio eroare", async () => {
    const { process, sent, calls } = arrange({ claim: async () => ({ status: "gone" }) });
    await expect(process(alertJob())).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
    expect(calls).toEqual([`claim:${ALERT_ID}`]);
  });

  it("stocul a dispărut între timp: niciun email, cererea rămâne în așteptare (fără release, fără complete)", async () => {
    const { process, sent, calls } = arrange({ claim: async () => ({ status: "unavailable" }) });
    await expect(process(alertJob())).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
    expect(calls).toEqual([`claim:${ALERT_ID}`]);
  });

  it("trimiterea eșuează: cererea revine în așteptare (release), nu se șterge, iar eroarea e temporară și curățată", async () => {
    const { process, calls } = arrange({
      sendMail: async (_c, message) => {
        throw Object.assign(
          new Error(`550 <${message.to}> rejected: ${message.text.slice(0, 120)}`),
          {
            code: "EENVELOPE",
          },
        );
      },
    });
    const error = await process(alertJob()).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    const thrown = `${(error as Error).name} ${(error as Error).message} ${(error as Error).stack ?? ""}`;
    for (const secret of [ADDRESS, TITLE, PRODUCT_LINK]) {
      expect(thrown, secret).not.toContain(secret);
    }
    expect((error as Error).message).toContain("EENVELOPE");
    expect(calls).toEqual([`claim:${ALERT_ID}`, `release:${ALERT_ID}`]);
  });

  it("eșec la randare după claim: tot release (cererea nu se pierde)", async () => {
    const d = delivery();
    const failing = createEmailProcessor({
      appKey: APP_KEY,
      appUrl: APP_URL,
      loadMailer: async () => MAILER,
      loadTheme: async () => {
        throw new Error("tema nu se poate citi");
      },
      sendMail: async () => undefined,
      logger: capturingLogger().logger,
      backInStock: d.impl,
    });
    await expect(failing(alertJob())).rejects.toThrow("tema nu se poate citi");
    expect(d.calls).toEqual([`claim:${ALERT_ID}`, `release:${ALERT_ID}`]);
  });

  it("emailul a plecat, dar ștergerea eșuează: NU se aruncă eroare (o reîncercare ar trimite din nou), doar se avertizează fără adresă", async () => {
    const d = delivery();
    d.impl.complete = async () => {
      throw new Error(`conexiune pierdută pentru ${ADDRESS}`);
    };
    const log = capturingLogger();
    const sent: OutgoingMessage[] = [];
    const processor = createEmailProcessor({
      appKey: APP_KEY,
      appUrl: APP_URL,
      loadMailer: async () => MAILER,
      loadTheme: async () => THEME,
      sendMail: async (_c, m) => void sent.push(m),
      logger: log.logger,
      backInStock: d.impl,
    });
    await expect(processor(alertJob())).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(log.text()).toContain("warn");
    expect(log.text()).not.toContain(ADDRESS);
  });

  it("release-ul însuși eșuează după un eșec de trimitere: se aruncă tot eroarea de trimitere (curățată), nu cea de release", async () => {
    const d = delivery();
    d.impl.release = async () => {
      throw new Error(`baza nu răspunde (${ADDRESS})`);
    };
    const processor = createEmailProcessor({
      appKey: APP_KEY,
      appUrl: APP_URL,
      loadMailer: async () => MAILER,
      loadTheme: async () => THEME,
      sendMail: async () => {
        throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
      },
      logger: capturingLogger().logger,
      backInStock: d.impl,
    });
    const error = await processor(alertJob()).catch((e: unknown) => e as Error);
    expect((error as Error).message).toContain("ETIMEDOUT");
    expect((error as Error).message).not.toContain(ADDRESS);
  });

  it("SMTP neconfigurat: eroare nerecuperabilă ÎNAINTE de claim (cererea nu e atinsă)", async () => {
    const { process, calls, sent } = arrange({ loadMailer: async () => null });
    expect(await process(alertJob()).catch((e: unknown) => e)).toBeInstanceOf(UnrecoverableError);
    expect(calls).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("procesor fără serviciul de cereri: eroare nerecuperabilă, nimic trimis", async () => {
    const { process, sent } = arrange({ withDelivery: false });
    expect(await process(alertJob()).catch((e: unknown) => e)).toBeInstanceOf(UnrecoverableError);
    expect(sent).toHaveLength(0);
  });

  it("logurile conțin doar jobId, tip și încercare: nicio adresă, niciun titlu, niciun link", async () => {
    const { process, log } = arrange();
    await process(alertJob(1));
    const text = log.text();
    expect(text).toContain("back-in-stock");
    for (const secret of [ADDRESS, "ana.client", TITLE, "pompa-caldura-12", "/produs/"]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("logurile unui eșec de trimitere nu conțin adresa", async () => {
    const { process, log } = arrange({
      sendMail: async () => {
        throw new Error(`rejected ${ADDRESS}`);
      },
    });
    await process(alertJob()).catch(() => undefined);
    expect(log.text()).not.toContain(ADDRESS);
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

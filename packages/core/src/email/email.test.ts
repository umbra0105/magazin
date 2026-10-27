import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildProductLink, buildResetPasswordLink, buildVerifyEmailLink } from "./links";
import { openEmailPayload, sealEmailPayload, type EmailPayload } from "./payload-seal";
import { redactSecrets } from "./sanitize";

const APP_KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");
const token = () => randomBytes(32).toString("base64url");

const payload = (): Extract<EmailPayload, { kind: "reset-password" }> => ({
  kind: "reset-password",
  to: "client@example.test",
  name: "Ana Popescu",
  token: token(),
  validForMinutes: 60,
});

describe("payload-ul joburilor de email (criptat)", () => {
  it("se deschide înapoi identic cu aceeași cheie", () => {
    const p = payload();
    expect(openEmailPayload(APP_KEY, sealEmailPayload(APP_KEY, p))).toEqual(p);
  });

  it("în valoarea din coadă nu apar în clar tokenul, adresa sau numele", () => {
    const p = payload();
    const sealed = JSON.stringify(sealEmailPayload(APP_KEY, p));
    for (const secret of [p.token, p.to, p.name, "client@example"]) {
      expect(sealed).not.toContain(secret);
    }
    expect(sealed).toContain("reset-password"); // doar tipul e în clar, pentru diagnostic
  });

  it("alterarea, altă cheie sau o structură greșită => eroare (job nerecuperabil)", () => {
    const job = sealEmailPayload(APP_KEY, payload());
    expect(() => openEmailPayload(OTHER_KEY, job)).toThrow();
    expect(() => openEmailPayload(APP_KEY, { ...job, sealed: `${job.sealed}x` })).toThrow();
    expect(() => openEmailPayload(APP_KEY, { ...job, sealed: "v1:a:b:c" })).toThrow();
  });
});

describe("payload-ul «Anunță-mă când revine» (doar identificatorul cererii)", () => {
  const alert = (): EmailPayload => ({
    kind: "back-in-stock",
    alertId: "cm9x2k1a30000abcd1234efgh",
  });

  it("se deschide înapoi identic și nu conține nicio adresă de email", () => {
    const p = alert();
    const job = sealEmailPayload(APP_KEY, p);
    expect(openEmailPayload(APP_KEY, job)).toEqual(p);
    expect(job.kind).toBe("back-in-stock");
    expect(JSON.stringify(job)).not.toContain("@");
  });

  it("un identificator ciudat (spații, bară, prea lung, gol) e respins la deschidere", () => {
    for (const alertId of ["", "a b", "a/b", "a:b", "x".repeat(65)]) {
      const job = sealEmailPayload(APP_KEY, { kind: "back-in-stock", alertId });
      expect(() => openEmailPayload(APP_KEY, job), JSON.stringify(alertId)).toThrow();
    }
  });
});

describe("linkul spre produs din emailul «Anunță-mă»", () => {
  it("se construiește din originea APP_URL: /produs/{slug}, fără query și fără fragment", () => {
    const url = new URL(
      buildProductLink("https://magazin.example/orice/cale?x=1", "pompa-caldura-12"),
    );
    expect(url.origin).toBe("https://magazin.example");
    expect(url.pathname).toBe("/produs/pompa-caldura-12");
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
  });

  it("slugul se codifică: nu poate ieși din cale și nu poate schimba gazda", () => {
    const url = new URL(buildProductLink("https://magazin.example", "../x?y=1#z/@evil.example"));
    expect(url.origin).toBe("https://magazin.example");
    expect(url.pathname.startsWith("/produs/")).toBe(true);
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
  });
});

describe("linkurile din emailuri", () => {
  it("se construiesc din APP_URL, cu tokenul în fragment (nu în cale sau query)", () => {
    const t = token();
    for (const link of [
      buildVerifyEmailLink("https://magazin.example/", t),
      buildResetPasswordLink("https://magazin.example/orice/cale?x=1", t),
    ]) {
      const url = new URL(link);
      expect(url.origin).toBe("https://magazin.example");
      expect(url.search).toBe("");
      expect(url.pathname).not.toContain(t);
      expect(url.hash).toBe(`#token=${encodeURIComponent(t)}`);
    }
    expect(new URL(buildVerifyEmailLink("https://m.example", t)).pathname).toBe(
      "/verificare-email",
    );
    expect(new URL(buildResetPasswordLink("https://m.example", t)).pathname).toBe(
      "/resetare-parola",
    );
  });

  it("alt host nu se poate strecura: doar originea din APP_URL", () => {
    const link = buildVerifyEmailLink("https://magazin.example", "a".repeat(32));
    expect(link.startsWith("https://magazin.example/")).toBe(true);
  });
});

describe("redactSecrets", () => {
  it("scoate tokenul, linkul, adresa și variantele codificate din mesaj", () => {
    const t = "tok_" + randomBytes(12).toString("base64url");
    const link = buildResetPasswordLink("https://magazin.example", t);
    const message = `550 mailbox client@example.test unavailable; body had ${link} and ${encodeURIComponent("client@example.test")} ${t}`;
    const out = redactSecrets(message, [t, link, "client@example.test"]);
    for (const secret of [
      t,
      link,
      "client@example.test",
      encodeURIComponent("client@example.test"),
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("mailbox");
    expect(out).toContain("[ascuns]");
  });

  it("ignoră valori prea scurte sau goale (nu strică mesajul)", () => {
    expect(redactSecrets("a b c", ["a", "", null, undefined])).toBe("a b c");
  });
});

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

const pw = () => randomBytes(18).toString("base64url");

describe("parole argon2id", () => {
  it("produce un hash argon2id cu parametrii OWASP, diferit la fiecare apel (sare)", async () => {
    const p = pw();
    const [a, b] = await Promise.all([hashPassword(p), hashPassword(p)]);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
  });

  it("verifică parola corectă și respinge una greșită", async () => {
    const p = pw();
    const hash = await hashPassword(p);
    expect(await verifyPassword({ hash, password: p })).toBe(true);
    expect(await verifyPassword({ hash, password: pw() })).toBe(false);
  });

  it("nu aruncă pe un hash corupt sau în alt format", async () => {
    expect(await verifyPassword({ hash: "nu-e-un-hash", password: pw() })).toBe(false);
    expect(await verifyPassword({ hash: "", password: pw() })).toBe(false);
  });
});

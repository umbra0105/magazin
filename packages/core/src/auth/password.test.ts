import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PASSWORD_HASH_LIMITS, hashPassword, verifyPassword } from "./password";

const pw = () => randomBytes(18).toString("base64url");
const b64 = (bytes: number): string => randomBytes(bytes).toString("base64").replace(/=+$/, "");

/** Un hash cu forma cerută, dar cu parametrii dați (fără să fie calculat: verificarea trebuie să-l refuze înainte). */
const fake = (params: string, salt = b64(16), tag = b64(32), head = "$argon2id$v=19$"): string =>
  `${head}${params}$${salt}$${tag}`;

describe("parole argon2id", () => {
  it("produce un hash argon2id cu parametrii OWASP, diferit la fiecare apel (sare)", async () => {
    const p = pw();
    const [a, b] = await Promise.all([hashPassword(p), hashPassword(p)]);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
  });

  it("formatul PHC: sare de 16 octeți, tag de 32, base64 fără padding", async () => {
    const hash = await hashPassword(pw());
    const match =
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(hash) ?? [];
    expect(Buffer.from(match[1] ?? "", "base64")).toHaveLength(16);
    expect(Buffer.from(match[2] ?? "", "base64")).toHaveLength(32);
    expect(hash.split("$").slice(4).join("")).not.toContain("=");
  });

  it("verifică parola corectă și respinge una greșită", async () => {
    const p = pw();
    const hash = await hashPassword(p);
    expect(await verifyPassword({ hash, password: p })).toBe(true);
    expect(await verifyPassword({ hash, password: pw() })).toBe(false);
    expect(await verifyPassword({ hash, password: `${p} ` })).toBe(false);
  });

  it("unicode, parolă goală (la nivel de funcție) și parolă lungă se verifică exact", async () => {
    for (const p of ["Șarpele țesut ăîâ 密码🔐", "", "x".repeat(500), "é ≠ é"]) {
      const hash = await hashPassword(p);
      expect(await verifyPassword({ hash, password: p }), JSON.stringify(p)).toBe(true);
      expect(await verifyPassword({ hash, password: `${p}!` })).toBe(false);
    }
    // forma descompusă (NFD) și cea compusă (NFC) a aceleiași litere sunt parole diferite (octeți diferiți)
    const nfc = await hashPassword("é");
    expect(await verifyPassword({ hash: nfc, password: "é" })).toBe(false);
  });

  it("un tag modificat nu se acceptă", async () => {
    const hash = await hashPassword("parola-de-test");
    const parts = hash.split("$");
    const tag = Buffer.from(parts[5] ?? "", "base64");
    tag[0] = (tag[0] ?? 0) ^ 1;
    parts[5] = tag.toString("base64").replace(/=+$/, "");
    expect(await verifyPassword({ hash: parts.join("$"), password: "parola-de-test" })).toBe(false);
  });

  it("nu aruncă pe un hash corupt sau în alt format", async () => {
    expect(await verifyPassword({ hash: "nu-e-un-hash", password: pw() })).toBe(false);
    expect(await verifyPassword({ hash: "", password: pw() })).toBe(false);
    expect(await verifyPassword({ hash: "$argon2id$", password: pw() })).toBe(false);
    expect(await verifyPassword({ hash: `${"$".repeat(50)}`, password: pw() })).toBe(false);
  });
});

describe("parole: hash-uri străine sau cu parametri excesivi sunt respinse înainte de orice calcul", () => {
  const p = pw();
  const lim = PASSWORD_HASH_LIMITS;
  const cases: [string, string][] = [
    ["argon2i", fake("m=19456,t=2,p=1", b64(16), b64(32), "$argon2i$v=19$")],
    ["argon2d", fake("m=19456,t=2,p=1", b64(16), b64(32), "$argon2d$v=19$")],
    ["versiune veche (v=16)", fake("m=19456,t=2,p=1", b64(16), b64(32), "$argon2id$v=16$")],
    ["fără versiune", `$argon2id$m=19456,t=2,p=1$${b64(16)}$${b64(32)}`],
    ["bcrypt", "$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234"],
    ["memorie peste plafon", fake(`m=${lim.memory.max + 1},t=2,p=1`)],
    ["memorie de 4 GiB", fake("m=4194304,t=2,p=1")],
    ["memorie la limita u32", fake("m=4294967295,t=2,p=1")],
    ["iterații peste plafon", fake(`m=19456,t=${lim.passes.max + 1},p=1`)],
    ["un miliard de iterații", fake("m=19456,t=1000000000,p=1")],
    ["paralelism peste plafon", fake(`m=19456,t=2,p=${lim.parallelism.max + 1}`)],
    ["paralelism 0", fake("m=19456,t=2,p=0")],
    ["iterații 0", fake("m=19456,t=0,p=1")],
    ["memorie sub 8·p", fake("m=8,t=2,p=2")],
    ["sare prea scurtă", fake("m=19456,t=2,p=1", b64(lim.saltBytes.min - 1))],
    ["sare prea lungă", fake("m=19456,t=2,p=1", b64(lim.saltBytes.max + 1))],
    ["tag prea scurt", fake("m=19456,t=2,p=1", b64(16), b64(lim.tagBytes.min - 1))],
    ["tag prea lung", fake("m=19456,t=2,p=1", b64(16), b64(lim.tagBytes.max + 1))],
    ["cu padding «=»", `${fake("m=19456,t=2,p=1")}=`],
    ["ordinea parametrilor schimbată", fake("t=2,m=19456,p=1")],
    ["parametri cu semn", fake("m=+19456,t=2,p=1")],
    ["cifre în plus", fake("m=0000019456000,t=2,p=1")],
    ["spațiu la capăt", `${fake("m=19456,t=2,p=1")} `],
    ["parametri suplimentari", fake("m=19456,t=2,p=1,keyid=x")],
  ];

  it.each(cases)("%s → false, rapid (fără derivare)", async (_name, hash) => {
    const started = performance.now();
    expect(await verifyPassword({ hash, password: p })).toBe(false);
    // o derivare la parametrii de azi durează ~30 ms; refuzul din parsare e sub o milisecundă (marjă largă)
    expect(performance.now() - started).toBeLessThan(15);
  });

  it("limitele sunt apropiate de parametrii de azi (marjă mică)", () => {
    expect(lim.memory.max).toBeLessThanOrEqual(19_456 * 3);
    expect(lim.passes.max).toBeLessThanOrEqual(2 * 2);
    expect(lim.parallelism.max).toBeLessThanOrEqual(2);
  });

  it("hash-urile la limitele permise se acceptă la verificare (parametrii citiți din hash)", async () => {
    // un hash propriu cu parametri mai mari decât ai noștri, dar în plafon, se calculează și se verifică
    const { argon2Sync } = await import("node:crypto");
    const salt = randomBytes(16);
    const tag = argon2Sync("argon2id", {
      message: Buffer.from(p),
      nonce: salt,
      parallelism: 2,
      tagLength: 32,
      memory: 24_576,
      passes: 3,
    });
    const hash = `$argon2id$v=19$m=24576,t=3,p=2$${salt.toString("base64").replace(/=+$/, "")}$${tag.toString("base64").replace(/=+$/, "")}`;
    expect(await verifyPassword({ hash, password: p })).toBe(true);
    expect(await verifyPassword({ hash, password: `${p}x` })).toBe(false);
  });
});

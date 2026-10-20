import { argon2Sync, randomBytes } from "node:crypto";
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

/**
 * Hash-uri produse de implementarea VECHE (`@node-rs/argon2` 2.2.2, parametrii de azi) în CI-ul din B2.1, cu parole
 * INVENTATE. Sunt valori fixe: dovada permanentă că parolele stocate înainte de trecerea la `crypto.argon2` se
 * validează cu implementarea nouă, fără migrare sau rehash. Parolele sunt scrise cu escape-uri \u, ca forma
 * Unicode (compusă / descompusă) să nu se altereze la copiere sau la salvare.
 */
const OLD_VECTORS: { label: string; password: string; hash: string }[] = [
  {
    label: "ascii (cu diacritice românești)",
    password: "Parola-de-test-1 cu spații și simboluri !@#$%",
    hash: "$argon2id$v=19$m=19456,t=2,p=1$j0jizD8PxbI2s2MhHYSmPQ$Kiou/LKEY2SUvBUxHD7+uPcDJneSktM0kf/Iv63wXq4",
  },
  {
    label: "unicode compus (NFC)",
    password: "Șarpele țesut ăîâ 密码\u{1f510} pässwörd",
    hash: "$argon2id$v=19$m=19456,t=2,p=1$sCZQiHLEazvxUqGcaajRkQ$PxUNywC4Rh07f9BD9bUI+MSKYjWrbmo6pa/mzvi48yo",
  },
  {
    label: "unicode descompus (NFD)",
    password: "é ä ô (forma descompusă)",
    hash: "$argon2id$v=19$m=19456,t=2,p=1$Ib0diSynZRDE6j5uoY3TiA$tcwHTrmstiYdx7FTdr6vcXWaWANmsgpiX//XOj4A2lc",
  },
  {
    label: "goală",
    password: "",
    hash: "$argon2id$v=19$m=19456,t=2,p=1$gVxzQiaJSto3pcKpGDMY8Q$dqMuBYzCja3G4EehIUHRF3fhcWmAVbWBBwNhIjRyM9g",
  },
  {
    label: "lungă (300 de caractere)",
    password: "lung-".repeat(60),
    hash: "$argon2id$v=19$m=19456,t=2,p=1$pG60bURoJFv9NrnpeA6NUQ$sEQIqn71g7ts1UVuGqQ2cTchCrmCKfHke5f79ufu3fQ",
  },
  {
    label: "cu caracter NUL",
    password: "a\u0000b",
    hash: "$argon2id$v=19$m=19456,t=2,p=1$7VGOPPHpC8IAp02rQ1SHwA$G766+LV0Q3Q0RfuJQeHf43UhFPk21gJiHkwvbPodjjk",
  },
];

describe("compatibilitate permanentă: hash-uri produse de implementarea veche (valori fixe)", () => {
  it.each(OLD_VECTORS)("$label: se validează cu implementarea nouă", async ({ password, hash }) => {
    expect(await verifyPassword({ hash, password })).toBe(true);
  });

  it.each(OLD_VECTORS)("$label: o parolă apropiată NU se validează", async ({ password, hash }) => {
    expect(await verifyPassword({ hash, password: `${password}x` })).toBe(false);
    expect(await verifyPassword({ hash, password: `x${password}` })).toBe(false);
  });

  it("forma compusă (NFC) și cea descompusă (NFD) sunt parole DIFERITE (octeți diferiți)", async () => {
    const nfc = OLD_VECTORS.find((v) => v.label.includes("NFC"));
    const nfd = OLD_VECTORS.find((v) => v.label.includes("NFD"));
    if (!nfc || !nfd) throw new Error("lipsesc vectorii NFC / NFD");
    // forma lor Unicode e cea așteptată (nu s-a alterat la salvare)
    expect(nfc.password).toBe(nfc.password.normalize("NFC"));
    expect(nfd.password).not.toBe(nfd.password.normalize("NFC"));
    // fiecare hash se validează DOAR cu forma lui
    expect(await verifyPassword({ hash: nfd.hash, password: nfd.password })).toBe(true);
    expect(await verifyPassword({ hash: nfd.hash, password: nfd.password.normalize("NFC") })).toBe(
      false,
    );
    expect(await verifyPassword({ hash: nfc.hash, password: nfc.password })).toBe(true);
    expect(await verifyPassword({ hash: nfc.hash, password: nfc.password.normalize("NFD") })).toBe(
      false,
    );
  });

  it("hash-urile vechi au exact forma și parametrii așteptați (și hash-urile noi la fel)", async () => {
    const shape = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;
    for (const { hash } of OLD_VECTORS) expect(hash).toMatch(shape);
    expect(await hashPassword("forma")).toMatch(shape);
  });
});

describe("algoritmul: vectorul oficial RFC 9106 §5.3 (Argon2id)", () => {
  it("crypto.argon2 reproduce exact eticheta din RFC 9106", () => {
    // parola 32×0x01, sare 16×0x02, secret 8×0x03, date asociate 12×0x04; t=3, m=32 KiB, p=4, tag de 32 de octeți
    const tag = argon2Sync("argon2id", {
      message: Buffer.alloc(32, 0x01),
      nonce: Buffer.alloc(16, 0x02),
      secret: Buffer.alloc(8, 0x03),
      associatedData: Buffer.alloc(12, 0x04),
      parallelism: 4,
      tagLength: 32,
      memory: 32,
      passes: 3,
    });
    expect(tag.toString("hex")).toBe(
      "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659",
    );
  });
});

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalStorageDriver } from "./local-driver";
import { deriveSigningKey, verifyClaims } from "./signing";
import { StorageError } from "./types";

const signingKey = deriveSigningKey(Buffer.alloc(32, 3).toString("base64"));
let base: string;
let root: string;
let driver: LocalStorageDriver;

async function read(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "ecom-storage-"));
  root = join(base, "root");
  driver = new LocalStorageDriver({ rootDir: root, appUrl: "https://magazin.test", signingKey });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("LocalStorageDriver", () => {
  it("put → stat → get → delete", async () => {
    const body = Buffer.from("conținut");
    const key = "public/media/2026/10/a.txt";
    const stored = await driver.put(key, body, { contentType: "text/plain" });
    expect(stored).toEqual({ key, size: body.length, contentType: "text/plain" });

    expect(await driver.stat(key)).toEqual({ key, size: body.length, contentType: "text/plain" });
    const { stream, object } = await driver.get(key);
    expect(object.contentType).toBe("text/plain");
    expect((await read(stream)).equals(body)).toBe(true);

    await driver.delete(key);
    expect(await driver.stat(key)).toBeNull();
    await expect(driver.get(key)).rejects.toMatchObject({ code: "STORAGE_NOT_FOUND" });
  });

  it("put înlocuiește un obiect existent și nu lasă fișiere temporare", async () => {
    const key = "private/digital/x.bin";
    await driver.put(key, Buffer.from("v1"), { contentType: "application/octet-stream" });
    await driver.put(key, Buffer.from("versiunea-2"), { contentType: "application/pdf" });
    expect(await driver.stat(key)).toMatchObject({ size: 11, contentType: "application/pdf" });
    const files = await readdir(join(root, "private", "digital"));
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("ștergerea unui obiect inexistent e idempotentă", async () => {
    await expect(driver.delete("public/nu/exista.jpg")).resolves.toBeUndefined();
  });

  it("stat pe un director sau pe o cheie lipsă întoarce null", async () => {
    await driver.put("public/dir/f.txt", Buffer.from("x"), { contentType: "text/plain" });
    expect(await driver.stat("public/dir")).toBeNull();
    expect(await driver.stat("public/lipsa.txt")).toBeNull();
  });

  it("refuză cheile cu path traversal la ORICE operație și nu scrie în afara rădăcinii", async () => {
    const keys = [
      "../outside/x.txt",
      "public/../../outside/x.txt",
      "public/%2e%2e/x",
      "/etc/passwd",
    ];
    for (const key of keys) {
      await expect(
        driver.put(key, Buffer.from("x"), { contentType: "text/plain" }),
      ).rejects.toMatchObject({ code: "STORAGE_INVALID_KEY" });
      await expect(driver.get(key)).rejects.toMatchObject({ code: "STORAGE_INVALID_KEY" });
      await expect(driver.stat(key)).rejects.toMatchObject({ code: "STORAGE_INVALID_KEY" });
      await expect(driver.delete(key)).rejects.toMatchObject({ code: "STORAGE_INVALID_KEY" });
      await expect(driver.signedUrl(key, { expiresInSeconds: 60 })).rejects.toMatchObject({
        code: "STORAGE_INVALID_KEY",
      });
    }
    // nimic nu a apărut lângă rădăcină
    expect((await readdir(base)).sort()).toEqual(["root"]);
  });

  it("fișierul de metadate nu e adresabil ca obiect", async () => {
    await driver.put("public/meta/a.txt", Buffer.from("x"), { contentType: "text/plain" });
    await expect(driver.get("public/meta/a.txt.meta.json")).rejects.toMatchObject({
      code: "STORAGE_INVALID_KEY",
    });
  });

  it("publicUrl: doar pentru public/, fără prefixul public și cu segmente codificate", () => {
    expect(driver.publicUrl("public/media/2026/10/a-b.jpg")).toBe(
      "https://magazin.test/media/media/2026/10/a-b.jpg",
    );
    expect(() => driver.publicUrl("private/digital/a.pdf")).toThrowError(
      expect.objectContaining({ code: "STORAGE_NOT_PUBLIC" }),
    );
    expect(() => driver.publicUrl("public/../x")).toThrowError(StorageError);
  });

  it("signedUrl: expirare obligatorie, semnătură verificabilă, nume de descărcare", async () => {
    const key = "private/digital/curs.pdf";
    const url = new URL(
      await driver.signedUrl(key, { expiresInSeconds: 300, downloadFilename: "Curs piscine.pdf" }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://magazin.test/storage/signed/private/digital/curs.pdf",
    );
    const exp = Number(url.searchParams.get("exp"));
    const sig = url.searchParams.get("sig") ?? "";
    expect(exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(290);
    expect(url.searchParams.get("dl")).toBe("Curs piscine.pdf");
    const claims = { key, expires: exp, downloadFilename: "Curs piscine.pdf" };
    expect(verifyClaims(claims, sig, signingKey)).toBe(true);
    expect(verifyClaims({ ...claims, key: "private/digital/alt.pdf" }, sig, signingKey)).toBe(
      false,
    );
  });

  it("signedUrl respinge expirări invalide (0, negativ, fracționar, peste 7 zile, NaN)", async () => {
    for (const expiresInSeconds of [0, -5, 1.5, 7 * 24 * 3600 + 1, Number.NaN]) {
      await expect(driver.signedUrl("private/a/b.pdf", { expiresInSeconds })).rejects.toMatchObject(
        { code: "STORAGE_INVALID_EXPIRY" },
      );
    }
  });
});

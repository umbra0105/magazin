import { describe, expect, it } from "vitest";
import { S3StorageDriver, contentDisposition } from "./s3-driver";

const base = {
  endpoint: "http://s3.example.test:9000",
  region: "us-east-1",
  bucket: "magazin",
  accessKeyId: "AKIA-TEST-NOT-REAL",
  secretAccessKey: "secret-test-not-real",
  forcePathStyle: true,
  appUrl: "https://magazin.test",
};

// Semnarea URL-urilor e calcul local: nu deschide nicio conexiune (testul unitar ar eșua altfel).
describe("S3StorageDriver (fără rețea)", () => {
  const driver = new S3StorageDriver(base);

  it("signedUrl: cu expirare, fără secretul în URL, valabil pentru chei private", async () => {
    const url = new URL(await driver.signedUrl("private/digital/a.pdf", { expiresInSeconds: 120 }));
    expect(url.origin).toBe("http://s3.example.test:9000");
    expect(url.pathname).toBe("/magazin/private/digital/a.pdf");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.toString()).not.toContain(base.secretAccessKey);
  });

  it("signedUrl cu nume de descărcare cere Content-Disposition: attachment", async () => {
    const url = new URL(
      await driver.signedUrl("private/a/b.pdf", {
        expiresInSeconds: 60,
        downloadFilename: "Manual.pdf",
      }),
    );
    const disposition = url.searchParams.get("response-content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("Manual.pdf");
  });

  it("signedUrl respinge expirările invalide și cheile invalide", async () => {
    await expect(
      driver.signedUrl("private/a/b.pdf", { expiresInSeconds: 0 }),
    ).rejects.toMatchObject({ code: "STORAGE_INVALID_EXPIRY" });
    await expect(driver.signedUrl("../x", { expiresInSeconds: 60 })).rejects.toMatchObject({
      code: "STORAGE_INVALID_KEY",
    });
  });

  it("list refuză prefixele invalide înainte de orice cerere de rețea", async () => {
    for (const bad of ["private/docs", "../x/", "private/", ""]) {
      await expect(driver.list(bad), JSON.stringify(bad)).rejects.toMatchObject({
        code: "STORAGE_INVALID_KEY",
      });
    }
  });

  it("publicUrl trece prin aplicație fără S3_PUBLIC_URL și prin CDN cu el", () => {
    expect(driver.publicUrl("public/media/2026/10/a.avif")).toBe(
      "https://magazin.test/media/media/2026/10/a.avif",
    );
    const cdn = new S3StorageDriver({ ...base, publicBaseUrl: "https://cdn.magazin.test/" });
    expect(cdn.publicUrl("public/media/2026/10/a.avif")).toBe(
      "https://cdn.magazin.test/public/media/2026/10/a.avif",
    );
  });

  it("publicUrl refuză obiectele private, oricum ar fi configurat", () => {
    const cdn = new S3StorageDriver({ ...base, publicBaseUrl: "https://cdn.magazin.test" });
    for (const d of [driver, cdn]) {
      expect(() => d.publicUrl("private/digital/a.pdf")).toThrowError(
        expect.objectContaining({ code: "STORAGE_NOT_PUBLIC" }),
      );
    }
  });

  it("operațiile resping cheile invalide înainte de orice apel de rețea", async () => {
    await expect(driver.get("public/../x")).rejects.toMatchObject({ code: "STORAGE_INVALID_KEY" });
    await expect(driver.stat("x")).rejects.toMatchObject({ code: "STORAGE_INVALID_KEY" });
    await expect(driver.delete("public//x")).rejects.toMatchObject({
      code: "STORAGE_INVALID_KEY",
    });
    await expect(
      driver.put("../x", Buffer.from("a"), { contentType: "text/plain" }),
    ).rejects.toMatchObject({ code: "STORAGE_INVALID_KEY" });
  });
});

describe("contentDisposition", () => {
  it("curăță ghilimelele, rândurile noi și separatorii de cale", () => {
    const value = contentDisposition('ra"u\r\nX-Injected: 1/../ș.pdf');
    expect(value).not.toMatch(/[\r\n]/);
    expect(value.startsWith('attachment; filename="')).toBe(true);
    expect(value).toContain("filename*=UTF-8''");
    expect(value).not.toContain('ra"u');
  });
});

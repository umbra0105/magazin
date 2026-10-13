import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { promoteE2eUser } from "../packages/core/test/e2e-support";
import { solidPng } from "./support/png";
import { deleteTestObject, presignGet, putTestObject, s3E2eEnv } from "./support/s3";

/**
 * Upload pe driverul S3 (MinIO), pe un server E2E separat (vezi `playwright.config.ts`, proiectul
 * `chromium-s3`): STORAGE_DRIVER=s3, bucket de test creat cu `storage:init`, `S3_PUBLIC_URL` către
 * bucketul de test. Acoperă ce nu se vede pe driverul local: bucket, credențiale, path-style,
 * citire anonimă doar pe `public/*`, refuz pe `private/*`.
 */

const s3 = s3E2eEnv();

async function createOwner(request: APIRequestContext, baseURL: string) {
  const email = `e2e-${randomBytes(5).toString("hex")}@example.test`;
  const password = randomBytes(18).toString("base64url");
  const response = await request.post(`${baseURL}/api/auth/sign-up/email`, {
    headers: { origin: baseURL },
    data: { name: "Cont E2E", email, password },
  });
  expect(response.ok()).toBe(true);
  await promoteE2eUser(email, "owner");
  return { email, password };
}

async function login(page: Page, account: { email: string; password: string }) {
  await page.goto("/autentificare?next=%2Fadmin%2Fmedia");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Parolă", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Intră în cont" }).click();
  await page.waitForURL((url) => url.pathname === "/admin/media");
}

test.describe.configure({ mode: "serial", timeout: 300_000 });

test.describe("media pe driverul S3 (MinIO)", () => {
  test("upload, procesare până la «Gata», citire anonimă pe public/, refuz pe private/, ștergere", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createOwner(request, baseURL as string);
    await login(page, owner);

    // 1. Upload prin serverul aplicației (driverul S3 scrie în bucketul de test).
    const tag = randomBytes(3).toString("hex");
    const name = `s3-${tag}.png`;
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name, mimeType: "image/png", buffer: solidPng(640, 360, [30, 140, 200]) });
    await expect(page.getByText("1 din 1 încărcate")).toBeVisible({ timeout: 60_000 });

    // 2. Procesarea (worker, sharp, scriere de variante în S3) ajunge la «Gata».
    await page.goto(`/admin/media?q=${tag}`);
    const card = page.locator("[data-media-card]");
    await expect(card).toHaveCount(1, { timeout: 30_000 });
    await expect(card.getByText("Gata", { exact: true })).toBeVisible({ timeout: 90_000 });

    // 3. Adresa thumb-ului pleacă direct către S3_PUBLIC_URL (nu prin aplicație) și se citește
    // anonim (fără cookie-uri), cu tipul corect.
    const src = await card
      .locator("img")
      .first()
      .evaluate((el) => (el as HTMLImageElement).src);
    expect(src.startsWith(`${s3.publicUrl}/public/media/`)).toBe(true);
    expect(src).not.toContain("original");
    const anonymous = await request.get(src);
    expect(anonymous.status()).toBe(200);
    expect(anonymous.headers()["content-type"]).toMatch(/^image\//);

    // 4. Bucketul nu se poate lista anonim.
    const listing = await request.get(`${s3.endpoint}/${s3.bucket}/`);
    expect(listing.status()).toBe(403);

    // 5. private/: un obiect real nu se citește anonim; cu link semnat da.
    const privateKey = `private/e2e-${tag}/secret.txt`;
    await putTestObject(s3, privateKey, Buffer.from(`secret-${tag}`), "text/plain");
    try {
      const denied = await request.get(`${s3.publicUrl}/${privateKey}`);
      expect(denied.status()).toBe(403);
      const signed = await request.get(await presignGet(s3, privateKey));
      expect(signed.status()).toBe(200);
      expect(await signed.text()).toBe(`secret-${tag}`);
    } finally {
      await deleteTestObject(s3, privateKey);
    }

    // 6. Ștergerea din bibliotecă scoate și fișierele din bucket.
    await page.getByRole("button", { name: `Deschide ${name}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Șterge…" }).click();
    await page.getByRole("button", { name: "Șterge definitiv" }).click();
    await expect(page.getByRole("button", { name: `Deschide ${name}` })).toHaveCount(0);
    await expect
      .poll(async () => (await request.get(src)).status(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(400);
  });
});

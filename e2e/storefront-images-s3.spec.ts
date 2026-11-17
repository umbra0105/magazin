import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  promoteE2eUser,
  publishE2eStorefrontProduct,
  removeE2eCatalogRefs,
  removeE2eProducts,
} from "../packages/core/test/e2e-support";
import { solidPng } from "./support/png";
import { s3E2eEnv } from "./support/s3";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Imaginile din vitrină, într-o configurare ca la dezvoltarea locală: storage S3 (MinIO), adresele de imagini pe ALTĂ origine
 * decât aplicația (`S3_PUBLIC_URL`), fișiere încărcate prin interfață și procesate de worker, iar un original mic (640 px) care
 * nu primește varianta «large» (pipeline-ul nu mărește imaginile). Cazul real din baza de dezvoltare: galeria paginii de produs
 * cerea doar «large» și rămânea goală. Verifică, pe un browser real, că imaginea e DESENATĂ (`naturalWidth > 0`) în cardul din
 * categorie și în galeria paginii de produs, nu doar că elementul `img` există.
 */
const s3 = s3E2eEnv();

async function createOwner(request: APIRequestContext, baseURL: string) {
  const email = `e2e-${randomBytes(5).toString("hex")}@example.test`;
  const password = randomBytes(18).toString("base64url");
  const response = await request.post(`${baseURL}/api/auth/sign-up/email`, {
    headers: { origin: baseURL, "x-forwarded-for": uniqueClientIp() },
    data: { name: "Cont E2E", email, password },
  });
  await expectResponseOk(response, "înregistrarea contului de test");
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

/** Imaginea e încărcată și desenată de browser: dimensiune naturală > 0 (nu un `img` gol sau eșuat). */
async function expectDrawn(image: Locator) {
  await image.scrollIntoViewIfNeeded();
  await expect
    .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 30_000 })
    .toBeGreaterThan(0);
}

test.describe.configure({ mode: "serial", timeout: 300_000 });

test.describe("imaginile vitrinei pe storage S3 (ca la dezvoltare)", () => {
  const tag = randomBytes(3).toString("hex");
  let slug = "";
  let categoryPath = "";

  test.afterAll(async () => {
    await removeE2eProducts();
    await removeE2eCatalogRefs();
  });

  test("categorie și pagină de produs: imaginea reală e desenată, de pe altă origine", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createOwner(request, baseURL as string);
    await login(page, owner);

    const name = `vitrina-${tag}.png`;
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name, mimeType: "image/png", buffer: solidPng(640, 360, [30, 140, 200]) });
    await expect(page.getByText("1 din 1 încărcate")).toBeVisible({ timeout: 60_000 });
    await page.goto(`/admin/media?q=${tag}`);
    const card = page.locator("[data-media-card]");
    await expect(card.getByText("Gata", { exact: true })).toBeVisible({ timeout: 90_000 });

    const published = await publishE2eStorefrontProduct(name, tag);
    slug = published.productSlug;
    categoryPath = published.categoryPath;

    // categoria: cardul produsului are imaginea desenată, de pe adresa publică a storage-ului
    await page.goto(`/categorie/${categoryPath}`);
    const productCard = page.locator("article", { hasText: published.title });
    await expect(productCard).toHaveCount(1);
    const cardImage = productCard.locator("img");
    await expect(cardImage).toHaveCount(1);
    await expectDrawn(cardImage);
    const cardSrc = await cardImage.evaluate((el) => (el as HTMLImageElement).currentSrc);
    expect(cardSrc.startsWith(`${s3.publicUrl}/public/media/`)).toBe(true);
    expect(new URL(cardSrc).origin).not.toBe(new URL(baseURL as string).origin);

    // pagina de produs: galeria are imaginea mare desenată (originalul mic nu are varianta «large»)
    await page.goto(`/produs/${slug}`);
    const mainImage = page.locator("[data-gallery-main] img");
    await expect(mainImage).toHaveCount(1);
    await expectDrawn(mainImage);
    await expect(page.getByText("Fără imagine")).toHaveCount(0);
    const mainSrc = await mainImage.evaluate((el) => (el as HTMLImageElement).currentSrc);
    expect(mainSrc.startsWith(`${s3.publicUrl}/public/media/`)).toBe(true);
    expect(mainSrc).not.toContain("original");
  });
});

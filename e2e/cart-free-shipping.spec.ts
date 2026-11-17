import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  clearE2eSetting,
  promoteE2eUser,
  removeE2eCarts,
  removeE2eProducts,
  seedE2eCartProduct,
  type E2eCartProduct,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Pragul de transport gratuit (Faza 8): setarea `checkout.freeShippingThreshold` se completează din admin (`/admin/setari/cos`);
 * gol = dezactivat (indicatorul nu apare deloc în coș). Specul schimbă o setare comună întregii vitrine, de aceea rulează în
 * proiectul izolat (`GLOBAL_STATE_SPEC_FILES`), nu în paralel cu alte specuri care citesc coșul.
 */
const tag = randomBytes(3).toString("hex");
let product: E2eCartProduct;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await clearE2eSetting("checkout.freeShippingThreshold");
  product = await seedE2eCartProduct(tag, "prag", { price: 19900 });
});

test.afterAll(async () => {
  await clearE2eSetting("checkout.freeShippingThreshold");
  await removeE2eCarts();
  await removeE2eProducts();
});

async function createOwner(request: APIRequestContext, baseURL: string) {
  const email = `e2e-${randomBytes(5).toString("hex")}@example.test`;
  const password = randomBytes(18).toString("base64url");
  const response = await request.post(`${baseURL}/api/auth/sign-up/email`, {
    headers: { origin: baseURL, "x-forwarded-for": uniqueClientIp() },
    data: { name: "Owner E2E", email, password },
  });
  await expectResponseOk(response, "înregistrarea contului de test");
  await promoteE2eUser(email, "owner");
  return { email, password };
}

async function login(page: Page, account: { email: string; password: string }, next: string) {
  await page.goto(`/autentificare?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Parolă", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Intră în cont" }).click();
  await page.waitForURL((url) => url.pathname === next);
}

async function saveThreshold(page: Page, value: string) {
  const field = page.getByLabel(/Prag de transport gratuit/);
  await field.fill(value);
  await page.getByRole("button", { name: "Salvează" }).click();
  await expect(page.getByText("Setările coșului au fost salvate.")).toBeVisible();
}

test("din admin: pragul se setează, indicatorul apare în coș și dispare când câmpul se golește", async ({
  page,
  request,
  baseURL,
  browser,
}) => {
  const owner = await createOwner(request, baseURL as string);
  await login(page, owner, "/admin/setari/cos");
  await expect(page.getByRole("heading", { level: 1, name: "Coș și transport" })).toBeVisible();
  await expect(page.locator("[data-threshold-state]")).toHaveText(
    "Indicatorul e oprit: coșul nu arată niciun prag.",
  );

  // valoare invalidă: mesaj pe câmp, nu se salvează
  await page.getByLabel(/Prag de transport gratuit/).fill("abc");
  await page.getByRole("button", { name: "Salvează" }).click();
  await expect(page.getByText(/Introdu o sumă în lei/)).toBeVisible();

  await saveThreshold(page, "300");
  await expect(page.locator("[data-threshold-state]")).toContainText("transport gratuit de la 300");

  // vitrina: un client cu un produs de 199,00 lei vede cât mai are până la prag
  const shopper = await browser.newContext();
  const shop = await shopper.newPage();
  await shop.goto(`/produs/${product.slug}`);
  await shop.locator("[data-add-button]").click();
  await expect(shop.locator("[data-cart-drawer]")).toBeVisible();
  const indicator = shop.locator("[data-cart-drawer] [data-free-shipping]");
  await expect(indicator).toContainText("Mai ai 101,00");
  await expect(indicator).toContainText("până la transport gratuit");
  await expect(indicator.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "66");
  await shop.goto("/cos");
  await shop.getByRole("button", { name: "Mărește cantitatea" }).click();
  await expect(shop.locator("[data-free-shipping]")).toContainText("Ai transport gratuit");

  // pragul gol: indicatorul dispare
  await saveThreshold(page, "");
  await expect(page.locator("[data-threshold-state]")).toHaveText(
    "Indicatorul e oprit: coșul nu arată niciun prag.",
  );
  await shop.reload();
  await expect(shop.locator("[data-cart-panel='page'] [data-cart-line]")).toHaveCount(1);
  await expect(shop.locator("[data-free-shipping]")).toHaveCount(0);
  await shopper.close();
});

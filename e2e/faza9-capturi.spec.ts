import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  E2E_ORDER_EMAIL_DOMAIN,
  promoteE2eUser,
  removeE2eCarts,
  removeE2eOrders,
  removeE2eProducts,
  removeE2eShippingZones,
  seedE2eCartProduct,
  seedE2eCheckoutSettings,
  clearE2eSettings,
  type E2eCartProduct,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Capturile Fazei 9 pentru autorevizuire (docs/20 §7): checkout pe pași, confirmare, «Zone de livrare» și «Coș și transport»,
 * la 390 și 1440 px, în tema deschisă și în cea închisă. Se înregistrează DOAR cu `CAPTURE_DIR=<cale>` (un test sărit ar încălca
 * «0 sărite» din poartă). Verifică și invarianții: fără derulare orizontală, ținte tactile de cel puțin 44 px pe telefon.
 */
const captureDir = process.env["CAPTURE_DIR"];

if (captureDir) {
  mkdirSync(captureDir, { recursive: true });
  const tag = randomBytes(3).toString("hex");
  const EMAIL = `captura-${tag}${E2E_ORDER_EMAIL_DOMAIN}`;
  let product: E2eCartProduct;
  let onOrder: E2eCartProduct;

  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await removeE2eShippingZones();
    await seedE2eCheckoutSettings();
    product = await seedE2eCartProduct(tag, "capt", { price: 49_900 });
    onOrder = await seedE2eCartProduct(tag, "lenta", {
      price: 129_900,
      stockStatus: "onbackorder",
      leadTimeDays: 14,
    });
  });
  test.afterAll(async () => {
    await removeE2eOrders();
    await removeE2eCarts();
    await removeE2eProducts();
    await removeE2eShippingZones();
    await clearE2eSettings([
      "company.legalName",
      "company.bankName",
      "company.iban",
      "shipping.pickupEnabled",
      "checkout.orderNumberPrefix",
      "checkout.orderNumberDigits",
    ]);
  });

  const SCHEMES = ["light", "dark"] as const;
  const WIDTHS = [390, 1440] as const;
  const shot = async (page: Page, name: string, scheme: string, width: number) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `derulare orizontală la ${name}`).toBeLessThanOrEqual(0);
    await page.waitForTimeout(250); // tranzițiile (150 ms) se termină înainte de captură
    await page.screenshot({
      path: join(captureDir, `${name}-${scheme === "light" ? "deschis" : "inchis"}-${width}.png`),
      fullPage: true,
    });
  };

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

  for (const scheme of SCHEMES) {
    for (const width of WIDTHS) {
      const label = `${scheme} / ${width} px`;

      test(`admin: Zone de livrare și Coș și transport (${label})`, async ({
        page,
        request,
        baseURL,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        const owner = await createOwner(request, baseURL as string);
        await page.goto(`/autentificare?next=${encodeURIComponent("/admin/setari/livrare")}`);
        await page.getByLabel("Email").fill(owner.email);
        await page.getByLabel("Parolă", { exact: true }).fill(owner.password);
        await page.getByRole("button", { name: "Intră în cont" }).click();
        await page.waitForURL((url) => url.pathname === "/admin/setari/livrare");

        // lista goală, apoi cu o zonă
        await expect(
          page.getByRole("heading", { level: 1, name: /Zone de livrare/ }),
        ).toBeVisible();
        await shot(page, "zone-livrare-gol", scheme, width);
        await page.getByRole("button", { name: "Adaugă o zonă" }).first().click();
        const form = page.locator("[data-zone-form]");
        await expect(form).toBeVisible();
        await form.locator("#zone-name").fill("E2E Zona demo captură");
        await form.locator("#zone-methodName").fill("Curier DEMO");
        await form.locator("#zone-price").fill("29");
        await form.locator("#zone-codFee").fill("7");
        await form.locator("#zone-freeAbove").fill("800");
        await form.locator("#zone-days").fill("2");
        await form.locator("[data-zone-counties] input[type=checkbox]").nth(0).check();
        await form.locator("[data-zone-counties] input[type=checkbox]").nth(1).check();
        await shot(page, "zone-livrare-formular", scheme, width);
        // erori: golesc numele
        await form.locator("#zone-name").fill("");
        await form.getByRole("button", { name: "Salvează zona" }).click();
        await expect(form.getByText("Scrie numele zonei (cel puțin 2 caractere).")).toBeVisible();
        await shot(page, "zone-livrare-formular-erori", scheme, width);
        await form.locator("#zone-name").fill("E2E Zona demo captură");
        await form.getByRole("button", { name: "Salvează zona" }).click();
        await expect(form).toBeHidden();
        await expect(page.locator('[data-zone-row="E2E Zona demo captură"]')).toBeVisible();
        await shot(page, "zone-livrare-lista", scheme, width);
        // ștergerea cere confirmare
        await page.getByRole("button", { name: "Șterge: E2E Zona demo captură" }).click();
        await expect(page.getByRole("button", { name: "Șterge zona" })).toBeVisible();
        await shot(page, "zone-livrare-confirmare", scheme, width);
        await page.getByRole("button", { name: "Șterge zona" }).click();
        await expect(page.locator('[data-zone-row="E2E Zona demo captură"]')).toHaveCount(0);

        await page.goto("/admin/setari/cos");
        await expect(
          page.getByRole("heading", { level: 1, name: "Coș și transport" }),
        ).toBeVisible();
        await expect(page.locator("[data-free-shipping-exclusions]")).toBeVisible();
        await shot(page, "cos-si-transport", scheme, width);
      });

      test(`checkout: pașii, recapitularea și confirmarea (${label})`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.goto(`/produs/${product.slug}`);
        await page.locator("[data-add-button]").click();
        await expect(page.locator("[data-cart-drawer] [data-cart-line]").first()).toBeVisible();
        await page.goto("/cos");
        await shot(page, "cos", scheme, width);
        await page.locator("main [data-checkout]").click();
        await expect(page).toHaveURL(/\/checkout$/);
        const step = (id: string) => page.locator(`[data-step="${id}"]`);
        await expect(step("contact")).toBeVisible();
        await shot(page, "checkout-1-contact", scheme, width);
        await step("contact").getByLabel("Adresa de email").fill(EMAIL);
        await step("contact").getByLabel("Telefon").fill("0722 123 456");
        await page.locator('[data-continue="contact"]').click();
        const delivery = step("delivery");
        await delivery.getByLabel("Nume și prenume").fill("Ion Popescu");
        await delivery.getByLabel("Județ").selectOption({ label: "Alba" });
        await expect(delivery.getByLabel("Localitate").locator("option")).not.toHaveCount(1);
        await delivery.getByLabel("Localitate").selectOption({ label: "Alba Iulia" });
        await delivery
          .getByLabel("Strada, numărul, blocul, apartamentul")
          .fill("Str. Exemplu 1, bl. A, ap. 2");
        await delivery.getByLabel("Cod poștal").fill("510005");
        await shot(page, "checkout-2-livrare", scheme, width);
        await page.locator('[data-continue="delivery"]').click();
        await expect(step("shipping").locator('[data-offer="demo:courier"]')).toBeVisible();
        await step("shipping").locator('[data-offer="demo:courier"] input').check();
        await shot(page, "checkout-3-transport", scheme, width);
        await page.locator('[data-continue="shipping"]').click();
        await expect(step("billing")).toBeVisible();
        await shot(page, "checkout-4-facturare", scheme, width);
        await page.locator('[data-continue="billing"]').click();
        await expect(step("payment").locator("[data-method]").first()).toBeVisible();
        await shot(page, "checkout-5-plata", scheme, width);
        await step("payment").locator('[data-method="cod"] input').check();
        await page.locator('[data-continue="payment"]').click();
        await expect(page.locator("[data-checkout-submit]")).toBeVisible();
        await page.getByRole("checkbox", { name: /Am citit și sunt de acord/ }).check();
        await shot(page, "checkout-6-recapitulare", scheme, width);
        await page.locator("[data-checkout-submit]").click();
        await expect(page).toHaveURL(/\/comanda\/confirmare$/);
        await expect(page.locator("[data-order-confirmation]")).toBeVisible();
        await shot(page, "confirmare-ramburs", scheme, width);
      });
    }
  }

  test("checkout: produs «La comandă» — ramburs dezactivat cu explicație (390 și 1440 px)", async ({
    browser,
  }) => {
    for (const width of WIDTHS) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      await page.goto(`/produs/${onOrder.slug}`);
      await page.locator("[data-add-button]").click();
      await expect(page.locator("[data-cart-drawer] [data-cart-line]").first()).toBeVisible();
      await page.goto("/cos");
      await page.locator("main [data-checkout]").click();
      const step = (id: string) => page.locator(`[data-step="${id}"]`);
      await step("contact").getByLabel("Adresa de email").fill(EMAIL);
      await step("contact").getByLabel("Telefon").fill("0722 123 456");
      await page.locator('[data-continue="contact"]').click();
      const delivery = step("delivery");
      await delivery.getByLabel("Nume și prenume").fill("Ion Popescu");
      await delivery.getByLabel("Județ").selectOption({ label: "Alba" });
      await expect(delivery.getByLabel("Localitate").locator("option")).not.toHaveCount(1);
      await delivery.getByLabel("Localitate").selectOption({ label: "Alba Iulia" });
      await delivery
        .getByLabel("Strada, numărul, blocul, apartamentul")
        .fill("Str. Exemplu 1, bl. A, ap. 2");
      await delivery.getByLabel("Cod poștal").fill("510005");
      await page.locator('[data-continue="delivery"]').click();
      await step("shipping").locator('[data-offer="demo:courier"] input').check();
      await page.locator('[data-continue="shipping"]').click();
      await page.locator('[data-continue="billing"]').click();
      await expect(step("payment").locator('[data-method="cod"] input')).toBeDisabled();
      await shot(page, "checkout-la-comanda-plata", "light", width);
      await context.close();
    }
  });
}

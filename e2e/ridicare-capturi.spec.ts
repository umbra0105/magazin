import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  E2E_ORDER_EMAIL_DOMAIN,
  clearE2eSettings,
  removeE2eCarts,
  removeE2eOrders,
  removeE2eProducts,
  seedE2eCartProduct,
  seedE2eCheckoutSettings,
  setE2eSettings,
  type E2eCartProduct,
} from "../packages/core/test/e2e-support";
import { addToCart, createAccount, login, step, type Account } from "./support/card-flow";

/**
 * Capturile corecției «ridicare personală» pentru autorevizuire (docs/20 §7): pasul de livrare cu ridicarea aleasă, recapitularea,
 * confirmarea, urmărirea, pasul fără adresa magazinului și nota din admin (Setări → Coș), la 390 și 1440 px, în tema deschisă și în
 * cea închisă. Se înregistrează DOAR cu `CAPTURE_DIR=<cale>` (un test sărit ar încălca «0 sărite» din poartă). Invarianți:
 * fără derulare orizontală; la 390 px, butoanele, câmpurile și selectoarele au cel puțin 44 px.
 */
const captureDir = process.env["CAPTURE_DIR"];

if (captureDir) {
  mkdirSync(captureDir, { recursive: true });
  const tag = randomBytes(3).toString("hex");
  const STORE = {
    street: "Strada Magazinului 7",
    city: "Alba Iulia",
    county: "Alba",
    postalCode: "510000",
    country: "RO",
  };
  let produs: E2eCartProduct;
  let owner: Account;
  // doar setarea pe care o schimbă acest spec: celelalte (IBAN, prefix …) sunt folosite și de alte specuri, rulate în paralel de alt worker;
  // curățarea lor aici ar rupe, de exemplu, comanda cu transfer bancar din `checkout.spec.ts`
  const SETTING_KEYS = ["company.address"];

  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ request, baseURL }) => {
    await seedE2eCheckoutSettings();
    await setE2eSettings({ "checkout.anafTimeoutMs": 500, "company.address": STORE });
    produs = await seedE2eCartProduct(tag, "ridcapt", { price: 49_900 });
    owner = await createAccount(request, baseURL as string, "owner");
  });
  test.afterAll(async () => {
    await removeE2eOrders();
    await removeE2eCarts();
    await removeE2eProducts();
    await clearE2eSettings(SETTING_KEYS);
  });

  const SCHEMES = ["light", "dark"] as const;
  const WIDTHS = [390, 1440] as const;

  async function shot(page: Page, name: string, scheme: string, width: number) {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `derulare orizontală la ${name} (${width})`).toBeLessThanOrEqual(0);
    if (width === 390) {
      const small = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>(
          "main button, main input:not([type=hidden]):not([type=checkbox]):not([type=radio]), main select, main textarea",
        )) {
          const box = el.getBoundingClientRect();
          if (box.width > 0 && box.height > 0 && box.height < 43.5) {
            out.push(
              `${el.tagName.toLowerCase()} «${(el.textContent || el.getAttribute("aria-label") || el.id).trim().slice(0, 40)}» ${Math.round(box.height)}px`,
            );
          }
        }
        return out;
      });
      expect(small, `ținte tactile sub 44 px la ${name}`).toEqual([]);
    }
    await page.waitForTimeout(250);
    await page.screenshot({
      path: join(captureDir, `${name}-${scheme === "light" ? "deschis" : "inchis"}-${width}.png`),
      fullPage: true,
    });
  }

  async function context(browser: Browser, scheme: string, width: number) {
    const ctx = await browser.newContext({
      viewport: { width, height: width === 390 ? 844 : 900 },
      colorScheme: scheme as "light" | "dark",
    });
    return { page: await ctx.newPage(), close: () => ctx.close() };
  }

  const next = (page: Page, id: string) => page.locator(`[data-continue="${id}"]`).click();

  async function toShipping(page: Page, email: string) {
    await addToCart(page, produs);
    await page.goto("/cos");
    await page.locator("main [data-checkout]").click();
    await expect(page).toHaveURL(/\/checkout$/);
    await step(page, "contact").getByLabel("Adresa de email").fill(email);
    await step(page, "contact").getByLabel("Telefon").fill("0722 123 456");
    await next(page, "contact");
    const delivery = step(page, "delivery");
    await expect(delivery.getByLabel("Nume și prenume")).toBeVisible();
    await delivery.getByLabel("Nume și prenume").fill("Ion Popescu");
    await delivery.getByLabel("Județ").selectOption({ label: "Alba" });
    const locality = delivery.getByLabel("Localitate");
    await expect(locality).toBeEnabled();
    await expect(locality.locator("option")).not.toHaveCount(1);
    await locality.selectOption({ label: "Alba Iulia" });
    await delivery
      .getByLabel("Strada, numărul, blocul, apartamentul")
      .fill("Str. Exemplu 1, bl. A, ap. 2");
    await delivery.getByLabel("Cod poștal").fill("510005");
    await next(page, "delivery");
  }

  for (const scheme of SCHEMES) {
    for (const width of WIDTHS) {
      test(`vitrină ${scheme} ${width}: ridicare cu adresă, recapitulare, confirmare, urmărire`, async ({
        browser,
      }) => {
        const email = `ridcapt-${randomBytes(3).toString("hex")}${E2E_ORDER_EMAIL_DOMAIN}`;
        const { page, close } = await context(browser, scheme, width);
        await toShipping(page, email);
        const pickup = step(page, "shipping").locator('[data-offer="pickup"]');
        await expect(pickup.locator("[data-offer-address]")).toBeVisible();
        await pickup.locator("input").check();
        await expect(page.locator("[data-summary-pickup]")).toBeVisible();
        await shot(page, "checkout-livrare-ridicare", scheme, width);
        await next(page, "shipping");
        await next(page, "billing");
        await step(page, "payment").locator('[data-method="cod"] input').check();
        await next(page, "payment");
        await expect(page.locator("[data-review-pickup]")).toBeVisible();
        await shot(page, "checkout-recapitulare-ridicare", scheme, width);
        await page.getByRole("checkbox", { name: /Am citit și sunt de acord/ }).check();
        await page.locator("[data-checkout-submit]").click();
        await expect(page).toHaveURL(/\/comanda\/confirmare$/);
        await expect(page.locator("[data-order-summary-view] [data-pickup-address]")).toBeVisible();
        const number = /E2E-\d{6}/.exec(await page.locator("[data-order-number]").innerText())![0];
        await shot(page, "confirmare-ridicare", scheme, width);
        await page.goto("/comanda/urmarire");
        const form = page.locator("[data-track-form]");
        await form.getByLabel("Numărul comenzii").fill(number);
        await form.getByLabel("Adresa de email").fill(email);
        await form.getByRole("button", { name: "Caută comanda" }).click();
        await expect(page.locator("[data-track-result] [data-pickup-address]")).toBeVisible();
        await shot(page, "urmarire-ridicare", scheme, width);
        await close();
      });

      test(`vitrină ${scheme} ${width}: fără adresa magazinului ridicarea lipsește`, async ({
        browser,
      }) => {
        await setE2eSettings({ "company.address": { ...STORE, street: "", city: "" } });
        try {
          const email = `ridfara-${randomBytes(3).toString("hex")}${E2E_ORDER_EMAIL_DOMAIN}`;
          const { page, close } = await context(browser, scheme, width);
          await toShipping(page, email);
          await expect(step(page, "shipping").locator('[data-offer="demo:courier"]')).toBeVisible();
          await expect(step(page, "shipping").locator('[data-offer="pickup"]')).toHaveCount(0);
          await shot(page, "checkout-livrare-fara-adresa", scheme, width);
          await close();
        } finally {
          await setE2eSettings({ "company.address": STORE });
        }
      });

      test(`admin ${scheme} ${width}: nota de lângă ridicare, fără și cu adresă`, async ({
        browser,
      }) => {
        const { page, close } = await context(browser, scheme, width);
        await setE2eSettings({ "company.address": { ...STORE, street: "", city: "" } });
        try {
          await login(page, owner, "/admin/setari/cos");
          await expect(page.locator("[data-pickup-needs-address]")).toBeVisible();
          await page.locator("[data-pickup-needs-address]").scrollIntoViewIfNeeded();
          await shot(page, "admin-ridicare-fara-adresa", scheme, width);
        } finally {
          await setE2eSettings({ "company.address": STORE });
        }
        await page.reload();
        await expect(page.locator("[data-pickup-address]")).toBeVisible();
        await shot(page, "admin-ridicare-cu-adresa", scheme, width);
        await close();
      });
    }
  }
}

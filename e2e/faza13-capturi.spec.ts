import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  E2E_ORDER_EMAIL_DOMAIN,
  clearE2eSettings,
  readE2eOrder,
  removeE2eCarts,
  removeE2eDemoInvoicing,
  removeE2eOrders,
  removeE2eProducts,
  seedE2eCartProduct,
  seedE2eCheckoutSettings,
  seedE2eDemoInvoicing,
  setE2eInvoiceState,
  setE2eSettings,
  type E2eCartProduct,
} from "../packages/core/test/e2e-support";
import { addToCart, createAccount, login, step, type Account } from "./support/card-flow";

/**
 * Capturile Fazei 13 pentru autorevizuire (docs/20 §7): datele firmei, configurarea facturării, lista facturilor, «Comenzi fără
 * factură» și panoul «Facturare» din comandă, la 390 și 1440 px, în tema deschisă și în cea închisă. Se înregistrează DOAR cu
 * `CAPTURE_DIR=<cale>` (un test sărit ar încălca «0 sărite» din poartă). Verifică și invarianții: fără derulare orizontală; la 390 px,
 * butoanele și câmpurile din conținut au cel puțin 44 px. Datele sunt FICTIVE; niciun document real nu se emite.
 */
const captureDir = process.env["CAPTURE_DIR"];

if (captureDir) {
  mkdirSync(captureDir, { recursive: true });
  const tag = randomBytes(3).toString("hex");
  const emailOf = (name: string) => `capt13-${name}-${tag}${E2E_ORDER_EMAIL_DOMAIN}`;
  let produs: E2eCartProduct;
  let owner: Account;
  const state = { numberIssued: "", idIssued: "", numberFailed: "", idFailed: "" };

  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ request, baseURL }) => {
    await seedE2eCheckoutSettings();
    await setE2eSettings({
      "checkout.anafTimeoutMs": 500,
      "company.address": {
        street: "Strada Magazinului 7",
        city: "Alba Iulia",
        county: "Alba",
        postalCode: "510000",
        country: "RO",
      },
      "company.pickupHours": "Luni–Vineri, 09:00–17:00",
    });
    produs = await seedE2eCartProduct(tag, "capt13", { price: 49_900 });
    owner = await createAccount(request, baseURL as string, "owner");
  });
  test.afterAll(async () => {
    await removeE2eDemoInvoicing();
    await removeE2eOrders({ tag });
    await removeE2eCarts();
    await removeE2eProducts();
    await clearE2eSettings(["company.address", "company.pickupHours"]);
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

  async function adminPage(browser: Browser, scheme: string, width: number, next: string) {
    const context = await browser.newContext({
      viewport: { width, height: width === 390 ? 844 : 900 },
      colorScheme: scheme as "light" | "dark",
    });
    const page = await context.newPage();
    await login(page, owner, next);
    return { page, close: () => context.close() };
  }

  async function placeCodPickup(page: Page, email: string): Promise<string> {
    await addToCart(page, produs);
    await page.goto("/cos");
    await page.locator("main [data-checkout]").click();
    await step(page, "contact").getByLabel("Adresa de email").fill(email);
    await step(page, "contact").getByLabel("Telefon").fill("0722 123 456");
    await page.locator('[data-continue="contact"]').click();
    const delivery = step(page, "delivery");
    await delivery.getByLabel("Nume și prenume").fill("Ion Popescu");
    await delivery.getByLabel("Județ").selectOption({ label: "Alba" });
    const locality = delivery.getByLabel("Localitate");
    await expect(locality).toBeEnabled();
    await expect(locality.locator("option")).not.toHaveCount(1);
    await locality.selectOption({ label: "Alba Iulia" });
    await delivery
      .getByLabel("Strada, numărul, blocul, apartamentul")
      .fill("Str. Exemplu 1, bl. A");
    await delivery.getByLabel("Cod poștal").fill("510005");
    await page.locator('[data-continue="delivery"]').click();
    await step(page, "shipping").locator('[data-offer="pickup"] input').check();
    await page.locator('[data-continue="shipping"]').click();
    await page.locator('[data-continue="billing"]').click();
    await expect(step(page, "payment").locator("[data-method]").first()).toBeVisible();
    await step(page, "payment").locator('[data-method="cod"] input').check();
    await page.locator('[data-continue="payment"]').click();
    await page.getByRole("checkbox", { name: /Am citit și sunt de acord/ }).check();
    await page.locator("[data-checkout-submit]").click();
    await expect(page.locator("[data-order-confirmation]")).toBeVisible();
    return /E2E-\d{6}/.exec(await page.locator("main").innerText())![0];
  }

  test("pregătește o comandă cu factură emisă (SIMULAT), una cu factură eșuată și una fără factură", async ({
    page,
  }) => {
    await seedE2eDemoInvoicing();
    state.numberIssued = await placeCodPickup(page, emailOf("emisa"));
    state.idIssued = (await readE2eOrder(state.numberIssued))!.id;
    await setE2eInvoiceState(state.numberIssued, "invoice", { status: "issued" });
    state.numberFailed = await placeCodPickup(page, emailOf("esuata"));
    state.idFailed = (await readE2eOrder(state.numberFailed))!.id;
    await setE2eInvoiceState(state.numberFailed, "invoice", {
      status: "failed",
      code: "INVOICE_PROVIDER_TIMEOUT",
      message:
        "Rezultat nesigur: furnizorul nu a răspuns la timp. Verifică în contul furnizorului dacă documentul există.",
    });
    // o a treia comandă, plasată cu facturarea oprită: apare în «Comenzi fără factură»
    await setE2eSettings({ "invoicing.provider": "" });
    await placeCodPickup(page, emailOf("fara"));
    await setE2eSettings({ "invoicing.provider": "demo" });
  });

  for (const scheme of SCHEMES) {
    for (const width of WIDTHS) {
      test(`admin ${scheme} ${width}: datele firmei și configurarea facturării`, async ({
        browser,
      }) => {
        const { page, close } = await adminPage(browser, scheme, width, "/admin/setari/firma");
        await expect(page.getByRole("heading", { level: 1, name: "Datele firmei" })).toBeVisible();
        await shot(page, "firma", scheme, width);
        await page.goto("/admin/setari/facturare");
        await expect(page.getByRole("heading", { level: 1, name: "Facturare" })).toBeVisible();
        await shot(page, "facturare-setari", scheme, width);
        await close();
      });

      test(`admin ${scheme} ${width}: facturi, fără factură și panoul din comandă`, async ({
        browser,
      }) => {
        const { page, close } = await adminPage(browser, scheme, width, "/admin/comenzi/facturi");
        await expect(page.getByRole("heading", { level: 1, name: "Facturi" })).toBeVisible();
        await expect(page.locator("[data-invoice-row]").first()).toBeVisible();
        await shot(page, "facturi-lista", scheme, width);
        await page.goto("/admin/comenzi/fara-factura");
        await expect(
          page.getByRole("heading", { level: 1, name: "Comenzi fără factură" }),
        ).toBeVisible();
        await shot(page, "fara-factura", scheme, width);
        await page.goto(`/admin/comenzi/${state.idIssued}`);
        await expect(page.locator('[data-invoice-doc="invoice"]')).toBeVisible();
        await shot(page, "comanda-factura-emisa", scheme, width);
        await page.goto(`/admin/comenzi/${state.idFailed}`);
        await expect(page.locator('[data-invoice-doc="invoice"]')).toBeVisible();
        await shot(page, "comanda-factura-esuata", scheme, width);
        await page.locator("[data-invoice-retry]").click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await shot(page, "comanda-reincearca-dialog", scheme, width);
        await close();
      });
    }
  }
}

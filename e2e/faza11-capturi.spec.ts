import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  E2E_ORDER_EMAIL_DOMAIN,
  clearE2eSettings,
  removeE2eCartStock,
  removeE2eCarts,
  removeE2eDemoPayments,
  removeE2eOrders,
  removeE2eProducts,
  seedE2eCartProduct,
  seedE2eCheckoutSettings,
  seedE2eDemoPayments,
  setE2eCartStock,
  setE2eFeatureFlag,
  setE2eSettings,
  type E2eCartProduct,
} from "../packages/core/test/e2e-support";
import {
  addToCart,
  createAccount,
  login,
  step,
  toPayment,
  type Account,
} from "./support/card-flow";

/**
 * Capturile Fazei 11 pentru autorevizuire (docs/20 §7): ecranele noi de admin (lista de comenzi, detaliul, ofertele de plată, șabloanele
 * de email, SMTP, cereri de instalare, clopoțelul) și pagina publică a ofertei, la 390 și 1440 px, în tema deschisă și în cea închisă.
 * Se înregistrează DOAR cu `CAPTURE_DIR=<cale>` (un test sărit ar încălca «0 sărite» din poartă). Verifică și invarianții: fără
 * derulare orizontală; la 390 px, butoanele și câmpurile din conținut au cel puțin 44 px.
 */
const captureDir = process.env["CAPTURE_DIR"];

if (captureDir) {
  mkdirSync(captureDir, { recursive: true });
  const tag = randomBytes(3).toString("hex");
  const emailOf = (name: string) => `capt-${name}-${tag}${E2E_ORDER_EMAIL_DOMAIN}`;
  let produs: E2eCartProduct;
  let owner: Account;
  const SETTING_KEYS = [
    "company.legalName",
    "company.bankName",
    "company.iban",
    "shipping.pickupEnabled",
    "checkout.orderNumberPrefix",
    "checkout.orderNumberDigits",
    "checkout.anafTimeoutMs",
  ];
  const state: { orderId: string; offerId: string; offerLink: string } = {
    orderId: "",
    offerId: "",
    offerLink: "",
  };

  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ request, baseURL }) => {
    await seedE2eCheckoutSettings();
    await setE2eSettings({ "checkout.anafTimeoutMs": 500 });
    await seedE2eDemoPayments();
    await setE2eFeatureFlag("installationRequests", true);
    produs = await seedE2eCartProduct(tag, "capt11", { price: 49_900 });
    await setE2eCartStock(produs.variantId, "50");
    owner = await createAccount(request, baseURL as string, "owner");
  });
  test.afterAll(async () => {
    await setE2eFeatureFlag("installationRequests", false);
    await removeE2eDemoPayments({ tag });
    await removeE2eOrders({ tag });
    await removeE2eCarts();
    await removeE2eCartStock([produs.variantId]);
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

  async function adminPage(browser: Browser, scheme: string, width: number, next: string) {
    const context = await browser.newContext({
      viewport: { width, height: width === 390 ? 844 : 900 },
      colorScheme: scheme as "light" | "dark",
    });
    const page = await context.newPage();
    await login(page, owner, next);
    return { page, close: () => context.close() };
  }

  /** Creează o ofertă din ecranul pas cu pas (fără email) și întoarce linkul (afișat o singură dată) și adresa detaliului. */
  async function createOfferLink(
    adminPage: Page,
    email: string,
  ): Promise<{ link: string; id: string }> {
    await adminPage.goto("/admin/comenzi/oferte/nou");
    await adminPage.getByLabel("Caută produs").fill(produs.sku);
    await adminPage.getByRole("button", { name: "Adaugă" }).click();
    await adminPage.locator("[data-offer-next]").click();
    await adminPage.getByLabel("Email client").fill(email);
    await adminPage.getByLabel("Telefon").fill("0722 123 456");
    await adminPage.getByLabel("Nume complet").fill("Ion Popescu");
    await adminPage.getByLabel("Județ").selectOption({ label: "Alba" });
    await expect(adminPage.getByLabel("Localitate").locator("option")).not.toHaveCount(1);
    await adminPage.getByLabel("Localitate").selectOption({ label: "Alba Iulia" });
    await adminPage.getByLabel("Strada și numărul").fill("Str. Exemplu 1, bl. A");
    await adminPage.getByLabel("Cod poștal").fill("510005");
    await adminPage.locator("[data-offer-next]").click();
    await adminPage.locator('input[name="offer"]').first().check();
    await adminPage.locator("[data-offer-next]").click();
    await adminPage.getByLabel("Trimite linkul pe email acum").uncheck();
    await adminPage.getByRole("button", { name: "Creează oferta" }).click();
    await expect(adminPage.locator("[data-offer-created]")).toBeVisible();
    const link = await adminPage.locator("[data-offer-link]").inputValue();
    const href = await adminPage
      .getByRole("link", { name: "Deschide oferta" })
      .getAttribute("href");
    return { link, id: href!.split("/oferte/")[1]! };
  }

  test("pregătește o comandă cu transfer, cu cerere de instalare, și o ofertă activă", async ({
    page,
    browser,
  }) => {
    await addToCart(page, produs);
    await toPayment(page, emailOf("comanda"));
    await step(page, "payment").locator('[data-method="bank_transfer"] input').check();
    await page.locator('[data-continue="payment"]').click();
    await page.getByRole("checkbox", { name: /Am citit și sunt de acord/ }).check();
    await page.locator("[data-checkout-submit]").click();
    await expect(page.locator("[data-order-confirmation]")).toBeVisible();
    const number = /E2E-\d{6}/.exec(await page.locator("main").innerText())![0];

    const admin = await adminPage(browser, "light", 1440, "/admin/comenzi");
    await admin.page
      .locator("[data-order-row]")
      .filter({ hasText: number })
      .getByRole("link", { name: number })
      .first()
      .click();
    await expect(admin.page.locator("[data-order-detail]")).toBeVisible();
    state.orderId = admin.page.url().split("/admin/comenzi/")[1]!.split("?")[0]!;
    const created = await createOfferLink(admin.page, emailOf("oferta"));
    state.offerLink = created.link;
    state.offerId = created.id;

    // o ofertă învechită (stocul a dispărut înainte de plată): produce în clopoțel o notificare cu context și legătură (C3)
    const stale = await createOfferLink(admin.page, emailOf("invechita"));
    await setE2eCartStock(produs.variantId, "0");
    const buyer = await (await browser.newContext()).newPage();
    await buyer.goto(stale.link);
    await buyer.getByRole("checkbox", { name: /Am citit și sunt de acord/ }).check();
    await buyer.locator("[data-offer-pay-button]").click();
    await expect(
      buyer.getByRole("alert").filter({ hasText: "Oferta nu mai este disponibilă" }),
    ).toBeVisible();
    await buyer.context().close();
    await setE2eCartStock(produs.variantId, "50");
    await admin.close();
  });

  for (const scheme of SCHEMES) {
    for (const width of WIDTHS) {
      test(`admin ${scheme} ${width}: comenzi și oferte`, async ({ browser }) => {
        const { page, close } = await adminPage(browser, scheme, width, "/admin/comenzi");
        await expect(page.getByRole("heading", { level: 1, name: /^Comenzi/ })).toBeVisible();
        await shot(page, "admin-comenzi-lista", scheme, width);
        await page.goto(`/admin/comenzi/${state.orderId}`);
        await expect(page.locator("[data-order-detail]")).toBeVisible();
        await shot(page, "admin-comanda-detaliu", scheme, width);
        await page.goto("/admin/comenzi/oferte");
        await expect(page.locator("[data-offer-row]").first()).toBeVisible();
        await shot(page, "admin-oferte-lista", scheme, width);
        await page.goto("/admin/comenzi/oferte/nou");
        await expect(page.locator("[data-offer-step]")).toBeVisible();
        await shot(page, "admin-oferta-noua-pas1", scheme, width);
        await page.goto(`/admin/comenzi/oferte/${state.offerId}`);
        await expect(page.locator("[data-offer-detail]")).toBeVisible();
        await shot(page, "admin-oferta-detaliu", scheme, width);
        await page.goto(`/admin/comenzi/oferte/nou?dinComanda=${state.orderId}`);
        await expect(page.getByText("Schiță preluată din comandă")).toBeVisible();
        await shot(page, "admin-oferta-din-comanda", scheme, width);
        await close();
      });

      test(`admin ${scheme} ${width}: email, instalare, clopoțel`, async ({ browser }) => {
        const { page, close } = await adminPage(
          browser,
          scheme,
          width,
          "/admin/comenzi/sabloane-email",
        );
        await expect(page.getByRole("heading", { level: 1, name: /Șabloane email/ })).toBeVisible();
        await shot(page, "admin-sabloane-lista", scheme, width);
        await page.goto("/admin/comenzi/sabloane-email/order.confirmation");
        await expect(
          page.getByRole("heading", { name: "Previzualizarea emailului" }),
        ).toBeVisible();
        await shot(page, "admin-sablon-detaliu", scheme, width);
        await page.goto("/admin/setari/email");
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await shot(page, "admin-setari-email", scheme, width);
        await page.goto("/admin/comenzi/cereri-instalare");
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await shot(page, "admin-cereri-instalare", scheme, width);
        await page.goto("/admin/comenzi");
        await page.locator("[data-notifications-bell]").click();
        await expect(page.locator("[data-notifications-list]")).toBeVisible();
        await shot(page, "admin-clopotel", scheme, width);
        await close();
      });

      test(`vitrină ${scheme} ${width}: pagina ofertei`, async ({ browser }) => {
        const context = await browser.newContext({
          viewport: { width, height: width === 390 ? 844 : 900 },
          colorScheme: scheme,
        });
        const page = await context.newPage();
        await page.goto(state.offerLink);
        await expect(page.locator("[data-offer-total]")).toBeVisible();
        await shot(page, "vitrina-oferta", scheme, width);
        await page.locator("[data-offer-pay-button]").click();
        await expect(page.getByRole("alert").filter({ hasText: "Bifează acordul" })).toBeVisible();
        await shot(page, "vitrina-oferta-fara-acord", scheme, width);
        await page.goto(`/oferta/${"x".repeat(43)}`);
        await expect(
          page.getByRole("heading", { name: "Oferta nu mai este disponibilă" }),
        ).toBeVisible();
        await shot(page, "vitrina-oferta-indisponibila", scheme, width);
        await context.close();
      });

      // corecția C8: oferta deja transformată în comandă, cu plata cu cardul întreruptă, arată «Continuă plata»
      test(`vitrină ${scheme} ${width}: oferta cu plata întreruptă`, async ({ browser }) => {
        const admin = await adminPage(browser, "light", 1440, "/admin/comenzi/oferte/nou");
        const created = await createOfferLink(admin.page, emailOf(`plata-${scheme}-${width}`));
        await admin.close();
        const context = await browser.newContext({
          viewport: { width, height: width === 390 ? 844 : 900 },
          colorScheme: scheme,
        });
        const page = await context.newPage();
        await page.goto(created.link);
        await page.getByRole("checkbox", { name: /Am citit și sunt de acord/ }).check();
        await page.locator("[data-offer-pay-button]").click();
        await expect(page).toHaveURL(/\/plata-demo\//);
        await page.goto(created.link);
        await expect(page.getByRole("heading", { name: "Comanda ta a fost creată" })).toBeVisible();
        await shot(page, "vitrina-oferta-continua-plata", scheme, width);
        await context.close();
      });
    }
  }
}

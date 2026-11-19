import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  clearE2eSettings,
  expireE2eOrderReservations,
  issueE2eRetryToken,
  readE2eLastPaymentId,
  removeE2eCartStock,
  removeE2eCarts,
  removeE2eDemoPayments,
  removeE2eOrders,
  removeE2eProducts,
  seedE2eCartProduct,
  seedE2eCheckoutSettings,
  seedE2eDemoPayments,
  setE2eCartStock,
  setE2eSettings,
  takeE2eCartStock,
  type E2eCartProduct,
} from "../packages/core/test/e2e-support";
import {
  CARD_EMAIL,
  createAccount,
  demoScenario,
  login,
  paymentState,
  placeWithCard,
  type Account,
} from "./support/card-flow";

/**
 * Capturile Fazei 10 pentru autorevizuire (docs/20 §7): ecranele de admin (Plăți cu card, Plăți cu cardul, detaliu cu rambursări) și
 * paginile vitrinei (card în checkout, pagina DEMO, așteptare, plătit, eșuat, fără stoc, link de plată), la 390 și 1440 px, în tema
 * deschisă și în cea închisă. Se înregistrează DOAR cu `CAPTURE_DIR=<cale>` (un test sărit ar încălca «0 sărite» din poartă).
 * Verifică și invarianții: fără derulare orizontală; la 390 px, butoanele, câmpurile și legăturile de acțiune au cel puțin 44 px.
 */
const captureDir = process.env["CAPTURE_DIR"];

if (captureDir) {
  mkdirSync(captureDir, { recursive: true });
  const tag = randomBytes(3).toString("hex");
  const EMAIL = CARD_EMAIL(tag);
  let produs: E2eCartProduct;
  let ultima: E2eCartProduct;
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

  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ request, baseURL }) => {
    await seedE2eCheckoutSettings();
    await setE2eSettings({ "checkout.anafTimeoutMs": 500 });
    await seedE2eDemoPayments();
    produs = await seedE2eCartProduct(tag, "capt", { price: 49_900 });
    ultima = await seedE2eCartProduct(tag, "ultima", { price: 49_900 });
    await setE2eCartStock(produs.variantId, "50");
    await setE2eCartStock(ultima.variantId, "1");
    owner = await createAccount(request, baseURL as string, "owner");
  });
  test.afterAll(async () => {
    await removeE2eDemoPayments();
    await removeE2eOrders();
    await removeE2eCarts();
    await removeE2eCartStock([produs.variantId, ultima.variantId]);
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

  async function adminPage(browser: Browser, scheme: string, width: number) {
    const context = await browser.newContext({
      viewport: { width, height: width === 390 ? 844 : 900 },
      colorScheme: scheme as "light" | "dark",
    });
    const page = await context.newPage();
    await login(page, owner, "/admin/plati");
    return { page, close: () => context.close() };
  }

  const states: { id: string; number: string; paymentId: string }[] = [];

  test("pregătește comenzile pentru capturi (plătită parțial rambursată, eșuată, în așteptare, fără stoc)", async ({
    page,
    browser,
  }) => {
    // 1. plătită
    const paid = await placeWithCard(page, produs, EMAIL);
    await demoScenario(page, "paid");
    await expect(paymentState(page)).toHaveAttribute("data-card-payment-state", "paid", {
      timeout: 30_000,
    });
    states.push({
      id: "paid",
      number: paid,
      paymentId: (await readE2eLastPaymentId(paid)) as string,
    });
    // 2. sumă greșită (necesită atenție)
    const wrong = await placeWithCard(page, produs, EMAIL);
    await demoScenario(page, "wrong");
    await expect(paymentState(page)).toHaveAttribute("data-card-payment-state", "attention", {
      timeout: 30_000,
    });
    states.push({
      id: "wrong",
      number: wrong,
      paymentId: (await readE2eLastPaymentId(wrong)) as string,
    });
    // 3. refuzată
    const failed = await placeWithCard(page, produs, EMAIL);
    await demoScenario(page, "failed");
    await expect(paymentState(page)).toHaveAttribute("data-card-payment-state", "failed", {
      timeout: 30_000,
    });
    states.push({
      id: "failed",
      number: failed,
      paymentId: (await readE2eLastPaymentId(failed)) as string,
    });
    // 4. fără stoc după plată
    const lost = await placeWithCard(page, ultima, EMAIL);
    await expireE2eOrderReservations(lost);
    await takeE2eCartStock(ultima.variantId);
    await demoScenario(page, "paid");
    await expect(paymentState(page)).toHaveAttribute("data-card-payment-state", "stock_lost", {
      timeout: 30_000,
    });
    states.push({
      id: "lost",
      number: lost,
      paymentId: (await readE2eLastPaymentId(lost)) as string,
    });
    // 5. rambursare manuală necesară pe prima comandă
    await seedE2eDemoPayments("manual_required");
    const admin = await adminPage(browser, "light", 1440);
    await admin.page.goto(`/admin/plati/${states[0]!.paymentId}`);
    await admin.page.getByLabel("Suma de rambursat (lei)").fill("100,00");
    await admin.page.getByLabel("Motivul rambursării").fill("Produs deteriorat la livrare");
    await admin.page.getByRole("button", { name: "Rambursează…" }).click();
    await admin.page
      .getByRole("dialog", { name: "Confirmi rambursarea?" })
      .getByRole("button", { name: "Rambursează", exact: true })
      .click();
    await expect(admin.page.getByText("Manuală necesară").first()).toBeVisible({ timeout: 15_000 });
    await admin.close();
    await seedE2eDemoPayments("confirmed");
  });

  for (const scheme of SCHEMES) {
    for (const width of WIDTHS) {
      test(`admin ${scheme} ${width}: setări plăți, listă, detaliu`, async ({ browser }) => {
        const { page, close } = await adminPage(browser, scheme, width);
        await page.goto("/admin/setari/plati");
        await expect(page.getByRole("heading", { level: 1, name: "Plăți cu card" })).toBeVisible();
        await shot(page, "admin-setari-plati", scheme, width);
        await page.goto("/admin/plati");
        await expect(page.getByRole("heading", { level: 1 })).toContainText("Plăți cu cardul");
        await shot(page, "admin-plati-lista", scheme, width);
        await page.goto("/admin/plati?vedere=atentie");
        await expect(page.getByRole("link", { name: states[1]!.number })).toBeVisible();
        await shot(page, "admin-plati-atentie", scheme, width);
        await page.goto(`/admin/plati/${states[0]!.paymentId}`);
        await expect(page.getByRole("heading", { level: 1 })).toContainText(states[0]!.number);
        await shot(page, "admin-plata-detaliu-rambursare-manuala", scheme, width);
        await page.goto(`/admin/plati/${states[1]!.paymentId}`);
        await expect(page.getByRole("heading", { name: /Necesită atenție/ })).toBeVisible();
        await shot(page, "admin-plata-detaliu-atentie", scheme, width);
        await close();
      });

      test(`vitrină ${scheme} ${width}: card în checkout, pagina DEMO, stări de plată, link`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          viewport: { width, height: width === 390 ? 844 : 900 },
          colorScheme: scheme,
        });
        const page = await context.newPage();
        // card în checkout și pagina procesatorului
        const number = await placeWithCard(page, produs, EMAIL);
        await shot(page, "vitrina-pagina-demo", scheme, width);
        // așteptare (încă nu s-a plătit)
        const paymentId = decodeURIComponent(page.url().split("/plata-demo/")[1] ?? "");
        await page.goto(`/comanda/plata/${paymentId}`);
        await expect(paymentState(page)).toHaveAttribute("data-card-payment-state", "checking");
        await shot(page, "vitrina-plata-se-verifica", scheme, width);
        await page.goto(`/plata-demo/${paymentId}`);
        await demoScenario(page, "paid");
        await expect(paymentState(page)).toHaveAttribute("data-card-payment-state", "paid", {
          timeout: 30_000,
        });
        await shot(page, "vitrina-plata-confirmata", scheme, width);
        expect(number).toMatch(/E2E-/);
        // eșec cu reîncercare
        const failed = await placeWithCard(page, produs, EMAIL);
        await demoScenario(page, "failed");
        await expect(paymentState(page)).toHaveAttribute("data-card-payment-state", "failed", {
          timeout: 30_000,
        });
        await shot(page, "vitrina-plata-esuata", scheme, width);
        expect(failed).toMatch(/E2E-/);
        // linkul de plată al comenzii eșuate
        const token = await issueE2eRetryToken(failed);
        await page.goto(`/comanda/plateste/${token}`);
        await expect(page.getByRole("heading", { name: "Plătește comanda" })).toBeVisible();
        await shot(page, "vitrina-link-plata", scheme, width);
        await context.close();

        // pagina «fără stoc» a comenzii pregătite: cookie-ul ei nu mai există, deci se arată starea din urmărire
        const track = await browser.newContext({
          viewport: { width, height: width === 390 ? 844 : 900 },
          colorScheme: scheme,
        });
        const tp = await track.newPage();
        await tp.goto("/comanda/urmarire");
        await tp.getByLabel("Numărul comenzii").fill(states[3]!.number);
        await tp.getByLabel("Adresa de email").fill(EMAIL);
        await tp.getByRole("button", { name: "Caută comanda" }).click();
        await expect(tp.locator("[data-payment-notice]")).toBeVisible();
        await shot(tp, "vitrina-urmarire-fara-stoc", scheme, width);
        // link de plată invalid
        await tp.goto("/comanda/plateste/token-invalid-token-invalid-123456");
        await expect(
          tp.getByRole("heading", { name: "Linkul de plată nu mai este valabil" }),
        ).toBeVisible();
        await shot(tp, "vitrina-link-invalid", scheme, width);
        await track.close();
      });
    }
  }
}

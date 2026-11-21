import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  E2E_ORDER_EMAIL_DOMAIN,
  clearE2eSettings,
  readE2eOrder,
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
 * Ridicarea personală (corecție pe faza-10): la ridicare se afișează ADRESA MAGAZINULUI (`company.address`), niciodată adresa
 * clientului: în pasul de livrare, în rezumatele pașilor, în recapitulare, în confirmare și în urmărire. Fără adresa magazinului
 * ridicarea nu se oferă. Livrarea cu curier rămâne neschimbată. Adresele sunt FICTIVE.
 */
const tag = randomBytes(3).toString("hex");
const EMAIL = `ridicare-${tag}${E2E_ORDER_EMAIL_DOMAIN}`;
const STORE_STREET = "Strada Magazinului 7";
const STORE_TEXT = `${STORE_STREET}, 510000 Alba Iulia, Alba`;
const CUSTOMER_STREET = "Str. Exemplu 1, bl. A, ap. 2";

test.describe.configure({ mode: "serial" });

let produs: E2eCartProduct;
let owner: Account;

// doar setarea pe care o schimbă acest spec: celelalte (IBAN, prefix …) sunt folosite și de alte specuri, rulate în paralel de alt worker;
// curățarea lor aici ar rupe, de exemplu, comanda cu transfer bancar din `checkout.spec.ts`
const SETTING_KEYS = ["company.address"];

const storeAddress = (over: Record<string, string> = {}) => ({
  street: STORE_STREET,
  city: "Alba Iulia",
  county: "Alba",
  postalCode: "510000",
  country: "RO",
  ...over,
});

test.beforeAll(async ({ request, baseURL }) => {
  await seedE2eCheckoutSettings();
  await setE2eSettings({ "checkout.anafTimeoutMs": 500, "company.address": storeAddress() });
  produs = await seedE2eCartProduct(tag, "ridicare", { price: 19_900 });
  owner = await createAccount(request, baseURL as string, "owner");
});

test.afterAll(async () => {
  await removeE2eOrders({ tag });
  await removeE2eCarts();
  await removeE2eProducts();
  await clearE2eSettings(SETTING_KEYS);
});

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
  await delivery.getByLabel("Strada, numărul, blocul, apartamentul").fill(CUSTOMER_STREET);
  await delivery.getByLabel("Cod poștal").fill("510005");
  await next(page, "delivery");
  await expect(step(page, "shipping").locator('[data-offer="demo:courier"]')).toBeVisible();
}

async function placeCod(page: Page): Promise<string> {
  await next(page, "billing");
  await expect(step(page, "payment").locator("[data-method]").first()).toBeVisible();
  await step(page, "payment").locator('[data-method="cod"] input').check();
  await next(page, "payment");
  await page.getByRole("checkbox", { name: /Am citit și sunt de acord/ }).check();
  await page.locator("[data-checkout-submit]").click();
  await expect(page).toHaveURL(/\/comanda\/confirmare$/);
  await expect(page.locator("[data-order-confirmation]")).toBeVisible();
  const text = (await page.locator("[data-order-number]").innerText()).trim();
  const match = /E2E-\d{6}/.exec(text);
  expect(match, text).not.toBeNull();
  return match![0];
}

test.describe("ridicare cu adresa magazinului setată", () => {
  test("adresa magazinului apare în toate locurile; adresa clientului nu e prezentată ca ridicare", async ({
    page,
    browser,
  }) => {
    await toShipping(page, EMAIL);
    const pickup = step(page, "shipping").locator('[data-offer="pickup"]');
    await expect(pickup).toBeVisible();
    // sub opțiune: «Adresa de ridicare: …», fără cost de transport
    await expect(pickup.locator("[data-offer-address]")).toHaveText(
      `Adresa de ridicare: ${STORE_TEXT}`,
    );
    await expect(pickup).toContainText("Gratuit");
    // cu curierul apare mesajul despre livrarea la nivelul solului; la ridicare dispare (decizia 2026-11-19)
    await step(page, "shipping").locator('[data-offer="demo:courier"] input').check();
    await expect(step(page, "shipping").locator("[data-ground-notice]")).toBeVisible();
    await pickup.locator("input").check();
    await expect(step(page, "shipping").locator("[data-ground-notice]")).toHaveCount(0);

    // cât timp ridicarea e aleasă, adresa de la pasul 2 nu se mai numește «livrare»
    await expect(step(page, "delivery").locator("h2 button")).toContainText(
      "Adresa ta (contact și facturare)",
    );
    await expect(step(page, "delivery").locator("h2 button")).not.toContainText("livrare");
    await expect(page.locator("[data-summary-pickup]")).toHaveText(
      `Ridicare personală de la: ${STORE_TEXT}`,
    );
    await next(page, "shipping");

    // rezumatul pasului de livrare (închis) și etichetele de la facturare
    await expect(step(page, "shipping").locator("[data-step-summary]")).toHaveText(
      `Ridicare personală de la: ${STORE_TEXT}`,
    );
    await expect(step(page, "billing").getByLabel("Aceleași date ca la adresa ta")).toBeChecked();
    await next(page, "billing");
    // rambursul rămâne oferit la ridicare, dar plata se face în magazin, nu «curierului»
    const cod = step(page, "payment").locator('[data-method="cod"]');
    await expect(cod).toContainText("Plătești în magazin la ridicare");
    await expect(cod).not.toContainText("curier");
    await cod.locator("input").check();
    await next(page, "payment");
    // recapitularea
    await expect(page.locator("[data-review-pickup]")).toHaveText(
      `Ridicare personală de la: ${STORE_TEXT}`,
    );
    for (const text of await page
      .locator("[data-step-summary], [data-summary-pickup], [data-review-pickup]")
      .allInnerTexts()) {
      // adresa clientului apare doar ca rezumat al adresei lui (pasul 2), niciodată alături de «ridicare»
      if (text.includes("Ridicare")) expect(text).not.toContain(CUSTOMER_STREET);
    }

    await page.getByRole("checkbox", { name: /Am citit și sunt de acord/ }).check();
    await page.locator("[data-checkout-submit]").click();
    await expect(page).toHaveURL(/\/comanda\/confirmare$/);
    await expect(page.locator("[data-order-confirmation]")).toBeVisible();
    const number = /E2E-\d{6}/.exec(await page.locator("[data-order-number]").innerText())![0];

    // confirmare: «Ce urmează» și metoda de plată spun «în magazin», nu «curierului»
    await expect(page.locator("main")).toContainText("Plătești în magazin la ridicare");
    await expect(page.locator("main")).not.toContainText("curierului");
    const view = page.locator("[data-order-summary-view]");
    await expect(view).toContainText("Ramburs (în magazin, la ridicare)");
    await expect(view.locator("[data-pickup-address]")).toHaveText(
      `Ridicare personală de la: ${STORE_TEXT}`,
    );
    const body = await view.innerText();
    expect(body).not.toContain("Str. Exemplu");
    expect(body).not.toContain("Livrare în");

    // snapshot pe comandă, în bază
    const order = await readE2eOrder(number);
    expect(order?.shippingMethodCode).toBe("pickup");
    expect(order?.shippingMinor).toBe(0);

    // urmărirea (altă sesiune, cu număr + email) arată același lucru
    const other = await browser.newContext();
    const track = await other.newPage();
    await track.goto("/comanda/urmarire");
    const form = track.locator("[data-track-form]");
    await form.getByLabel("Numărul comenzii").fill(number);
    await form.getByLabel("Adresa de email").fill(EMAIL);
    await form.getByRole("button", { name: "Caută comanda" }).click();
    await expect(track.locator("[data-track-result]")).toContainText(number);
    await expect(track.locator("[data-track-result] [data-pickup-address]")).toHaveText(
      `Ridicare personală de la: ${STORE_TEXT}`,
    );
    const tracked = await track.locator("[data-track-result]").innerText();
    expect(tracked).not.toContain("Str. Exemplu");
    expect(tracked).not.toContain("Livrare în");
    await other.close();
  });

  test("o schimbare ulterioară a adresei magazinului nu modifică o comandă veche", async ({
    page,
  }) => {
    await toShipping(page, `schimb-${tag}${E2E_ORDER_EMAIL_DOMAIN}`);
    await step(page, "shipping").locator('[data-offer="pickup"] input').check();
    await next(page, "shipping");
    const number = await placeCod(page);
    await setE2eSettings({ "company.address": storeAddress({ street: "Strada Nouă 99" }) });
    await page.reload();
    await expect(page.locator("[data-order-summary-view] [data-pickup-address]")).toContainText(
      STORE_STREET,
    );
    await expect(page.locator("[data-order-summary-view]")).not.toContainText("Strada Nouă 99");
    expect(number).toMatch(/^E2E-/);
    await setE2eSettings({ "company.address": storeAddress() });
  });
});

test.describe("ridicare fără adresa magazinului", () => {
  test("ridicarea dispare din checkout, livrarea cu curier rămâne", async ({ page }) => {
    await setE2eSettings({ "company.address": storeAddress({ street: "", city: "" }) });
    await toShipping(page, `fara-${tag}${E2E_ORDER_EMAIL_DOMAIN}`);
    await expect(step(page, "shipping").locator('[data-offer="demo:courier"]')).toBeVisible();
    await expect(step(page, "shipping").locator('[data-offer="pickup"]')).toHaveCount(0);
    await expect(step(page, "shipping").locator("[data-ground-notice]")).toBeVisible();
    await setE2eSettings({ "company.address": storeAddress() });
  });

  test("în admin, lângă opțiunea de ridicare apare nota; cu adresă setată apare adresa", async ({
    page,
  }) => {
    await setE2eSettings({ "company.address": storeAddress({ street: "", city: "" }) });
    await login(page, owner, "/admin/setari/cos");
    await expect(page.locator("[data-pickup-needs-address]")).toContainText(
      "Ridicarea personală are nevoie de adresa firmei (setarea `company.address`; ecranul pentru datele firmei vine în Faza 13)",
    );
    await setE2eSettings({ "company.address": storeAddress() });
    await page.reload();
    await expect(page.locator("[data-pickup-address]")).toContainText(STORE_TEXT);
    await expect(page.locator("[data-pickup-needs-address]")).toHaveCount(0);
  });
});

test.describe("regresie: livrarea cu curier rămâne neschimbată", () => {
  test("pasul 2 rămâne «Adresa de livrare», confirmarea arată «Livrare în», fără adresă de ridicare", async ({
    page,
  }) => {
    await toShipping(page, `curier-${tag}${E2E_ORDER_EMAIL_DOMAIN}`);
    await step(page, "shipping").locator('[data-offer="demo:courier"] input').check();
    await expect(step(page, "delivery").locator("h2 button")).toContainText("Adresa de livrare");
    await expect(page.locator("[data-summary-pickup]")).toHaveCount(0);
    await next(page, "shipping");
    await expect(step(page, "billing").getByLabel("Aceleași date ca la livrare")).toBeChecked();
    await placeCod(page);
    const view = page.locator("[data-order-summary-view]");
    await expect(view).toContainText("Livrare în");
    await expect(view.locator("[data-pickup-address]")).toHaveCount(0);
    await expect(view).not.toContainText("Ridicare");
  });
});

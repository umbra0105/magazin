import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  E2E_ORDER_EMAIL_DOMAIN,
  clearE2eSettings,
  expireE2eOrderReservations,
  readE2eOrder,
  readE2ePayments,
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

/**
 * Plata cu cardul prin furnizorul DEMO (Faza 10), în browser, pe aceeași cale ca un procesator real: checkout → pagina «procesatorului»
 * (DEMO) → notificare semnată către ruta webhook → coadă → worker → pagina de așteptare cu polling. Cazuri: succes, eșec și
 * reîncercare, retur fără plată (nu confirmă nimic), sumă greșită (necesită atenție), același webhook de 3 ori (un singur efect) și
 * plată târzie fără stoc (comandă anulată, rambursare automată, mesaj pentru client). Cardul apare doar cu un furnizor activ.
 * DEMO funcționează aici pentru că serverul E2E rulează cu `E2E_HARNESS=1`.
 */
const tag = randomBytes(3).toString("hex");
const EMAIL = `card-${tag}${E2E_ORDER_EMAIL_DOMAIN}`;

test.describe.configure({ mode: "serial" });

let simplu: E2eCartProduct; // 199,00 lei, stoc negestionat
let gestionat: E2eCartProduct; // 199,00 lei, stoc gestionat (5)
let ultima: E2eCartProduct; // 199,00 lei, stoc gestionat (1)

const SETTING_KEYS = [
  "company.legalName",
  "company.bankName",
  "company.iban",
  "shipping.pickupEnabled",
  "checkout.orderNumberPrefix",
  "checkout.orderNumberDigits",
  "checkout.anafTimeoutMs",
];

test.beforeAll(async () => {
  await seedE2eCheckoutSettings();
  await setE2eSettings({ "checkout.anafTimeoutMs": 500 });
  simplu = await seedE2eCartProduct(tag, "simplu", { price: 19_900 });
  gestionat = await seedE2eCartProduct(tag, "gestionat", { price: 19_900 });
  ultima = await seedE2eCartProduct(tag, "ultima", { price: 19_900 });
  await setE2eCartStock(gestionat.variantId, "5");
  await setE2eCartStock(ultima.variantId, "1");
});

test.afterAll(async () => {
  await removeE2eDemoPayments();
  await removeE2eOrders();
  await removeE2eCarts();
  await removeE2eCartStock([gestionat.variantId, ultima.variantId]);
  await removeE2eProducts();
  await clearE2eSettings(SETTING_KEYS);
});

async function addToCart(page: Page, product: E2eCartProduct) {
  await page.goto(`/produs/${product.slug}`);
  await page.locator("[data-add-button]").click();
  await expect(page.locator("[data-cart-drawer] [data-cart-line]").first()).toBeVisible();
}

const step = (page: Page, id: string) => page.locator(`[data-step="${id}"]`);
const next = async (page: Page, id: string) => {
  await page.locator(`[data-continue="${id}"]`).click();
};

async function toPayment(page: Page) {
  await page.goto("/cos");
  await page.locator("main [data-checkout]").click();
  await expect(page).toHaveURL(/\/checkout$/);
  await step(page, "contact").getByLabel("Adresa de email").fill(EMAIL);
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
  await expect(step(page, "shipping").locator('[data-offer="demo:courier"]')).toBeVisible();
  await step(page, "shipping").locator('[data-offer="demo:courier"] input').check();
  await next(page, "shipping");
  await expect(step(page, "billing")).toBeVisible();
  await next(page, "billing");
  await expect(step(page, "payment").locator("[data-method]").first()).toBeVisible();
}

/** Plasează o comandă cu card și ajunge pe pagina procesatorului (DEMO). Întoarce numărul comenzii. */
async function placeWithCard(page: Page, product: E2eCartProduct): Promise<string> {
  await addToCart(page, product);
  await toPayment(page);
  await step(page, "payment").locator('[data-method="card"] input').check();
  await next(page, "payment");
  await page.getByRole("checkbox", { name: /Am citit și sunt de acord/ }).check();
  await page.locator("[data-checkout-submit]").click();
  await expect(page).toHaveURL(/\/plata-demo\//);
  await expect(page.getByRole("note").filter({ hasText: "DEMO" })).toBeVisible();
  const text = await page.locator("main").innerText();
  const match = /E2E-\d{6}/.exec(text);
  expect(match, text).not.toBeNull();
  return match![0];
}

const demo = (page: Page, scenario: "paid" | "wrong" | "failed" | "triple") =>
  page.locator(`[data-demo-scenario="${scenario}"]`).click();

const state = (page: Page) => page.locator("[data-card-payment-state]");

test.describe("cardul apare doar cu un furnizor activ", () => {
  test("fără furnizor activ, checkout-ul oferă doar ramburs și transfer", async ({ page }) => {
    await clearE2eSettings(["payment.cardProvider"]);
    await addToCart(page, simplu);
    await toPayment(page);
    await expect(step(page, "payment").locator('[data-method="cod"]')).toBeVisible();
    await expect(step(page, "payment").locator('[data-method="bank_transfer"]')).toBeVisible();
    await expect(step(page, "payment").locator('[data-method="card"]')).toHaveCount(0);
    await expect(step(page, "payment")).not.toContainText("Card online");
    await seedE2eDemoPayments();
  });

  test("cu DEMO activ apare un singur buton «Card online», fără limită de valoare", async ({
    page,
  }) => {
    await seedE2eDemoPayments();
    await addToCart(page, simplu);
    await toPayment(page);
    const card = step(page, "payment").locator('[data-method="card"]');
    await expect(card).toHaveAttribute("data-available", "true");
    await expect(card).toContainText("Card online");
    await expect(step(page, "payment").locator('[data-method="card"]')).toHaveCount(1);
  });
});

test.describe("succes, eșec și reîncercare", () => {
  test("succes: confirmarea vine din notificare, pagina de așteptare o arată, comanda e confirmată o singură dată", async ({
    page,
  }) => {
    const number = await placeWithCard(page, gestionat);
    // cât timp nu s-a plătit, comanda e în așteptare și stocul e rezervat
    const before = await readE2ePayments(number);
    expect(before).toMatchObject({ orderStatus: "pending", orderPaymentStatus: "pending" });
    expect(before?.activeReservations).toBe(1);
    expect(before?.commitments).toBe(0);

    await demo(page, "paid");
    await expect(page).toHaveURL(/\/comanda\/plata\//);
    await expect(state(page)).toHaveAttribute("data-card-payment-state", "paid", {
      timeout: 30_000,
    });
    await expect(page.getByRole("heading", { name: "Plata a fost confirmată" })).toBeVisible();

    const after = await readE2ePayments(number);
    expect(after).toMatchObject({ orderStatus: "confirmed", orderPaymentStatus: "paid" });
    expect(after?.payments).toHaveLength(1);
    expect(after?.payments[0]).toMatchObject({
      provider: "demo",
      status: "paid",
      amountMinor: 22_400,
      capturedAmountMinor: 22_400,
      cardLast4: "4242",
    });
    expect(after?.commitments).toBe(1);
    expect(after?.activeReservations).toBe(0);
    expect(after?.events.filter((e) => e === "payment.confirmed")).toHaveLength(1);
    expect(after?.refunds).toHaveLength(0);

    // pagina de confirmare a comenzii (după plată) spune că plata a fost confirmată
    await page.goto("/comanda/confirmare");
    await expect(page.locator("[data-order-confirmation]")).toBeVisible();
    await expect(page.locator("main")).toContainText("Plata cu cardul a fost confirmată");
    await expect(page.locator("main")).toContainText("224,00");
  });

  test("eșec: comanda rămâne în așteptare, stocul se eliberează; «Reîncearcă plata» creează o tentativă nouă care reușește", async ({
    page,
  }) => {
    const number = await placeWithCard(page, gestionat);
    await demo(page, "failed");
    await expect(state(page)).toHaveAttribute("data-card-payment-state", "failed", {
      timeout: 30_000,
    });
    await expect(page.getByRole("heading", { name: "Plata nu a reușit" })).toBeVisible();
    const failed = await readE2ePayments(number);
    expect(failed).toMatchObject({ orderStatus: "pending", orderPaymentStatus: "pending" });
    expect(failed?.payments.map((p) => p.status)).toEqual(["failed"]);
    expect(failed?.activeReservations).toBe(0);

    await page.locator("[data-retry-payment]").click();
    await expect(page).toHaveURL(/\/plata-demo\//);
    await expect.poll(async () => (await readE2ePayments(number))?.activeReservations).toBe(1);
    await demo(page, "paid");
    await expect(state(page)).toHaveAttribute("data-card-payment-state", "paid", {
      timeout: 30_000,
    });
    const done = await readE2ePayments(number);
    expect(done?.payments.map((p) => [p.attemptNo, p.status])).toEqual([
      [1, "failed"],
      [2, "paid"],
    ]);
    expect(done).toMatchObject({ orderStatus: "confirmed", orderPaymentStatus: "paid" });
    expect(done?.commitments).toBe(1);
  });

  test("returul clientului la pagina de plată NU confirmă nimic: fără notificare, comanda rămâne în așteptare", async ({
    page,
  }) => {
    const number = await placeWithCard(page, simplu);
    const payUrl = page.url();
    const paymentId = decodeURIComponent(payUrl.split("/plata-demo/")[1] ?? "");
    // clientul «se întoarce» singur la magazin, fără să fi plătit (sau cu un retur fals)
    await page.goto(`/comanda/plata/${paymentId}?status=success&paid=1`);
    await expect(state(page)).toHaveAttribute("data-card-payment-state", "checking");
    await expect(page.getByRole("heading", { name: "Verificăm plata" })).toBeVisible();
    await page.waitForTimeout(4_000);
    await expect(state(page)).toHaveAttribute("data-card-payment-state", "checking");
    const snapshot = await readE2ePayments(number);
    expect(snapshot).toMatchObject({ orderStatus: "pending", orderPaymentStatus: "pending" });
    expect(snapshot?.payments[0]?.status).toBe("pending");
  });

  test("starea plății nu se vede fără cookie-ul comenzii (fără IDOR)", async ({
    page,
    browser,
  }) => {
    await placeWithCard(page, simplu);
    const paymentId = decodeURIComponent(page.url().split("/plata-demo/")[1] ?? "");
    const stranger = await browser.newContext();
    const other = await stranger.newPage();
    await other.goto(`/comanda/plata/${paymentId}`);
    await expect(other.locator("[data-card-payment-state]")).toHaveCount(0);
    await expect(
      other.getByRole("heading", { name: /Nu putem arăta starea acestei plăți/ }),
    ).toBeVisible();
    await stranger.close();
  });
});

test.describe("sumă greșită, notificare triplă, plată târzie fără stoc", () => {
  test("sumă diferită: comanda NU se confirmă, plata cere atenție, clientul vede că verificăm", async ({
    page,
  }) => {
    const number = await placeWithCard(page, simplu);
    await demo(page, "wrong");
    await expect(state(page)).toHaveAttribute("data-card-payment-state", "attention", {
      timeout: 30_000,
    });
    const snapshot = await readE2ePayments(number);
    expect(snapshot).toMatchObject({ orderStatus: "pending", orderPaymentStatus: "pending" });
    expect(snapshot?.payments[0]).toMatchObject({
      status: "pending",
      attentionReason: "amount_mismatch",
    });
    expect(snapshot?.refunds).toHaveLength(0);
  });

  test("același webhook trimis de 3 ori: un singur efect (o confirmare, o angajare, un eveniment, nicio rambursare)", async ({
    page,
  }) => {
    const number = await placeWithCard(page, gestionat);
    await demo(page, "triple");
    await expect(state(page)).toHaveAttribute("data-card-payment-state", "paid", {
      timeout: 30_000,
    });
    const snapshot = await readE2ePayments(number);
    expect(snapshot?.commitments).toBe(1);
    expect(snapshot?.processedWebhookEvents).toBe(1);
    expect(snapshot?.events.filter((e) => e === "payment.confirmed")).toHaveLength(1);
    expect(snapshot?.refunds).toHaveLength(0);
  });

  test("plată târzie fără stoc: comandă anulată, o singură rambursare automată, mesaj în română pe pagina comenzii și în urmărire", async ({
    page,
  }) => {
    const number = await placeWithCard(page, ultima);
    // rezervarea expiră, iar altcineva cumpără ultima bucată
    expect(await expireE2eOrderReservations(number)).toBe(1);
    await takeE2eCartStock(ultima.variantId);
    await demo(page, "paid");
    await expect(state(page)).toHaveAttribute("data-card-payment-state", "stock_lost", {
      timeout: 30_000,
    });
    await expect(page.getByRole("heading", { name: "Comanda a fost anulată" })).toBeVisible();
    await expect(page.locator("main")).toContainText("iar suma plătită va fi returnată");
    await expect(page.locator("main")).not.toContainText("a fost rambursată");

    const snapshot = await readE2ePayments(number);
    expect(snapshot?.orderStatus).toBe("cancelled");
    expect(snapshot?.commitments).toBe(0);
    expect(snapshot?.refunds).toHaveLength(1);
    expect(snapshot?.refunds[0]).toMatchObject({
      amountMinor: 22_400,
      kind: "auto_stock_lost",
      status: "confirmed",
    });
    expect(snapshot?.events.filter((e) => e === "payment.stock_lost")).toHaveLength(1);
    expect(await readE2eOrder(number)).toMatchObject({ status: "cancelled" });

    // și în urmărire (număr + email)
    await page.goto("/comanda/urmarire");
    await page.getByLabel("Numărul comenzii").fill(number);
    await page.getByLabel("Adresa de email").fill(EMAIL);
    await page.getByRole("button", { name: "Caută comanda" }).click();
    await expect(page.locator("[data-payment-notice]")).toContainText(
      "iar suma plătită va fi returnată",
    );
  });
});

import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
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
  setE2eSettings,
  type E2eCartProduct,
} from "../packages/core/test/e2e-support";
import {
  createAccount,
  demoScenario,
  login,
  paymentState,
  type Account,
} from "./support/card-flow";
import { waitForEmail } from "./support/mailpit";

/**
 * Oferta de plată (Faza 11, decizia A), în browser: adminul creează oferta pas cu pas, clientul o deschide din link într-o fereastră
 * separată (fără sesiune), bifează Termenii și plătește prin DEMO. Cazuri: succes (o singură comandă, link folosit a doua oară),
 * ofertă învechită (stocul a dispărut), anulare, retrimitere (linkul vechi nu mai merge), răspuns identic pentru jeton necunoscut și
 * pentru oferta anulată, emailul cu link (Mailpit) și permisiunea (Suport nu vede ecranele). DEMO merge pentru că serverul E2E
 * rulează cu `E2E_HARNESS=1`.
 */
const tag = randomBytes(3).toString("hex");
const emailOf = (name: string) => `oferta-${name}-${tag}${E2E_ORDER_EMAIL_DOMAIN}`;

test.describe.configure({ mode: "serial" });

let produs: E2eCartProduct;
let ultima: E2eCartProduct;
let manager: Account;
let support: Account;

const SETTING_KEYS = [
  "company.legalName",
  "company.bankName",
  "company.iban",
  "shipping.pickupEnabled",
  "checkout.orderNumberPrefix",
  "checkout.orderNumberDigits",
  "checkout.anafTimeoutMs",
];

test.beforeAll(async ({ request, baseURL }) => {
  await seedE2eCheckoutSettings();
  await setE2eSettings({ "checkout.anafTimeoutMs": 500 });
  await seedE2eDemoPayments();
  produs = await seedE2eCartProduct(tag, "oferta", { price: 19_900 });
  ultima = await seedE2eCartProduct(tag, "ultima", { price: 19_900 });
  await setE2eCartStock(produs.variantId, "50");
  await setE2eCartStock(ultima.variantId, "1");
  manager = await createAccount(request, baseURL as string, "manager");
  support = await createAccount(request, baseURL as string, "support");
});

test.afterAll(async () => {
  await removeE2eDemoPayments();
  await removeE2eOrders();
  await removeE2eCarts();
  await removeE2eCartStock([produs.variantId, ultima.variantId]);
  await removeE2eProducts();
  await clearE2eSettings(SETTING_KEYS);
});

/** Creează o ofertă din ecranul pas cu pas; întoarce linkul (afișat o singură dată) și adresa detaliului. */
async function createOffer(
  page: Page,
  product: E2eCartProduct,
  email: string,
  options: { sendEmail?: boolean } = {},
): Promise<{ link: string; detail: string }> {
  await page.goto("/admin/comenzi/oferte/nou");
  await expect(page.locator("[data-offer-step]")).toContainText("Pasul 1 din 4");
  await page.getByLabel("Caută produs").fill(product.sku);
  await page.getByRole("button", { name: "Adaugă" }).click();
  await expect(page.getByLabel("Cantitate")).toHaveValue("1");
  await page.locator("[data-offer-next]").click();

  await expect(page.locator("[data-offer-step]")).toContainText("Pasul 2 din 4");
  await page.getByLabel("Email client").fill(email);
  await page.getByLabel("Telefon").fill("0722 123 456");
  await page.getByLabel("Nume complet").fill("Ion Popescu");
  await page.getByLabel("Județ").selectOption({ label: "Alba" });
  const locality = page.getByLabel("Localitate");
  await expect(locality.locator("option")).not.toHaveCount(1);
  await locality.selectOption({ label: "Alba Iulia" });
  await page.getByLabel("Strada și numărul").fill("Str. Exemplu 1, bl. A");
  await page.getByLabel("Cod poștal").fill("510005");
  await page.locator("[data-offer-next]").click();

  await expect(page.locator("[data-offer-step]")).toContainText("Pasul 3 din 4");
  await page.locator('input[name="offer"]').first().check();
  await page.locator("[data-offer-next]").click();

  await expect(page.locator("[data-offer-step]")).toContainText("Pasul 4 din 4");
  await expect(page.getByText("Total de plată (TVA inclus)")).toBeVisible();
  const send = page.getByLabel("Trimite linkul pe email acum");
  if (options.sendEmail) await send.check();
  else await send.uncheck();
  await page.getByRole("button", { name: "Creează oferta" }).click();

  await expect(page.locator("[data-offer-created]")).toBeVisible();
  const link = await page.locator("[data-offer-link]").inputValue();
  const detail = await page.getByRole("link", { name: "Deschide oferta" }).getAttribute("href");
  expect(link).toMatch(/\/oferta\/[A-Za-z0-9_-]{43}$/);
  return { link, detail: detail as string };
}

test.describe("ecranele de admin", () => {
  test("Suport nu vede ecranele ofertelor (nici în meniu, nici prin adresă)", async ({ page }) => {
    await login(page, support, "/admin/comenzi");
    await expect(page.getByRole("link", { name: "Oferte de plată" })).toHaveCount(0);
    await page.goto("/admin/comenzi/oferte");
    await expect(page).toHaveURL(/\/admin\/acces-interzis|\/cont/);
    await page.goto("/admin/comenzi/oferte/nou");
    await expect(page).toHaveURL(/\/admin\/acces-interzis|\/cont/);
  });

  test("validarea pașilor: produs lipsă, cantitate invalidă, câmpuri goale (mesaje în română, fără validare nativă)", async ({
    page,
  }) => {
    await login(page, manager, "/admin/comenzi/oferte/nou");
    await page.locator("[data-offer-next]").click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Adaugă cel puțin un produs." }),
    ).toBeVisible();
    await page.getByLabel("Caută produs").fill(produs.sku);
    await page.getByRole("button", { name: "Adaugă" }).click();
    await page.getByLabel("Cantitate").fill("0");
    await page.locator("[data-offer-next]").click();
    await expect(page.getByText("Scrie o cantitate validă")).toBeVisible();
    await page.getByLabel("Cantitate").fill("1");
    await page.locator("[data-offer-next]").click();
    await expect(page.locator("[data-offer-step]")).toContainText("Pasul 2 din 4");
    await page.locator("[data-offer-next]").click();
    await expect(page.getByText("Adresa de email nu este validă.")).toBeVisible();
    await expect(page.getByLabel("Email client")).toBeFocused();
  });
});

test.describe("succes: de la creare la plată", () => {
  test("oferta creată, deschisă din link într-o fereastră separată, plătită prin DEMO: o singură comandă", async ({
    page,
    browser,
  }) => {
    await login(page, manager, "/admin/comenzi/oferte/nou");
    const { link, detail } = await createOffer(page, produs, emailOf("succes"));

    const client = await (await browser.newContext()).newPage();
    await client.goto(link);
    await expect(client.locator("[data-offer-total]")).toContainText("224,00");
    await expect(client.locator("main")).toContainText(produs.title);
    // fără bifa Termenilor nu se plătește
    await client.locator("[data-offer-pay-button]").click();
    await expect(client.getByRole("alert").filter({ hasText: "Bifează acordul" })).toBeVisible();
    await client.getByRole("checkbox", { name: /Am citit și sunt de acord/ }).check();
    await client.locator("[data-offer-pay-button]").click();
    await expect(client).toHaveURL(/\/plata-demo\//);
    await demoScenario(client, "paid");
    await expect(paymentState(client)).toHaveAttribute("data-card-payment-state", "paid", {
      timeout: 30_000,
    });

    // linkul folosit a doua oară: oferta e deja comandă, fără o a doua comandă
    await client.goto(link);
    await expect(
      client.getByRole("heading", { name: "Oferta a fost deja folosită" }),
    ).toBeVisible();
    await client.context().close();

    await page.goto(detail);
    await expect(page.locator("[data-offer-detail]")).toContainText("Convertită în comandă");
    await expect(page.getByRole("link", { name: /^E2E-\d{6}$/ })).toBeVisible();
    await page.goto("/admin/comenzi/oferte?vedere=toate");
    await expect(page.locator("[data-offer-row]").first()).toContainText("Convertită în comandă");
  });
});

test.describe("oferta învechită", () => {
  test("stocul a dispărut între timp: nu se creează comandă, oferta devine «Învechită»", async ({
    page,
    browser,
  }) => {
    await login(page, manager, "/admin/comenzi/oferte/nou");
    const { link, detail } = await createOffer(page, ultima, emailOf("stoc"));
    await setE2eCartStock(ultima.variantId, "0");

    const client = await (await browser.newContext()).newPage();
    await client.goto(link);
    await client.getByRole("checkbox", { name: /Am citit și sunt de acord/ }).check();
    await client.locator("[data-offer-pay-button]").click();
    await expect(
      client.getByRole("alert").filter({ hasText: "Oferta nu mai este disponibilă" }),
    ).toBeVisible();
    await expect(client).not.toHaveURL(/plata-demo/);
    await client.context().close();

    await page.goto(detail);
    await expect(page.locator("[data-offer-detail]")).toContainText("Învechită");
    await expect(page.locator("[data-offer-detail]")).toContainText("Stocul nu mai acoperă oferta");
    await expect(page.locator("[data-offer-actions]")).toHaveCount(0);
  });
});

test.describe("anulare, retrimitere și răspuns identic", () => {
  test("anularea oprește linkul; jetonul necunoscut și oferta anulată arată aceeași pagină", async ({
    page,
    browser,
  }) => {
    await login(page, manager, "/admin/comenzi/oferte/nou");
    const { link, detail } = await createOffer(page, produs, emailOf("anulat"));
    await page.goto(detail);
    await page.getByRole("button", { name: "Anulează oferta" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Anulează oferta" }).click();
    await expect(page.locator("[data-offer-detail]")).toContainText("Anulată");
    await expect(page.locator("[data-offer-actions]")).toHaveCount(0);

    const client = await (await browser.newContext()).newPage();
    await client.goto(link);
    const cancelledText = await client.locator("main").innerText();
    await client.goto(`/oferta/${"x".repeat(43)}`);
    const unknownText = await client.locator("main").innerText();
    expect(cancelledText).toContain("Oferta nu mai este disponibilă");
    expect(unknownText).toBe(cancelledText);
    await client.goto("/oferta/scurt");
    expect(await client.locator("main").innerText()).toBe(cancelledText);
    // pagina nu se indexează
    await expect(client.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await client.context().close();
  });

  test("retrimiterea dă un link nou, iar cel vechi nu mai merge", async ({ page, browser }) => {
    await login(page, manager, "/admin/comenzi/oferte/nou");
    const { link, detail } = await createOffer(page, produs, emailOf("retrimis"));
    await page.goto(detail);
    // linkul nu mai poate fi citit din pagina detaliului
    await expect(page.locator("[data-offer-link]")).toHaveCount(0);
    await page.getByRole("button", { name: "Retrimite (link nou)" }).click();
    await page.getByRole("dialog").getByLabel("Trimite și pe email").uncheck();
    await page.getByRole("button", { name: "Generează link nou" }).click();
    const fresh = await page.locator("[data-offer-link]").inputValue();
    expect(fresh).not.toBe(link);

    const client = await (await browser.newContext()).newPage();
    await client.goto(link);
    await expect(
      client.getByRole("heading", { name: "Oferta nu mai este disponibilă" }),
    ).toBeVisible();
    await client.goto(fresh);
    await expect(client.locator("[data-offer-total]")).toContainText("224,00");
    await client.context().close();
  });
});

test.describe("emailul cu link", () => {
  test("linkul ajunge pe email (Mailpit) și deschide oferta", async ({ page, browser }) => {
    const email = emailOf("email");
    await login(page, manager, "/admin/comenzi/oferte/nou");
    const { link } = await createOffer(page, produs, email, { sendEmail: true });
    await expect(page.getByText("Linkul a fost pus la trimis pe email.")).toBeVisible();
    const message = await waitForEmail(email, { subject: /^Oferta OF-/ });
    const fromEmail = /https?:\/\/[^\s\])"<>]+\/oferta\/[A-Za-z0-9_-]{43}/.exec(message.text)?.[0];
    expect(fromEmail).toBe(link);
    const client = await (await browser.newContext()).newPage();
    await client.goto(fromEmail as string);
    await expect(client.locator("[data-offer-total]")).toContainText("224,00");
    await client.context().close();
  });
});

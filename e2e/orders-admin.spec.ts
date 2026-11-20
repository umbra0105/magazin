import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  E2E_ORDER_EMAIL_DOMAIN,
  clearE2eSettings,
  readE2eOrder,
  removeE2eCartStock,
  removeE2eCarts,
  removeE2eOrders,
  removeE2eProducts,
  seedE2eCartProduct,
  seedE2eCheckoutSettings,
  setE2eCartStock,
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
import { waitForEmail } from "./support/mailpit";

/**
 * Ecranele noi de comenzi din admin (Faza 11), în browser: lista cu vederi, detaliul, «Marchează plătit» (transfer bancar),
 * anularea cu motiv, nota internă, emailurile trimise clientului (Mailpit), ecranele de șabloane (previzualizare, suprascriere cu
 * variabile validate, revenire la implicit) și clopoțelul. Comenzile se plasează din vitrină, pe aceeași cale ca un client.
 */
const tag = randomBytes(3).toString("hex");
const emailOf = (name: string) => `adm-${name}-${tag}${E2E_ORDER_EMAIL_DOMAIN}`;

test.describe.configure({ mode: "serial" });

let produs: E2eCartProduct;
let manager: Account;
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

test.beforeAll(async ({ request, baseURL }) => {
  await seedE2eCheckoutSettings();
  await setE2eSettings({ "checkout.anafTimeoutMs": 500 });
  produs = await seedE2eCartProduct(tag, "admcom", { price: 19_900 });
  await setE2eCartStock(produs.variantId, "50");
  manager = await createAccount(request, baseURL as string, "manager");
  owner = await createAccount(request, baseURL as string, "owner");
});

test.afterAll(async () => {
  await removeE2eOrders();
  await removeE2eCarts();
  await removeE2eCartStock([produs.variantId]);
  await removeE2eProducts();
  await clearE2eSettings(SETTING_KEYS);
});

/** Plasează o comandă cu transfer bancar din vitrină; întoarce numărul ei. */
async function placeTransfer(page: Page, email: string): Promise<string> {
  await addToCart(page, produs);
  await toPayment(page, email);
  await step(page, "payment").locator('[data-method="bank_transfer"] input').check();
  await page.locator('[data-continue="payment"]').click();
  await page.getByRole("checkbox", { name: /Am citit și sunt de acord/ }).check();
  await page.locator("[data-checkout-submit]").click();
  await expect(page.locator("[data-order-confirmation]")).toBeVisible();
  const match = /E2E-\d{6}/.exec(await page.locator("main").innerText());
  expect(match).not.toBeNull();
  return match![0];
}

const openOrder = async (page: Page, number: string) => {
  await page.goto("/admin/comenzi");
  const row = page.locator("[data-order-row]").filter({ hasText: number });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: number }).first().click();
  await expect(page.locator("[data-order-detail]")).toContainText(number);
};

test.describe("lista, detaliul și acțiunile", () => {
  // emailurile pleacă prin măturătorul de 10 s și workerul: sub sarcină pot dura mai mult decât timpul implicit al testului
  test.describe.configure({ timeout: 180_000 });

  test("transfer bancar: comanda apare în listă, «Marchează plătit» o confirmă, clientul primește emailul, nota se salvează", async ({
    page,
    browser,
  }) => {
    const email = emailOf("plata");
    const customer = await (await browser.newContext()).newPage();
    const number = await placeTransfer(customer, email);
    await customer.context().close();

    await login(page, manager, "/admin/comenzi");
    await expect(page.getByRole("heading", { level: 1, name: /^Comenzi/ })).toBeVisible();
    await openOrder(page, number);
    await expect(page.locator("[data-order-detail]")).toContainText("224,00");

    await page.getByRole("button", { name: "Marchează plătit…" }).first().click();
    const dialog = page.getByRole("dialog");
    // fără referință: mesaj în română, fără validare nativă
    await dialog.getByLabel("Suma primită (lei)").fill("224,00");
    await dialog.getByRole("button", { name: "Marchează plătit" }).click();
    await expect(dialog.getByText("Scrie referința din extras")).toBeVisible();
    await dialog.getByLabel("Referința din extras").fill("OP 12345");
    await dialog.getByRole("button", { name: "Marchează plătit" }).click();
    await expect(page.getByText("Plata a fost înregistrată; comanda e confirmată.")).toBeVisible();

    const order = await readE2eOrder(number);
    expect(order).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
    const message = await waitForEmail(email, { subject: /Plat/, timeoutMs: 90_000 });
    expect(message.text).toContain(number);

    // nota internă: se vede în detaliu, nu ajunge la client
    await page.getByLabel("Nota internă").fill("Client sunat, vine după 10");
    await page.getByRole("button", { name: "Adaugă nota" }).click();
    await expect(page.locator("[data-order-detail]")).toContainText("Client sunat, vine după 10");
  });

  test("anularea cere un motiv; comanda devine «Anulată», iar clientul primește emailul de anulare", async ({
    page,
    browser,
  }) => {
    const email = emailOf("anulare");
    const customer = await (await browser.newContext()).newPage();
    const number = await placeTransfer(customer, email);
    await customer.context().close();

    await login(page, manager, "/admin/comenzi");
    await openOrder(page, number);
    await page.getByRole("button", { name: "Anulează comanda…" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Anulează comanda" }).click();
    await expect(dialog.getByText("Scrie motivul anulării")).toBeVisible();
    await dialog.getByLabel("Motivul anulării").fill("Clientul s-a răzgândit");
    await dialog.getByRole("button", { name: "Anulează comanda" }).click();
    await expect(page.getByText("Comanda a fost anulată.")).toBeVisible();

    expect(await readE2eOrder(number)).toMatchObject({ status: "cancelled" });
    const message = await waitForEmail(email, { subject: /anulat/i, timeoutMs: 90_000 });
    expect(message.text).toContain("Clientul s-a răzgândit");
  });
});

test.describe("șabloanele de email", () => {
  test("previzualizare, suprascriere cu variabile validate și revenire la implicit", async ({
    page,
  }) => {
    await login(page, owner, "/admin/comenzi/sabloane-email");
    await expect(page.getByRole("heading", { level: 1, name: /Șabloane email/ })).toBeVisible();
    await page.goto("/admin/comenzi/sabloane-email/order.confirmation");
    await expect(page.getByRole("heading", { name: "Previzualizarea emailului" })).toBeVisible();

    const subject = page.getByLabel("Subiectul emailului");
    await subject.fill("Test {{variabila_necunoscuta}}");
    await page.getByRole("button", { name: "Salvează textul propriu" }).click();
    await expect(page.getByRole("alert").first()).toBeVisible();

    await subject.fill("Comanda ta {{numar}} – {{magazin}}");
    await page.getByRole("button", { name: "Salvează textul propriu" }).click();
    await expect(page.getByText("Textul propriu a fost salvat.")).toBeVisible();

    await page.getByRole("button", { name: "Revino la textul implicit" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Revino la textul implicit" })
      .click();
    await expect(page.getByText("S-a revenit la textul implicit.")).toBeVisible();
  });
});

test.describe("clopoțelul", () => {
  test("clopoțelul se deschide și arată lista (goală sau cu notificări)", async ({ page }) => {
    await login(page, manager, "/admin/comenzi");
    await page.locator("[data-notifications-bell]").click();
    await expect(page.locator("[data-notifications-list]")).toBeVisible();
  });
});

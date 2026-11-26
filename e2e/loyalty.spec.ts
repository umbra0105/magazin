import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  E2E_ORDER_EMAIL_DOMAIN,
  clearE2eSettings,
  disableE2eLoyalty,
  enableE2eLoyalty,
  ensureE2eSystemGroup,
  readE2eLoyaltyAudit,
  readE2eLoyaltyBalance,
  readE2eOrder,
  readE2ePayments,
  readE2eSetting,
  readE2eUserId,
  removeE2eCarts,
  removeE2eCustomerGroups,
  removeE2eDemoPayments,
  removeE2eDemoProvider,
  removeE2eOrders,
  removeE2eProducts,
  seedE2eCartProduct,
  seedE2eCheckoutSettings,
  seedE2eCustomerGroup,
  seedE2eDemoPayments,
  setE2eFeatureFlag,
  setE2eSettings,
  setE2eUserGroup,
  type E2eCartProduct,
} from "../packages/core/test/e2e-support";
import {
  addToCart,
  createAccount,
  demoScenario,
  login,
  paymentState,
  step,
  toPayment,
  type Account,
} from "./support/card-flow";

/**
 * Punctele de loialitate (Faza 15b), din browser. Specul pornește programul (flag și setări comune întregii aplicații), de aceea
 * stă în proiectul izolat al comenzilor (vezi test/support/e2e-projects.ts). Conturile au parole generate în test; ceasul NU se
 * mută (acordarea și expirarea sunt dovedite de testele de integrare cu ceas injectat).
 *
 * Cifre de mână: produs de 300,00 lei → 3 puncte (1 punct la 100,00 lei). Cu 500 de puncte și un coș de 300,00 lei, se pot
 * folosi cel mult 300 (punctele nu acoperă transportul): de plată rămâne exact transportul, niciodată 0.
 */
const tag = randomBytes(3).toString("hex");
const emailOf = (name: string) => `puncte-${name}-${tag}${E2E_ORDER_EMAIL_DOMAIN}`;

test.describe.configure({ mode: "serial", timeout: 150_000 });

let produs: E2eCartProduct;
let owner: Account;
let manager: Account;
let accountant: Account;
let warehouse: Account;
let member: Account;
let partner: Account;
let memberPage = "";

const SETTING_KEYS = [
  "company.legalName",
  "company.bankName",
  "company.iban",
  "company.address",
  "shipping.pickupEnabled",
  "checkout.orderNumberPrefix",
  "checkout.orderNumberDigits",
  "checkout.anafTimeoutMs",
];

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
  });
  await seedE2eDemoPayments();
  await enableE2eLoyalty();
  await ensureE2eSystemGroup();
  produs = await seedE2eCartProduct(tag, "puncte", { price: 30_000 });
  const url = baseURL as string;
  owner = await createAccount(request, url, "owner");
  manager = await createAccount(request, url, "manager");
  accountant = await createAccount(request, url, "accountant");
  warehouse = await createAccount(request, url, "warehouse");
  member = await createAccount(request, url, "");
  partner = await createAccount(request, url, "");
  const group = await seedE2eCustomerGroup(tag, "partener", {
    name: `Partener ${tag}`,
    pricingType: "cost_plus",
    markupBps: 1200,
    earnsLoyaltyPoints: false,
    tone: "warning",
  });
  await setE2eUserGroup(partner.email, group.id);
  memberPage = `/admin/clienti/puncte/${await readE2eUserId(member.email)}`;
});

test.afterAll(async () => {
  await removeE2eDemoProvider();
  await removeE2eDemoPayments({ tag });
  await removeE2eOrders({ tag });
  await removeE2eCarts();
  await removeE2eProducts();
  await removeE2eCustomerGroups(tag);
  await disableE2eLoyalty();
  await clearE2eSettings(SETTING_KEYS);
});

const productNote = (page: Page) => page.locator("[data-product-points]");
const slider = (page: Page) => page.locator('[data-points-choice] input[type="range"]');

/** Deschide pagina produsului și așteaptă răspunsul cererii de puncte (altfel «nu apare nimic» ar trece înainte de răspuns). */
async function openProductAndWaitForPoints(page: Page): Promise<void> {
  const answered = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      (response.request().postData() ?? "").includes("quantityTicks"),
  );
  await page.goto(`/produs/${produs.slug}`);
  await (await answered).finished();
}

/** Alege metoda de plată, bifează acordul și plasează comanda; întoarce numărul ei. */
async function payAndPlace(page: Page, method: "card" | "bank_transfer"): Promise<string> {
  await step(page, "payment").locator(`[data-method="${method}"] input`).check();
  await page.locator('[data-continue="payment"]').click();
  await page.getByRole("checkbox", { name: /Am citit și sunt de acord/ }).check();
  await page.locator("[data-checkout-submit]").click();
  if (method === "card") await expect(page).toHaveURL(/\/plata-demo\//);
  else await expect(page.locator("[data-order-confirmation]")).toBeVisible();
  const text = await page.locator("main").innerText();
  const match = /E2E-\d{6}/.exec(text);
  expect(match, text).not.toBeNull();
  return match![0];
}

test("pagina produsului: oaspetele e invitat să-și facă cont, clientul vede punctele lui, Partenerul nimic", async ({
  page,
  browser,
}) => {
  await openProductAndWaitForPoints(page);
  await expect(productNote(page)).toHaveText(
    "Creează cont și primești 3 puncte la această achiziție.",
  );

  const signedIn = await (await browser.newContext()).newPage();
  await login(signedIn, member, "/cont");
  await openProductAndWaitForPoints(signedIn);
  await expect(productNote(signedIn)).toHaveText("Primești 3 puncte la această achiziție.");
  await signedIn.context().close();

  const partnerPage = await (await browser.newContext()).newPage();
  await login(partnerPage, partner, "/cont");
  await openProductAndWaitForPoints(partnerPage);
  await expect(partnerPage.locator("[data-add-button]")).toBeVisible();
  await expect(productNote(partnerPage)).toHaveCount(0);
  await partnerPage.goto("/cont/puncte");
  await expect(partnerPage.locator("[data-points-partner]")).toContainText(
    "Contul tău nu acumulează puncte.",
  );
  await partnerPage.context().close();
});

test("admin: ajustarea cere motiv; apare în istoric și în contul clientului, fără motivul intern", async ({
  page,
  browser,
}) => {
  await login(page, manager, "/admin/clienti/puncte");
  await page.goto(`/admin/clienti/puncte?q=${encodeURIComponent(member.email)}`);
  await page.getByRole("link", { name: /Deschide/ }).click();
  await expect(page).toHaveURL(new RegExp(memberPage));
  const form = page.locator("[data-adjust-form]");
  await form.getByRole("button", { name: "Aplică ajustarea" }).click();
  await expect(form.getByText("Scrie un număr întreg diferit de zero")).toBeVisible();
  await expect(form.getByText("Scrie motivul ajustării (cel puțin 3 caractere).")).toBeVisible();
  await form.getByLabel(/^Puncte/).fill("500");
  await form.getByLabel("Motivul").fill(`motiv intern ${tag}`);
  await form.getByRole("button", { name: "Aplică ajustarea" }).click();
  await expect(form.locator("[data-adjust-status]")).toHaveText(
    "Ajustarea a fost aplicată. Sold nou: 500.",
  );
  await expect(page.locator('[data-loyalty-row="adjust"]')).toContainText(`motiv intern ${tag}`);
  await expect(page.locator("[data-loyalty-balance]")).toHaveText("500");
  expect(await readE2eLoyaltyBalance(member.email)).toBe(500);
  // auditul: numere, fără email și fără textul motivului
  const dumps = (await readE2eLoyaltyAudit("loyalty.adjust")).join(" ");
  expect(dumps).toContain("balance");
  expect(dumps).not.toContain(member.email);
  expect(dumps).not.toContain(`motiv intern ${tag}`);

  const client = await (await browser.newContext()).newPage();
  await login(client, member, "/cont/puncte");
  await expect(client.locator("[data-points-total]")).toHaveText("500");
  await expect(client.locator('[data-points-row="adjust"]')).toContainText(
    "Ajustare făcută de magazin",
  );
  await expect(client.locator("[data-account-points]")).not.toContainText(`motiv intern ${tag}`);
  await client.context().close();
});

test("checkout: cursorul merge până la maxim, reducerea e o linie separată, cardul încasează totalul minus puncte", async ({
  page,
}) => {
  await login(page, member, "/cont");
  await addToCart(page, produs);
  await page.goto("/cos");
  await expect(page.locator("[data-cart-points]")).toContainText("Ai 500 de puncte");
  await toPayment(page, emailOf("card"));
  await expect(page.locator("[data-points-balance]")).toContainText("Ai 500 de puncte");
  await expect(page.locator("[data-summary-points]")).toHaveCount(0);
  await slider(page).press("End");
  // punctele nu acoperă transportul: maximul e valoarea produselor
  await expect(slider(page)).toHaveAttribute("max", "300");
  await expect(page.locator("[data-points-applied]")).toContainText("Folosești 300 de puncte");
  await expect(page.locator("[data-summary-points]")).toContainText("300,00");

  const number = await payAndPlace(page, "card");
  await demoScenario(page, "paid");
  await expect(paymentState(page)).toHaveAttribute("data-card-payment-state", "paid");
  const order = await readE2eOrder(number);
  expect(order!.shippingMinor).toBeGreaterThan(0);
  expect(order!.totalMinor).toBe(order!.shippingMinor);
  const payments = await readE2ePayments(number);
  expect(payments!.payments.map((payment) => payment.amountMinor)).toEqual([order!.totalMinor]);
  expect(await readE2eLoyaltyBalance(member.email)).toBe(200);
});

test("anularea unei comenzi cu puncte le întoarce în cont", async ({ page, browser }) => {
  await login(page, member, "/cont");
  await addToCart(page, produs);
  await toPayment(page, emailOf("anulare"));
  await slider(page).fill("100");
  await expect(page.locator("[data-points-applied]")).toContainText("Folosești 100 de puncte");
  await expect(page.locator("[data-summary-points]")).toContainText("100,00");
  const number = await payAndPlace(page, "bank_transfer");
  await expect(page.locator("[data-order-points-discount]")).toContainText("100,00");
  await expect(page.locator("[data-order-points]")).toContainText(
    "Ai folosit 100 de puncte la această comandă.",
  );
  expect(await readE2eLoyaltyBalance(member.email)).toBe(100);

  const admin = await (await browser.newContext()).newPage();
  const order = await readE2eOrder(number);
  await login(admin, manager, `/admin/comenzi/${order!.id}`);
  await admin.getByRole("button", { name: "Anulează comanda…" }).click();
  const dialog = admin.getByRole("dialog");
  await dialog.getByLabel("Motivul anulării").fill("Clientul s-a răzgândit");
  await dialog.getByRole("button", { name: "Anulează comanda" }).click();
  await expect(admin.getByText("Comanda a fost anulată.")).toBeVisible();
  await admin.context().close();
  expect(await readE2eLoyaltyBalance(member.email)).toBe(200);
});

test("comanda livrată (ridicată) apare în cont cu punctele în așteptare și data", async ({
  page,
  browser,
}) => {
  await login(page, member, "/cont");
  await addToCart(page, produs);
  await page.goto("/cos");
  await page.locator("main [data-checkout]").click();
  await step(page, "contact").getByLabel("Adresa de email").fill(emailOf("ridicare"));
  await step(page, "contact").getByLabel("Telefon").fill("0722 123 456");
  await page.locator('[data-continue="contact"]').click();
  const delivery = step(page, "delivery");
  await delivery.getByLabel("Nume și prenume").fill("Ion Popescu");
  await delivery.getByLabel("Județ").selectOption({ label: "Alba" });
  const locality = delivery.getByLabel("Localitate");
  await expect(locality).toBeEnabled();
  await expect(locality.locator("option")).not.toHaveCount(1);
  await locality.selectOption({ label: "Alba Iulia" });
  await delivery.getByLabel("Strada, numărul, blocul, apartamentul").fill("Str. Exemplu 1");
  await delivery.getByLabel("Cod poștal").fill("510005");
  await page.locator('[data-continue="delivery"]').click();
  await step(page, "shipping").locator('[data-offer="pickup"] input').check();
  await page.locator('[data-continue="shipping"]').click();
  await page.locator('[data-continue="billing"]').click();
  await expect(page.locator("[data-summary-points-note]")).toHaveText(
    "Primești 3 puncte la această comandă.",
  );
  const number = await payAndPlace(page, "bank_transfer");
  await expect(page.locator("[data-order-points]")).toContainText(
    "Primești 3 puncte după livrare, când se încheie termenul de retur.",
  );
  const order = await readE2eOrder(number);

  const admin = await (await browser.newContext()).newPage();
  await login(admin, manager, `/admin/comenzi/${order!.id}`);
  await admin.getByRole("button", { name: "Marchează plătit…" }).first().click();
  const dialog = admin.getByRole("dialog");
  await dialog
    .getByLabel("Suma primită (lei)")
    .fill((order!.totalMinor / 100).toFixed(2).replace(".", ","));
  await dialog.getByLabel("Referința din extras").fill("OP 15B");
  await dialog.getByRole("button", { name: "Marchează plătit" }).click();
  await expect(admin.getByText("Plata a fost înregistrată; comanda e confirmată.")).toBeVisible();
  await admin.locator("[data-pickup-button]").click();
  await expect(admin.locator("[data-pickup-button]")).toHaveCount(0);
  await admin.context().close();

  await page.goto("/cont/puncte");
  await expect(page.locator("[data-points-pending]")).toContainText(
    `Comanda ${number}: 3 puncte, disponibile din `,
  );
  // în așteptare nu înseamnă acordat: soldul nu s-a schimbat
  await expect(page.locator("[data-points-total]")).toHaveText("200");
});

test("fără tratament TVA stabilit nu există cursor și nici nota din coș", async ({ page }) => {
  await clearE2eSettings(["loyalty.vatMode"]);
  try {
    await login(page, member, "/cont");
    await addToCart(page, produs);
    await page.goto("/cos");
    await expect(page.locator("main [data-cart-line]").first()).toBeVisible();
    await expect(page.locator("[data-cart-points]")).toHaveCount(0);
    await toPayment(page, emailOf("fara-tva"));
    // metodele de plată apar doar după răspunsul serverului, deci absența cursorului e verificată pe răspunsul venit
    await expect(step(page, "payment").locator('[data-method="card"]')).toBeVisible();
    await expect(page.locator("[data-points-choice]")).toHaveCount(0);
  } finally {
    await setE2eSettings({ "loyalty.vatMode": "base_reduced" });
  }
});

test("Partenerul nu primește promisiuni de puncte în checkout", async ({ page }) => {
  await login(page, partner, "/cont");
  await addToCart(page, produs);
  await toPayment(page, emailOf("partener"));
  await expect(step(page, "payment").locator('[data-method="card"]')).toBeVisible();
  await expect(page.locator("[data-points-choice]")).toHaveCount(0);
  await expect(page.locator("[data-summary-points-note]")).toHaveCount(0);
});

test("setări: avertismentul despre contabil, mesaje în română și salvare", async ({ page }) => {
  await login(page, owner, "/admin/setari/puncte");
  await expect(page.locator("[data-vat-warning]")).toHaveText(
    "Cere confirmarea contabilului înainte de a o seta.",
  );
  const grace = page.getByLabel("Valabilitate minimă a punctelor întoarse (zile)");
  await grace.fill("999");
  await page.getByRole("button", { name: "Salvează" }).click();
  await expect(page.getByText("Scrie un număr întreg între 0 și 365.")).toBeVisible();
  await grace.fill("45");
  await page.getByRole("button", { name: "Salvează" }).click();
  await expect(page.getByText("Setările au fost salvate.")).toBeVisible();
  expect(await readE2eSetting("loyalty.releasedGraceDays")).toBe(45);
  expect(await readE2eSetting("loyalty.vatMode")).toBe("base_reduced");
});

test("permisiuni: Depozit nu vede nimic, Contabilul vede fără ajustare și descarcă CSV-ul", async ({
  page,
  browser,
}) => {
  await login(page, warehouse, "/admin");
  await expect(page.locator('a[href="/admin/clienti/puncte"]')).toHaveCount(0);
  for (const path of ["/admin/clienti/puncte", memberPage, "/admin/clienti/puncte/datorie"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/admin\/acces-interzis$/);
  }
  expect((await page.request.get("/api/admin/loyalty/debt")).status()).toBe(403);

  const reader = await (await browser.newContext()).newPage();
  await login(reader, accountant, memberPage);
  await expect(reader.locator("[data-loyalty-balance]")).toHaveText("200");
  await expect(reader.locator("[data-adjust-form]")).toHaveCount(0);
  await reader.goto("/admin/setari/puncte");
  await expect(reader).toHaveURL(/\/admin\/acces-interzis$/);
  await reader.goto("/admin/clienti/puncte/datorie");
  await expect(reader.locator('[data-debt-card="available"]')).toBeVisible();
  const csv = await reader.request.get("/api/admin/loyalty/debt");
  expect(csv.status()).toBe(200);
  const bytes = await csv.body();
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
  const text = bytes.subarray(2).toString("utf16le");
  expect(text).toContain("Luna expirării\tPuncte\tValoare (lei)");
  expect(text).toContain("În așteptare");
  expect(text).not.toContain(member.email);
  await reader.context().close();
});

test("flag-ul oprit ascunde meniul, rutele și mesajele din vitrină", async ({ page, browser }) => {
  await setE2eFeatureFlag("loyalty", false);
  try {
    const admin = await (await browser.newContext()).newPage();
    await login(admin, owner, "/admin/clienti");
    await expect(admin.locator('a[href="/admin/clienti/grupuri"]').first()).toBeVisible();
    await expect(admin.locator('a[href^="/admin/clienti/puncte"]')).toHaveCount(0);
    expect((await admin.goto("/admin/clienti/puncte"))?.status()).toBe(404);
    expect((await admin.goto("/admin/setari/puncte"))?.status()).toBe(404);
    expect((await admin.request.get("/api/admin/loyalty/debt")).status()).toBe(404);
    await admin.context().close();

    await login(page, member, "/cont");
    expect((await page.goto("/cont/puncte"))?.status()).toBe(404);
    await addToCart(page, produs);
    await expect(productNote(page)).toHaveCount(0);
    await toPayment(page, emailOf("oprit"));
    await expect(step(page, "payment").locator('[data-method="card"]')).toBeVisible();
    await expect(page.locator("[data-points-choice]")).toHaveCount(0);
  } finally {
    await setE2eFeatureFlag("loyalty", true);
  }
});

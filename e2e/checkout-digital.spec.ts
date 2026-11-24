import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  E2E_ORDER_EMAIL_DOMAIN,
  countE2eOrdersByEmail,
  readE2eOrder,
  removeE2eCarts,
  removeE2eOrders,
  removeE2eProducts,
  seedE2eCartProduct,
  seedE2eCheckoutSettings,
  seedE2eDigitalProduct,
  setE2eCartQuantity,
  ageE2eSessions,
  setE2eUserVerified,
  type E2eCartProduct,
  type E2eDigitalProduct,
} from "../packages/core/test/e2e-support";
import { createAccount, step, type Account } from "./support/card-flow";

/**
 * Checkout pentru produse digitale (Faza 14c), din browser: oaspetele cu un produs digital în coș e dus la autentificare și coșul îi
 * rămâne; contul cu emailul neverificat nu poate comanda; coșul 100% digital NU are pas de livrare, adresă de livrare, text despre
 * «nivelul solului» sau ramburs; bifa legală e separată de Termeni, nepre-bifată și obligatorie; accesul apare după «Marchează plătit»
 * (transfer) sau abia la livrare (ramburs mixt); un produs digital nu are selector de cantitate, iar un coș vechi cu 2 bucăți cere o
 * decizie. Fără card (nu atinge starea comună DEMO a specurilor de plăți); cardul DEMO e în pașii manuali de verificare și în
 * testele de integrare. Conturile au parole generate în test; comenzile se șterg pe tag, odată cu drepturile lor de acces.
 */
const tag = randomBytes(3).toString("hex");
const EMAIL = `digital-${tag}${E2E_ORDER_EMAIL_DOMAIN}`;
const MIXED_EMAIL = `mixt-${tag}${E2E_ORDER_EMAIL_DOMAIN}`;

test.describe.configure({ mode: "serial" });

let curs: E2eDigitalProduct; // 99,00 lei
let cursMixt: E2eDigitalProduct;
let cursVechi: E2eDigitalProduct;
let fizic: E2eCartProduct; // 199,00 lei
let client: Account;
let unverified: Account;
let admin: Account;

const CONSENT_TEXT =
  "Solicit livrarea imediată a conținutului digital și confirm că îmi pierd dreptul de retragere de 14 zile după începerea livrării.";

test.beforeAll(async ({ request, baseURL }) => {
  await seedE2eCheckoutSettings();
  curs = await seedE2eDigitalProduct(tag, "curs", { maxDownloads: null, price: 9_900 });
  cursMixt = await seedE2eDigitalProduct(tag, "mixt", { maxDownloads: null, price: 4_900 });
  cursVechi = await seedE2eDigitalProduct(tag, "vechi", { maxDownloads: null, price: 2_900 });
  fizic = await seedE2eCartProduct(tag, "fizic", { price: 19_900 });
  client = await createAccount(request, baseURL as string, "");
  unverified = await createAccount(request, baseURL as string, "");
  admin = await createAccount(request, baseURL as string, "owner");
});

test.afterAll(async () => {
  await removeE2eOrders({ tag });
  await removeE2eCarts();
  await removeE2eProducts();
});

const next = async (page: Page, id: string) => {
  await page.locator(`[data-continue="${id}"]`).click();
};

async function addToCart(page: Page, product: { slug: string }) {
  await page.goto(`/produs/${product.slug}`);
  await page.locator("[data-add-button]").click();
  await expect(page.locator("[data-cart-drawer] [data-cart-line]").first()).toBeVisible();
}

/** Autentificare pe pagina deschisă, cu întoarcere la adresa din `?next=` (coșul de oaspete se îmbină la intrare). */
async function signInHere(page: Page, account: Account, destination: string) {
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Parolă", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Intră în cont" }).click();
  await page.waitForURL((url) => url.pathname === destination);
}

async function loginTo(page: Page, account: Account, destination: string) {
  await page.goto(`/autentificare?next=${encodeURIComponent(destination)}`);
  await signInHere(page, account, destination.split("?")[0] as string);
}

async function fillAddress(page: Page, id: "delivery" | "billing") {
  const area = step(page, id);
  await expect(area.getByLabel("Nume și prenume")).toBeVisible();
  await area.getByLabel("Nume și prenume").fill("Ion Popescu");
  await area.getByLabel("Județ").selectOption({ label: "Alba" });
  const locality = area.getByLabel("Localitate");
  await expect(locality).toBeEnabled();
  await expect(locality.locator("option")).not.toHaveCount(1);
  await locality.selectOption({ label: "Alba Iulia" });
  await area.getByLabel("Strada, numărul, blocul, apartamentul").fill("Str. Exemplu 1, bl. A");
  await area.getByLabel("Cod poștal").fill("510005");
}

async function fillContact(page: Page, email: string) {
  await step(page, "contact").getByLabel("Adresa de email").fill(email);
  await step(page, "contact").getByLabel("Telefon").fill("0722 123 456");
  await next(page, "contact");
}

const stepIds = (page: Page) =>
  page.locator("[data-step]").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-step")));

test("oaspetele cu un produs digital: fără selector de cantitate, «Disponibil», e dus la autentificare, coșul îi rămâne", async ({
  page,
}) => {
  await page.goto(`/produs/${curs.slug}`);
  // maxim o bucată: nu există selector de cantitate, doar nota
  await expect(page.locator("[data-digital-once]")).toBeVisible();
  await expect(page.locator("[data-quantity-total]")).toHaveCount(0);
  const availability = page.locator("[data-availability]");
  await expect(availability).toContainText("Disponibil");
  await expect(availability).not.toContainText("În stoc");
  await expect(availability).not.toContainText("Stoc limitat");
  await expect(availability).not.toContainText("La comandă");

  await page.locator("[data-add-button]").click();
  await expect(page.locator("[data-cart-drawer] [data-cart-line]").first()).toBeVisible();
  await page.goto("/cos");
  const line = page.locator("[data-cart-line]").first();
  await expect(line).toContainText(curs.title);
  await expect(line).toContainText("Disponibil");
  await expect(line).not.toContainText("În stoc");
  await expect(line.getByLabel(/Cantitate pentru/)).toHaveCount(0);
  await expect(line.locator("[data-digital-once]")).toBeVisible();

  await page.locator("main [data-checkout]").click();
  await page.waitForURL(/\/autentificare\?next=%2Fcheckout$/);

  await signInHere(page, client, "/checkout");
  // coșul de oaspete s-a îmbinat în coșul contului: produsul e în sumar, iar formularul e deschis
  await expect(page.locator("[data-checkout-summary]")).toContainText(curs.title);
  await expect(page.locator("[data-checkout-form]")).toBeVisible();
});

test("contul cu emailul neverificat nu poate comanda produse digitale; poate cere din nou emailul de confirmare", async ({
  page,
}) => {
  await loginTo(page, unverified, "/cos");
  // contul se înregistrează verificat în teste; aici îi scoatem confirmarea, ca să fie un cont cu emailul neverificat
  await setE2eUserVerified(unverified.email, false);
  // sesiunea ține în cache starea veche (verificat): o ștergem, ca endpoint-ul de retrimitere să vadă contul neverificat
  await ageE2eSessions(unverified.email, 0);
  await addToCart(page, curs);
  await page.goto("/checkout");
  const notice = page.locator("[data-verify-email-notice]");
  await expect(notice).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 1, name: "Confirmă adresa de email" }),
  ).toBeVisible();
  await expect(page.locator("[data-checkout-form]")).toHaveCount(0);
  await notice.getByRole("button", { name: "Trimite din nou emailul de confirmare" }).click();
  await expect(page.locator('[data-verify-email-status="sent"]')).toBeVisible();
  await expect(page.locator("[data-verify-email-status]")).toContainText("Am trimis din nou");
});

test("coș 100% digital cu transfer bancar: fără livrare, fără ramburs, bifa legală obligatorie; accesul vine după «Marchează plătit»", async ({
  page,
  browser,
}) => {
  await seedE2eCheckoutSettings();
  await loginTo(page, client, "/cos");
  await page.goto("/cos");
  // produsul digital a rămas în coșul contului din primul test (coșul de oaspete s-a îmbinat la autentificare)
  await expect(page.locator("[data-cart-line]").first()).toContainText(curs.title);
  await page.locator("main [data-checkout]").click();
  await expect(page).toHaveURL(/\/checkout$/);

  // pași renumerotați: nicio adresă și nicio metodă de livrare
  expect(await stepIds(page)).toEqual(["contact", "billing", "payment", "review"]);
  await expect(page.locator('[data-step="delivery"]')).toHaveCount(0);
  await expect(page.locator('[data-step="shipping"]')).toHaveCount(0);
  await expect(page.locator("[data-ground-notice]")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("la nivelul solului");
  await expect(page.locator("[data-summary-shipping]")).toHaveCount(0);

  await fillContact(page, EMAIL);
  await expect(step(page, "billing").locator("[data-digital-billing-lede]")).toBeVisible();
  await fillAddress(page, "billing");
  await next(page, "billing");

  // fără ramburs; transferul e disponibil, cu regula accesului
  await expect(step(page, "payment").locator('[data-method="bank_transfer"]')).toBeVisible();
  await expect(step(page, "payment").locator('[data-method="cod"]')).toHaveCount(0);
  await step(page, "payment").locator('[data-method="bank_transfer"] input').check();
  await expect(step(page, "payment").locator("[data-digital-access-note]")).toContainText(
    "după ce confirmăm plata",
  );
  await next(page, "payment");

  // bifa legală: separată de Termeni, cu textul exact, nepre-bifată
  const digitalConsent = page.getByRole("checkbox", { name: /Solicit livrarea imediată/ });
  const terms = page.getByRole("checkbox", { name: /Am citit și sunt de acord/ });
  await expect(digitalConsent).toBeVisible();
  await expect(digitalConsent).not.toBeChecked();
  await expect(terms).not.toBeChecked();
  await expect(page.locator("[data-digital-consent-text]")).toHaveText(CONSENT_TEXT);

  // fără bifa legală, doar cu Termenii: nu se plasează, cu mesaj în română
  await terms.check();
  await page.locator("[data-checkout-submit]").click();
  await expect(page.getByRole("alert").filter({ hasText: "livrare imediată" })).toBeVisible();
  await expect(page).toHaveURL(/\/checkout$/);
  expect(await countE2eOrdersByEmail(EMAIL)).toBe(0);

  await digitalConsent.check();
  await page.locator("[data-checkout-submit]").click();
  await expect(page).toHaveURL(/\/comanda\/confirmare$/);
  const number = ((await page.locator("[data-order-number]").innerText()).match(/E2E-\d{6}/) ??
    [])[0] as string;
  expect(number).toBeTruthy();

  // confirmarea spune când și unde apare accesul
  const access = page.locator('[data-digital-access="pending"]');
  await expect(access).toBeVisible();
  await expect(access).toContainText("imediat ce plata e confirmată");
  await expect(access.locator("[data-digital-library-link]")).toHaveAttribute(
    "href",
    "/cont/produsele-mele",
  );
  await expect(access.locator("[data-digital-consent-saved]")).toContainText(CONSENT_TEXT);

  const order = await readE2eOrder(number);
  expect(order).toMatchObject({
    paymentMethod: "bank_transfer",
    shippingMethodCode: "digital",
    shippingMinor: 0,
    codFeeMinor: 0,
    subtotalMinor: 9_900,
    totalMinor: 9_900,
    digitalConsentText: CONSENT_TEXT,
    status: "pending",
    fulfillmentStatus: "unfulfilled",
  });
  expect(order?.customerId).not.toBeNull();
  expect(order?.digitalConsentAt).not.toBeNull();
  expect(order?.addresses.map((address) => address.kind)).toEqual(["billing"]);
  expect(order?.lines.map((line) => line.isDigital)).toEqual([true]);
  expect(order?.stockCommitments).toBe(0);
  expect(order?.stockReservations).toBe(0);

  // înainte de plată: în așteptarea plății
  await page.goto("/cont/produsele-mele");
  await expect(page.locator("[data-digital-pending] li").first()).toContainText(
    "În așteptarea plății",
  );
  await expect(page.locator("[data-digital-items] li")).toHaveCount(0);

  // adminul marchează plata; accesul apare, iar comanda se încheie fără expediere
  const adminPage = await (await browser.newContext()).newPage();
  await loginTo(adminPage, admin, `/admin/comenzi/${order?.id}`);
  await expect(adminPage.locator("[data-order-detail]")).toContainText(number);
  await adminPage.getByRole("button", { name: "Marchează plătit…" }).first().click();
  const dialog = adminPage.getByRole("dialog");
  await dialog.getByLabel("Suma primită (lei)").fill("99,00");
  await dialog.getByLabel("Referința din extras").fill("OP 24680");
  await dialog.getByRole("button", { name: "Marchează plătit" }).click();
  await expect(
    adminPage.getByText("Plata a fost înregistrată; comanda e confirmată."),
  ).toBeVisible();
  // comanda 100% digitală nu apare în «gata de expediere» (admin) și nu are buton de AWB
  await adminPage.goto("/admin/comenzi/expedieri");
  await expect(adminPage.locator("main")).not.toContainText(number);
  await adminPage.context().close();

  await page.goto("/cont/produsele-mele");
  await expect(page.locator("[data-digital-items] li")).toHaveCount(1);
  await expect(page.locator("[data-digital-items] li").first()).toContainText(curs.title);
  const after = await readE2eOrder(number);
  expect(after).toMatchObject({ paymentStatus: "paid", fulfillmentStatus: "fulfilled" });
  expect(after?.events).toContain("digital.granted");
});

test("coș mixt cu ramburs: pas de livrare și «la nivelul solului» pentru partea fizică, transport doar pe fizic, accesul digital abia la livrare", async ({
  page,
}) => {
  await loginTo(page, client, "/cos");
  await page.goto("/cos");
  await addToCart(page, cursMixt);
  await addToCart(page, fizic);
  await page.goto("/cos");
  await page.locator("main [data-checkout]").click();
  await expect(page).toHaveURL(/\/checkout$/);
  expect(await stepIds(page)).toEqual([
    "contact",
    "delivery",
    "shipping",
    "billing",
    "payment",
    "review",
  ]);
  await fillContact(page, MIXED_EMAIL);
  await fillAddress(page, "delivery");
  await next(page, "delivery");
  await expect(step(page, "shipping").locator('[data-offer="demo:courier"]')).toBeVisible();
  // ridicarea personală (dacă e activă și mai ieftină) se alege implicit, iar mesajul despre sol nu se arată la ridicare: alegem curierul
  await step(page, "shipping").locator('[data-offer="demo:courier"] input').check();
  await expect(step(page, "shipping").locator("[data-ground-notice]")).toBeVisible();
  // transportul DEMO al unui colet de 1 kg, nu al cursului digital
  await expect(step(page, "shipping").locator('[data-offer="demo:courier"]')).toContainText(
    "25,00",
  );
  await next(page, "shipping");
  await next(page, "billing");

  await expect(step(page, "payment").locator('[data-method="cod"]')).toBeVisible();
  await step(page, "payment").locator('[data-method="cod"] input').check();
  await expect(step(page, "payment").locator('[data-digital-access-note="cod"]')).toContainText(
    "livrarea confirmată",
  );
  await next(page, "payment");
  await page.getByRole("checkbox", { name: /Solicit livrarea imediată/ }).check();
  await page.getByRole("checkbox", { name: /Am citit și sunt de acord/ }).check();
  await page.locator("[data-checkout-submit]").click();
  await expect(page).toHaveURL(/\/comanda\/confirmare$/);
  const number = ((await page.locator("[data-order-number]").innerText()).match(/E2E-\d{6}/) ??
    [])[0] as string;
  const access = page.locator('[data-digital-access="pending"]');
  await expect(access).toContainText("după livrarea confirmată");

  const order = await readE2eOrder(number);
  expect(order).toMatchObject({
    paymentMethod: "cod",
    status: "confirmed",
    fulfillmentStatus: "unfulfilled",
    shippingMethodCode: "demo:courier",
    subtotalMinor: 24_800,
  });
  expect(order?.shippingMinor).toBeGreaterThan(0);
  expect(order?.addresses.map((address) => address.kind).sort()).toEqual(["billing", "shipping"]);
  expect(order?.lines.map((line) => line.isDigital).sort()).toEqual([false, true]);
  // stoc negestionat: fără angajări pentru niciuna dintre linii
  expect(order?.stockReservations).toBe(0);

  await page.goto("/cont/produsele-mele");
  await expect(page.locator("[data-digital-pending]")).toContainText("În așteptarea livrării");
  await expect(page.locator("[data-digital-pending]")).toContainText(number);
});

test("un coș vechi cu 2 bucăți digitale cere o decizie: nu se modifică în tăcere, checkout-ul e blocat până alegi", async ({
  page,
}) => {
  await loginTo(page, client, "/cos");
  await page.goto("/cos");
  // coșul contului e gol (comenzile anterioare l-au golit): adaugă produsul digital și simulează un coș de dinainte de regulă
  await expect(page.locator("[data-cart-empty]").first()).toBeVisible();
  await addToCart(page, cursVechi);
  expect(await setE2eCartQuantity(client.email, cursVechi.variantId, 20_000n)).toBe(1);
  await page.goto("/cos");
  const issue = page.locator('[data-cart-issue="digital_quantity"]');
  await expect(issue).toBeVisible();
  await expect(issue).toContainText("se cumpără o singură dată");
  await expect(page.locator("[data-line-quantity]").first()).toContainText("2");
  // coșul nu poate trece la checkout cât decizia e nepusă
  await page.goto("/checkout");
  await expect(page.locator("[data-checkout-blocked]")).toBeVisible();

  await page.goto("/cos");
  await issue.getByRole("button", { name: "Păstrează 1 bucată" }).click();
  await expect(page.locator('[data-cart-issue="digital_quantity"]')).toHaveCount(0);
  await expect(page.locator("[data-line-quantity]").first()).toContainText("1");
  await page.goto("/checkout");
  await expect(page.locator("[data-checkout-form]")).toBeVisible();
});

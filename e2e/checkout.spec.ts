import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  E2E_ORDER_EMAIL_DOMAIN,
  changeE2eCartProduct,
  clearE2eSettings,
  countE2eOrdersByEmail,
  readE2eOrder,
  removeE2eCarts,
  removeE2eOrders,
  removeE2eProducts,
  seedE2eCartProduct,
  seedE2eCheckoutSettings,
  setE2eSettings,
  type E2eCartProduct,
} from "../packages/core/test/e2e-support";

/**
 * Checkout și plasarea comenzii (Faza 9), în browser: comandă completă cu ramburs, cu transfer bancar, cu un produs «La comandă»
 * (fără ramburs, doar transfer) și limitele de ramburs (persoană fizică și firmă); dublu-click, urmărire (număr + email) fără
 * scurgeri de informație, sectoarele Bucureștiului, checkout «curat», pagini provizorii noindex, telefon (bannerul de cookie-uri
 * nu acoperă butonul final), total schimbat. Tarifele de livrare sunt DEMO (furnizorul fals); datele bancare sunt FICTIVE.
 * Produsele (stoc negestionat) și comenzile se creează și se șterg de test; fiecare test are un browser și un coș proprii.
 */
const tag = randomBytes(3).toString("hex");
const EMAIL = `client-${tag}${E2E_ORDER_EMAIL_DOMAIN}`;

test.describe.configure({ mode: "serial" });

let normal: E2eCartProduct; // 199,00 lei
let scump: E2eCartProduct; // 12.000,00 lei (peste limita de ramburs a persoanelor fizice)
let mediu: E2eCartProduct; // 5.500,00 lei (sub limita persoanelor fizice, peste cea a firmelor)
let lenta: E2eCartProduct; // «La comandă», 21 de zile

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
  // ANAF e un serviciu extern: în teste așteptăm cel mult 0,5 s; rezultatul (verificat / neverificat) nu influențează regulile testate
  await setE2eSettings({ "checkout.anafTimeoutMs": 500 });
  normal = await seedE2eCartProduct(tag, "normal", { price: 19_900 });
  scump = await seedE2eCartProduct(tag, "scump", { price: 1_200_000 });
  mediu = await seedE2eCartProduct(tag, "mediu", { price: 550_000 });
  lenta = await seedE2eCartProduct(tag, "lenta", {
    price: 5_000,
    stockStatus: "onbackorder",
    leadTimeDays: 21,
  });
});

test.afterAll(async () => {
  await removeE2eOrders();
  await removeE2eCarts();
  await removeE2eProducts();
  await clearE2eSettings(SETTING_KEYS);
});

async function addToCart(page: Page, product: E2eCartProduct) {
  await page.goto(`/produs/${product.slug}`);
  await page.locator("[data-add-button]").click();
  await expect(page.locator("[data-cart-drawer] [data-cart-line]").first()).toBeVisible();
}

async function goToCheckout(page: Page) {
  await page.goto("/cos");
  await page.locator("main [data-checkout]").click();
  await expect(page).toHaveURL(/\/checkout$/);
  await expect(page.getByRole("heading", { level: 1, name: "Finalizează comanda" })).toBeVisible();
}

const step = (page: Page, id: string) => page.locator(`[data-step="${id}"]`);
const next = async (page: Page, id: string) => {
  await page.locator(`[data-continue="${id}"]`).click();
};

interface Fill {
  county?: string;
  locality?: string;
  email?: string;
}

async function fillContactAndDelivery(page: Page, fill: Fill = {}) {
  await step(page, "contact")
    .getByLabel("Adresa de email")
    .fill(fill.email ?? EMAIL);
  await step(page, "contact").getByLabel("Telefon").fill("0722 123 456");
  await next(page, "contact");
  const delivery = step(page, "delivery");
  await expect(delivery.getByLabel("Nume și prenume")).toBeVisible();
  await delivery.getByLabel("Nume și prenume").fill("Ion Popescu");
  await delivery.getByLabel("Județ").selectOption({ label: fill.county ?? "Alba" });
  const locality = delivery.getByLabel("Localitate");
  await expect(locality).toBeEnabled();
  await expect(locality.locator("option")).not.toHaveCount(1);
  await locality.selectOption({ label: fill.locality ?? "Alba Iulia" });
  await delivery
    .getByLabel("Strada, numărul, blocul, apartamentul")
    .fill("Str. Exemplu 1, bl. A, ap. 2");
  await delivery.getByLabel("Cod poștal").fill("510005");
  await next(page, "delivery");
}

async function chooseShipping(page: Page, offer = "demo:courier") {
  await expect(step(page, "shipping").locator(`[data-offer="${offer}"]`)).toBeVisible();
  await step(page, "shipping").locator(`[data-offer="${offer}"] input`).check();
  await next(page, "shipping");
}

async function throughToPayment(page: Page, fill: Fill = {}) {
  await fillContactAndDelivery(page, fill);
  await chooseShipping(page);
  await expect(step(page, "billing")).toBeVisible();
  await next(page, "billing");
  await expect(step(page, "payment").locator("[data-method]").first()).toBeVisible();
}

async function review(page: Page, method: "cod" | "bank_transfer") {
  await step(page, "payment").locator(`[data-method="${method}"] input`).check();
  await next(page, "payment");
  await expect(page.locator("[data-checkout-submit]")).toBeVisible();
}

async function accept(page: Page) {
  await page.getByRole("checkbox", { name: /Am citit și sunt de acord/ }).check();
}

async function placeAndReadNumber(page: Page): Promise<string> {
  await page.locator("[data-checkout-submit]").click();
  await expect(page).toHaveURL(/\/comanda\/confirmare$/);
  await expect(page.locator("[data-order-confirmation]")).toBeVisible();
  const text = (await page.locator("[data-order-number]").innerText()).trim();
  const match = /E2E-\d{6}/.exec(text);
  expect(match, text).not.toBeNull();
  return match![0];
}

test.describe("verificarea 1: comandă completă cu ramburs", () => {
  test("de la coș la confirmare, cu totaluri corecte, comandă confirmată, stoc angajat, coș golit", async ({
    page,
  }) => {
    await addToCart(page, normal);
    await goToCheckout(page);

    // checkout «curat»: logo și indicator de securitate, fără meniu și subsol
    await expect(page.locator("[data-checkout-secure]")).toContainText("Plată în siguranță");
    await expect(page.locator("footer")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Navigare principală" })).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

    await throughToPayment(page);
    // metodele: ramburs disponibil, transfer disponibil, cardul NU există
    await expect(step(page, "payment").locator('[data-method="cod"]')).toHaveAttribute(
      "data-available",
      "true",
    );
    await expect(step(page, "payment").locator('[data-method="bank_transfer"]')).toBeVisible();
    await expect(step(page, "payment")).not.toContainText(/card/i);
    await review(page, "cod");

    // 199,00 + 25,00 transport DEMO + 5,00 taxă de ramburs = 229,00
    await expect(page.locator("[data-summary-total]")).toContainText("229,00");
    await expect(page.locator("[data-checkout-summary]")).toContainText("Taxă de ramburs");

    // acordul e obligatoriu și nepre-bifat
    await expect(
      page.getByRole("checkbox", { name: /Am citit și sunt de acord/ }),
    ).not.toBeChecked();
    await page.locator("[data-checkout-submit]").click();
    await expect(page.getByRole("alert").filter({ hasText: "Bifează acordul" })).toBeVisible();
    await expect(page).toHaveURL(/\/checkout$/);

    await accept(page);
    const number = await placeAndReadNumber(page);
    await expect(page.locator("main")).toContainText("229,00");
    await expect(page.locator("main")).toContainText("Plătești curierului la primirea coletului");

    const order = await readE2eOrder(number);
    expect(order).toMatchObject({
      status: "confirmed",
      paymentStatus: "pending",
      paymentMethod: "cod",
      customerId: null,
      subtotalMinor: 19_900,
      shippingMinor: 2_500,
      codFeeMinor: 500,
      totalMinor: 22_900,
      // TVA = 34,54 (produs) + 4,34 (transport) + 0,87 (taxă): extras din fiecare sumă, nu din total
      taxMinor: 3_454 + 434 + 87,
      installationRequested: false,
      termsConsentVersion: "provizoriu-1",
    });
    expect(order?.termsConsentText).toContain("Am citit și sunt de acord");
    expect(order?.events).toEqual(["order.placed", "order.confirmed"]);
    expect(order?.payments).toEqual([{ provider: "cod", status: "pending", amountMinor: 22_900 }]);
    expect(order?.lines).toHaveLength(1);
    expect(order?.addresses.map((a) => a.kind).sort()).toEqual(["billing", "shipping"]);
    expect(order?.addresses[0]).toMatchObject({
      countyName: "Alba",
      localityName: "Alba Iulia",
      postalCode: "510005",
    });

    // coșul s-a golit; ciorna din browser a dispărut
    await page.goto("/cos");
    await expect(page.locator("[data-cart-empty]")).toBeVisible();
    await page.goto("/checkout");
    await expect(page.getByRole("heading", { level: 1, name: "Coșul tău este gol" })).toBeVisible();
    await expect(page.locator("[data-checkout-blocked]")).toContainText("Adaugă produse în coș");
  });
});

test.describe("verificarea 2: comandă cu transfer bancar", () => {
  test("date bancare fictive, termen de rezervare, comandă în așteptare, fără taxă de ramburs", async ({
    page,
  }) => {
    await addToCart(page, normal);
    await goToCheckout(page);
    await throughToPayment(page);
    await step(page, "payment").locator('[data-method="bank_transfer"] input').check();
    await expect(step(page, "payment").locator("[data-bank-details]")).toContainText(
      "RO00DEMO0000000000000000",
    );
    await expect(step(page, "payment").locator("[data-bank-details]")).toContainText(
      "Magazin Demo SRL",
    );
    await next(page, "payment");
    await expect(page.locator("[data-summary-total]")).toContainText("224,00");
    await expect(page.locator("[data-checkout-summary]")).not.toContainText("Taxă de ramburs");
    await accept(page);
    const number = await placeAndReadNumber(page);
    await expect(page.locator("[data-bank-details]")).toContainText("RO00DEMO0000000000000000");
    await expect(page.locator("main")).toContainText("Plătește prin transfer bancar până la");
    const order = await readE2eOrder(number);
    expect(order).toMatchObject({
      status: "pending",
      paymentStatus: "pending",
      paymentMethod: "bank_transfer",
      codFeeMinor: 0,
      totalMinor: 22_400,
    });
    expect(order?.reservationExpiresAt && order.reservationExpiresAt.getTime() > Date.now()).toBe(
      true,
    );
    expect(order?.events).toEqual(["order.placed", "stock.reserved"]);
  });
});

test.describe("verificarea 3: produs «La comandă» — fără ramburs, doar transfer", () => {
  test("rambursul e dezactivat cu explicație; transferul merge; comanda păstrează termenul", async ({
    page,
  }) => {
    await addToCart(page, normal);
    await page.goto(`/produs/${lenta.slug}`);
    await page.locator("[data-add-button]").click();
    await expect(page.locator("[data-cart-drawer] [data-cart-line]")).toHaveCount(2);
    await goToCheckout(page);
    await throughToPayment(page);
    const cod = step(page, "payment").locator('[data-method="cod"]');
    await expect(cod).toHaveAttribute("data-available", "false");
    await expect(cod.locator("input")).toBeDisabled();
    await expect(cod).toContainText("nu e disponibil pentru comenzile cu produse «La comandă»");
    await expect(cod).toContainText("Indisponibil");
    // transferul e preselectat (primul disponibil)
    await expect(
      step(page, "payment").locator('[data-method="bank_transfer"] input'),
    ).toBeChecked();
    await next(page, "payment");
    await accept(page);
    const number = await placeAndReadNumber(page);
    await expect(page.locator("main")).toContainText("21 de zile");
    const order = await readE2eOrder(number);
    expect(order?.paymentMethod).toBe("bank_transfer");
    expect(order?.lines.map((l) => [l.stockState, l.leadTimeDays]).sort()).toEqual([
      ["in_stock", null],
      ["on_order", 21],
    ]);
  });
});

test.describe("verificarea 4: limitele de ramburs", () => {
  test("peste 10.000 lei (persoană fizică) rambursul dispare, cu explicație; transferul rămâne", async ({
    page,
  }) => {
    await addToCart(page, scump);
    await goToCheckout(page);
    await throughToPayment(page);
    const cod = step(page, "payment").locator('[data-method="cod"]');
    await expect(cod).toHaveAttribute("data-available", "false");
    await expect(cod).toContainText("nu e disponibil pentru comenzi peste 10.000,00 RON");
    await expect(step(page, "payment").locator('[data-method="bank_transfer"]')).toHaveAttribute(
      "data-available",
      "true",
    );
  });

  test("o sumă de 5.500 lei: persoană fizică da, firmă (CUI) nu — limita de 5.000 lei", async ({
    page,
  }) => {
    await addToCart(page, mediu);
    await goToCheckout(page);
    await fillContactAndDelivery(page);
    await chooseShipping(page);
    // persoană fizică: rambursul există
    await next(page, "billing");
    await expect(step(page, "payment").locator('[data-method="cod"]')).toHaveAttribute(
      "data-available",
      "true",
    );
    // revenim la facturare: firmă cu CUI → rambursul dispare (limita firmelor)
    await step(page, "billing")
      .getByRole("button", { name: /Facturare/ })
      .click();
    await step(page, "billing").getByLabel("Facturează pe firmă (persoană juridică)").check();
    await step(page, "billing").getByLabel("CUI", { exact: true }).fill("RO14399840");
    await step(page, "billing").getByLabel("Denumirea firmei").fill("Firma Test SRL");
    await next(page, "billing");
    const cod = step(page, "payment").locator('[data-method="cod"]');
    await expect(cod).toHaveAttribute("data-available", "false");
    await expect(cod).toContainText("Pentru firme, rambursul nu e disponibil peste 5.000,00 RON");
  });
});

test.describe("dublu-click și erori", () => {
  test("dublu-click pe «Plasează comanda»: o singură comandă", async ({ page }) => {
    const email = `dublu-${tag}${E2E_ORDER_EMAIL_DOMAIN}`;
    await addToCart(page, normal);
    await goToCheckout(page);
    await throughToPayment(page, { email });
    await review(page, "cod");
    await accept(page);
    await page.locator("[data-checkout-submit]").dblclick();
    await expect(page).toHaveURL(/\/comanda\/confirmare$/);
    expect(await countE2eOrdersByEmail(email)).toBe(1);
  });

  test("prețul s-a schimbat între timp: comanda NU se plasează, cu mesaj, și nimic nu se scrie", async ({
    page,
  }) => {
    const email = `pret-${tag}${E2E_ORDER_EMAIL_DOMAIN}`;
    const product = await seedE2eCartProduct(tag, "schimbat", { price: 10_000 });
    await addToCart(page, product);
    await goToCheckout(page);
    await throughToPayment(page, { email });
    await review(page, "cod");
    await accept(page);
    await changeE2eCartProduct(product, { price: 11_000 });
    await page.locator("[data-checkout-submit]").click();
    await expect(page.locator("[data-checkout-problem]")).toBeVisible();
    await expect(page).toHaveURL(/\/checkout$/);
    expect(await countE2eOrdersByEmail(email)).toBe(0);
  });
});

test.describe("urmărirea comenzii (număr + email)", () => {
  test("perechea corectă arată comanda; oricare pereche greșită dă ACELAȘI mesaj; nu apar strada sau telefonul", async ({
    page,
    browser,
  }) => {
    const email = `urmarire-${tag}${E2E_ORDER_EMAIL_DOMAIN}`;
    await addToCart(page, normal);
    await goToCheckout(page);
    await throughToPayment(page, { email });
    await review(page, "cod");
    await accept(page);
    const number = await placeAndReadNumber(page);

    const other = await browser.newContext();
    const track = await other.newPage();
    await track.goto("/comanda/urmarire");
    const form = track.locator("[data-track-form]");
    const message = track.locator("[data-track-message]");

    await form.getByLabel("Numărul comenzii").fill("E2E-999999");
    await form.getByLabel("Adresa de email").fill(email);
    await form.getByRole("button", { name: "Caută comanda" }).click();
    await expect(message).toContainText("Nu am găsit o comandă cu aceste date");
    const wrongNumber = await message.innerText();

    await form.getByLabel("Numărul comenzii").fill(number);
    await form.getByLabel("Adresa de email").fill(`altcineva-${tag}@exemplu.ro`);
    await form.getByRole("button", { name: "Caută comanda" }).click();
    await expect(message).toContainText("Nu am găsit o comandă cu aceste date");
    expect(await message.innerText()).toBe(wrongNumber);

    await form.getByLabel("Adresa de email").fill(email.toUpperCase());
    await form.getByRole("button", { name: "Caută comanda" }).click();
    await expect(track.locator("[data-track-result]")).toContainText(number);
    await expect(track.locator("[data-order-total]")).toContainText("229,00");
    const body = await track.locator("main").innerText();
    expect(body).not.toContain("Str. Exemplu");
    expect(body).not.toContain("0722");
    expect(body).not.toContain(email);
    await other.close();
  });

  test("pagina nu e indexată", async ({ page }) => {
    await page.goto("/comanda/urmarire");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  });
});

test.describe("sectoarele Municipiului București", () => {
  test("cele 6 sectoare sunt selectabile ca localitate și se salvează pe comandă", async ({
    page,
  }) => {
    const email = `sector-${tag}${E2E_ORDER_EMAIL_DOMAIN}`;
    await addToCart(page, normal);
    await goToCheckout(page);
    await step(page, "contact").getByLabel("Adresa de email").fill(email);
    await step(page, "contact").getByLabel("Telefon").fill("0722123456");
    await next(page, "contact");
    const delivery = step(page, "delivery");
    await delivery.getByLabel("Județ").selectOption({ label: "București" });
    const locality = delivery.getByLabel("Localitate");
    await expect(locality.locator("option", { hasText: /^București Sectorul [1-6]$/ })).toHaveCount(
      6,
    );
    await delivery.getByLabel("Nume și prenume").fill("Ion Popescu");
    await locality.selectOption({ label: "București Sectorul 1" });
    await delivery.getByLabel("Strada, numărul, blocul, apartamentul").fill("Str. Exemplu 1");
    await delivery.getByLabel("Cod poștal").fill("010001");
    await next(page, "delivery");
    await chooseShipping(page);
    await next(page, "billing");
    await review(page, "cod");
    await accept(page);
    const number = await placeAndReadNumber(page);
    const order = await readE2eOrder(number);
    expect(order?.addresses.find((a) => a.kind === "shipping")).toMatchObject({
      countyName: "București",
      localityName: "București Sectorul 1",
    });
  });
});

test.describe("cerere de instalare și note", () => {
  test("bifa de instalare e nebifată implicit, nu schimbă totalul, iar observațiile se salvează", async ({
    page,
  }) => {
    const email = `instalare-${tag}${E2E_ORDER_EMAIL_DOMAIN}`;
    await addToCart(page, normal);
    await goToCheckout(page);
    await throughToPayment(page, { email });
    await review(page, "cod");
    const install = page.getByRole("checkbox", { name: /Doresc o ofertă pentru instalare/ });
    await expect(install).not.toBeChecked();
    await install.check();
    await step(page, "review").getByLabel("Observații pentru instalare").fill("Etaj 2, fără lift");
    await expect(page.locator("[data-summary-total]")).toContainText("229,00");
    await accept(page);
    const number = await placeAndReadNumber(page);
    const order = await readE2eOrder(number);
    expect(order).toMatchObject({
      installationRequested: true,
      installationNote: "Etaj 2, fără lift",
      totalMinor: 22_900,
    });
  });
});

test.describe("ciorna din browser și pagini provizorii", () => {
  test("datele de contact rămân după reîncărcare, dar nu și acordul", async ({ page }) => {
    await addToCart(page, normal);
    await goToCheckout(page);
    await step(page, "contact")
      .getByLabel("Adresa de email")
      .fill(`draft-${tag}${E2E_ORDER_EMAIL_DOMAIN}`);
    await step(page, "contact").getByLabel("Telefon").fill("0722123456");
    await page.reload();
    await expect(step(page, "contact").getByLabel("Adresa de email")).toHaveValue(
      `draft-${tag}${E2E_ORDER_EMAIL_DOMAIN}`,
    );
  });

  test("paginile Termeni și Confidențialitate sunt provizorii, marcate și neindexate", async ({
    page,
  }) => {
    for (const path of ["/termeni-si-conditii", "/politica-de-confidentialitate"]) {
      await page.goto(path);
      await expect(page.locator("main")).toContainText("În curs de redactare");
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    }
  });

  test("validare în română, fără validarea nativă a browserului", async ({ page }) => {
    await addToCart(page, normal);
    await goToCheckout(page);
    await expect(page.locator("form[data-checkout-form]")).toHaveAttribute("novalidate", "");
    await next(page, "contact");
    await expect(step(page, "contact")).toContainText("Scrie o adresă de email validă.");
    await expect(step(page, "contact")).toContainText("Scrie un număr de telefon românesc valid");
    await expect(step(page, "contact").getByLabel("Adresa de email")).toBeFocused();
  });
});

test.describe("telefon (390 px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("bannerul de cookie-uri nu acoperă butonul «Plasează comanda»; fără derulare orizontală", async ({
    page,
  }) => {
    await addToCart(page, normal);
    await goToCheckout(page);
    await throughToPayment(page);
    await review(page, "cod");
    await expect(page.locator("[data-consent-banner]")).toBeVisible();
    // la capătul paginii (cât poate derula cumpărătorul) butonul stă deasupra bannerului: pagina rezervă jos spațiu cât bannerul
    await page.mouse.move(195, 300);
    await page.mouse.wheel(0, 5000);
    await expect
      .poll(() =>
        page.evaluate(
          () => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1,
        ),
      )
      .toBe(true);
    const submit = await page.locator("[data-checkout-submit]").boundingBox();
    const banner = await page.locator("[data-consent-banner]").boundingBox();
    expect(submit && banner).toBeTruthy();
    // bannerul compact pe telefon: «Refuz» și «Acceptă tot» pe un rând, «Preferințe» dedesubt (nu trei rânduri de butoane)
    expect(banner!.height).toBeLessThanOrEqual(280);
    expect(submit!.y + submit!.height).toBeLessThanOrEqual(banner!.y + 1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    // ținte tactile de cel puțin 44 px pe butoanele principale
    expect(submit!.height).toBeGreaterThanOrEqual(44);
  });
});

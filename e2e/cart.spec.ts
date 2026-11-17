import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  changeE2eCartProduct,
  countE2eCartLines,
  linkE2eProducts,
  promoteE2eUser,
  removeE2eCarts,
  removeE2eProducts,
  removeE2eUnits,
  seedE2eCartProduct,
  seedE2eUnit,
  type E2eCartProduct,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Coșul (Faza 8), în browser: adăugare din pagina de produs, selector în PAȘI (pasul exact, validat pe server), sertar și `/cos`,
 * coș mixt, produs devenit indisponibil, preț schimbat, îmbinare la autentificare, cross-sell, piese de schimb, finalizare
 * dezactivată, fără câmp de cupon, fără reduceri afișate, telefon. Produsele sunt create de test (stoc negestionat) și șterse la
 * final; fiecare test rulează într-un context de browser propriu, deci cu un coș de oaspete propriu.
 */
const tag = randomBytes(3).toString("hex");
const unitCode = `e2e${tag}mp`;

// Un singur worker pentru tot fișierul: produsele de probă se creează o dată (`beforeAll` rulează pe worker).
test.describe.configure({ mode: "serial" });

let bucati: E2eCartProduct; // 199,00 lei / buc
let mozaic: E2eCartProduct; // 123,45 lei / mp, cutie de 2,03 mp
let bisulfat: E2eCartProduct; // 120,00 lei / sac de 25 kg (preț pe pas)
let lenta: E2eCartProduct; // «La comandă», 21 de zile
let rapida: E2eCartProduct; // «La comandă», 5 zile
let accesoriu: E2eCartProduct; // cross-sell pentru `bucati`
let ciorna: E2eCartProduct; // draft, legat cross-sell: nu se arată
let piesa: E2eCartProduct; // piesă de schimb pentru `bucati`
let redus: E2eCartProduct; // promoție activă, dar «reducerile» sunt oprite

test.beforeAll(async () => {
  await seedE2eUnit({ code: unitCode, name: `Metru pătrat ${tag}`, symbol: "mp", decimals: 4 });
  await seedE2eUnit({ code: `e2e${tag}kg`, name: `Kilogram ${tag}`, symbol: "kg", decimals: 4 });
  bucati = await seedE2eCartProduct(tag, "bucati", { price: 19900 });
  mozaic = await seedE2eCartProduct(tag, "mozaic", {
    price: 12345,
    unitCode,
    saleStep: 20300,
    saleStepLabel: "cutie",
  });
  bisulfat = await seedE2eCartProduct(tag, "bisulfat", {
    price: 12000,
    unitCode: `e2e${tag}kg`,
    saleStep: 250000,
    saleStepLabel: "sac",
    priceBasis: "step",
  });
  lenta = await seedE2eCartProduct(tag, "lenta", {
    price: 5000,
    stockStatus: "onbackorder",
    leadTimeDays: 21,
  });
  rapida = await seedE2eCartProduct(tag, "rapida", {
    price: 3000,
    stockStatus: "onbackorder",
    leadTimeDays: 5,
  });
  accesoriu = await seedE2eCartProduct(tag, "accesoriu", { price: 2500 });
  ciorna = await seedE2eCartProduct(tag, "ciorna", { price: 2500, status: "draft" });
  piesa = await seedE2eCartProduct(tag, "piesa", { price: 4500 });
  redus = await seedE2eCartProduct(tag, "redus", { price: 10000, salePrice: 7000 });
  await linkE2eProducts(bucati.productId, accesoriu.productId, "crosssell");
  await linkE2eProducts(bucati.productId, ciorna.productId, "crosssell");
  await linkE2eProducts(bucati.productId, piesa.productId, "spare_part");
});

test.afterAll(async () => {
  await removeE2eCarts();
  await removeE2eProducts();
  await removeE2eUnits();
});

const drawer = (page: Page) => page.locator("[data-cart-drawer]");
const live = (page: Page, text: string | RegExp) =>
  page.locator('[aria-live="polite"]').filter({ hasText: text });

async function addFromProductPage(page: Page, product: E2eCartProduct, steps?: number) {
  await page.goto(`/produs/${product.slug}`);
  if (steps !== undefined) {
    const input = page.locator("[data-add-to-cart]").getByRole("textbox");
    await input.fill(String(steps));
    await input.press("Enter");
  }
  await page.locator("[data-add-button]").click();
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).locator(`[data-cart-line]`).first()).toBeVisible();
}

async function closeDrawer(page: Page) {
  await drawer(page).getByRole("button", { name: "Închide coșul" }).click();
  await expect(drawer(page)).toBeHidden();
}

test.describe("adăugare din pagina de produs", () => {
  test("sertarul se deschide cu produsul, insigna arată 1, totalul e prețul cu TVA; /cos arată aceleași valori", async ({
    page,
  }) => {
    await page.goto(`/produs/${bucati.slug}`);
    await expect(page.locator("[data-cart-badge]")).toHaveCount(0);
    await page.locator("[data-add-button]").click();
    await expect(drawer(page)).toBeVisible();
    const line = drawer(page).locator("[data-cart-line]");
    await expect(line).toHaveCount(1);
    await expect(line).toContainText(bucati.title);
    await expect(line.locator("[data-line-total]")).toContainText("199,00");
    await expect(drawer(page).locator("[data-cart-total]")).toContainText("199,00");
    await expect(live(page, `${bucati.title} a fost adăugat în coș.`)).toHaveCount(1);
    await closeDrawer(page);
    await expect(page.locator("[data-cart-badge]")).toHaveText("1");
    await expect(page.getByRole("link", { name: "Coșul tău, 1 produs" })).toBeVisible();

    await page.goto("/cos");
    await expect(page.getByRole("heading", { level: 1, name: "Coșul tău" })).toBeVisible();
    await expect(page.locator("[data-cart-panel='page'] [data-line-total]")).toContainText(
      "199,00",
    );
    await expect(page.locator("[data-cart-total]")).toContainText("199,00");
    // TVA inclus în total: 199,00 − 199,00 / 1,21 = 34,54
    await expect(page.locator("[data-order-summary]")).toContainText("34,54");
  });

  test("finalizarea e dezactivată cu explicația cerută, transportul se calculează mai târziu, fără câmp de cupon și fără reduceri", async ({
    page,
  }) => {
    await addFromProductPage(page, bucati);
    await page.goto("/cos");
    const checkout = page.locator("[data-checkout]");
    await expect(checkout).toHaveText("Finalizarea comenzii se activează în curând");
    await expect(checkout).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("main")).toContainText(
      "Transportul se calculează la finalizarea comenzii",
    );
    const text = (await page.locator("body").innerText()).toLowerCase();
    expect(text).not.toMatch(/cupon|cod de reducere|reducere/);
    await expect(page.locator("input[name*='coupon' i], input[name*='cupon' i]")).toHaveCount(0);
    // un singur buton principal pe pagina de coș
    await expect(page.locator("main [data-checkout]")).toHaveCount(1);
  });

  test("cu o promoție activă, dar «reducerile» oprite, vitrina și coșul arată ACELAȘI preț, cel întreg", async ({
    page,
  }) => {
    await page.goto(`/produs/${redus.slug}`);
    await expect(page.locator("[data-price]")).toContainText("100,00");
    await expect(page.locator("[data-price] s")).toHaveCount(0);
    await page.locator("[data-add-button]").click();
    await expect(drawer(page).locator("[data-line-total]")).toContainText("100,00");
    await expect(drawer(page).locator("[data-cart-total]")).toContainText("100,00");
    await expect(drawer(page)).not.toContainText("70,00");
  });

  test("izolare: alt browser, alt coș", async ({ page, browser }) => {
    await addFromProductPage(page, bucati);
    await closeDrawer(page);
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto("/cos");
    await expect(otherPage.locator("[data-cart-empty]")).toBeVisible();
    await expect(otherPage.locator("[data-cart-badge]")).toHaveCount(0);
    await other.close();
  });
});

test.describe("cantitatea în pași, validată pe server", () => {
  test("3 cutii de 2,03 mp = 6,09 mp = 751,81 lei (nu 751,80); apoi 4 cutii = 8,12 mp = 1.002,41 lei", async ({
    page,
  }) => {
    await page.goto(`/produs/${mozaic.slug}`);
    await expect(page.locator("[data-price]")).toContainText("123,45");
    await expect(page.locator("[data-price]")).toContainText("/ mp");
    await expect(page.locator("[data-step-hint]")).toContainText("cutie de 2,03 mp");
    const stepper = page.locator("[data-add-to-cart]");
    await stepper.getByRole("button", { name: "Mărește cantitatea" }).click();
    await stepper.getByRole("button", { name: "Mărește cantitatea" }).click();
    await expect(page.locator("[data-quantity-total]")).toHaveText("În total: 6,09 mp");
    await page.locator("[data-add-button]").click();
    const line = drawer(page).locator("[data-cart-line]");
    await expect(line.locator("[data-line-total]")).toContainText("751,81");
    await expect(line.locator("[data-line-quantity]")).toHaveText("6,09 mp");
    await expect(line).toContainText("Se vinde în multipli de 2,03 mp (cutie)");

    await line.getByRole("button", { name: "Mărește cantitatea" }).click();
    await expect(line.locator("[data-line-quantity]")).toHaveText("8,12 mp");
    await expect(line.locator("[data-line-total]")).toContainText(/1\.?002,41/);
    await expect(drawer(page).locator("[data-cart-total]")).toContainText(/1\.?002,41/);
  });

  test("prețul pe pas: 2 saci de 25 kg × 120,00 = 240,00 lei, fără rotunjire", async ({ page }) => {
    await page.goto(`/produs/${bisulfat.slug}`);
    await expect(page.locator("[data-price]")).toContainText("/ sac de 25 kg");
    await addFromProductPage(page, bisulfat, 2);
    const line = drawer(page).locator("[data-cart-line]");
    await expect(line.locator("[data-line-quantity]")).toHaveText("50 kg");
    await expect(line.locator("[data-line-total]")).toContainText("240,00");
  });

  test("pasul s-a schimbat în admin și cantitatea nu mai e multiplu: mesaj și ajustare la cel mai apropiat multiplu", async ({
    page,
  }) => {
    const step = await seedE2eCartProduct(tag, "pas", {
      price: 10000,
      unitCode,
      saleStep: 20000,
      saleStepLabel: "rolă",
    });
    await addFromProductPage(page, step, 3); // 6 mp
    await closeDrawer(page);
    await changeE2eCartProduct(step, { saleStep: 25000 }); // pas nou: 2,5 mp; 6 nu mai e multiplu
    await page.goto("/cos");
    const line = page.locator("[data-cart-panel='page'] [data-cart-line]");
    await expect(line).toContainText("Cantitatea nu mai este potrivită");
    // linia cu cantitate invalidă nu intră în total
    await expect(page.locator("[data-cart-total]")).toHaveCount(0);
    await line.getByRole("button", { name: /Ajustează la 5 mp/ }).click();
    await expect(line).not.toContainText("Cantitatea nu mai este potrivită");
    await expect(line.locator("[data-line-quantity]")).toHaveText("5 mp");
    await expect(line.locator("[data-line-total]")).toContainText("500,00");
  });
});

test.describe("coș mixt, indisponibil, preț schimbat", () => {
  test("coș mixt: livrare toată odată, cu termenul cel mai lung", async ({ page }) => {
    await addFromProductPage(page, rapida);
    await closeDrawer(page);
    await addFromProductPage(page, lenta);
    await closeDrawer(page);
    await addFromProductPage(page, bucati);
    await closeDrawer(page);
    await page.goto("/cos");
    await expect(page.locator("[data-order-summary]")).toContainText(
      "Livrare toată odată, în aproximativ 21 de zile",
    );
    await expect(page.locator("[data-cart-line]")).toHaveCount(3);
    await expect(page.locator("[data-cart-line]", { hasText: rapida.title })).toContainText(
      "La comandă",
    );
  });

  test("produs devenit indisponibil: marcat, ieșit din total, cu acțiune clară de scoatere", async ({
    page,
  }) => {
    const a = await seedE2eCartProduct(tag, "dispare", { price: 10000 });
    await addFromProductPage(page, a);
    await closeDrawer(page);
    await addFromProductPage(page, accesoriu);
    await closeDrawer(page);
    await changeE2eCartProduct(a, { stockStatus: "outofstock" });
    await page.goto("/cos");
    const gone = page.locator("[data-cart-line]", { hasText: a.title });
    await expect(gone).toContainText("Indisponibil");
    await expect(gone).toContainText("nu intră în total");
    await expect(gone.locator("[data-line-total]")).toContainText("Nu intră în total");
    await expect(page.locator("[data-cart-total]")).toContainText("25,00");
    await gone
      .getByRole("button", { name: `Scoate din coș: ${a.title}` })
      .last()
      .click();
    await expect(page.locator("[data-cart-line]")).toHaveCount(1);
    await expect(live(page, `${a.title} a fost scos din coș.`)).toHaveCount(1);
  });

  test("preț schimbat: mesaj cu vechiul și noul preț, totalul urmează prețul curent, apoi se confirmă", async ({
    page,
  }) => {
    const p = await seedE2eCartProduct(tag, "pret", { price: 10000 });
    await addFromProductPage(page, p);
    await closeDrawer(page);
    await changeE2eCartProduct(p, { price: 12000 });
    await page.goto("/cos");
    const line = page.locator("[data-cart-panel='page'] [data-cart-line]");
    await expect(line).toContainText("Prețul s-a schimbat");
    await expect(line).toContainText("100,00");
    await expect(line).toContainText("120,00");
    await expect(page.locator("[data-cart-total]")).toContainText("120,00");
    await line.getByRole("button", { name: "Am înțeles" }).click();
    await expect(line).not.toContainText("Prețul s-a schimbat");
  });
});

test.describe("cross-sell și piese de schimb", () => {
  test("pe /cos apar doar produsele vandabile din relațiile «crosssell»", async ({ page }) => {
    await addFromProductPage(page, bucati);
    await closeDrawer(page);
    await page.goto("/cos");
    const section = page
      .getByRole("region", { name: "Te-ar putea interesa" })
      .or(page.locator("section", { hasText: "Te-ar putea interesa" }));
    await expect(section).toContainText(accesoriu.title);
    await expect(section).not.toContainText(ciorna.title);
    await expect(section).not.toContainText(bucati.title);
  });

  test("tabul «Piese de schimb»: rândul are «Adaugă în coș» (nu doar «Vezi piesa»)", async ({
    page,
  }) => {
    await page.goto(`/produs/${bucati.slug}`);
    await page
      .getByRole("tab", { name: "Piese de schimb" })
      .click()
      .catch(() => undefined);
    const row = page.locator("tr", { hasText: piesa.title });
    await expect(row.getByRole("link", { name: "Vezi piesa" })).toBeVisible();
    await row.getByRole("button", { name: `Adaugă în coș: ${piesa.title}` }).click();
    await expect(drawer(page)).toBeVisible();
    await expect(drawer(page).locator("[data-cart-line]")).toContainText(piesa.title);
    await expect(drawer(page).locator("[data-line-total]")).toContainText("45,00");
  });
});

test.describe("pagina /cos nu se indexează", () => {
  test("meta robots noindex și Disallow în robots.txt", async ({ page, request }) => {
    await page.goto("/cos");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    const robots = await (await request.get("/robots.txt")).text();
    expect(robots).toMatch(/Disallow:\s*\/cos/);
  });
});

interface Account {
  email: string;
  password: string;
}

async function createCustomer(request: APIRequestContext, baseURL: string): Promise<Account> {
  const email = `e2e-${randomBytes(5).toString("hex")}@example.test`;
  const password = randomBytes(18).toString("base64url");
  const response = await request.post(`${baseURL}/api/auth/sign-up/email`, {
    headers: { origin: baseURL, "x-forwarded-for": uniqueClientIp() },
    data: { name: "Client E2E", email, password },
  });
  await expectResponseOk(response, "înregistrarea clientului de test");
  await promoteE2eUser(email, null);
  return { email, password };
}

test.describe("îmbinare la autentificare", () => {
  test("coșul de oaspete se mută în coșul contului; cookie-ul dispare, insigna arată produsele", async ({
    page,
    request,
    baseURL,
  }) => {
    const account = await createCustomer(request, baseURL as string);
    await addFromProductPage(page, bucati);
    await closeDrawer(page);
    await expect(page.locator("[data-cart-badge]")).toHaveText("1");
    const guestCookie = (await page.context().cookies()).find((c) => c.name === "ecom_cart");
    expect(guestCookie).toBeDefined();
    expect(guestCookie?.httpOnly).toBe(true);
    expect(guestCookie?.sameSite).toBe("Lax");
    expect(guestCookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await page.goto("/autentificare?next=%2Fmagazin");
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Parolă", { exact: true }).fill(account.password);
    await page.getByRole("button", { name: "Intră în cont" }).click();
    await page.waitForURL((url) => url.pathname === "/magazin");
    await expect(page.locator("[data-cart-badge]")).toHaveText("1");
    expect((await page.context().cookies()).some((c) => c.name === "ecom_cart")).toBe(false);
    expect(await countE2eCartLines(account.email)).toBe(1);
    await page.goto("/cos");
    await expect(page.locator("[data-cart-panel='page'] [data-cart-line]")).toContainText(
      bucati.title,
    );
  });
});

test.describe("telefon", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("pagina de produs: bara lipicioasă cu «Adaugă în coș»; /cos fără defilare laterală, cu ținte de cel puțin 44 px", async ({
    page,
  }) => {
    await page.goto(`/produs/${mozaic.slug}`);
    // bannerul de cookie-uri (prima vizită) acoperă bara de jos: vizitatorul răspunde întâi (S3 în FINISAJE.md)
    await page.locator("[data-consent-banner] [data-consent='reject']").click();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    const sticky = page.locator("[data-sticky-bar]");
    await expect(sticky).toBeVisible();
    await sticky.locator("[data-sticky-add]").click();
    await expect(drawer(page)).toBeVisible();
    await closeDrawer(page);
    await page.goto("/cos");
    await expect(page.locator("[data-cart-panel='page'] [data-cart-line]")).toHaveCount(1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const small = await page
      .locator(
        "[data-cart-panel='page'] button, [data-cart-panel='page'] [role='textbox'], [data-cart-panel='page'] input",
      )
      .evaluateAll((nodes) =>
        nodes
          .map((node) => node.getBoundingClientRect())
          .filter((box) => box.width > 0 && (box.height < 44 || box.width < 40))
          .map((box) => `${Math.round(box.width)}×${Math.round(box.height)}`),
      );
    expect(small).toEqual([]);
  });
});

// Testele de capturi se înregistrează DOAR cu CAPTURE_DIR (un test sărit ar încălca «0 sărite» din poartă).
if (process.env["CAPTURE_DIR"])
  test.describe("capturi pentru autorevizuire", () => {
    for (const width of [390, 1440]) {
      test(`pagina de produs, sertarul și /cos reale la ${width} px`, async ({ page }) => {
        const dir = process.env["CAPTURE_DIR"] as string;
        mkdirSync(dir, { recursive: true });
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.goto(`/produs/${mozaic.slug}`);
        await page.locator("[data-consent-banner] [data-consent='reject']").click();
        await page.screenshot({ path: join(dir, `real-produs-${width}.png`) });
        await page
          .locator("[data-add-to-cart]")
          .getByRole("button", { name: "Mărește cantitatea" })
          .click();
        await page.locator("[data-add-button]").click();
        await expect(drawer(page).locator("[data-cart-line]")).toBeVisible();
        await page.screenshot({ path: join(dir, `real-sertar-${width}.png`) });
        await closeDrawer(page);
        await page.goto("/cos");
        await expect(page.locator("[data-cart-panel='page'] [data-cart-line]")).toBeVisible();
        await page.screenshot({ path: join(dir, `real-cos-${width}.png`), fullPage: true });
      });
    }
  });

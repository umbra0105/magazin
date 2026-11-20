import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  E2E_ORDER_EMAIL_DOMAIN,
  clearE2eSettings,
  countE2eOrdersByEmail,
  readE2eOrder,
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
  addToCart,
  createAccount,
  demoScenario,
  login,
  paymentState,
  step,
  toPayment,
  type Account,
} from "./support/card-flow";
import { waitForEmail } from "./support/mailpit";

/**
 * Fluxurile de comenzi și de oferte din admin (Faza 11), într-un singur fișier, în proiectul Playwright propriu `chromium-orders`
 * (după toate celelalte): lucrează cu listele comune de comenzi și de oferte și cu curățarea globală a comenzilor E2E
 * (`removeE2eOrders`), deci nu au voie să ruleze în paralel cu alte specuri (nici cu cele cu plan pe tot catalogul, care mută stocul
 * tuturor variantelor). Partea 1: comenzi (listă, detaliu, «Marchează plătit», anulare, șabloane de email, clopoțel). Partea 2:
 * oferta de plată (creare pas cu pas, plată prin DEMO, învechită, anulare, retrimitere, email). DEMO merge pentru că serverul E2E
 * rulează cu `E2E_HARNESS=1`.
 */
const tag = randomBytes(3).toString("hex");
const emailOf = (name: string) => `flux-${name}-${tag}${E2E_ORDER_EMAIL_DOMAIN}`;

test.describe.configure({ mode: "serial" });

let produs: E2eCartProduct;
let ultima: E2eCartProduct;
let manager: Account;
let owner: Account;
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
  produs = await seedE2eCartProduct(tag, "flux", { price: 19_900 });
  ultima = await seedE2eCartProduct(tag, "ultima", { price: 19_900 });
  await setE2eCartStock(produs.variantId, "100");
  await setE2eCartStock(ultima.variantId, "1");
  manager = await createAccount(request, baseURL as string, "manager");
  owner = await createAccount(request, baseURL as string, "owner");
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
    await expect(client.locator("[data-offer-continue]")).toHaveCount(0);
    await expect(client.locator("[data-offer-pay]")).toHaveCount(0);
    await client.context().close();

    await page.goto(detail);
    await expect(page.locator("[data-offer-detail]")).toContainText("Convertită în comandă");
    await expect(page.getByRole("link", { name: /^E2E-\d{6}$/ })).toBeVisible();
    await page.goto("/admin/comenzi/oferte?vedere=toate");
    await expect(
      page.locator("[data-offer-row]").filter({ hasText: "Convertită în comandă" }).first(),
    ).toBeVisible();
  });
});

test.describe("plata ofertei întreruptă", () => {
  test("după conversie, din link se continuă plata ACEEAȘI comenzi (fără a doua comandă); după plată, linkul nu mai oferă nimic", async ({
    page,
    browser,
  }) => {
    const email = emailOf("continua");
    await login(page, manager, "/admin/comenzi/oferte/nou");
    const { link } = await createOffer(page, produs, email);

    const client = await (await browser.newContext()).newPage();
    await client.goto(link);
    await client.getByRole("checkbox", { name: /Am citit și sunt de acord/ }).check();
    await client.locator("[data-offer-pay-button]").click();
    await expect(client).toHaveURL(/\/plata-demo\//);
    expect(await countE2eOrdersByEmail(email)).toBe(1);

    // clientul închide fila înainte să plătească și revine pe linkul din email
    await client.goto(link);
    await expect(client.getByRole("heading", { name: "Comanda ta a fost creată" })).toBeVisible();
    // consimțământul s-a dat la prima plată: nu se cere din nou
    await expect(client.getByRole("checkbox")).toHaveCount(0);
    await expect(client.locator("main")).not.toContainText("E2E-");
    await client.getByRole("button", { name: "Continuă plata" }).click();
    // pagina de reîncercare din Faza 10, apoi procesatorul (DEMO)
    await expect(client).toHaveURL(/\/comanda\/plateste\//);
    await client.locator("[data-pay-by-link]").click();
    await expect(client).toHaveURL(/\/plata-demo\//);
    await demoScenario(client, "paid");
    await expect(paymentState(client)).toHaveAttribute("data-card-payment-state", "paid", {
      timeout: 30_000,
    });
    expect(await countE2eOrdersByEmail(email)).toBe(1);

    // plătită: linkul spune doar că oferta e folosită, fără acțiune
    await client.goto(link);
    await expect(
      client.getByRole("heading", { name: "Oferta a fost deja folosită" }),
    ).toBeVisible();
    await expect(client.getByRole("button", { name: "Continuă plata" })).toHaveCount(0);
    await client.context().close();
  });
});

test.describe("pagina ofertei: fără «Înapoi la coș», bannerul de cookie-uri nu acoperă acțiunea", () => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    test(`la prima vizită (${viewport.width} px) bifa și butonul se văd și se pot apăsa fără să răspunzi bannerului`, async ({
      page,
      browser,
    }) => {
      await login(page, manager, "/admin/comenzi/oferte/nou");
      const { link } = await createOffer(page, produs, emailOf(`cookie${viewport.width}`));

      // context nou = prima vizită: fără cookie-ul de consimțământ, deci cu banner
      const context = await browser.newContext({ viewport });
      const client = await context.newPage();
      await client.goto(link);
      const banner = client.locator("[data-consent-banner]");
      await expect(banner).toBeVisible();
      // clientul vine din email: nu are coș, deci nu există «Înapoi la coș»; ieșirea spre pagina de start e logo-ul
      await expect(client.getByRole("link", { name: "Înapoi la coș" })).toHaveCount(0);
      await expect(
        client.locator("[data-checkout-header]").getByRole("link").first(),
      ).toHaveAttribute("href", "/");

      const consent = client.getByRole("checkbox", { name: /Am citit și sunt de acord/ });
      const pay = client.locator("[data-offer-pay-button]");
      // la capătul paginii (cât poate derula clientul) bifa și butonul stau deasupra bannerului
      await client.mouse.move(viewport.width / 2, 300);
      await client.mouse.wheel(0, 8000);
      await expect
        .poll(() =>
          client.evaluate(
            () => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1,
          ),
        )
        .toBe(true);
      const bannerBox = await banner.boundingBox();
      for (const target of [consent, pay]) {
        const box = await target.boundingBox();
        expect(box && bannerBox).toBeTruthy();
        expect(box!.y + box!.height).toBeLessThanOrEqual(bannerBox!.y + 1);
        // în punctul din mijloc ajunge elementul însuși (nu bannerul)
        const covered = await target.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return hit !== null && !element.contains(hit) && !hit.contains(element);
        });
        expect(covered).toBe(false);
      }
      // pe calculator, la prima vedere (fără derulare), bifa și butonul stau deja deasupra bannerului (rezumatul de plată e în coloana
      // din dreapta, sus), nu abia după ce derulezi
      if (viewport.width >= 1024) {
        await client.evaluate(() => window.scrollTo(0, 0));
        for (const target of [consent, pay]) {
          const box = await target.boundingBox();
          expect(box).toBeTruthy();
          expect(box!.y).toBeGreaterThanOrEqual(0);
          expect(box!.y + box!.height).toBeLessThanOrEqual(bannerBox!.y + 1);
        }
      } else {
        // pe telefon: bifa adusă sub banner (de exemplu după o derulare) revine deasupra lui când primește focusul (și de la
        // tastatură, și după «Plătește» fără bifă): pagina rezervă marginea de derulare cât bannerul (`scroll-padding-bottom`)
        await client.evaluate(() => {
          const bannerEl = document.querySelector("[data-consent-banner]") as HTMLElement;
          const checkbox = document.querySelector(
            '[data-offer-pay] input[type="checkbox"]',
          ) as HTMLElement;
          const rect = checkbox.getBoundingClientRect();
          window.scrollBy(0, rect.top - (bannerEl.getBoundingClientRect().top + 4));
        });
        await consent.focus();
        const focusedBox = await consent.boundingBox();
        const bannerNow = await banner.boundingBox();
        expect(focusedBox && bannerNow).toBeTruthy();
        expect(focusedBox!.y + focusedBox!.height).toBeLessThanOrEqual(bannerNow!.y + 1);
        await client.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      }
      // apăsabile cu bannerul încă la locul lui (nu s-a răspuns la el)
      await consent.check();
      await expect(consent).toBeChecked();
      await expect(banner).toBeVisible();
      await pay.click();
      await expect(client).toHaveURL(/\/plata-demo\//);
      await context.close();
    });
  }
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

    // clopoțelul: notificarea are context (numărul ofertei și motivul), fără date personale, și duce la oferta în cauză;
    // deschiderea ei o marchează citită
    const number = /OF-\d{4,}/.exec(await page.getByRole("heading", { level: 1 }).innerText())?.[0];
    expect(number).toBeTruthy();
    await page.goto("/admin/comenzi");
    await page.locator("[data-notifications-bell]").click();
    const item = page
      .locator("[data-notifications-list] li")
      .filter({ hasText: `Oferta ${number} · Stocul nu mai acoperă oferta` });
    await expect(item).toHaveCount(1);
    await expect(item).toContainText("O ofertă nu mai poate fi plătită");
    await expect(item).toContainText("Necitită");
    await expect(item).not.toContainText("Ion Popescu");
    await expect(item).not.toContainText("@");
    await item.getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`${detail}$`));
    await expect(page.locator("[data-offer-detail]")).toContainText("Învechită");
    await page.locator("[data-notifications-bell]").click();
    await expect(item).toHaveCount(1);
    await expect(item).not.toContainText("Necitită");
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

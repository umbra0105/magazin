import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  E2E_ORDER_EMAIL_DOMAIN,
  clearE2eSettings,
  readE2eInvoices,
  readE2eSetting,
  removeE2eCarts,
  removeE2eDemoInvoicing,
  removeE2eOrders,
  removeE2eProducts,
  seedE2eCartProduct,
  seedE2eCheckoutSettings,
  seedE2eDemoInvoicing,
  setE2eInvoiceState,
  setE2eSettings,
  type E2eCartProduct,
} from "../packages/core/test/e2e-support";
import { addToCart, createAccount, login, step, type Account } from "./support/card-flow";

/**
 * Facturare (Faza 13), din browser: datele firmei (salvare, program de ridicare), configurarea furnizorului (garda LIVE refuzată de
 * server), comanda cu ramburs și ridicare plasată prin checkout-ul real (programul de ridicare în checkout și la confirmare, factura
 * pusă în coadă de aplicație la plasare), panoul «Facturare» al comenzii (document SIMULAT, PDF marcat, storno, reîncercare după un
 * rezultat nesigur), lista facturilor și lista «Comenzi fără factură». Niciun test nu emite o factură reală: în E2E nu rulează niciun
 * lucrător, deci trecerea documentului din coadă în «emis» sau «eșuat» o face ajutorul `setE2eInvoiceState` (starea engine-ului e
 * acoperită de testele de integrare). Fiecare fișier își șterge doar comenzile lui, pe tag; starea comună (furnizorul DEMO, programul
 * de ridicare) se aduce înapoi în `afterAll`. Adresele și datele sunt FICTIVE.
 */
const tag = randomBytes(3).toString("hex");
const emailOf = (name: string) => `facturare-${name}-${tag}${E2E_ORDER_EMAIL_DOMAIN}`;
const HOURS = `Luni–Vineri, 09:00–17:00 (${tag})`;

test.describe.configure({ mode: "serial" });

let produs: E2eCartProduct;
let owner: Account;
let orderNumber = "";
let orderId = "";

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
  produs = await seedE2eCartProduct(tag, "produs", { price: 19_900 });
  owner = await createAccount(request, baseURL as string, "owner");
});

test.afterAll(async () => {
  await removeE2eDemoInvoicing();
  await removeE2eOrders({ tag });
  await removeE2eCarts();
  await removeE2eProducts();
  await clearE2eSettings(["company.address", "company.pickupHours", "invoicing.shippingLabel"]);
});

const next = (page: Page, id: string) => page.locator(`[data-continue="${id}"]`).click();

test.describe("datele firmei", () => {
  test("se salvează programul de ridicare; valorile salvate rămân după reîncărcare", async ({
    page,
  }) => {
    await login(page, owner, "/admin/setari/firma");
    await expect(page.getByRole("heading", { name: "Datele firmei", level: 1 })).toBeVisible();
    // cota de TVA e doar afișată (citită din setări), nu editabilă
    await expect(page.locator("[data-vat-rate]")).toContainText("21%");
    const hours = page.getByLabel("Programul de ridicare personală");
    await hours.fill(HOURS);
    await page.getByRole("button", { name: "Salvează" }).click();
    await expect(page.getByText("Salvat. Vitrina se reîmprospătează.")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Programul de ridicare personală")).toHaveValue(HOURS);
    expect(await readE2eSetting("company.pickupHours")).toBe(HOURS);
  });

  test("câmpurile greșite se marchează pe câmp, în română, fără validarea nativă a browserului", async ({
    page,
  }) => {
    await login(page, owner, "/admin/setari/firma");
    await page.getByLabel("Email de contact").fill("nu-este-email");
    await page.getByLabel("Programul de ridicare personală").fill("<b>text</b>");
    await page.getByRole("button", { name: "Salvează" }).click();
    await expect(page.getByText("Introdu o adresă de email validă.")).toBeVisible();
    await expect(
      page.getByText("Cel mult 300 de caractere și fără semnele < sau >."),
    ).toBeVisible();
    expect(await readE2eSetting("company.pickupHours")).toBe(HOURS); // nimic nu s-a scris
  });
});

test.describe("configurarea facturării", () => {
  test("DEMO apare cu garda de dezvoltare, se alege și se activează; LIVE la SmartBill e refuzat de server", async ({
    page,
  }) => {
    await login(page, owner, "/admin/setari/facturare");
    await expect(page.getByRole("heading", { name: "Facturare", level: 1 })).toBeVisible();
    const smartbill = page.locator('[data-invoicing-provider="smartbill"]');
    await expect(smartbill).toContainText("Încă netestat cu un cont real");
    // cheile nu se afișează niciodată după salvare: câmpul de token e de tip parolă
    await expect(smartbill.getByLabel(/Token API/)).toHaveAttribute("type", "password");

    // DEMO: se alege și se activează
    const demo = page.locator('[data-invoicing-provider="demo"]');
    await expect(demo).toBeVisible();
    await demo.getByLabel("Furnizor activ").check();
    await demo.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(demo.getByText("Salvat.")).toBeVisible();
    await page
      .getByLabel("Furnizor", { exact: true })
      .selectOption({ label: "DEMO (doar dezvoltare)" });
    await page.getByRole("button", { name: "Salvează alegerea" }).click();
    await expect(page.getByText("Alegerea a fost salvată.")).toBeVisible();
    expect(await readE2eSetting("invoicing.provider")).toBe("demo");

    // SmartBill: date fictive; trecerea în LIVE e refuzată pe server (nu s-a testat cu un cont real)
    await smartbill.getByLabel(/Email-ul contului SmartBill/).fill("cont@exemplu.invalid");
    await smartbill.getByLabel(/Token API/).fill("token-fals-de-test");
    await smartbill.getByLabel(/CIF-ul firmei/).fill("RO12345678");
    await smartbill.getByLabel(/Seria facturilor/).fill("FCT");
    await smartbill.getByLabel(/Seria proformelor/).fill("PRF");
    await smartbill.getByLabel(/Numele cotei de TVA/).fill("Normala");
    await smartbill.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(smartbill.getByText("Salvat.", { exact: true }).first()).toBeVisible();
    await smartbill.getByRole("button", { name: "Treci în LIVE" }).click();
    await page.getByRole("button", { name: "Da, treci în LIVE" }).click();
    await expect(
      smartbill.getByRole("alert").filter({ hasText: "nu a fost încă testat cu un cont real" }),
    ).toBeVisible();
    await expect(smartbill).toContainText("Mod test");
  });
});

test.describe("comandă cu ramburs și ridicare, cu facturare activă", () => {
  test("checkout-ul și confirmarea arată programul de ridicare; la plasare factura intră în coadă", async ({
    page,
  }) => {
    await seedE2eDemoInvoicing();
    await addToCart(page, produs);
    await page.goto("/cos");
    await page.locator("main [data-checkout]").click();
    await expect(page).toHaveURL(/\/checkout$/);
    await step(page, "contact").getByLabel("Adresa de email").fill(emailOf("ramburs"));
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
      .fill("Str. Exemplu 1, bl. A");
    await delivery.getByLabel("Cod poștal").fill("510005");
    await next(page, "delivery");
    const pickup = step(page, "shipping").locator('[data-offer="pickup"]');
    await expect(pickup).toBeVisible();
    // programul de ridicare apare lângă adresa de ridicare, în oferta de ridicare
    await expect(pickup.locator("[data-offer-hours]")).toContainText(
      `Program de ridicare: ${HOURS}`,
    );
    await pickup.locator("input").check();
    await next(page, "shipping");
    await expect(step(page, "billing")).toBeVisible();
    await next(page, "billing");
    await expect(step(page, "payment").locator("[data-method]").first()).toBeVisible();
    await step(page, "payment").locator('[data-method="cod"] input').check();
    await next(page, "payment");
    await page.getByRole("checkbox", { name: /Am citit și sunt de acord/ }).check();
    await page.locator("[data-checkout-submit]").click();
    await expect(page).toHaveURL(/\/comanda\/confirmare$/);
    await expect(page.locator("[data-order-confirmation]")).toBeVisible();
    // confirmarea arată adresa de ridicare ȘI programul
    await expect(page.locator("[data-pickup-hours]")).toContainText(HOURS);
    const text = (await page.locator("[data-order-number]").innerText()).trim();
    const match = /E2E-\d{6}/.exec(text);
    expect(match, text).not.toBeNull();
    orderNumber = match![0];

    // outbox: factura (ramburs = la plasare) e în coadă, cu totalul comenzii; nimic emis încă
    const docs = await readE2eInvoices(orderNumber);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      kind: "invoice",
      docKey: "invoice",
      status: "queued",
      attempts: 0,
      series: null,
    });
    expect(docs[0]?.totalMinor).toBeGreaterThan(0);
  });

  test("panoul «Facturare» al comenzii: în coadă, apoi emis (SIMULAT), cu PDF marcat", async ({
    page,
  }) => {
    await login(page, owner, `/admin/comenzi?q=${orderNumber}`);
    await page.getByRole("link", { name: orderNumber }).first().click();
    await expect(page).toHaveURL(/\/admin\/comenzi\/[^/?]+$/);
    orderId = new URL(page.url()).pathname.split("/").pop() as string;
    await expect(page.locator("[data-pickup-hours]")).toContainText(HOURS); // și în pagina comenzii din admin
    const panel = page.locator("[data-invoice-panel]");
    await expect(panel.locator('[data-invoice-doc="invoice"]')).toHaveAttribute(
      "data-invoice-status",
      "queued",
    );
    // «Comenzi fără factură»: o factură în coadă nu mai e «fără factură»
    await page.goto("/admin/comenzi/fara-factura");
    await expect(page.getByRole("link", { name: orderNumber })).toHaveCount(0);

    await setE2eInvoiceState(orderNumber, "invoice", { status: "issued" });
    await page.goto(`/admin/comenzi/${orderId}`);
    const doc = page.locator('[data-invoice-doc="invoice"]');
    await expect(doc).toHaveAttribute("data-invoice-status", "issued");
    await expect(doc.locator("[data-simulated]")).toContainText("SIMULAT, nu este document fiscal");
    await expect(doc.locator("[data-efactura]")).toContainText("În așteptare");

    // PDF-ul vine de la furnizorul simulat și poartă marcajul; răspunsul nu se păstrează în cache
    const href = await doc.getByRole("link", { name: "PDF" }).getAttribute("href");
    const pdf = await page.request.get(href as string);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["cache-control"]).toContain("no-store");
    const body = (await pdf.body()).toString("latin1");
    expect(body.startsWith("%PDF")).toBe(true);
    expect(body).toContain("SIMULAT");

    // e-Factura se poate marca manual (SmartBill nu o expune prin API)
    await doc.getByLabel("Marchează e-Factura ca").selectOption({ label: "Validată" });
    await doc.getByRole("button", { name: "Salvează starea" }).click();
    await expect(page.getByText("Starea e-Factura a fost salvată.")).toBeVisible();
    await expect(doc.locator("[data-efactura]")).toContainText("Validată");

    // lista facturilor: documentul apare cu starea lui
    await page.goto(`/admin/comenzi/facturi?q=${orderNumber}`);
    const row = page.locator("[data-invoice-row]").first();
    await expect(row).toContainText(orderNumber);
    await expect(row).toContainText("Emis");
  });

  test("storno total din panou: dialog de confirmare, apoi stornoul intră în coadă", async ({
    page,
  }) => {
    await login(page, owner, `/admin/comenzi/${orderId}`);
    await page.getByRole("button", { name: "Stornează factura" }).click();
    await page.getByRole("button", { name: "Da, stornează" }).click();
    await expect(page.getByText("Stornoul a fost pus în coadă.")).toBeVisible();
    const docs = await readE2eInvoices(orderNumber);
    expect(docs.map((d) => `${d.kind}:${d.docKey}:${d.status}`)).toEqual([
      "invoice:invoice:issued",
      "storno:storno:total:queued",
    ]);
    await page.reload();
    await expect(page.locator('[data-invoice-doc="storno"]')).toHaveAttribute(
      "data-invoice-status",
      "queued",
    );
    await expect(page.getByRole("button", { name: "Stornează factura" })).toHaveCount(0);
  });

  test("un document eșuat cu rezultat nesigur: «Reîncearcă» cere confirmarea că nu există la furnizor", async ({
    page,
  }) => {
    await setE2eInvoiceState(orderNumber, "storno:total", {
      status: "failed",
      code: "INVOICE_PROVIDER_TIMEOUT",
      message:
        "Rezultat nesigur: furnizorul nu a răspuns la timp. Verifică în contul furnizorului.",
    });
    await login(page, owner, `/admin/comenzi/${orderId}`);
    const doc = page.locator('[data-invoice-doc="storno"]');
    await expect(doc).toHaveAttribute("data-invoice-status", "failed");
    await expect(doc.locator("[data-invoice-error]")).toContainText("Rezultat nesigur");
    await doc.locator("[data-invoice-retry]").click();
    // fără bifă, serverul NU e apelat și mesajul explică de ce
    await page.getByRole("button", { name: "Reîncearcă emiterea" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "confirmă că ai verificat" }),
    ).toBeVisible();
    expect((await readE2eInvoices(orderNumber)).at(-1)?.status).toBe("failed");
    await page.getByLabel("Am verificat în contul furnizorului: documentul nu există").check();
    await page.getByRole("button", { name: "Reîncearcă emiterea" }).click();
    await expect(page.locator('[data-invoice-doc="storno"]')).toHaveAttribute(
      "data-invoice-status",
      "queued",
    );
    expect((await readE2eInvoices(orderNumber)).at(-1)).toMatchObject({
      status: "queued",
      attempts: 0,
    });
  });

  test("lista «Comenzi fără factură»: o comandă confirmată, fără factură, apare cu angajările de stoc", async ({
    page,
  }) => {
    // se oprește furnizorul: comanda nouă nu primește factură în coadă, deci apare în listă
    await setE2eSettings({ "invoicing.provider": "" });
    await addToCart(page, produs);
    await page.goto("/cos");
    await page.locator("main [data-checkout]").click();
    await step(page, "contact").getByLabel("Adresa de email").fill(emailOf("fara-factura"));
    await step(page, "contact").getByLabel("Telefon").fill("0722 123 456");
    await next(page, "contact");
    const delivery = step(page, "delivery");
    await delivery.getByLabel("Nume și prenume").fill("Ion Popescu");
    await delivery.getByLabel("Județ").selectOption({ label: "Alba" });
    const locality = delivery.getByLabel("Localitate");
    await expect(locality).toBeEnabled();
    await expect(locality.locator("option")).not.toHaveCount(1);
    await locality.selectOption({ label: "Alba Iulia" });
    await delivery
      .getByLabel("Strada, numărul, blocul, apartamentul")
      .fill("Str. Exemplu 1, bl. A");
    await delivery.getByLabel("Cod poștal").fill("510005");
    await next(page, "delivery");
    await step(page, "shipping").locator('[data-offer="pickup"] input').check();
    await next(page, "shipping");
    await next(page, "billing");
    await expect(step(page, "payment").locator("[data-method]").first()).toBeVisible();
    await step(page, "payment").locator('[data-method="cod"] input').check();
    await next(page, "payment");
    await page.getByRole("checkbox", { name: /Am citit și sunt de acord/ }).check();
    await page.locator("[data-checkout-submit]").click();
    await expect(page.locator("[data-order-confirmation]")).toBeVisible();
    const number = /E2E-\d{6}/.exec(
      (await page.locator("[data-order-number]").innerText()).trim(),
    )![0];
    expect(await readE2eInvoices(number)).toHaveLength(0);

    await login(page, owner, "/admin/comenzi/fara-factura");
    const row = page.locator("[data-uninvoiced-row]").filter({ hasText: number });
    await expect(row).toBeVisible();
    // furnizorul e oprit: butonul «Emite factura» nu se oferă, iar pagina spune de ce
    await expect(page.locator("[data-uninvoiced-list]")).toContainText(
      "Alege și activează un furnizor",
    );
    await expect(row.getByRole("button", { name: "Emite factura" })).toHaveCount(0);

    // cu furnizorul pornit, «Emite factura» pune documentul în coadă și comanda iese din listă
    await setE2eSettings({ "invoicing.provider": "demo" });
    await page.reload();
    await page
      .locator("[data-uninvoiced-row]")
      .filter({ hasText: number })
      .getByRole("button", { name: "Emite factura" })
      .click();
    await expect(page.getByText("Factura a fost pusă în coadă.")).toBeVisible();
    await expect(page.locator("[data-uninvoiced-row]").filter({ hasText: number })).toHaveCount(0);
    expect((await readE2eInvoices(number)).map((d) => d.status)).toEqual(["queued"]);
  });
});

import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  E2E_ORDER_EMAIL_DOMAIN,
  clearE2ePalletSettings,
  clearE2eSettings,
  readE2eOrder,
  readE2eShipments,
  removeE2eCarts,
  removeE2eDemoCarrier,
  removeE2eOrders,
  removeE2eProducts,
  seedE2eCartProduct,
  seedE2eCheckoutSettings,
  seedE2eDemoCarrier,
  setE2eSettings,
  type E2eCartProduct,
} from "../packages/core/test/e2e-support";
import { addToCart, createAccount, login, step, type Account } from "./support/card-flow";
import { waitForEmail } from "./support/mailpit";

/**
 * Livrare și AWB (Faza 12): transportul paletizat în checkout (preț fix per palet, doar paletizat la produs `pallet`, paletul în locul
 * curierului peste prag, curierul rămâne dacă paletul ar costa mai mult), rambursul «doar cu cardul» la paletizat, AWB manual din admin
 * cu emailul «expediată», marcarea «livrată», reconcilierea rambursului, ridicarea personală fără AWB, AWB în masă prin curierul
 * DEMO (simulat), etichete PDF și ZPL, anulare, setările de palet și garda LIVE a curierilor. Fiecare fișier își șterge doar comenzile
 * lui, pe tag; setările și starea DEMO a curierului se aduc înapoi în `afterAll`. Adresele și datele sunt FICTIVE.
 */
const tag = randomBytes(3).toString("hex");
const emailOf = (name: string) => `livrare-${name}-${tag}${E2E_ORDER_EMAIL_DOMAIN}`;

test.describe.configure({ mode: "serial" });

let palet: E2eCartProduct;
let greu: E2eCartProduct;
let obisnuit: E2eCartProduct;
let owner: Account;
let paletNumber = "";
let carrierNumber = "";
const SETTING_KEYS = ["company.address"];

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
  // pompă de căldură: 70 kg, 120×100×30 cm, produs `pallet` (nu poate merge pe curier standard)
  palet = await seedE2eCartProduct(tag, "palet", {
    price: 800_000,
    shippingClass: "pallet",
    weightGrams: 70_000,
    dimensionsMm: [1200, 1000, 300],
  });
  // marfă standard de 100 kg: curierul DEMO costă 405 lei (peste pragul de 400), 1 palet = 350 lei
  greu = await seedE2eCartProduct(tag, "greu", { price: 500_000, weightGrams: 100_000 });
  obisnuit = await seedE2eCartProduct(tag, "obisnuit", { price: 19_900 });
  owner = await createAccount(request, baseURL as string, "owner");
});

test.afterAll(async () => {
  await removeE2eDemoCarrier();
  await removeE2eOrders({ tag });
  await removeE2eCarts();
  await removeE2eProducts();
  await clearE2ePalletSettings();
  await clearE2eSettings(SETTING_KEYS);
});

const next = (page: Page, id: string) => page.locator(`[data-continue="${id}"]`).click();

/** Coș → checkout → până la pasul «Livrare» (alegerea transportului). */
async function toShipping(page: Page, product: E2eCartProduct, email: string) {
  await addToCart(page, product);
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
  await delivery.getByLabel("Strada, numărul, blocul, apartamentul").fill("Str. Exemplu 1, bl. A");
  await delivery.getByLabel("Cod poștal").fill("510005");
  await next(page, "delivery");
  // oferta de ridicare apare mereu (adresa magazinului e setată): așteptăm să se încarce ofertele
  await expect(step(page, "shipping").locator('[data-offer="pickup"]')).toBeVisible();
}

async function placeCod(page: Page, offer: string): Promise<string> {
  await step(page, "shipping").locator(`[data-offer="${offer}"] input`).check();
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
  const text = (await page.locator("[data-order-number]").innerText()).trim();
  const match = /E2E-\d{6}/.exec(text);
  expect(match, text).not.toBeNull();
  return match![0];
}

test.describe("transport paletizat în checkout", () => {
  test("un produs `pallet`: doar transport paletizat, 350 lei, cu ramburs doar cu cardul", async ({
    page,
  }) => {
    await toShipping(page, palet, emailOf("palet"));
    const shipping = step(page, "shipping");
    const pallet = shipping.locator('[data-offer="pallet"]');
    await expect(pallet).toBeVisible();
    await expect(pallet).toContainText("Transport paletizat (marfă grea sau voluminoasă)");
    await expect(pallet).toContainText("Estimare: 1 palet.");
    await expect(pallet).toContainText("350,00");
    // nici curierul standard, nici easybox
    await expect(shipping.locator('[data-offer="demo:courier"]')).toHaveCount(0);
    await expect(shipping.locator('[data-offer="demo:easybox"]')).toHaveCount(0);
    await pallet.locator("input").check();
    await expect(shipping.locator("[data-ground-notice]")).toHaveText(
      "Livrarea se face la adresă, la nivelul solului; descărcarea și manipularea sunt în sarcina clientului.",
    );
    await next(page, "shipping");
    await expect(step(page, "billing")).toBeVisible();
    await next(page, "billing");
    const cod = step(page, "payment").locator('[data-method="cod"]');
    await expect(cod).toBeVisible();
    await expect(cod).toContainText("Plata la livrare doar cu cardul; curierul nu acceptă numerar");
    await expect(cod).not.toContainText("Plătești curierului");
    await cod.locator("input").check();
    await next(page, "payment");
    await page.getByRole("checkbox", { name: /Am citit și sunt de acord/ }).check();
    await page.locator("[data-checkout-submit]").click();
    await expect(page).toHaveURL(/\/comanda\/confirmare$/);
    await expect(page.locator("main")).toContainText(
      "Comanda este confirmată. Plata la livrare doar cu cardul; curierul nu acceptă numerar.",
    );
    const text = (await page.locator("[data-order-number]").innerText()).trim();
    paletNumber = /E2E-\d{6}/.exec(text)![0];
    const order = await readE2eOrder(paletNumber);
    expect(order).toMatchObject({
      shippingMethodCode: "pallet",
      paymentMethod: "cod",
      shippingMinor: 35_000,
    });
  });

  test("curierul peste 400 lei: curierul și easybox dispar, apare paletul de 350 lei", async ({
    page,
  }) => {
    await toShipping(page, greu, emailOf("greu"));
    const shipping = step(page, "shipping");
    await expect(shipping.locator('[data-offer="pallet"]')).toContainText("350,00");
    await expect(shipping.locator('[data-offer="demo:courier"]')).toHaveCount(0);
    await expect(shipping.locator('[data-offer="demo:easybox"]')).toHaveCount(0);
    // ridicarea personală rămâne mereu
    await expect(shipping.locator('[data-offer="pickup"]')).toBeVisible();
  });
});

test.describe("setările transportului paletizat", () => {
  test("se văd valorile implicite, valorile greșite se refuză, apoi paletul mai scump lasă curierul", async ({
    page,
  }) => {
    await login(page, owner, "/admin/setari/paleti");
    await expect(page.getByLabel(/Preț per palet/)).toHaveValue("350,00");
    await expect(page.getByLabel(/Prag de la care/)).toHaveValue("400,00");
    await expect(page.getByLabel(/Capacitatea unui palet în greutate/)).toHaveValue("600");
    await expect(page.getByLabel(/Capacitatea unui palet în volum/)).toHaveValue("1,2");

    // valoare greșită: mesaj pe câmp, nimic salvat
    await page.getByLabel(/Preț per palet/).fill("abc");
    await page.getByRole("button", { name: "Salvează" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Introdu o sumă pozitivă" }),
    ).toBeVisible();

    // paletul de 1.000 lei: mai scump decât curierul de ~405 lei, deci curierul rămâne
    await page.getByLabel(/Preț per palet/).fill("1000");
    await page.getByRole("button", { name: "Salvează" }).click();
    await expect(page.getByText("Salvat.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel(/Preț per palet/)).toHaveValue("1000,00");

    const client = await page.context().newPage();
    await toShipping(client, greu, emailOf("greu2"));
    const shipping = step(client, "shipping");
    await expect(shipping.locator('[data-offer="demo:courier"]')).toBeVisible();
    await expect(shipping.locator('[data-offer="pallet"]')).toHaveCount(0);
    await client.close();

    // înapoi la valoarea implicită
    await page.getByLabel(/Preț per palet/).fill("350");
    await page.getByRole("button", { name: "Salvează" }).click();
    await expect(page.getByText("Salvat.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel(/Preț per palet/)).toHaveValue("350,00");
  });
});

test.describe("expediere manuală, livrare și reconcilierea rambursului", () => {
  test("AWB manual la comanda paletizată: «expediată», email cu AWB, apoi «livrată»", async ({
    page,
  }) => {
    const order = await readE2eOrder(paletNumber);
    expect(order).not.toBeNull();
    await login(page, owner, `/admin/comenzi/${order!.id}`);
    const panel = page.locator("[data-shipment-panel]");
    await expect(panel).toContainText("Transport paletizat: AWB-ul se introduce manual");
    await panel.getByLabel("Transportator").fill("Transport Palet SRL");
    await panel.getByLabel("Număr AWB / document").fill(`PAL-${tag}`);
    await panel
      .getByLabel("Link de urmărire (opțional)")
      .fill(`https://urmarire.exemplu.ro/PAL-${tag}`);
    await panel.getByRole("button", { name: "Marchează expediată" }).click();
    // starea apare doar după răspunsul serverului: expedierea nouă, în tranzit
    const shipment = panel.locator('[data-shipment-status="in_transit"]');
    await expect(shipment).toContainText(`AWB PAL-${tag}`);
    await expect(panel.locator("[data-manual-shipment]")).toHaveCount(0);
    expect(await readE2eShipments(paletNumber)).toEqual([
      expect.objectContaining({
        mode: "manual",
        provider: null,
        carrier: "Transport Palet SRL",
        awb: `PAL-${tag}`,
        status: "in_transit",
      }),
    ]);
    expect((await readE2eOrder(paletNumber))?.fulfillmentStatus).toBe("in_transit");

    const mail = await waitForEmail(emailOf("palet"), { subject: /expediată/ });
    expect(mail.text).toContain(`PAL-${tag}`);
    expect(mail.text).toContain("Transport Palet SRL");

    await panel.getByRole("button", { name: "Marchează livrată" }).click();
    await expect(panel.locator('[data-shipment-status="delivered"]')).toBeVisible();
    expect((await readE2eOrder(paletNumber))?.fulfillmentStatus).toBe("delivered");
    await waitForEmail(emailOf("palet"), { subject: /livrat/i });
  });

  test("rambursul: comanda apare la reconciliere și se încasează cu suma, referința și data", async ({
    page,
  }) => {
    const order = await readE2eOrder(paletNumber);
    await login(page, owner, "/admin/comenzi/rambursuri");
    const row = page.locator(`[data-cod-row="${order!.id}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText("Transport Palet SRL");
    await row.getByRole("button", { name: "Marchează încasat" }).click();
    const dialog = page.getByRole("dialog");
    // validare: referință prea scurtă
    await dialog.getByLabel("Referința din extras").fill("x");
    await dialog.getByRole("button", { name: "Marchează încasat" }).click();
    await expect(
      dialog.getByRole("alert").filter({ hasText: "Referința are între" }),
    ).toBeVisible();
    // o sumă diferită cere decizie explicită
    await dialog.getByLabel("Suma virată").fill("1");
    await expect(dialog.getByText("Suma diferă de total: înregistrează totuși")).toBeVisible();
    await dialog.getByLabel("Suma virată").fill(String(order!.totalMinor / 100).replace(".", ","));
    await expect(dialog.getByText("Suma diferă de total: înregistrează totuși")).toHaveCount(0);
    await dialog.getByLabel("Referința din extras").fill(`OP-${tag}`);
    await dialog.getByRole("button", { name: "Marchează încasat" }).click();
    // rândul dispare doar după ce serverul a înregistrat încasarea
    await expect(row).toHaveCount(0);
    const after = await readE2eOrder(paletNumber);
    expect(after?.paymentStatus).toBe("paid");
    expect(after?.events).toContain("payment.cod_collected");
  });
});

test.describe("ridicare personală", () => {
  test("comanda cu ridicare nu primește AWB și nu are formular de expediere", async ({ page }) => {
    await toShipping(page, obisnuit, emailOf("ridicare"));
    carrierNumber = "";
    const number = await placeCod(page, "pickup");
    const order = await readE2eOrder(number);
    expect(order?.shippingMethodCode).toBe("pickup");
    await login(page, owner, `/admin/comenzi/${order!.id}`);
    await expect(page.locator("[data-shipment-pickup]")).toContainText(
      "Ridicare personală: comanda nu primește AWB",
    );
    await expect(page.locator("[data-manual-shipment]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Creează AWB" })).toHaveCount(0);
    expect(await readE2eShipments(number)).toEqual([]);
  });
});

test.describe("AWB prin curierul DEMO (simulat)", () => {
  test("în masă, cu ramburs transmis; etichete PDF și ZPL; anulare readuce comanda în listă", async ({
    page,
  }) => {
    await seedE2eDemoCarrier();
    await toShipping(page, obisnuit, emailOf("curier"));
    carrierNumber = await placeCod(page, "demo:courier");
    const order = (await readE2eOrder(carrierNumber))!;

    await login(page, owner, "/admin/comenzi/expedieri");
    const row = page.locator(`[data-bulk-row="${order.id}"]`);
    await expect(row).toBeVisible();
    await row.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Creează AWB pentru selecție" }).click();
    await expect(row).toContainText(/AWB DEMO\d{13}/);
    const [shipment] = await readE2eShipments(carrierNumber);
    expect(shipment).toMatchObject({
      mode: "provider",
      provider: "demo",
      status: "created",
      codAmountMinor: order.totalMinor,
    });
    expect((await readE2eOrder(carrierNumber))?.fulfillmentStatus).toBe("fulfilled");

    await page.goto(`/admin/comenzi/${order.id}`);
    const panel = page.locator("[data-shipment-panel]");
    await expect(panel).toContainText("Curier DEMO (simulat)");
    const pdf = await page.request.get(
      (await panel.getByRole("link", { name: "Etichetă PDF" }).getAttribute("href")) as string,
    );
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toContain("application/pdf");
    expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
    const zpl = await page.request.get(
      (await panel.getByRole("link", { name: "Etichetă ZPL" }).getAttribute("href")) as string,
    );
    expect(zpl.status()).toBe(200);
    expect(await zpl.text()).toContain("^XA");

    await panel.getByRole("button", { name: "Anulează AWB" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Da, anulează AWB-ul" }).click();
    await expect(panel.locator('[data-shipment-status="cancelled"]')).toBeVisible();
    expect((await readE2eOrder(carrierNumber))?.fulfillmentStatus).toBe("unfulfilled");
    await page.goto("/admin/comenzi/expedieri");
    await expect(page.locator(`[data-bulk-row="${order.id}"]`)).toBeVisible();
    await removeE2eDemoCarrier();
  });
});

test.describe("configurarea curierilor", () => {
  test("wootPRO și Sameday sunt «încă netestate cu un cont real»; LIVE e refuzat de server", async ({
    page,
  }) => {
    await login(page, owner, "/admin/setari/curieri");
    const woot = page.locator('[data-carrier="wootpro"]');
    await expect(woot).toBeVisible();
    await expect(woot).toContainText("Încă netestat cu un cont real");
    await expect(page.locator('[data-carrier="sameday"]')).toContainText(
      "Încă netestat cu un cont real",
    );
    // DEMO nu apare fără garda de dezvoltare? În E2E (E2E_HARNESS=1) apare; aici contează doar cardurile reale
    await woot.getByRole("button", { name: "Treci în LIVE" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Da, treci în LIVE" }).click();
    await expect(
      woot
        .getByRole("alert")
        .filter({ hasText: "adaptorul nu a fost încă testat cu un cont real" }),
    ).toBeVisible();
    await expect(woot).toContainText("Mod test");
  });
});

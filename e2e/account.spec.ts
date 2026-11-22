import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import {
  countE2eReturnsOfOrder,
  readE2eReturn,
  removeE2eCarts,
  removeE2eOrders,
  removeE2eProducts,
  seedE2eAccountOrder,
  seedE2eCartProduct,
  setE2eOrderSecrets,
  type E2eAccountOrder,
  type E2eCartProduct,
} from "../packages/core/test/e2e-support";
import { createAccount, login, type Account } from "./support/card-flow";

/**
 * Contul clientului și retururile (Faza 14), din browser: sumarul și istoricul comenzilor, detaliul cu cronologia fără nimic intern,
 * cererea de retur (cantitate peste cât a rămas, dialog de confirmare), izolarea între clienți (comenzile, returul și factura altui
 * client dau 404), fluxul adminului (aprobare, AWB manual, recepție, inspecție, rambursare pornită), anularea de către client, agenda
 * de adrese, datele personale (profil, preferințe, export, ștergere refuzată sau reușită) și «Favorite» cu flag-ul oprit (404).
 * Comenzile se pregătesc direct în baza de test (livrate, plătite) și se șterg pe tag, odată cu returele lor; starea comună nu se
 * schimbă (flag-ul `wishlist` nu se pornește aici: ar atinge alte specuri). Conturile de test au parole generate în test.
 */
const tag = randomBytes(3).toString("hex");

test.describe.configure({ mode: "serial" });

const NOTE = `NOTA-INTERNA-${tag}`;
const SUPPLIER = `FURNIZOR-${tag}`;

let produs: E2eCartProduct;
let client: Account;
let other: Account;
let admin: Account;
let delivered: E2eAccountOrder;
let undelivered: E2eAccountOrder;
let foreign: E2eAccountOrder;
let returnId = "";

test.beforeAll(async ({ request, baseURL }) => {
  produs = await seedE2eCartProduct(tag, "produs", { price: 19_900 });
  client = await createAccount(request, baseURL as string, "");
  other = await createAccount(request, baseURL as string, "");
  admin = await createAccount(request, baseURL as string, "owner");
  const sku = produs.sku;
  delivered = await seedE2eAccountOrder({
    tag,
    key: "livrata",
    customerEmail: client.email,
    variantSku: sku,
    unitPriceMinor: 19_900,
    deliveredDaysAgo: 2,
  });
  undelivered = await seedE2eAccountOrder({
    tag,
    key: "nelivrata",
    customerEmail: client.email,
    variantSku: sku,
    unitPriceMinor: 19_900,
    deliveredDaysAgo: null,
  });
  foreign = await seedE2eAccountOrder({
    tag,
    key: "strain",
    customerEmail: other.email,
    variantSku: sku,
    unitPriceMinor: 19_900,
    deliveredDaysAgo: 2,
  });
  await setE2eOrderSecrets(delivered.orderId, { adminNote: NOTE, supplierName: SUPPLIER });
});

test.afterAll(async () => {
  await removeE2eOrders({ tag });
  await removeE2eCarts();
  await removeE2eProducts();
});

const returnIdFrom = (page: Page): string => new URL(page.url()).pathname.split("/").pop() ?? "";

test.describe("comenzile clientului", () => {
  test("sumarul și istoricul arată comenzile lui; detaliul nu conține nimic intern", async ({
    page,
  }) => {
    await login(page, client, "/cont");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Bună");
    await expect(page.getByText(delivered.orderNumber)).toBeVisible();
    await page.goto("/cont/comenzi");
    await expect(page.getByText(delivered.orderNumber)).toBeVisible();
    await expect(page.getByText(undelivered.orderNumber)).toBeVisible();
    await expect(page.getByText(foreign.orderNumber)).toHaveCount(0);
    await page.goto(`/cont/comenzi/${delivered.orderId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(delivered.orderNumber);
    await expect(page.locator("[data-timeline]").first()).toContainText("Comanda a fost livrată");
    const text = await page.locator("main").innerText();
    expect(text).not.toContain(NOTE);
    expect(text).not.toContain(SUPPLIER);
    expect(text).toContain("Nu există încă facturi emise");
  });

  test("returul nu se poate cere înainte de livrare", async ({ page }) => {
    await login(page, client, `/cont/comenzi/${undelivered.orderId}`);
    await expect(page.getByRole("link", { name: "Solicită retur" })).toHaveCount(0);
    await expect(page.getByText("Returul se poate cere după livrare")).toBeVisible();
  });
});

test.describe("cererea de retur", () => {
  test("cantitate peste cât a rămas: refuzată de server; apoi o cerere validă, cu dialog de confirmare", async ({
    page,
  }) => {
    await login(page, client, `/cont/comenzi/${delivered.orderId}`);
    await page.getByRole("link", { name: "Solicită retur" }).click();
    await page.waitForURL(/\/cont\/retururi\/nou/);
    const line = page.locator("[data-return-line]").first();
    await line.getByRole("checkbox").check();
    await line.getByLabel(/Cantitate/).fill("4");
    await line.getByLabel("Motivul").selectOption("defective");
    await page.getByRole("button", { name: "Trimite cererea de retur" }).click();
    await page.locator("[data-return-confirm]").click();
    await expect(page.locator("[data-return-error]")).toContainText("depășește ce a rămas");
    // validare locală: fără motiv, cu mesaj propriu și focus pe câmp
    await line.getByLabel(/Cantitate/).fill("1");
    await line.getByLabel("Motivul").selectOption("");
    await page.getByRole("button", { name: "Trimite cererea de retur" }).click();
    await expect(line.locator('[id$="-error"]')).toContainText("Alege motivul");
    await line.getByLabel("Motivul").selectOption("defective");
    await page.getByRole("button", { name: "Trimite cererea de retur" }).click();
    await page.locator("[data-return-confirm]").click();
    await page.waitForURL(/\/cont\/retururi\/(?!nou)[a-z0-9]+$/);
    returnId = returnIdFrom(page);
    await expect(page.locator("[data-account-return]")).toContainText("Cerut");
    await expect(page.locator("[data-timeline]")).toContainText("Cererea a fost primită");
    expect(await countE2eReturnsOfOrder(delivered.orderId)).toBe(1);
  });
});

test.describe("izolarea între clienți", () => {
  test("alt client nu vede comanda, returul sau factura clientului", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, other, "/cont");
    const order = await page.goto(`/cont/comenzi/${delivered.orderId}`);
    expect(order?.status()).toBe(404);
    const ret = await page.goto(`/cont/retururi/${returnId}`);
    expect(ret?.status()).toBe(404);
    const form = await page.goto(`/cont/retururi/nou?comanda=${delivered.orderId}`);
    expect(form?.status()).toBe(404);
    const invoice = await page.request.get(`/api/account/invoices/${returnId}`);
    expect(invoice.status()).toBe(404);
    await page.goto("/cont/retururi");
    await expect(page.getByText(/R-\d+/)).toHaveCount(0);
    await context.close();
  });

  test("fără sesiune, contul trimite la autentificare", async ({ page }) => {
    await page.goto("/cont/comenzi");
    await page.waitForURL(/\/autentificare/);
    const exportCall = await page.request.post("/api/account/export");
    expect(exportCall.status()).toBe(401);
  });
});

test.describe("fluxul adminului pe retur", () => {
  test("aprobare, AWB manual, recepție, inspecție și rambursare pornită", async ({ page }) => {
    await login(page, admin, `/admin/comenzi/retururi/${returnId}`);
    await expect(page.locator("[data-admin-return]")).toContainText("Cerut");
    await page.locator("[data-return-approve]").click();
    await page.locator("[data-return-confirm]").click();
    await expect(page.locator("[data-admin-return]").getByText("Aprobat").first()).toBeVisible();
    await page.getByLabel("Curier").fill("Curier Test");
    await page.getByLabel("Număr AWB").fill(`AWB-${tag}`);
    await page.locator("[data-return-awb-save]").click();
    await expect(page.locator("[data-return-facts]")).toContainText(`AWB-${tag}`);
    await expect(
      page.locator("[data-admin-return]").getByText("Așteaptă coletul").first(),
    ).toBeVisible();
    await page.locator("[data-return-receive]").click();
    await page.locator("[data-return-confirm]").click();
    await expect(page.locator("[data-inspect-line]").first()).toBeVisible();
    await page.locator("[data-return-inspect]").click();
    await expect(page.locator("[data-return-refund]")).toBeVisible();
    await page.locator("[data-return-refund]").click();
    await page.locator("[data-return-confirm]").click();
    await expect(page.locator("[data-return-refund-state]")).toContainText("199,00");
    const state = await readE2eReturn(returnId);
    expect(state?.status).toBe("inspected");
    expect(state?.refundProductsMinor).toBe(19_900);
  });

  test("clientul vede AWB-ul de retur și starea; nu vede nota internă", async ({ page }) => {
    await login(page, client, `/cont/retururi/${returnId}`);
    await expect(page.locator("[data-return-awb]")).toContainText(`AWB-${tag}`);
    await expect(page.locator("[data-account-return]")).toContainText("Inspectat");
    expect(await page.locator("main").innerText()).not.toContain(NOTE);
  });
});

test.describe("anularea returului de către client", () => {
  test("un retur nou se poate anula din cont, cu dialog de confirmare", async ({ page }) => {
    await login(page, client, `/cont/retururi/nou?comanda=${delivered.orderId}`);
    const line = page.locator("[data-return-line]").first();
    await line.getByRole("checkbox").check();
    await line.getByLabel(/Cantitate/).fill("1");
    await line.getByLabel("Motivul").selectOption("changed_mind");
    await page.getByRole("button", { name: "Trimite cererea de retur" }).click();
    await page.locator("[data-return-confirm]").click();
    await page.waitForURL(/\/cont\/retururi\/(?!nou)[a-z0-9]+$/);
    const id = returnIdFrom(page);
    await page.getByRole("button", { name: "Anulează returul" }).click();
    await page.locator("[data-cancel-confirm]").click();
    await expect(page.locator("[data-account-return]")).toContainText("Anulat");
    expect((await readE2eReturn(id))?.status).toBe("cancelled");
  });
});

test.describe("agenda de adrese", () => {
  test("se adaugă o adresă (devine implicită), se modifică și se șterge cu dialog", async ({
    page,
  }) => {
    await login(page, client, "/cont/adrese");
    await page.locator("[data-address-add]").click();
    const form = page.locator("[data-address-form]");
    // validare locală, cu mesaje proprii
    await form.getByRole("button", { name: "Salvează adresa" }).click();
    await expect(form.getByText("Scrie numele complet")).toBeVisible();
    await form.getByLabel("Nume și prenume").fill("Ion Popescu");
    await form.getByLabel("Telefon").fill("0722123456");
    await form.getByLabel("Județ").selectOption({ index: 1 });
    await expect(form.getByLabel("Localitate").locator("option")).not.toHaveCount(1);
    await form.getByLabel("Localitate").selectOption({ index: 1 });
    await form.getByLabel("Strada și numărul").fill("Str. Exemplu 1");
    await form.getByLabel("Cod poștal").fill("123456");
    await form.getByRole("button", { name: "Salvează adresa" }).click();
    await expect(page.locator("[data-address-card]")).toHaveCount(1);
    await expect(page.locator("[data-address-card]")).toContainText("Implicită pentru livrare");
    await page.getByRole("button", { name: "Modifică" }).click();
    await page.locator("[data-address-form]").getByLabel("Strada și numărul").fill("Str. Nouă 9");
    await page
      .locator("[data-address-form]")
      .getByRole("button", { name: "Salvează adresa" })
      .click();
    await expect(page.locator("[data-address-form]")).toHaveCount(0);
    await expect(page.locator("[data-address-card]")).toContainText("Str. Nouă 9");
    await page.getByRole("button", { name: "Șterge", exact: true }).click();
    await page.locator("[data-address-remove-confirm]").click();
    await expect(page.locator("[data-address-card]")).toHaveCount(0);
  });
});

test.describe("date personale", () => {
  test("profil, preferințe (marketing implicit oprit), export fără câmpuri interne", async ({
    page,
  }) => {
    await login(page, client, "/cont/date-personale");
    const profile = page.locator("[data-profile-form]");
    await profile.getByLabel("Nume").fill("Ana Test");
    await profile.getByLabel("Telefon").fill("0733 111 222");
    await profile.getByRole("button", { name: "Salvează" }).click();
    await expect(page.locator("[data-profile-message]")).toContainText("Datele au fost salvate");
    await expect(page.locator("[data-marketing-toggle]")).not.toBeChecked();
    await page.locator("[data-marketing-toggle]").check();
    await expect(page.locator("[data-marketing-message]")).toContainText(
      "Preferința a fost salvată",
    );
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("[data-export-button]").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^date-cont-\d{4}-\d{2}-\d{2}\.json$/);
    const path = await download.path();
    const raw = await readFile(path, "utf8");
    const dump = JSON.parse(raw) as {
      orders: Array<{ number: string }>;
      preferences: { marketingOptIn: boolean };
    };
    expect(dump.orders.map((o) => o.number)).toContain(delivered.orderNumber);
    expect(dump.orders.map((o) => o.number)).not.toContain(foreign.orderNumber);
    expect(dump.preferences.marketingOptIn).toBe(true);
    expect(raw).not.toContain(NOTE);
    expect(raw).not.toContain(SUPPLIER);
    expect(raw).not.toMatch(/costPrice|adminNote|supplier|rawPayload/);
  });

  test("ștergerea e refuzată cât există comenzi nefinalizate (cu mesaj clar)", async ({ page }) => {
    await login(page, client, "/cont/date-personale");
    await page.locator("[data-delete-open]").click();
    await page.locator("[data-delete-form]").getByLabel("Parola").fill(client.password);
    await page.locator("[data-delete-confirm]").click();
    await expect(page.locator("[data-delete-error]")).toContainText("comenzi nefinalizate");
  });

  test("ștergerea reușește pe un cont fără comenzi nefinalizate: contul se anonimizează și nu se mai poate folosi", async ({
    page,
    request,
    baseURL,
  }) => {
    const temporary = await createAccount(request, baseURL as string, "");
    await login(page, temporary, "/cont/date-personale");
    await page.locator("[data-delete-open]").click();
    await page.locator("[data-delete-form]").getByLabel("Parola").fill("parola-gresita-123");
    await page.locator("[data-delete-confirm]").click();
    await expect(page.locator("[data-delete-error]")).toContainText("Parola nu este corectă");
    await page.locator("[data-delete-form]").getByLabel("Parola").fill(temporary.password);
    await page.locator("[data-delete-confirm]").click();
    await page.waitForURL((url) => url.pathname === "/");
    await page.goto("/cont");
    await page.waitForURL(/\/autentificare/);
    await page.getByLabel("Email").fill(temporary.email);
    await page.getByLabel("Parolă", { exact: true }).fill(temporary.password);
    await page.getByRole("button", { name: "Intră în cont" }).click();
    await expect(page).toHaveURL(/\/autentificare/);
  });
});

test.describe("favorite cu flag-ul oprit", () => {
  test("ruta și API-ul dau 404, iar meniul nu are «Favorite»", async ({ page }) => {
    await login(page, client, "/cont");
    await expect(page.locator("[data-account-nav]").getByText("Favorite")).toHaveCount(0);
    const route = await page.goto("/cont/favorite");
    expect(route?.status()).toBe(404);
    const api = await page.request.get("/api/account/wishlist-state");
    expect(api.status()).toBe(404);
    const product = await page.goto(`/produs/${produs.slug}`);
    expect(product?.status()).toBe(200);
    await expect(page.locator("[data-wishlist-button]")).toHaveCount(0);
  });
});

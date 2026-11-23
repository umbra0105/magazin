import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  readE2eDigitalAssets,
  readE2eEntitlement,
  removeE2eCarts,
  removeE2eOrders,
  removeE2eProducts,
  revokeE2eEntitlement,
  seedE2eDigitalOrder,
  seedE2eDigitalProduct,
  type E2eDigitalOrder,
  type E2eDigitalProduct,
} from "../packages/core/test/e2e-support";
import { createAccount, login, type Account } from "./support/card-flow";

/**
 * Produsele digitale (Faza 14b), din browser: adminul încarcă un modul din tabul «Conținut digital» (cu progres) și îl marchează
 * previzualizare; clientul își vede biblioteca (acces acordat, «în așteptarea livrării» la ramburs mixt), descarcă prin linkuri scurte
 * cu contor și limită, vede starea «Revocat», iar alt client primește 404 pe orice cale; previzualizarea e publică doar pentru
 * modulul marcat; panoul «Acces digital» din comandă resetează contorul; exportul de date conține achizițiile fără chei.
 * Checkout-ul pentru digital NU face parte din fază (14c): comenzile se pregătesc direct în baza de test și se șterg pe tag, odată cu
 * drepturile lor de acces. Conturile de test au parole generate în test. Fișierele încărcate rămân în stocarea de test.
 */
const tag = randomBytes(3).toString("hex");

test.describe.configure({ mode: "serial" });

const FILE_TEXT = `Conținut de test ${tag}`;
const FILE_NAME = `ghid-${tag}.txt`;

let product: E2eDigitalProduct;
let client: Account;
let other: Account;
let admin: Account;
let granted: E2eDigitalOrder;
let waiting: E2eDigitalOrder;
let assetId = "";

test.beforeAll(async ({ request, baseURL }) => {
  product = await seedE2eDigitalProduct(tag, "curs", { maxDownloads: 2 });
  client = await createAccount(request, baseURL as string, "");
  other = await createAccount(request, baseURL as string, "");
  admin = await createAccount(request, baseURL as string, "owner");
  granted = await seedE2eDigitalOrder({
    tag,
    key: "acordat",
    customerEmail: client.email,
    product,
    granted: true,
  });
  waiting = await seedE2eDigitalOrder({
    tag,
    key: "asteptare",
    customerEmail: client.email,
    product,
    granted: false,
  });
});

test.afterAll(async () => {
  await removeE2eOrders({ tag });
  await removeE2eCarts();
  await removeE2eProducts();
});

test.describe("administrare", () => {
  test("tabul «Conținut digital»: încarcă un fișier cu progres, îl marchează previzualizare gratuită", async ({
    page,
  }) => {
    await login(page, admin, `/admin/produse/${product.productId}?tab=digital`);
    await expect(page.locator("[data-digital-tab]")).toBeVisible();
    await expect(page.getByText("Nu există încă niciun modul")).toBeVisible();

    await page.locator("#dg-file").setInputFiles({
      name: FILE_NAME,
      mimeType: "text/plain",
      buffer: Buffer.from(FILE_TEXT, "utf8"),
    });
    await page.locator("#dg-upload-name").fill(`Ghid ${tag}`);
    await page.locator("#dg-upload-preview").check();
    await page.getByRole("button", { name: "Încarcă", exact: true }).click();
    // starea apare DOAR după răspunsul serverului: modulul din listă
    await expect(page.locator("[data-digital-asset]")).toHaveCount(1);
    await expect(page.getByText("Modulul a fost încărcat.")).toBeVisible();

    const assets = await readE2eDigitalAssets(product.productId);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ title: `Ghid ${tag}`, type: "file", isPreview: true });
    assetId = assets[0]?.id ?? "";
    // cheia de stocare nu apare nicăieri în pagină
    expect(await page.content()).not.toContain("private/digital");
  });

  test("un fișier cu extensie activă (.html) e refuzat de server, fără să apară în listă", async ({
    page,
  }) => {
    await login(page, admin, `/admin/produse/${product.productId}?tab=digital`);
    await page.locator("#dg-file").setInputFiles({
      name: "pagina.html",
      mimeType: "text/html",
      buffer: Buffer.from("<script>alert(1)</script>", "utf8"),
    });
    await page.getByRole("button", { name: "Încarcă", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "nu a putut fi încărcat" }),
    ).toBeVisible();
    expect(await readE2eDigitalAssets(product.productId)).toHaveLength(1);
  });
});

test.describe("clientul", () => {
  test("biblioteca: dreptul acordat cu descărcările rămase și comanda «în așteptarea livrării»", async ({
    page,
  }) => {
    await login(page, client, "/cont/produsele-mele");
    const items = page.locator("[data-digital-items] li");
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText(product.title);
    await expect(items.first()).toContainText("Descărcări rămase: 2 din 2");
    const pending = page.locator("[data-digital-pending] li");
    await expect(pending).toHaveCount(1);
    await expect(pending.first()).toContainText("În așteptarea livrării");
    await expect(pending.first()).toContainText("nu la plata către curier");
    // nicio cheie și niciun jeton de la altcineva în pagină
    const html = await page.content();
    expect(html).not.toContain("private/digital");
    await expect(pending.first()).toContainText(waiting.orderNumber);
  });

  test("detaliul: modulul se descarcă prin link scurt, contorul scade, la limită cererea e refuzată", async ({
    page,
    request,
    baseURL,
  }) => {
    await login(page, client, `/cont/produsele-mele/${granted.token}`);
    await expect(page.locator("[data-digital-module]")).toHaveCount(1);
    const ask = () =>
      page.request.post(`${baseURL}/api/cont/digital/acces`, {
        headers: { origin: baseURL as string, accept: "application/json" },
        data: { token: granted.token, asset: assetId },
      });

    const first = await ask();
    expect(first.status()).toBe(200);
    const body = (await first.json()) as { ok: boolean; url: string; remainingDownloads: number };
    expect(body).toMatchObject({ ok: true, remainingDownloads: 1 });
    expect(first.headers()["cache-control"]).toContain("no-store");
    // linkul semnat chiar servește fișierul
    const file = await request.get(body.url);
    expect(file.status()).toBe(200);
    expect(await file.text()).toBe(FILE_TEXT);

    expect((await ask()).status()).toBe(200);
    const third = await ask();
    expect(third.status()).toBe(403);
    expect(await third.json()).toMatchObject({ ok: false, code: "DIGITAL_LIMIT_REACHED" });
    expect(await readE2eEntitlement(granted.orderId)).toMatchObject({
      downloadCount: 2,
      maxDownloads: 2,
    });

    // din formular: aceeași limită, cu mesaj pe pagină
    await page.goto(`/cont/produsele-mele/${granted.token}`);
    await page.getByRole("button", { name: "Descarcă" }).click();
    await expect(page.getByRole("alert")).toContainText("limita de descărcări");
  });

  test("adminul resetează contorul din panoul «Acces digital»; clientul descarcă din nou", async ({
    page,
    baseURL,
  }) => {
    await login(page, admin, `/admin/comenzi/${granted.orderId}`);
    const panel = page.locator("[data-digital-panel]");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("2 din 2 descărcări");
    await panel.getByRole("button", { name: "Resetează contorul" }).click();
    await page.getByLabel("Motiv (obligatoriu)").fill("Clientul a pierdut fișierul");
    await page.getByRole("button", { name: "Confirmă" }).click();
    await expect(panel).toContainText("0 din 2 descărcări");
    expect(await readE2eEntitlement(granted.orderId)).toMatchObject({ downloadCount: 0 });

    // altă identitate în aceeași pagină: sesiunea adminului se închide întâi
    await page.context().clearCookies();
    await login(page, client, "/cont/produsele-mele");
    const response = await page.request.post(`${baseURL}/api/cont/digital/acces`, {
      headers: { origin: baseURL as string, accept: "application/json" },
      data: { token: granted.token, asset: assetId },
    });
    expect(response.status()).toBe(200);
  });

  test("alt client primește 404 pe pagină și pe cerere de link; fără sesiune: 401", async ({
    page,
    request,
    baseURL,
  }) => {
    await login(page, other, "/cont");
    expect((await page.goto(`/cont/produsele-mele/${granted.token}`))?.status()).toBe(404);
    const response = await page.request.post(`${baseURL}/api/cont/digital/acces`, {
      headers: { origin: baseURL as string, accept: "application/json" },
      data: { token: granted.token, asset: assetId },
    });
    expect(response.status()).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, code: "DIGITAL_NOT_FOUND" });
    // fără cont
    const anonymous = await request.post(`${baseURL}/api/cont/digital/acces`, {
      headers: { origin: baseURL as string, accept: "application/json" },
      data: { token: granted.token, asset: assetId },
    });
    expect(anonymous.status()).toBe(401);
    // origine străină
    const foreign = await page.request.post(`${baseURL}/api/cont/digital/acces`, {
      headers: { origin: "https://alt-site.example", accept: "application/json" },
      data: { token: granted.token, asset: assetId },
    });
    expect(foreign.status()).toBe(403);
  });

  test("previzualizarea e publică doar pentru modulul marcat; produsul arată secțiunea fără chei", async ({
    page,
    request,
    baseURL,
  }) => {
    const preview = await request.get(`${baseURL}/api/digital/previzualizare/${assetId}`);
    expect(preview.status()).toBe(200);
    expect(await preview.json()).toMatchObject({ ok: true, kind: "url" });
    expect((await request.get(`${baseURL}/api/digital/previzualizare/nu-exista`)).status()).toBe(
      404,
    );

    await page.goto(`/produs/${product.slug}`);
    await expect(page.locator("[data-digital-section]")).toBeVisible();
    await expect(page.getByText("Acces imediat după plată").first()).toBeVisible();
    expect(await page.content()).not.toContain("private/digital");
  });

  test("dreptul retras: biblioteca arată «Revocat», detaliul spune că accesul a fost retras, linkul nu se mai emite", async ({
    page,
    baseURL,
  }) => {
    await revokeE2eEntitlement(granted.orderId);
    await login(page, client, "/cont/produsele-mele");
    await expect(page.locator("[data-digital-items] li").first()).toContainText("Revocat");
    await page.goto(`/cont/produsele-mele/${granted.token}`);
    await expect(page.getByText("Accesul la acest produs a fost retras")).toBeVisible();
    const response = await page.request.post(`${baseURL}/api/cont/digital/acces`, {
      headers: { origin: baseURL as string, accept: "application/json" },
      data: { token: granted.token, asset: assetId },
    });
    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({ code: "DIGITAL_REVOKED" });
  });

  test("exportul de date conține achiziția digitală, fără chei de stocare sau jetoane", async ({
    page,
  }) => {
    await login(page, client, "/cont/date-personale");
    const response = await page.request.get("/api/account/export");
    expect(response.status()).toBe(200);
    const text = await response.text();
    const dump = JSON.parse(text) as { digitalPurchases: Array<{ orderNumber: string }> };
    expect(dump.digitalPurchases.map((p) => p.orderNumber)).toContain(granted.orderNumber);
    expect(text).not.toContain("private/digital");
    expect(text).not.toContain(granted.token ?? "nu-exista");
  });
});

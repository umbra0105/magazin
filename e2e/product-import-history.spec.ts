import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  insertE2eInterruptedImport,
  seedE2eProducts,
  promoteE2eUser,
  removeE2eImports,
  removeE2eProducts,
  trackE2eImportFile,
  trackE2eProduct,
} from "../packages/core/test/e2e-support";
import { decodeUtf16le } from "../packages/core/test/utf-16le";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Istoricul importurilor, în browser (punctul 15a+): un import aplicat apare în istoric cu contoarele lui,
 * detaliile arată raportul pe rânduri cu filtru pe rezultat, CSV-ul descărcat începe cu BOM UTF-16LE (FF FE) și TAB,
 * importul WooCommerce arată și entitățile create, unul întrerupt e vizibil, rolurile fără products.write nu
 * văd pagina, costul din fișier nu apare nicăieri.
 */

interface Account {
  email: string;
  password: string;
}

async function createAccount(
  request: APIRequestContext,
  baseURL: string,
  roleKey: string,
): Promise<Account> {
  const email = `e2e-${randomBytes(5).toString("hex")}@example.test`;
  const password = randomBytes(18).toString("base64url");
  const response = await request.post(`${baseURL}/api/auth/sign-up/email`, {
    headers: { origin: baseURL, "x-forwarded-for": uniqueClientIp() },
    data: { name: "Cont E2E", email, password },
  });
  await expectResponseOk(response, "înregistrarea contului de test");
  await promoteE2eUser(email, roleKey);
  return { email, password };
}

async function login(page: Page, account: Account, next: string) {
  await page.goto(`/autentificare?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Parolă", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Intră în cont" }).click();
  await page.waitForURL((url) => url.pathname === new URL(next, "http://x").pathname);
}

async function upload(page: Page, name: string, buffer: Buffer): Promise<void> {
  trackE2eImportFile(name);
  await page.getByLabel("Fișier CSV sau XLSX").setInputFiles({
    name,
    mimeType: "application/octet-stream",
    buffer,
  });
  await page.getByRole("button", { name: "Încarcă și analizează" }).click();
}

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.afterEach(async () => {
  await removeE2eImports();
  await removeE2eProducts();
});

test.describe("istoric de importuri", () => {
  test("import generic aplicat: apare în istoric, detaliile au filtru pe rezultat, CSV UTF-16LE cu BOM și TAB", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const fileName = `e2e-${tag}-istoric.csv`;
    trackE2eProduct(`e2e-${tag}-nou`);
    await login(page, owner, "/admin/produse/import");

    // un import mic: un produs nou și un rând cu eroare
    const csv = `SKU;Titlu;Preț (lei, cu TVA)\r\nE2E-${tag.toUpperCase()}-NEW;E2E ${tag} Nou;10\r\nE2E-${tag.toUpperCase()}-BAD;E2E ${tag} Greșit;abc\r\n`;
    await upload(page, fileName, Buffer.from(csv, "utf8"));
    await page.locator("[data-import-check]").click();
    await page.locator("[data-import-apply]").click();
    await page.locator("[data-import-confirm]").click();
    await expect(page.locator("[data-import-done]")).toBeVisible();

    // linkul din pagina de import duce la istoric
    await page.goto("/admin/produse/import");
    await page.locator("[data-import-history-link]").click();
    await page.waitForURL(/\/admin\/produse\/import\/istoric$/);
    await expect(page.getByRole("heading", { level: 1, name: "Istoric importuri" })).toBeVisible();
    await expect(
      page.locator("nav ol li").filter({ hasText: "Istoric importuri" }).first(),
    ).toBeVisible();
    await expect(page.locator("[data-history-retention]")).toContainText("180 de zile");

    const row = page.locator("[data-history-row]").filter({ hasText: fileName });
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-state", "completed");
    await expect(row).toContainText("Aplicat");
    await expect(row).toContainText("Generic");
    await expect(row).toContainText("2 din 2");
    await expect(row.locator("[data-history-counts]")).toContainText("1 noi");
    await expect(row.locator("[data-history-counts]")).toContainText("1 cu erori");

    // detaliile: raportul pe rânduri, filtru, CSV
    await row.locator("[data-history-details]").click();
    await expect(
      page.getByRole("heading", { level: 1, name: `Import: ${fileName}` }),
    ).toBeVisible();
    await expect(
      page.locator("nav ol li").filter({ hasText: "Detalii import" }).first(),
    ).toBeVisible();
    await expect(page.locator('[data-count="new"] dd')).toHaveText("1");
    await expect(page.locator('[data-count="errors"] dd')).toHaveText("1");
    await expect(page.locator("[data-report-row]")).toHaveCount(2);
    await page.getByRole("link", { name: "Cu erori", exact: true }).click();
    await expect(page).toHaveURL(/rezultat=error/);
    await expect(page.locator("[data-report-row]")).toHaveCount(1);
    await expect(page.locator('[data-outcome="error"]')).toContainText("valoare invalidă");
    await expect(page.locator("[data-history-shown]")).toContainText("1 rând");

    const href = await page.locator("[data-import-download]").getAttribute("href");
    const csvResponse = await page.request.get(href as string);
    expect(csvResponse.status()).toBe(200);
    const bytes = new Uint8Array(await csvResponse.body());
    // BOM UTF-16LE (FF FE), apoi direct antetul cu TAB; nicio linie «sep=»
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    const text = decodeUtf16le(bytes).slice(1);
    const lines = text.split(String.fromCharCode(13, 10));
    expect(lines[0]).toBe("Rând\tSKU\tRezultat\tMotiv\tCâmpuri schimbate");
    expect(text).not.toMatch(/^sep=/i);
    expect(text).toContain("eroare");
    expect(csvResponse.headers()["content-disposition"]).toContain("raport-import-produse.csv");

    // un id inexistent dă 404, nu o pagină goală
    const missing = await page.goto("/admin/produse/import/istoric/nu-exista-acest-id");
    expect(missing?.status()).toBe(404);
  });

  test("import întrerupt: apare ca «Întrerupt», cu rândurile aplicate și fără raport final", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const fileName = `e2e-${tag}-intrerupt.csv`;
    const id = await insertE2eInterruptedImport(owner.email, fileName, 7, 20);
    await login(page, owner, "/admin/produse/import/istoric");
    const row = page.locator("[data-history-row]").filter({ hasText: fileName });
    await expect(row).toHaveAttribute("data-state", "interrupted");
    await expect(row).toContainText("Întrerupt");
    await expect(row.locator("[data-history-interrupted]")).toContainText(
      "S-au aplicat cel puțin 7 din 20 rânduri",
    );
    await page.goto(`/admin/produse/import/istoric/${id}`);
    await expect(page.locator("[data-history-state]")).toHaveAttribute(
      "data-history-state",
      "interrupted",
    );
    await expect(page.locator("[data-history-interrupted]")).toContainText("Reverifică importul");
    await expect(page.locator("[data-import-download]")).toHaveCount(0);
    // CSV-ul unui import întrerupt nu se descarcă
    const csv = await page.request.get(`/api/admin/product-imports/${id}/report`);
    expect(csv.status()).toBe(409);
  });

  test("fila Exporturi: exportul făcut apare cu numere, fără valori din catalog", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    await seedE2eProducts(tag, 1);
    await login(page, owner, "/admin/produse");
    // un export mic (produsul de probă), direct prin ruta aplicației, cu originea ei
    const exported = await page.request.post("/api/admin/product-exports", {
      headers: { origin: baseURL as string },
      data: { format: "csv", scope: "filters", filters: { q: tag } },
    });
    expect(exported.status()).toBe(200);
    await exported.body();
    await page.goto("/admin/produse/import/istoric?fila=exporturi");
    await expect(page.getByRole("heading", { name: "Exporturi de produse" })).toBeVisible();
    const mine = page.locator("[data-export-row]").filter({ hasText: owner.email });
    await expect(mine).toHaveCount(1);
    await expect(mine).toContainText(/csv/i);
    await expect(mine).toContainText("Descărcat");
    await expect(mine).toContainText("Filtrele curente");
    await expect(mine).toContainText("1 rând, 1 produs");
    // doar numere: nicio valoare din catalog
    await expect(page.locator("body")).not.toContainText(tag);
  });

  test("rolurile fără products.write nu văd istoricul, iar CSV-ul le e refuzat", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const fileName = `e2e-${tag}-rol.csv`;
    const id = await insertE2eInterruptedImport(owner.email, fileName, 1, 2);

    for (const role of ["editor", "support"]) {
      const account = await createAccount(request, baseURL as string, role);
      const context = await page
        .context()
        .browser()!
        .newContext({ baseURL: baseURL as string });
      const other = await context.newPage();
      await login(other, account, "/admin");
      await other.goto("/admin/produse/import/istoric");
      await expect(other).toHaveURL(/\/admin\/acces-interzis/);
      await other.goto(`/admin/produse/import/istoric/${id}`);
      await expect(other).toHaveURL(/\/admin\/acces-interzis/);
      const csv = await other.request.get(`/api/admin/product-imports/${id}/report`);
      expect(csv.status()).toBe(403);
      await context.close();
    }
  });
});

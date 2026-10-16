import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { WOO_COST_SENTINEL, syntheticWooRows, wooCsv } from "../packages/core/test/woo-fixture";
import {
  promoteE2eUser,
  readE2eAuditByEntity,
  readE2eWooFixtureState,
  removeE2eImports,
  removeE2eWooFixtureData,
  trackE2eImportFile,
} from "../packages/core/test/e2e-support";

/**
 * Importul WooCommerce în browser (punctul 15a), pe fixture-ul SINTETIC (fără conținut din exportul real):
 * alegerea profilului, opțiunile (stare, unități, clase de livrare, atribute), verificarea fără modificări cu
 * lista a ce se creează, confirmarea, aplicarea, a doua rulare = «neschimbat», fișier greșit la profil,
 * prețul de achiziție nepătruns.
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
    headers: { origin: baseURL },
    data: { name: "Cont E2E", email, password },
  });
  expect(response.ok()).toBe(true);
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

async function upload(page: Page, name: string, buffer: Buffer, woo: boolean): Promise<void> {
  trackE2eImportFile(name);
  if (woo) await page.getByRole("radio", { name: /WooCommerce/ }).check();
  await page.getByLabel("Fișier CSV sau XLSX").setInputFiles({
    name,
    mimeType: "application/octet-stream",
    buffer,
  });
  await page.getByRole("button", { name: "Încarcă și analizează" }).click();
}

const count = (page: Page, key: "new" | "updated" | "unchanged" | "skipped" | "errors") =>
  page.locator(`[data-count="${key}"] dd`);
const reportRow = (page: Page, n: number) => page.locator(`[data-report-row="${n}"]`);

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.beforeEach(async () => {
  await removeE2eWooFixtureData();
});
test.afterEach(async () => {
  await removeE2eImports();
  await removeE2eWooFixtureData();
});

test.describe("import WooCommerce", () => {
  test("profil, opțiuni, verificare cu lista a ce se creează, confirmare, aplicare, a doua rulare neschimbată", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const bytes = Buffer.from(wooCsv(syntheticWooRows()));
    await login(page, owner, "/admin/produse/import");

    // pasul 1: alegerea profilului (generic implicit), apoi WooCommerce
    await expect(page.getByRole("radio", { name: /Generic/ })).toBeChecked();
    await upload(page, `e2e-${tag}-woo.csv`, bytes, true);

    // pasul 2: panoul profilului; coloanele nu se mapează manual
    await expect(page.getByRole("heading", { name: "Profil WooCommerce" })).toBeVisible();
    await expect(page.locator("[data-woo-row-types]")).toContainText(
      "9 simple, 1 variabile, 3 variații",
    );
    await expect(page.locator("[data-woo-row-types]")).toContainText(
      "1 grupate (ignorate), 1 externe (ignorate)",
    );
    await expect(page.locator("[data-woo-keep-status]")).not.toBeChecked();
    await expect(page.getByLabel("Greutatea din fișier e în")).toHaveValue("kg");
    await expect(page.getByLabel("Dimensiunile din fișier sunt în")).toHaveValue("cm");
    // clasele de livrare: cunoscutele sunt propuse, cea necunoscută cere o alegere (rămâne «fără corespondent»)
    await expect(page.getByLabel("Clasa din aplicație: Paletizat")).toHaveValue("pallet");
    await expect(page.getByLabel("Clasa din aplicație: Supradimensionat")).toHaveValue("oversized");
    await expect(page.getByLabel("Clasa din aplicație: Curier special")).toHaveValue("");
    // atributele simple (nu și opțiunea de variație «Putere»)
    await expect(page.locator("[data-woo-attributes]")).toContainText("Material");
    await expect(page.locator("[data-woo-attributes]")).not.toContainText("Putere");
    await expect(page.getByLabel("În aplicație: Material")).toHaveValue("create");
    // coloanele ignorate și cea blocată (cost), fără valori
    await page.locator("[data-woo-columns] summary").click();
    await expect(page.locator("[data-woo-blocked]")).toContainText("Meta: _pret_intrare");
    await expect(page.locator("[data-woo-columns]")).toContainText("Imagini");
    await expect(page.locator("[data-woo-columns]")).toContainText("stocul nu se importă");
    await expect(page.locator("body")).not.toContainText(WOO_COST_SENTINEL);

    // pasul 3: verificarea (fără nicio modificare), cu lista a ce se creează
    await page.locator("[data-import-check]").click();
    await expect(page.getByRole("heading", { name: "Rezultatul verificării" })).toBeVisible();
    await expect(count(page, "new")).toHaveText("7");
    await expect(count(page, "skipped")).toHaveText("2");
    await expect(count(page, "errors")).toHaveText("6");
    const created = page.locator("[data-woo-report]");
    await expect(created.locator('[data-woo-create="categories"]')).toContainText(
      "6 categorii de creat",
    );
    await expect(created.locator('[data-woo-create="categories"]')).toContainText(
      "Pompe > Pompe de circulație",
    );
    await expect(created.locator('[data-woo-create="categories"]')).toContainText(
      "Accesorii, diverse",
    );
    await expect(created.locator('[data-woo-create="brands"]')).toContainText("Marca Fixture A");
    await expect(created.locator('[data-woo-create="attributes"]')).toContainText("Material");
    await expect(created.locator('[data-woo-stat="descriptionTables"]')).toHaveText("1");
    await expect(created.locator('[data-woo-stat="skuFallbacks"]')).toHaveText("1");
    await expect(page.locator("[data-file-warnings]")).toContainText("Meta: _pret_intrare");
    await expect(page.locator("[data-file-warnings]")).toContainText("Coloana de imagini");
    // rândurile murdare au motiv
    await expect(page.locator('[data-outcome="error"]').first()).toBeVisible();
    await expect(page.locator("[data-import-report]")).toContainText(
      "Preț obișnuit: valoare invalidă „abc”",
    );
    await expect(page.locator("[data-import-report]")).toContainText("conține «|»");
    await expect(page.locator("[data-import-report]")).toContainText(
      "Variație fără produs variabil",
    );
    await expect(page.locator("[data-import-report]")).toContainText("HTML redus la text simplu");
    await expect(page.locator("body")).not.toContainText(WOO_COST_SENTINEL);
    // dry-run: nimic în catalog
    expect((await readE2eWooFixtureState()).products).toBe(0);

    // aplicarea, cu confirmare care spune ce se creează
    await page.locator("[data-import-apply]").click();
    await expect(page.locator("[data-import-summary]")).toContainText("7 produse noi");
    await expect(page.locator("[data-import-summary]")).toContainText(
      "Se vor crea 6 categorii, 2 branduri și 1 atribute",
    );
    await page.locator("[data-import-confirm]").click();
    await expect(page.locator("[data-import-done]")).toBeVisible();
    await expect(count(page, "new")).toHaveText("7");

    const state = await readE2eWooFixtureState();
    expect(state).toMatchObject({
      products: 5,
      firstStatus: "draft",
      firstLegacyId: "101",
      attribute: { type: "text" },
      variableOptions: 1,
    });
    expect(state.categories).toEqual([
      "Accesorii",
      "Accesorii, diverse",
      "Filtrare",
      "Filtre cu nisip",
      "Pompe",
      "Pompe de circulație",
    ]);
    expect(state.brands).toEqual(["Marca Fixture A", "Marca Fixture B"]);
    expect(state.firstDescription).toContain("Putere: 0,75 kW");
    expect(state.firstDescription).not.toMatch(/<\/?[a-z]/i);

    // un singur eveniment de audit al importului
    const href = await page.locator("[data-import-download]").getAttribute("href");
    const importId = /product-imports\/([^/]+)\/report/.exec(href ?? "")?.[1] as string;
    expect(await readE2eAuditByEntity("product.import", importId)).toHaveLength(1);

    // a doua rulare: tot «neschimbat», nimic de creat, nimic de aplicat
    await page.getByRole("button", { name: "Import nou" }).click();
    await upload(page, `e2e-${tag}-woo2.csv`, bytes, true);
    await page.locator("[data-import-check]").click();
    await expect(count(page, "unchanged")).toHaveText("7");
    await expect(count(page, "new")).toHaveText("0");
    await expect(count(page, "updated")).toHaveText("0");
    await expect(page.locator("[data-woo-report]")).toContainText("Nimic de creat");
    await expect(page.locator("[data-import-apply]")).toBeDisabled();
  });

  test("opțiunea «păstrează starea din fișier» activează produsul publicat la reimport; implicit rămâne ciornă", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const bytes = Buffer.from(wooCsv(syntheticWooRows()));
    await login(page, owner, "/admin/produse/import");
    await upload(page, `e2e-${tag}-woo.csv`, bytes, true);
    await page.locator("[data-import-check]").click();
    await page.locator("[data-import-apply]").click();
    await page.locator("[data-import-confirm]").click();
    await expect(page.locator("[data-import-done]")).toBeVisible();
    expect((await readE2eWooFixtureState()).firstStatus).toBe("draft");

    await page.getByRole("button", { name: "Import nou" }).click();
    await upload(page, `e2e-${tag}-woo2.csv`, bytes, true);
    await page.locator("[data-woo-keep-status]").check();
    await page.locator("[data-import-check]").click();
    await expect(count(page, "updated")).not.toHaveText("0");
    await page.locator("[data-import-apply]").click();
    await page.locator("[data-import-confirm]").click();
    await expect(page.locator("[data-import-done]")).toBeVisible();
    expect((await readE2eWooFixtureState()).firstStatus).toBe("active");
  });

  test("un fișier care nu e export WooCommerce se refuză la profilul WooCommerce, cu mesaj clar", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    await login(page, owner, "/admin/produse/import");
    await upload(
      page,
      `e2e-${tag}-generic.csv`,
      Buffer.from("SKU;Titlu;Preț (lei, cu TVA)\r\nE2E-X;Produs;10\r\n", "utf8"),
      true,
    );
    await expect(page.locator("[data-problem]")).toContainText("nu pare un export WooCommerce");
    await expect(page.getByRole("heading", { name: "Alege fișierul" })).toBeVisible();
  });

  test("profilul generic funcționează ca înainte (alegerea implicită)", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    await login(page, owner, "/admin/produse/import");
    await upload(
      page,
      `e2e-${tag}-generic.csv`,
      Buffer.from("SKU;Titlu;Preț (lei, cu TVA)\r\nE2E-X;Produs;10\r\n", "utf8"),
      false,
    );
    await expect(page.getByRole("heading", { name: "Mapează coloanele" })).toBeVisible();
    await expect(page.getByLabel("Importă în câmpul: SKU")).toHaveValue("sku");
    await expect(reportRow(page, 2)).toHaveCount(0);
  });
});

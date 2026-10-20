import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { WOO_COST_SENTINEL, syntheticWooRows, wooCsv } from "../packages/core/test/woo-fixture";
import {
  countE2eProductsBySku,
  promoteE2eUser,
  readE2eImageTasks,
  removeE2eImageData,
  setE2eImageHosts,
  readE2eAuditByEntity,
  readE2eWooFixtureState,
  removeE2eImports,
  removeE2eWooFixtureData,
  trackE2eImportFile,
} from "../packages/core/test/e2e-support";
import { expectResponseOk } from "./support/diagnostics";

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
  await removeE2eImageData();
});
test.afterEach(async () => {
  await removeE2eImports();
  await removeE2eWooFixtureData();
  await removeE2eImageData();
  // lista de domenii permise revine la goală (instalarea de test nu permite nicio imagine)
  await setE2eImageHosts(null);
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
    // «Imagini» nu mai e coloană ignorată (15b): are propriul panou, cu lista de domenii goală în instalarea de test
    await expect(page.locator("[data-woo-columns]")).not.toContainText("Imagini");
    await expect(page.locator("[data-woo-images]")).toContainText("exemplu.invalid");
    await expect(page.locator("[data-images-no-hosts]")).toContainText(
      "Lista de domenii permise este goală",
    );
    await expect(page.locator("[data-woo-import-images]")).not.toBeChecked();
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
    await expect(page.locator("[data-file-warnings]")).toContainText(
      "Coloana «Imagini» nu se importă",
    );
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

  test("istoric: importul WooCommerce aplicat apare cu profilul și entitățile create; costul din fișier nu apare în istoric, detalii sau CSV", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const fileName = `e2e-${tag}-woo-istoric.csv`;
    await login(page, owner, "/admin/produse/import");
    await upload(page, fileName, Buffer.from(wooCsv(syntheticWooRows())), true);
    await page.locator("[data-import-check]").click();
    await page.locator("[data-import-apply]").click();
    await page.locator("[data-import-confirm]").click();
    await expect(page.locator("[data-import-done]")).toBeVisible();

    await page.goto("/admin/produse/import/istoric");
    const row = page.locator("[data-history-row]").filter({ hasText: fileName });
    await expect(row).toContainText("WooCommerce");
    await expect(row.locator("[data-history-created]")).toContainText(
      "6 categorii, 2 branduri, 1 atribute",
    );
    await expect(row.locator("[data-history-counts]")).toContainText("7 noi");
    await expect(page.locator("body")).not.toContainText(WOO_COST_SENTINEL);

    await row.locator("[data-history-details]").click();
    await expect(page.locator("[data-woo-create]").first()).toBeVisible();
    await expect(page.locator("[data-woo-report]")).toContainText("Accesorii, diverse");
    await expect(page.locator("body")).not.toContainText(WOO_COST_SENTINEL);
    const href = await page.locator("[data-import-download]").getAttribute("href");
    const body = await (await page.request.get(href as string)).text();
    expect(body).not.toContain(WOO_COST_SENTINEL);
    expect(body).not.toContain("7654321");
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

test.describe("import WooCommerce: imagini din adrese (15b)", () => {
  const imageRows = (): Record<string, string>[] => [
    {
      ID: "9001",
      Tip: "simple",
      SKU: "IMG-E2E-1",
      Nume: "Produs imagini 1",
      "Preț obișnuit": "100",
      Imagini:
        "https://imagini.localhost/poze/a.jpg, http://imagini.localhost/poze/b.jpg, https://alt-domeniu.invalid/poze/c.jpg, https://10.0.0.5/poze/d.jpg",
    },
    {
      ID: "9002",
      Tip: "simple",
      SKU: "IMG-E2E-2",
      Nume: "Produs imagini 2",
      "Preț obișnuit": "120",
      Imagini: "https://imagini.localhost/poze/e.jpg",
    },
  ];

  test("domenii permise, verificare fără cereri, aplicare, descărcare în fundal care eșuează fără scurgeri, reluare, audit agregat", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eImageHosts(["imagini.localhost"]);
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    await login(page, owner, "/admin/produse/import");
    await upload(page, `e2e-${tag}-img.csv`, Buffer.from(wooCsv(imageRows())), true);

    // pasul 2: domeniile din fișier, cu cele permise marcate; bifa e activă când lista nu e goală
    await expect(page.locator("[data-woo-images]")).toContainText(
      "Fișierul conține 5 adrese de imagini: 2 pe domenii permise, 1 pe alte domenii (se vor respinge), 2 care nu respectă regulile",
    );
    await expect(page.locator('[data-image-host="imagini.localhost"]')).toHaveAttribute(
      "data-allowed",
      "true",
    );
    await expect(page.locator('[data-image-host="alt-domeniu.invalid"]')).toHaveAttribute(
      "data-allowed",
      "false",
    );
    await expect(page.locator("[data-images-no-hosts]")).toHaveCount(0);
    await expect(page.locator("[data-woo-import-images]")).toBeChecked();
    await expect(page.locator("[data-woo-images]")).not.toContainText("10.0.0.5");

    // pasul 3: verificarea arată câte, de pe ce domenii și ce se respinge, fără nicio adresă completă
    await page.locator("[data-import-check]").click();
    await expect(page.getByRole("heading", { name: "Rezultatul verificării" })).toBeVisible();
    const report = page.locator("[data-woo-images-report]");
    await expect(report.locator("[data-images-summary]")).toContainText(
      "5 adrese: 2 acceptate, 3 respinse",
    );
    await expect(report.locator("[data-images-hosts]")).toContainText("imagini.localhost: 2");
    await expect(report.locator('[data-images-reason="scheme"]')).toContainText("Nu e https: 1");
    await expect(report.locator('[data-images-reason="host_not_allowed"]')).toContainText(
      "Domeniu nepermis: 1",
    );
    await expect(report.locator('[data-images-reason="ip_literal"]')).toContainText(
      "IP în loc de domeniu: 1",
    );
    await expect(page.locator("body")).not.toContainText("10.0.0.5");
    await expect(page.locator("body")).not.toContainText("/poze/");
    // dry-run: produsele nu există încă
    expect(await countE2eProductsBySku(["IMG-E2E-1", "IMG-E2E-2"])).toBe(0);

    // aplicare: produsele apar acum, imaginile se descarcă în fundal
    await page.locator("[data-import-apply]").click();
    await expect(page.locator("[data-import-summary]")).toContainText("2 imagini vor fi aduse");
    await page.locator("[data-import-confirm]").click();
    await expect(page.locator("[data-import-done]")).toBeVisible({ timeout: 60_000 });
    expect(await countE2eProductsBySku(["IMG-E2E-1", "IMG-E2E-2"])).toBe(2);

    // domeniul din test nu duce la un server public: ambele imagini eșuează, produsele rămân
    const panel = page.locator("[data-import-images]");
    await expect(panel.locator('[data-image-state="done"]')).toBeVisible({ timeout: 90_000 });
    await expect(panel.locator('[data-image-count="failed"] dd')).toHaveText("2");
    await expect(panel.locator('[data-image-count="downloaded"] dd')).toHaveText("0");
    const href = await panel.locator("a").getAttribute("href");
    const importId = (href ?? "").split("/").pop() as string;
    expect(importId.length).toBeGreaterThan(10);
    const tasks = await readE2eImageTasks(importId);
    expect(tasks).toHaveLength(2);
    for (const task of tasks) {
      expect(task.status).toBe("failed");
      expect(task.host).toBe("imagini.localhost");
      expect(["dns_failed", "address_not_public", "connect_failed", "timeout"]).toContain(
        task.reason,
      );
    }

    // istoricul: contoare, motive generice, fără IP-uri, adrese sau căi
    await page.goto(`/admin/produse/import/istoric/${importId}`);
    const history = page.locator("[data-history-images]");
    await expect(history.locator('[data-image-count="failed"] dd')).toHaveText("2");
    await expect(history.locator("[data-image-failure]")).toHaveCount(2);
    await expect(history).toContainText("imagini.localhost");
    const text = (await history.textContent()) ?? "";
    expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(text).not.toContain("/poze/");
    expect(text).not.toContain("https://");

    // reluarea imaginilor eșuate (doar cine a pornit importul)
    await history.locator("[data-image-retry]").click();
    await expect(history.locator("[data-image-retry-message]")).toContainText(
      "Descărcarea a fost reluată.",
    );
    await expect(async () => {
      await page.reload();
      await expect(page.locator('[data-history-images] [data-image-state="done"]')).toBeVisible();
      await expect(
        page.locator('[data-history-images] [data-image-count="pending"] dd'),
      ).toHaveText("0");
    }).toPass({ timeout: 90_000 });

    // auditul: o singură înregistrare agregată la aplicare, una la sfârșitul descărcării, doar numere
    const applied = await readE2eAuditByEntity("product.import", importId);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.after).toMatchObject({ imagesTotal: 5, imagesRejected: 3, imagesQueued: 2 });
    const finished = await readE2eAuditByEntity("product.import.images", importId);
    expect(finished.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(finished)).not.toContain("imagini.localhost");
  });

  test("un cont fără drept de media (Manager) importă produsele, dar nu vede opțiunea de imagini", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eImageHosts(["imagini.localhost"]);
    const manager = await createAccount(request, baseURL as string, "manager");
    const tag = randomBytes(3).toString("hex");
    await login(page, manager, "/admin/produse/import");
    await upload(page, `e2e-${tag}-img-m.csv`, Buffer.from(wooCsv(imageRows())), true);
    await expect(page.locator("[data-images-no-right]")).toContainText(
      "Contul tău nu poate încărca fișiere în biblioteca media",
    );
    await expect(page.locator("[data-woo-import-images]")).toHaveCount(0);
    await page.locator("[data-import-check]").click();
    await expect(page.locator("[data-file-warnings]")).toContainText("media.write");
    await page.locator("[data-import-apply]").click();
    await page.locator("[data-import-confirm]").click();
    await expect(page.locator("[data-import-done]")).toBeVisible({ timeout: 60_000 });
    expect(await countE2eProductsBySku(["IMG-E2E-1", "IMG-E2E-2"])).toBe(2);
    await expect(page.locator("[data-import-images]")).toHaveCount(0);
  });
});

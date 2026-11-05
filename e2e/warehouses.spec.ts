import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  E2E_WAREHOUSE_PREFIX,
  clearE2eWarehouseStock,
  countE2eWarehouses,
  createE2eRole,
  createE2eWarehouse,
  e2eWarehouseCode,
  keepOnlyE2eWarehousesActive,
  promoteE2eUser,
  putE2eStockInWarehouse,
  putE2eWarehouseSnapshot,
  readE2eDefaultWarehouseName,
  readE2eStockIn,
  readE2eTransferAudit,
  readE2eTransfers,
  readE2eWarehouse,
  readE2eWarehouseAudit,
  removeE2eRole,
  removeE2eStock,
  removeE2eWarehouses,
  seedE2eStock,
  setE2eDefaultWarehouseName,
  setE2eFeatureFlag,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Faza 5, punctul 13c, în browser: ecranul «Depozite» din grupul Catalog, doar cu steagul `multiWarehouse` pornit.
 * - steagul oprit: elementul lipsește din meniu, ruta dă 404, iar o acțiune trimisă după ce steagul a fost oprit între timp
 *   e refuzată cu mesaj în română, fără să scrie nimic;
 * - steagul pornit: listă cu depozitul implicit, creare, nume duplicat, redenumire (și a celui implicit, restabilit la final),
 *   dezactivare / activare, depozit cu stoc care nu se dezactivează (în dialog și, cu pagina veche, din server), audit;
 * - drepturi: doar citire (butoane dezactivate), Editor (fără acces), anonim; telefon fără derulare orizontală.
 * Flag-ul e global: celelalte fișiere ignoră elementul «Depozite» din meniu. Depozitele de probă au numele `E2E Depozit …`.
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
  // rolul de citire se (re)creează chiar înainte de atribuire: curățarea altui fișier de teste șterge rolurile `e2e-…` când
  // termină, în paralel cu acesta, iar între crearea rolului și înregistrarea contului era destul timp ca să dispară
  if (roleKey === READ_ROLE) await createE2eRole(READ_ROLE, ["admin.access", "inventory.read"]);
  await promoteE2eUser(email, roleKey);
  return { email, password };
}

/** Autentificare; așteaptă să iasă din pagina de autentificare (și pentru conturile fără acces la pagina cerută). */
async function login(page: Page, account: Account, next: string) {
  await page.goto(`/autentificare?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Parolă", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Intră în cont" }).click();
  await page.waitForURL((url) => url.pathname !== "/autentificare");
}

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Navigare principală" });
const submenu = (page: Page) => sidebar(page).locator('[data-nav-group="catalog"] ul');
const itemLink = (page: Page, name: string) =>
  submenu(page).getByRole("link", { name, exact: true });
const row = (page: Page, code: string) => page.locator(`[data-warehouse-row="${code}"]`);

test.describe.configure({ mode: "serial", timeout: 120_000 });

const tag = randomBytes(3).toString("hex");
const search = `E2E ${tag}`;
const NAME = `${E2E_WAREHOUSE_PREFIX} ${tag}`;
const RENAMED = `${NAME} nou`;
const CODE = `e2e_depozit_${tag}`;
const READ_ROLE = "e2e-depozite-citire";
let sku = "";
let defaultName = "";

// 13d: produse și depozite proprii (cu etichetă proprie, ca curățarea să nu atingă produsele de mai sus)
const tag13d = randomBytes(3).toString("hex");
const search13d = `E2E ${tag13d}`;
const W1 = `${E2E_WAREHOUSE_PREFIX} Stoc ${tag13d}`;
const W2 = `${E2E_WAREHOUSE_PREFIX} Poza ${tag13d}`;
const W1_CODE = e2eWarehouseCode(W1);
const W2_CODE = e2eWarehouseCode(W2);
const PCS_TITLE = `Produs Buc ${search13d}`;
const KG_TITLE = `Produs Kg ${search13d}`;
const LOW_TITLE = `Produs Mic ${search13d}`;
let skuPcs = "";
let skuKg = "";
let skuLow = "";

test.beforeAll(async () => {
  defaultName = await readE2eDefaultWarehouseName();
  await createE2eRole(READ_ROLE, ["admin.access", "inventory.read"]);
  [sku] = (await seedE2eStock(tag, [
    { title: `Produs ${search}`, variants: [{ sku: "A", physical: "5" }] },
  ])) as [string];
  await setE2eFeatureFlag("multiWarehouse", false);
});

test.afterAll(async () => {
  await setE2eFeatureFlag("multiWarehouse", false);
  await setE2eDefaultWarehouseName(defaultName);
  await removeE2eStock({ tag });
  await removeE2eStock({ tag: tag13d });
  await removeE2eWarehouses();
  await removeE2eRole(READ_ROLE);
});

test.describe("steagul multiWarehouse oprit", () => {
  test("elementul «Depozite» lipsește din meniu, iar ruta dă 404", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eFeatureFlag("multiWarehouse", false);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, "/admin/produse/stoc");
    await expect(itemLink(page, "Stoc")).toBeVisible();
    await expect(itemLink(page, "Depozite")).toHaveCount(0);

    const response = await page.goto("/admin/produse/depozite");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "Depozite" })).toHaveCount(0);
    // ecranul Stoc rămâne cel de până acum: fără selector de depozit
    await page.goto("/admin/produse/stoc");
    await expect(page.getByRole("heading", { level: 1, name: "Stoc" })).toBeVisible();
    await expect(page.getByLabel("Depozit", { exact: true })).toHaveCount(0);
  });
});

test.describe("steagul multiWarehouse pornit", () => {
  test("«Depozite» apare ultimul în grupul Catalog; lista arată depozitul implicit, fără buton de dezactivare", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eFeatureFlag("multiWarehouse", true);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, "/admin/produse/stoc");
    await expect(itemLink(page, "Depozite")).toBeVisible();
    const names = (await submenu(page).getByRole("link").allInnerTexts()).map((n) => n.trim());
    expect(names[names.length - 1]).toBe("Depozite");

    await itemLink(page, "Depozite").click();
    await page.waitForURL((url) => url.pathname === "/admin/produse/depozite");
    await expect(page.getByRole("heading", { level: 1, name: "Depozite" })).toBeVisible();
    await expect(itemLink(page, "Depozite")).toHaveAttribute("aria-current", "page");

    const main = page.locator('[data-warehouse-row][data-default="true"]');
    await expect(main).toHaveCount(1);
    await expect(main).toContainText(defaultName);
    await expect(main).toContainText("Implicit");
    await expect(main.getByRole("button", { name: /^Dezactivează depozitul/ })).toHaveCount(0);
    await expect(
      main.getByRole("button", { name: `Redenumește depozitul ${defaultName}` }),
    ).toBeEnabled();
    await expect(page.getByRole("button", { name: "Depozit nou" })).toBeEnabled();
    await page.screenshot({ path: "test-results/warehouses-desktop.png", fullPage: true });
  });

  test("creare: câmp gol → mesaj și focus, apoi se creează; același nume (altfel scris) e refuzat; auditul păstrează actorul", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eFeatureFlag("multiWarehouse", true);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, "/admin/produse/depozite");
    const before = await countE2eWarehouses();

    await page.getByRole("button", { name: "Depozit nou" }).click();
    const dialog = page.getByRole("dialog", { name: "Depozit nou" });
    await dialog.getByRole("button", { name: "Salvează" }).click();
    await expect(dialog.getByText("Numele e obligatoriu.")).toBeVisible();
    await expect(dialog.getByLabel("Nume")).toBeFocused();
    expect(await countE2eWarehouses()).toBe(before);

    await dialog.getByLabel("Nume").fill(NAME);
    await dialog.getByRole("button", { name: "Salvează" }).click();
    await expect(dialog).toBeHidden();
    await expect(row(page, CODE)).toBeVisible();
    await expect(row(page, CODE)).toContainText("Activ");

    const created = await readE2eWarehouse(NAME);
    expect(created).toMatchObject({ code: CODE, isActive: true, isDefault: false });
    expect(await countE2eWarehouses()).toBe(before + 1);
    const audit = await readE2eWarehouseAudit(NAME);
    expect(audit.map((a) => [a.action, a.outcome, a.actorLabel])).toEqual([
      ["warehouse.create", "success", manager.email],
    ]);

    // același nume, scris altfel: refuzat, dialogul rămâne deschis cu mesajul
    await page.getByRole("button", { name: "Depozit nou" }).click();
    const again = page.getByRole("dialog", { name: "Depozit nou" });
    await again.getByLabel("Nume").fill(NAME.toUpperCase());
    await again.getByRole("button", { name: "Salvează" }).click();
    await expect(again.getByRole("alert")).toContainText("Există deja un depozit");
    expect(await countE2eWarehouses()).toBe(before + 1);
    await again.getByRole("button", { name: "Anulează" }).click();
    await expect(again).toBeHidden();
  });

  test("redenumire: depozitul nou și cel implicit; codul rămâne, auditul are înainte/după", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eFeatureFlag("multiWarehouse", true);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, "/admin/produse/depozite");

    await page.getByRole("button", { name: `Redenumește depozitul ${NAME}` }).click();
    const dialog = page.getByRole("dialog", { name: `Redenumește «${NAME}»` });
    await dialog.getByLabel("Nume").fill(RENAMED);
    await dialog.getByRole("button", { name: "Salvează" }).click();
    await expect(dialog).toBeHidden();
    await expect(row(page, CODE)).toContainText(RENAMED);
    expect(await readE2eWarehouse(NAME)).toBeNull();
    expect(await readE2eWarehouse(RENAMED)).toMatchObject({ code: CODE, isActive: true });
    const audit = await readE2eWarehouseAudit(RENAMED);
    expect(audit.map((a) => a.action)).toContain("warehouse.rename");

    // depozitul implicit se redenumește și el; rămâne implicit, fără buton de dezactivare
    const central = `Depozit central E2E ${tag}`;
    await page.getByRole("button", { name: `Redenumește depozitul ${defaultName}` }).click();
    const mainDialog = page.getByRole("dialog", { name: `Redenumește «${defaultName}»` });
    await mainDialog.getByLabel("Nume").fill(central);
    await mainDialog.getByRole("button", { name: "Salvează" }).click();
    await expect(mainDialog).toBeHidden();
    const main = page.locator('[data-warehouse-row][data-default="true"]');
    await expect(main).toContainText(central);
    expect(await readE2eDefaultWarehouseName()).toBe(central);
    expect(await readE2eWarehouse(central)).toMatchObject({ isDefault: true, isActive: true });
    await expect(main.getByRole("button", { name: /^Dezactivează depozitul/ })).toHaveCount(0);
    await setE2eDefaultWarehouseName(defaultName);
  });

  test("dezactivare și activare a unui depozit fără stoc, cu confirmare", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eFeatureFlag("multiWarehouse", true);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, "/admin/produse/depozite");
    await expect(row(page, CODE)).toHaveAttribute("data-active", "true");

    await page.getByRole("button", { name: `Dezactivează depozitul ${RENAMED}` }).click();
    const dialog = page.getByRole("dialog", { name: `Dezactivezi «${RENAMED}»?` });
    await expect(dialog.getByRole("button", { name: "Dezactivează" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Dezactivează" }).click();
    await expect(dialog).toBeHidden();
    await expect(row(page, CODE)).toHaveAttribute("data-active", "false");
    await expect(row(page, CODE)).toContainText("Dezactivat");
    expect(await readE2eWarehouse(RENAMED)).toMatchObject({ isActive: false });

    await page.getByRole("button", { name: `Activează depozitul ${RENAMED}` }).click();
    await expect(row(page, CODE)).toHaveAttribute("data-active", "true");
    expect(await readE2eWarehouse(RENAMED)).toMatchObject({ isActive: true });
    expect((await readE2eWarehouseAudit(RENAMED)).map((a) => a.action)).toEqual(
      expect.arrayContaining(["warehouse.deactivate", "warehouse.activate"]),
    );
  });

  test("un depozit cu stoc nu se dezactivează: dialogul spune de ce, iar serverul refuză și cu pagina veche", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eFeatureFlag("multiWarehouse", true);
    const manager = await createAccount(request, baseURL as string, "manager");
    await putE2eStockInWarehouse(RENAMED, sku, "5");
    await login(page, manager, "/admin/produse/depozite");
    await expect(row(page, CODE)).toContainText("1 rând cu stoc");

    await page.getByRole("button", { name: `Dezactivează depozitul ${RENAMED}` }).click();
    const dialog = page.getByRole("dialog", { name: `Dezactivezi «${RENAMED}»?` });
    await expect(dialog.locator("[data-has-stock]")).toContainText("Depozitul are stoc (1 rând");
    await expect(dialog.getByRole("button", { name: "Dezactivează" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Anulează" }).click();
    await expect(dialog).toBeHidden();
    expect(await readE2eWarehouse(RENAMED)).toMatchObject({ isActive: true });

    // pagina veche: se golește stocul, se reîncarcă, apoi stocul reapare ÎNAINTE de clic
    await clearE2eWarehouseStock(RENAMED);
    await page.reload();
    await expect(row(page, CODE)).toContainText("fără stoc");
    await page.getByRole("button", { name: `Dezactivează depozitul ${RENAMED}` }).click();
    const stale = page.getByRole("dialog", { name: `Dezactivezi «${RENAMED}»?` });
    await expect(stale.locator("[data-has-stock]")).toHaveCount(0);
    await putE2eStockInWarehouse(RENAMED, sku, "5");
    await stale.getByRole("button", { name: "Dezactivează" }).click();
    await expect(stale.getByRole("alert")).toContainText(`«${RENAMED}» are stoc`);
    await expect(stale.getByRole("alert")).toContainText("Mută sau scoate stocul");
    expect(await readE2eWarehouse(RENAMED)).toMatchObject({ isActive: true });
    await stale.getByRole("button", { name: "Anulează" }).click();
    await expect(stale).toBeHidden();
    await clearE2eWarehouseStock(RENAMED);
  });
});

test.describe("steagul oprit între timp", () => {
  test("o acțiune trimisă de pe o pagină deschisă înainte de oprire e refuzată în română și nu scrie nimic", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eFeatureFlag("multiWarehouse", true);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, "/admin/produse/depozite");
    await expect(page.getByRole("heading", { level: 1, name: "Depozite" })).toBeVisible();
    const before = await countE2eWarehouses();

    await setE2eFeatureFlag("multiWarehouse", false);
    await page.getByRole("button", { name: "Depozit nou" }).click();
    const dialog = page.getByRole("dialog", { name: "Depozit nou" });
    await dialog.getByLabel("Nume").fill(`${NAME} oprit`);
    await dialog.getByRole("button", { name: "Salvează" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Multi-depozit");
    await expect(dialog.getByRole("alert")).toContainText("este oprită");
    expect(await readE2eWarehouse(`${NAME} oprit`)).toBeNull();
    expect(await countE2eWarehouses()).toBe(before);

    // și redenumirea / dezactivarea aceluiași depozit, de pe aceeași pagină veche, sunt refuzate
    await dialog.getByRole("button", { name: "Anulează" }).click();
    await page.getByRole("button", { name: `Dezactivează depozitul ${RENAMED}` }).click();
    const confirm = page.getByRole("dialog", { name: `Dezactivezi «${RENAMED}»?` });
    await confirm.getByRole("button", { name: "Dezactivează" }).click();
    await expect(confirm.getByRole("alert")).toContainText("este oprită");
    expect(await readE2eWarehouse(RENAMED)).toMatchObject({ isActive: true });
    await setE2eFeatureFlag("multiWarehouse", false);
  });
});

test.describe("drepturi", () => {
  test("doar citire: lista se vede, butoanele de scriere sunt dezactivate", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eFeatureFlag("multiWarehouse", true);
    const reader = await createAccount(request, baseURL as string, READ_ROLE);
    await login(page, reader, "/admin/produse/depozite");
    await expect(page.getByRole("heading", { level: 1, name: "Depozite" })).toBeVisible();
    await expect(itemLink(page, "Depozite")).toBeVisible();
    await expect(page.getByText("Poți vedea depozitele, dar nu le poți modifica.")).toBeVisible();
    await expect(row(page, CODE)).toBeVisible();
    await expect(page.getByRole("button", { name: "Depozit nou" })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: `Redenumește depozitul ${RENAMED}` }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: `Dezactivează depozitul ${RENAMED}` }),
    ).toBeDisabled();
  });

  test("Editorul nu are inventory.read: nu vede elementul și ruta îl trimite la «acces interzis»; anonimul la autentificare", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eFeatureFlag("multiWarehouse", true);
    const editor = await createAccount(request, baseURL as string, "editor");
    await login(page, editor, "/admin");
    await expect(page.getByRole("heading", { level: 1, name: "Panou de control" })).toBeVisible();
    await expect(sidebar(page).getByRole("link", { name: "Depozite" })).toHaveCount(0);
    await page.goto("/admin/produse/depozite");
    await expect(page).toHaveURL(/\/admin\/acces-interzis$/);

    await page.context().clearCookies();
    await page.goto("/admin/produse/depozite");
    await expect(page).toHaveURL(/\/autentificare/);
  });
});

test.describe("telefon", () => {
  test("fără derulare orizontală, cu lista și dialogul vizibile", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eFeatureFlag("multiWarehouse", true);
    const manager = await createAccount(request, baseURL as string, "manager");
    await page.setViewportSize({ width: 375, height: 812 });
    await login(page, manager, "/admin/produse/depozite");
    await expect(page.getByRole("heading", { level: 1, name: "Depozite" })).toBeVisible();
    await expect(row(page, CODE)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: "test-results/warehouses-phone.png", fullPage: true });

    await page.getByRole("button", { name: "Depozit nou" }).click();
    const dialog = page.getByRole("dialog", { name: "Depozit nou" });
    await expect(dialog.getByLabel("Nume")).toBeVisible();
    await page.screenshot({ path: "test-results/warehouses-phone-dialog.png" });
    await dialog.getByRole("button", { name: "Anulează" }).click();
    await expect(dialog).toBeHidden();
    await setE2eFeatureFlag("multiWarehouse", false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 13d: selectorul de depozit în Stoc și dialogul de transfer. Stau în acest fișier pentru că flag-ul `multiWarehouse` e
// global: două fișiere care îl pornesc și îl opresc deodată s-ar încurca. Depozitele sunt create direct în bază.
// ---------------------------------------------------------------------------------------------------------------------

const stockUrl = (extra = "") => `/admin/produse/stoc?q=${encodeURIComponent(search13d)}${extra}`;
const stockRow = (page: Page, rowSku: string) => page.locator(`[data-variant-row="${rowSku}"]`);
const selector = (page: Page) => page.getByLabel("Depozit", { exact: true });
const transferButton = (page: Page) => page.getByRole("button", { name: /^Transferă stoc:/ });
const physicalCell = (page: Page, rowSku: string) =>
  stockRow(page, rowSku).locator('[data-cell="physical"]');

test.describe("Stoc cu mai multe depozite (13d)", () => {
  test.beforeAll(async () => {
    [skuPcs, skuKg, skuLow] = (await seedE2eStock(tag13d, [
      { title: PCS_TITLE, variants: [{ sku: "A", physical: "5" }] },
      {
        title: KG_TITLE,
        unit: { symbol: "kg", decimals: 3 },
        step: "0,5",
        variants: [{ sku: "K", physical: "10" }],
      },
      // un singur pas disponibil, sub pragul implicit de 2 pași: apare în vederea «Stoc mic»
      { title: LOW_TITLE, variants: [{ sku: "L", physical: "1" }] },
    ])) as [string, string, string];
    await createE2eWarehouse(W1);
    await createE2eWarehouse(W2);
    await putE2eStockInWarehouse(W1, skuPcs, "77");
    await putE2eWarehouseSnapshot(W2);
  });

  test("steagul oprit: ?depozit= se ignoră, fără selector și fără buton «Transferă» (comportament neschimbat)", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eFeatureFlag("multiWarehouse", false);
    await keepOnlyE2eWarehousesActive([W1, W2]);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, stockUrl(`&depozit=${W1_CODE}`));
    await expect(page.getByRole("heading", { level: 1, name: "Stoc" })).toBeVisible();
    // lista e cea a depozitului implicit (5 buc), nu a lui W1 (77 buc), iar adresa cu ?depozit= nu schimbă nimic
    await expect(physicalCell(page, skuPcs)).toContainText("5 buc");
    await expect(stockRow(page, skuPcs)).not.toContainText("77");
    await expect(selector(page)).toHaveCount(0);
    await expect(transferButton(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Ajustează stocul:/ }).first()).toBeVisible();

    // istoricul: nici el nu ține cont de ?depozit=
    const href = await stockRow(page, skuPcs)
      .getByRole("link", { name: /^Istoric/ })
      .getAttribute("href");
    expect(href).not.toContain("depozit=");
    await page.goto(`${href as string}?depozit=${W1_CODE}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Transfer intrare")).toHaveCount(0);
    expect(await readE2eStockIn("default", skuPcs)).toMatchObject({ physical: "50000" });
  });

  test("steagul pornit, dar un singur depozit activ: tot fără selector, iar ?depozit= se ignoră", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eFeatureFlag("multiWarehouse", true);
    await keepOnlyE2eWarehousesActive([]);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, stockUrl(`&depozit=${W1_CODE}`));
    await expect(physicalCell(page, skuPcs)).toContainText("5 buc");
    await expect(selector(page)).toHaveCount(0);
    await expect(transferButton(page)).toHaveCount(0);
  });

  test("două depozite active: selectorul listează depozitele, alegerea schimbă lista, iar adresa păstrează depozitul în vedere, căutare și «Resetează»", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eFeatureFlag("multiWarehouse", true);
    await keepOnlyE2eWarehousesActive([W1, W2]);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, stockUrl());
    await expect(selector(page)).toBeVisible();
    const options = (await selector(page).locator("option").allInnerTexts()).map((o) => o.trim());
    expect(options).toEqual(expect.arrayContaining([defaultName, W1, W2]));
    // un depozit dezactivat nu e în listă
    expect(options).not.toContain(RENAMED);
    await expect(selector(page)).toHaveValue("");
    await expect(physicalCell(page, skuPcs)).toContainText("5 buc");

    await selector(page).selectOption({ label: W1 });
    await page.waitForURL((url) => url.searchParams.get("depozit") === W1_CODE);
    await expect(physicalCell(page, skuPcs)).toContainText("77 buc");
    await expect(selector(page)).toHaveValue(W1_CODE);
    // importul «stoc la zi» lucrează pe depozitul implicit: într-un alt depozit nu se oferă
    await expect(page.locator("[data-stock-import-link]")).toHaveCount(0);
    // depozitul rămâne în adresă la schimbarea vederii și la căutare
    await page.getByRole("link", { name: /^Stoc mic/ }).click();
    await page.waitForURL((url) => url.searchParams.get("filtru") === "stoc-mic");
    expect(new URL(page.url()).searchParams.get("depozit")).toBe(W1_CODE);
    await expect(selector(page)).toHaveValue(W1_CODE);
    await page.getByRole("link", { name: /^Toate variantele/ }).click();
    await page.waitForURL((url) => url.searchParams.get("filtru") === null);
    await page.getByLabel("Caută", { exact: false }).fill(PCS_TITLE);
    await page.getByRole("button", { name: "Filtrează" }).click();
    await page.waitForURL((url) => url.searchParams.get("q") === PCS_TITLE);
    expect(new URL(page.url()).searchParams.get("depozit")).toBe(W1_CODE);
    await page.getByRole("link", { name: "Resetează" }).click();
    await page.waitForURL((url) => url.searchParams.get("q") === null);
    expect(new URL(page.url()).searchParams.get("depozit")).toBe(W1_CODE);

    // înapoi la depozitul implicit: adresa canonică, fără cod, iar importul «stoc la zi» reapare
    await selector(page).selectOption({ label: defaultName });
    await page.waitForURL((url) => url.searchParams.get("depozit") === null);
    await expect(selector(page)).toHaveValue("");
    await expect(page.locator("[data-stock-import-link]")).toHaveCount(1);

    // un cod necunoscut sau al unui depozit dezactivat → depozitul implicit, fără eroare
    for (const code of ["nu_exista", e2eWarehouseCode(RENAMED)]) {
      await page.goto(stockUrl(`&depozit=${code}`));
      await expect(physicalCell(page, skuPcs)).toContainText("5 buc");
      await expect(selector(page)).toHaveValue("");
    }
    await page.goto(stockUrl(`&depozit=${W1_CODE}`));
    await expect(physicalCell(page, skuPcs)).toContainText("77 buc");
    await page.screenshot({
      path: "test-results/stock-warehouse-selector-desktop.png",
      fullPage: true,
    });
  });

  test("ajustarea dintr-un depozit ales scrie în acel depozit, nu în cel implicit", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eFeatureFlag("multiWarehouse", true);
    await keepOnlyE2eWarehousesActive([W1, W2]);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, stockUrl(`&depozit=${W1_CODE}`));
    await stockRow(page, skuPcs)
      .getByRole("button", { name: /^Ajustează stocul:/ })
      .click();
    const dialog = page.getByRole("dialog", { name: /^Ajustează stocul:/ });
    await dialog.getByLabel("Motiv", { exact: true }).selectOption({ label: "Deteriorat" });
    await dialog.getByLabel("Cantitate").fill("1");
    await dialog.getByLabel("Text (obligatoriu)").fill("probă 13d");
    await dialog.getByRole("button", { name: "Salvează ajustarea" }).click();
    await expect(dialog.locator("[data-saved]")).toBeVisible();
    expect(await readE2eStockIn(W1, skuPcs)).toMatchObject({ physical: "760000" });
    expect(await readE2eStockIn("default", skuPcs)).toMatchObject({ physical: "50000" });
    await putE2eStockInWarehouse(W1, skuPcs, "77");
  });

  test("transfer: dialogul arată sursa, disponibilul și pasul; mută marfa în două mișcări legate, cu audit și avertismentul despre poza SmartBill", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eFeatureFlag("multiWarehouse", true);
    await keepOnlyE2eWarehousesActive([W1, W2]);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, stockUrl());
    await stockRow(page, skuPcs)
      .getByRole("button", { name: `Transferă stoc: ${PCS_TITLE}` })
      .click();
    const dialog = page.getByRole("dialog", { name: `Transferă stoc: ${PCS_TITLE}` });
    await expect(dialog.locator("[data-source]")).toContainText(`«${defaultName}»`);
    await expect(dialog.locator("[data-available]")).toContainText("5 buc");
    await expect(dialog.locator("[data-available]")).toContainText("5 pași");
    await expect(dialog.locator("[data-step]")).toContainText("1 buc");
    // destinațiile sunt celelalte depozite active, nu sursa
    const destination = dialog.getByLabel("Depozit destinație");
    const options = (await destination.locator("option").allInnerTexts()).map((o) => o.trim());
    expect(options).toEqual(expect.arrayContaining([W1, W2]));
    expect(options).not.toContain(defaultName);
    expect(options).not.toContain(RENAMED);
    await page.screenshot({ path: "test-results/stock-transfer-dialog-desktop.png" });

    await destination.selectOption({ label: W2 });
    await dialog.getByLabel("Cantitate").fill("2");
    await dialog.getByLabel("Text (opțional)").fill("mutare E2E");
    await dialog.getByRole("button", { name: "Transferă" }).click();
    await expect(dialog.locator("[data-saved]")).toContainText(
      `Am mutat 2 buc din «${defaultName}» în «${W2}»`,
    );
    // avertismentul vine din rezultatul serviciului: W2 primește poze SmartBill
    await expect(dialog.locator("[data-warnings]")).toContainText(
      `Depozitul «${W2}» primește poze SmartBill`,
    );
    await dialog.getByRole("button", { name: "Închide" }).last().click();
    await expect(dialog).toBeHidden();
    // lista s-a reîmprospătat: 5 → 3 în depozitul afișat
    await expect(physicalCell(page, skuPcs)).toContainText("3 buc");

    expect(await readE2eStockIn("default", skuPcs)).toMatchObject({ physical: "30000" });
    expect(await readE2eStockIn(W2, skuPcs)).toMatchObject({ physical: "20000" });
    const moves = await readE2eTransfers(skuPcs);
    expect(moves.map((m) => [m.kind, m.warehouse, m.deltaPhysical, m.note, m.actorLabel])).toEqual([
      ["transfer_out", defaultName, "-20000", "mutare E2E", manager.email],
      ["transfer_in", W2, "20000", "mutare E2E", manager.email],
    ]);
    expect(moves[0]?.refType).toBe("stock_transfer");
    expect(moves[0]?.refId).toBe(moves[1]?.refId);
    const audit = await readE2eTransferAudit(moves[0]?.refId as string);
    expect(audit.map((a) => [a.outcome, a.actorLabel])).toEqual([["success", manager.email]]);

    // istoricul fiecărui depozit arată partea lui; legătura «Istoric» poartă depozitul ales
    await page.goto(stockUrl(`&depozit=${W2_CODE}`));
    await expect(physicalCell(page, skuPcs)).toContainText("2 buc");
    await stockRow(page, skuPcs)
      .getByRole("link", { name: /^Istoric/ })
      .click();
    await page.waitForURL(
      (url) =>
        url.pathname.startsWith("/admin/produse/stoc/") &&
        url.searchParams.get("depozit") === W2_CODE,
    );
    await expect(page.getByText("Transfer intrare")).toBeVisible();
    await expect(page.getByText("Transfer ieșire")).toHaveCount(0);
    await page.goto(stockUrl());
    await stockRow(page, skuPcs)
      .getByRole("link", { name: /^Istoric/ })
      .click();
    await page.waitForURL((url) => url.pathname.startsWith("/admin/produse/stoc/"));
    await expect(page.getByText("Transfer ieșire")).toBeVisible();
    await expect(page.getByText("Transfer intrare")).toHaveCount(0);
  });

  test("transfer: validări în română, fără baloane native; refuzurile serverului (stoc insuficient, pas) nu mută nimic", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eFeatureFlag("multiWarehouse", true);
    await keepOnlyE2eWarehousesActive([W1, W2]);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, stockUrl());
    const movesBefore = (await readE2eTransfers(skuPcs)).length;

    await stockRow(page, skuPcs)
      .getByRole("button", { name: `Transferă stoc: ${PCS_TITLE}` })
      .click();
    const dialog = page.getByRole("dialog", { name: `Transferă stoc: ${PCS_TITLE}` });
    await expect(dialog.locator("form")).toHaveAttribute("novalidate", "");
    await dialog.getByRole("button", { name: "Transferă" }).click();
    await expect(dialog.getByText("Alege depozitul destinație.")).toBeVisible();
    await expect(dialog.getByText("Cantitatea e obligatorie.")).toBeVisible();
    await expect(dialog.getByLabel("Depozit destinație")).toBeFocused();

    await dialog.getByLabel("Depozit destinație").selectOption({ label: W1 });
    await dialog.getByLabel("Cantitate").fill("0");
    await dialog.getByRole("button", { name: "Transferă" }).click();
    await expect(dialog.getByText("Cantitatea trebuie să fie mai mare decât zero.")).toBeVisible();
    await expect(dialog.getByLabel("Cantitate")).toBeFocused();
    await dialog.getByLabel("Cantitate").fill("1,5");
    await dialog.getByRole("button", { name: "Transferă" }).click();
    await expect(
      dialog.getByText("Unitatea «buc» nu are zecimale: scrie un număr întreg."),
    ).toBeVisible();

    // peste disponibil: refuzul vine de la server, în română, iar dialogul rămâne deschis
    await dialog.getByLabel("Cantitate").fill("99");
    await dialog.getByRole("button", { name: "Transferă" }).click();
    await expect(dialog.locator("[data-problem]")).toContainText(
      "Stoc disponibil insuficient în depozitul sursă",
    );
    expect(await readE2eStockIn("default", skuPcs)).toMatchObject({ physical: "30000" });
    expect((await readE2eTransfers(skuPcs)).length).toBe(movesBefore);
    await dialog.getByRole("button", { name: "Renunță" }).click();
    await expect(dialog).toBeHidden();

    // kilograme cu pas de 0,5: se afișează unitatea și pasul; 0,7 nu e multiplu, 1,5 da
    await stockRow(page, skuKg)
      .getByRole("button", { name: `Transferă stoc: ${KG_TITLE}` })
      .click();
    const kg = page.getByRole("dialog", { name: `Transferă stoc: ${KG_TITLE}` });
    await expect(kg.locator("[data-available]")).toContainText("10 kg");
    await expect(kg.locator("[data-available]")).toContainText("20 de pași");
    await expect(kg.locator("[data-step]")).toContainText("0,5 kg");
    await kg.getByLabel("Depozit destinație").selectOption({ label: W1 });
    await kg.getByLabel("Cantitate").fill("0,7");
    await kg.getByRole("button", { name: "Transferă" }).click();
    await expect(kg.locator("[data-problem]")).toContainText("multiplu al pasului de vânzare");
    expect(await readE2eStockIn("default", skuKg)).toMatchObject({ physical: "100000" });
    await kg.getByLabel("Cantitate").fill("1,5");
    await kg.getByRole("button", { name: "Transferă" }).click();
    await expect(kg.locator("[data-saved]")).toContainText("Am mutat 1,5 kg");
    // W1 nu primește poze: niciun avertisment despre ea (sursa, depozitul implicit, poate avea unul)
    await expect(kg.locator("[data-warnings]").filter({ hasText: `«${W1}»` })).toHaveCount(0);
    await kg.getByRole("button", { name: "Închide" }).last().click();
    await expect(physicalCell(page, skuKg)).toContainText("8,5 kg");
    expect(await readE2eStockIn(W1, skuKg)).toMatchObject({ physical: "15000" });
  });

  test("steagul oprit între timp: transferul trimis de pe o pagină veche e refuzat în română și nu mută nimic", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eFeatureFlag("multiWarehouse", true);
    await keepOnlyE2eWarehousesActive([W1, W2]);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, stockUrl());
    const before = await readE2eStockIn("default", skuPcs);
    const movesBefore = (await readE2eTransfers(skuPcs)).length;
    await stockRow(page, skuPcs)
      .getByRole("button", { name: `Transferă stoc: ${PCS_TITLE}` })
      .click();
    const dialog = page.getByRole("dialog", { name: `Transferă stoc: ${PCS_TITLE}` });
    await dialog.getByLabel("Depozit destinație").selectOption({ label: W1 });
    await dialog.getByLabel("Cantitate").fill("1");

    await setE2eFeatureFlag("multiWarehouse", false);
    await dialog.getByRole("button", { name: "Transferă" }).click();
    await expect(dialog.locator("[data-problem]")).toContainText("Multi-depozit");
    await expect(dialog.locator("[data-problem]")).toContainText("este oprită");
    expect(await readE2eStockIn("default", skuPcs)).toEqual(before);
    expect((await readE2eTransfers(skuPcs)).length).toBe(movesBefore);
  });

  test("doar citire: selectorul se vede, dar nu există «Transferă» și nici «Ajustează»", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eFeatureFlag("multiWarehouse", true);
    await keepOnlyE2eWarehousesActive([W1, W2]);
    const reader = await createAccount(request, baseURL as string, READ_ROLE);
    await login(page, reader, stockUrl(`&depozit=${W1_CODE}`));
    await expect(selector(page)).toBeVisible();
    await expect(selector(page)).toHaveValue(W1_CODE);
    await expect(physicalCell(page, skuPcs)).toContainText("77 buc");
    await expect(transferButton(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Ajustează stocul:/ })).toHaveCount(0);
  });

  test("transfer dintr-un depozit ales: sursa e depozitul afișat, iar destinațiile sunt celelalte (inclusiv cel implicit)", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eFeatureFlag("multiWarehouse", true);
    await keepOnlyE2eWarehousesActive([W1, W2]);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, stockUrl(`&depozit=${W1_CODE}`));
    await stockRow(page, skuPcs)
      .getByRole("button", { name: `Transferă stoc: ${PCS_TITLE}` })
      .click();
    const dialog = page.getByRole("dialog", { name: `Transferă stoc: ${PCS_TITLE}` });
    await expect(dialog.locator("[data-source]")).toContainText(`«${W1}»`);
    await expect(dialog.locator("[data-available]")).toContainText("77 buc");
    const destination = dialog.getByLabel("Depozit destinație");
    const options = (await destination.locator("option").allInnerTexts()).map((o) => o.trim());
    expect(options).toEqual(expect.arrayContaining([defaultName, W2]));
    expect(options).not.toContain(W1);

    await destination.selectOption({ label: W2 });
    await dialog.getByLabel("Cantitate").fill("7");
    await dialog.getByRole("button", { name: "Transferă" }).click();
    await expect(dialog.locator("[data-saved]")).toContainText(`din «${W1}» în «${W2}»`);
    await dialog.getByRole("button", { name: "Închide" }).last().click();
    await expect(physicalCell(page, skuPcs)).toContainText("70 buc");
    expect(await readE2eStockIn(W1, skuPcs)).toMatchObject({ physical: "700000" });
    // depozitul implicit nu s-a atins, iar W2 a primit cele 7 bucăți peste cele 2 de la primul transfer
    expect(await readE2eStockIn("default", skuPcs)).toMatchObject({ physical: "30000" });
    expect(await readE2eStockIn(W2, skuPcs)).toMatchObject({ physical: "90000" });
  });

  test("vederea «Stoc mic»: are și ea butonul «Transferă»; lista se reîmprospătează abia la închiderea dialogului", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eFeatureFlag("multiWarehouse", true);
    await keepOnlyE2eWarehousesActive([W1, W2]);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, stockUrl("&filtru=stoc-mic"));
    const lowRow = page.locator(`[data-low-row="${skuLow}"]`);
    await expect(lowRow.locator('[data-cell="available"]')).toContainText("1 buc");
    await lowRow.getByRole("button", { name: `Transferă stoc: ${LOW_TITLE}` }).click();
    const dialog = page.getByRole("dialog", { name: `Transferă stoc: ${LOW_TITLE}` });
    await dialog.getByLabel("Depozit destinație").selectOption({ label: W1 });
    await dialog.getByLabel("Cantitate").fill("1");
    await dialog.getByRole("button", { name: "Transferă" }).click();
    await expect(dialog.locator("[data-saved]")).toContainText(
      `Am mutat 1 buc din «${defaultName}»`,
    );
    await dialog.getByRole("button", { name: "Închide" }).last().click();
    await expect(dialog).toBeHidden();
    // după închidere lista s-a reîmprospătat: varianta e acum epuizată în depozitul afișat
    await expect(lowRow.locator('[data-cell="available"]')).toContainText("0 buc");
    expect(await readE2eStockIn("default", skuLow)).toMatchObject({ physical: "0" });
    expect(await readE2eStockIn(W1, skuLow)).toMatchObject({ physical: "10000" });
  });

  test("telefon: selectorul și dialogul de transfer încap, fără derulare orizontală a paginii", async ({
    page,
    request,
    baseURL,
  }) => {
    await setE2eFeatureFlag("multiWarehouse", true);
    await keepOnlyE2eWarehousesActive([W1, W2]);
    const manager = await createAccount(request, baseURL as string, "manager");
    await page.setViewportSize({ width: 375, height: 812 });
    await login(page, manager, stockUrl());
    await expect(selector(page)).toBeVisible();
    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: "test-results/stock-warehouse-selector-phone.png",
      fullPage: true,
    });

    await stockRow(page, skuPcs)
      .getByRole("button", { name: `Transferă stoc: ${PCS_TITLE}` })
      .click();
    const dialog = page.getByRole("dialog", { name: `Transferă stoc: ${PCS_TITLE}` });
    await expect(dialog.getByLabel("Depozit destinație")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Transferă" })).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.screenshot({ path: "test-results/stock-transfer-dialog-phone.png" });
    await dialog.getByRole("button", { name: "Renunță" }).click();
    await expect(dialog).toBeHidden();
    await setE2eFeatureFlag("multiWarehouse", false);
  });
});

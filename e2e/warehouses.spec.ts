import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  E2E_WAREHOUSE_PREFIX,
  clearE2eWarehouseStock,
  countE2eWarehouses,
  createE2eRole,
  promoteE2eUser,
  putE2eStockInWarehouse,
  readE2eDefaultWarehouseName,
  readE2eWarehouse,
  readE2eWarehouseAudit,
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
  await removeE2eWarehouses();
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

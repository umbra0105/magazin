import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Download, type Page } from "@playwright/test";
import { e2eUnzipText } from "../packages/core/test/e2e-import-files";
import {
  E2E_COST_SENTINEL,
  promoteE2eUser,
  readE2eExportAudit,
  removeE2eImports,
  removeE2eProducts,
  seedE2eProducts,
  trackE2eImportFile,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Exportul de produse (CSV/XLSX), în browser (punctul 14b): domeniile (filtre curente, selecție), cele
 * două formate, fișierul CSV pentru Excel (BOM + «sep=;»), fără prețul de achiziție, dus-întors prin
 * importul din aplicație (tot «neschimbat»), drepturi pe roluri, erori afișate în română, audit cu numere.
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

/** Valoarea-santinelă a costului, în toate scrierile posibile (777777 bani = 7777,77 lei). */
const COST_FORMS = ["777777", "7777,77", "7777.77", "7.777,77", "7,777.77"];

const dialogOf = (page: Page) => page.getByRole("dialog", { name: "Exportă produsele" });

async function exportFrom(page: Page, format: "csv" | "xlsx"): Promise<Download> {
  const dialog = dialogOf(page);
  await dialog.getByLabel(format === "csv" ? /^CSV/ : /^XLSX/).check();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "Exportă", exact: true }).click(),
  ]);
  return download;
}

const readDownload = async (download: Download): Promise<Buffer> =>
  readFileSync((await download.path()) as string);

/** Încarcă un fișier în pagina de import și rulează verificarea (fără aplicare). */
async function checkInImport(page: Page, name: string, bytes: Buffer): Promise<void> {
  trackE2eImportFile(name);
  await page.goto("/admin/produse/import");
  await page.getByLabel("Fișier CSV sau XLSX").setInputFiles({
    name,
    mimeType: "application/octet-stream",
    buffer: bytes,
  });
  await page.getByRole("button", { name: "Încarcă și analizează" }).click();
  await expect(page.getByRole("heading", { name: "Mapează coloanele" })).toBeVisible();
  await page.locator("[data-import-check]").click();
  await expect(page.getByRole("heading", { name: "Rezultatul verificării" })).toBeVisible();
}

const count = (page: Page, key: "new" | "updated" | "unchanged" | "skipped" | "errors") =>
  page.locator(`[data-count="${key}"] dd`);

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.afterEach(async () => {
  await removeE2eImports();
  await removeE2eProducts();
});

test.describe("export de produse", () => {
  test("CSV cu filtrele curente: BOM + «sep=;», fără cost, audit cu numere, reimport = tot «neschimbat»", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    await seedE2eProducts(tag, 4);
    await login(page, owner, "/admin/produse");
    await page.goto(`/admin/produse?q=${tag}`);
    await expect(page.locator("[data-product-total]")).toContainText("4");

    await page.getByRole("button", { name: "Exportă…" }).click();
    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible();
    // fără selecție: implicit «filtrele curente», cu numărul lor; selecția e dezactivată
    await expect(
      dialog.getByLabel("Toate produsele care respectă filtrele curente (4)"),
    ).toBeChecked();
    await expect(dialog.getByLabel(/^Produsele selectate/)).toBeDisabled();
    // coșul de gunoi: exclus implicit
    await expect(dialog.getByLabel("Include și produsele din coșul de gunoi")).not.toBeChecked();
    // nicio mențiune a prețului de achiziție ca opțiune: doar nota că nu se exportă
    await expect(dialog).toContainText("Prețul de achiziție nu se exportă niciodată");

    const download = await exportFrom(page, "csv");
    expect(download.suggestedFilename()).toMatch(/^export-produse-\d{4}-\d{2}-\d{2}\.csv$/);
    const bytes = await readDownload(download);

    // octeții: BOM UTF-8, apoi «sep=;», apoi antetul (aceleași antete ca importul), apoi 4 rânduri
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    const lines = text.split(String.fromCharCode(13, 10)).filter((l) => l !== "");
    expect(lines[0]).toBe("sep=;");
    expect(lines[1]).toBe(
      "SKU;Titlu;Subtitlu;Descriere;Adresă (slug);Preț (lei, cu TVA);Preț promoțional (lei, cu TVA);" +
        "Categorii;Brand;EAN;Garanție (luni);Greutate (g);Lungime (mm);Lățime (mm);Înălțime (mm);" +
        "Clasă de livrare;Stare;Unitate de măsură;Baza prețului;Pas de vânzare;Minim (pași);Denumire pas;" +
        "Mod conversie SmartBill;Unitate SmartBill;Raport SmartBill;Stare stoc;Termen livrare (zile);ID produs;Modificat la",
    );
    expect(lines).toHaveLength(2 + 4);
    // ordinea rândurilor e cea de creare (id), nu alfabetică: rândul se caută după SKU
    const first = lines.find((l) => l.startsWith(`E2E-${tag.toUpperCase()}-01;`));
    expect(first?.startsWith(`E2E-${tag.toUpperCase()}-01;E2E ${tag} Produs 01;`)).toBe(true);
    expect(first).toContain(";101,00;");
    expect(first).toContain(";Ciornă;");
    // prețul de achiziție nu există în fișier, în nicio formă
    for (const form of COST_FORMS) expect(text, form).not.toContain(form);
    expect(text).not.toMatch(/achizi|cost/i);

    // anunț accesibil după descărcare
    await expect(page.locator("[data-export-status]")).toContainText("Exportul a fost descărcat");

    // auditul: un eveniment cu numere, fără valori din catalog
    const events = await readE2eExportAudit(owner.email);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "success",
      after: { format: "csv", scope: "filters", rows: 4, products: 4, includeTrash: false },
    });
    expect(JSON.stringify(events[0])).not.toContain(tag);

    // dus-întors: exportul reimportat fără nicio mapare manuală dă tot «neschimbat»
    await checkInImport(page, `e2e-${tag}-export.csv`, bytes);
    await expect(count(page, "unchanged")).toHaveText("4");
    await expect(count(page, "updated")).toHaveText("0");
    await expect(count(page, "new")).toHaveText("0");
    await expect(count(page, "errors")).toHaveText("0");
  });

  test("XLSX doar cu produsele selectate: foile «Produse» și «Despre export», fără cost, reimport = «neschimbat»", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    await seedE2eProducts(tag, 3);
    await login(page, owner, "/admin/produse");
    await page.goto(`/admin/produse?q=${tag}`);

    await page.getByRole("checkbox", { name: `Selectează E2E ${tag} Produs 01` }).check();
    await page.getByRole("checkbox", { name: `Selectează E2E ${tag} Produs 02` }).check();
    await page.getByRole("button", { name: "Exportă…" }).click();
    const dialog = dialogOf(page);
    // cu selecție: implicit selecția, cu numărul ei; coșul de gunoi nu se aplică
    await expect(dialog.getByLabel("Produsele selectate (2)")).toBeChecked();
    await expect(dialog.getByLabel("Include și produsele din coșul de gunoi")).toBeDisabled();
    // XLSX e formatul recomandat, ales implicit
    await expect(dialog.getByLabel(/^XLSX/)).toBeChecked();

    const download = await exportFrom(page, "xlsx");
    expect(download.suggestedFilename()).toMatch(/^export-produse-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const bytes = await readDownload(download);
    const entries = e2eUnzipText(new Uint8Array(bytes));
    const workbook = entries["xl/workbook.xml"] ?? "";
    expect(workbook).toContain('name="Produse"');
    expect(workbook).toContain('name="Despre export"');
    const strings = entries["xl/sharedStrings.xml"] ?? "";
    expect(strings).toContain(`E2E-${tag.toUpperCase()}-01`);
    expect(strings).toContain(`E2E-${tag.toUpperCase()}-02`);
    expect(strings).not.toContain(`E2E-${tag.toUpperCase()}-03`);
    expect(strings).toContain("Produsele selectate");
    for (const content of Object.values(entries)) {
      for (const form of COST_FORMS) expect(content, form).not.toContain(form);
    }
    expect(String(E2E_COST_SENTINEL)).toBe("777777");

    await checkInImport(page, `e2e-${tag}-export.xlsx`, bytes);
    await expect(count(page, "unchanged")).toHaveText("2");
    await expect(count(page, "errors")).toHaveText("0");
  });

  test("drepturi: fără products.export nu există buton, iar ruta refuză; origine străină refuzată", async ({
    page,
    request,
    baseURL,
  }) => {
    const tag = randomBytes(3).toString("hex");
    await seedE2eProducts(tag, 1);

    // Editor: vede produsele (products.read), dar nu le poate exporta
    const editor = await createAccount(request, baseURL as string, "editor");
    await login(page, editor, "/admin/produse");
    await page.goto(`/admin/produse?q=${tag}`);
    await expect(page.getByText(`E2E ${tag} Produs 01`).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Exportă…" })).toHaveCount(0);
    const forbidden = await page.request.post("/api/admin/product-exports", {
      headers: { origin: baseURL as string },
      data: { format: "csv", scope: "all" },
    });
    expect(forbidden.status()).toBe(403);
    expect(await forbidden.json()).toEqual({ code: "AUTH_FORBIDDEN" });

    // Manager: are butonul
    const managerPage = await page
      .context()
      .browser()!
      .newPage({ baseURL: baseURL as string });
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(managerPage, manager, "/admin/produse");
    await managerPage.goto(`/admin/produse?q=${tag}`);
    await expect(managerPage.getByRole("button", { name: "Exportă…" })).toBeVisible();

    // origine străină (CSRF): refuzată chiar cu sesiune validă; fără origine la fel
    const csrf = await managerPage.request.post("/api/admin/product-exports", {
      headers: { origin: "https://evil.example" },
      data: { format: "csv", scope: "all" },
    });
    expect(csrf.status()).toBe(403);
    expect(await csrf.json()).toEqual({ code: "ORIGIN_INVALID" });
    // GET nu există
    const get = await managerPage.request.get("/api/admin/product-exports");
    expect(get.status()).toBe(405);
    await managerPage.close();
  });

  test("refuzurile serverului apar în română în dialog (limită de rânduri), iar dialogul rămâne deschis", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    await seedE2eProducts(tag, 1);
    await login(page, owner, "/admin/produse");
    await page.goto(`/admin/produse?q=${tag}`);
    await page.route("**/api/admin/product-exports", (route) =>
      route.fulfill({
        status: 413,
        contentType: "application/json",
        body: JSON.stringify({
          code: "EXPORT_TOO_MANY_ROWS",
          message: "Exportul ar avea 30000 de rânduri, iar limita este 20000.",
        }),
      }),
    );
    await page.getByRole("button", { name: "Exportă…" }).click();
    const dialog = dialogOf(page);
    await dialog.getByRole("button", { name: "Exportă", exact: true }).click();
    await expect(dialog.locator("[data-export-error]")).toHaveText(
      "Exportul ar avea 30000 de rânduri, iar limita este 20000.",
    );
    await expect(dialog).toBeVisible();
    // rate limit: textul din aplicație, nu un cod
    await page.unroute("**/api/admin/product-exports");
    await page.route("**/api/admin/product-exports", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ code: "AUTH_RATE_LIMITED" }),
      }),
    );
    await dialog.getByRole("button", { name: "Exportă", exact: true }).click();
    await expect(dialog.locator("[data-export-error]")).toContainText("Prea multe exporturi");
  });
});

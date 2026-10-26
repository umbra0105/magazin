import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { decodeUtf16le } from "../packages/core/test/utf-16le";
import { encodeWindows1250 } from "../packages/core/test/windows-1250";
import {
  e2eXlsx,
  e2eXlsxBomb,
  e2eXlsxWithMacros,
  e2eZipNames,
} from "../packages/core/test/e2e-import-files";
import {
  E2E_COST_SENTINEL,
  promoteE2eUser,
  readE2eAuditByEntity,
  readE2eImport,
  readE2eVariantBySku,
  removeE2eCatalogRefs,
  removeE2eImports,
  removeE2eProducts,
  seedE2eCatalogRefs,
  seedE2eProducts,
  trackE2eImportFile,
  trackE2eProduct,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Importul de produse (CSV/XLSX), în browser (punctul 14a): fluxul în pași (fișier → mapare →
 * verificare fără modificări → aplicare), raport pe rând, upsert pe SKU, idempotență, coloană de cost
 * refuzată, import mare în fundal cu progres, XLSX, fișiere refuzate, drepturi pe roluri.
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

// BOM UTF-8, ca Excel în limba română
const BOM = String.fromCharCode(0xfeff);
const csvFile = (rows: string[][]): Buffer =>
  Buffer.from(BOM + `${rows.map((r) => r.join(";")).join("\r\n")}\r\n`, "utf8");

async function upload(
  page: Page,
  file: { name: string; buffer: Buffer; mimeType?: string },
): Promise<void> {
  trackE2eImportFile(file.name);
  await page.getByLabel("Fișier CSV sau XLSX").setInputFiles({
    name: file.name,
    mimeType: file.mimeType ?? "application/octet-stream",
    buffer: file.buffer,
  });
  await page.getByRole("button", { name: "Încarcă și analizează" }).click();
}

const count = (page: Page, key: "new" | "updated" | "unchanged" | "skipped" | "errors") =>
  page.locator(`[data-count="${key}"] dd`);
const reportRow = (page: Page, n: number) => page.locator(`[data-report-row="${n}"]`);

const importIdOf = async (page: Page): Promise<string> => {
  const href = await page.locator("[data-import-download]").getAttribute("href");
  return /product-imports\/([^/]+)\/report/.exec(href ?? "")?.[1] as string;
};

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.afterEach(async () => {
  await removeE2eImports();
  await removeE2eProducts();
  await removeE2eCatalogRefs();
});

test.describe("import de produse", () => {
  test("flux complet CSV: șablon, mapare cu coloana de cost blocată, verificare fără modificări, raport, aplicare, a doua rulare nu schimbă nimic", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    await seedE2eProducts(tag, 3);
    const refs = await seedE2eCatalogRefs(tag);
    const sku = (s: string) => `E2E-${tag.toUpperCase()}-${s}`;
    const existing = sku("01");
    const created = sku("NEW");
    trackE2eProduct(`e2e-${tag}-importat`);
    await login(page, owner, "/admin/produse");

    // linkul din lista de produse duce la import
    await page.getByRole("link", { name: "Import produse" }).click();
    await page.waitForURL(/\/admin\/produse\/import$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Import de produse");
    // firimitura din antet are eticheta paginii, nu «Editare produs» (segmentul «import» nu e un id de produs)
    await expect(
      page.locator("nav ol li").filter({ hasText: "Import de produse" }).first(),
    ).toBeVisible();
    await expect(page.locator("nav ol li").filter({ hasText: "Editare produs" })).toHaveCount(0);

    // șablonul se descarcă în ambele formate
    const template = await page.request.get("/api/admin/product-imports/template?format=csv");
    expect(template.status()).toBe(200);
    expect(template.headers()["content-disposition"]).toContain("sablon-import-produse.csv");
    // șablonul CSV începe cu BOM UTF-16LE (FF FE), apoi antetul cu TAB, fără «sep=»: Excel îl deschide cu
    // diacriticele corecte ȘI coloanele separate
    const templateBytes = new Uint8Array(await template.body());
    expect([...templateBytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(decodeUtf16le(templateBytes).slice(0, 11)).toBe(
      String.fromCharCode(0xfeff) + "SKU\tTitlu\t",
    );
    // XLSX-ul apare primul și recomandat, CSV-ul al doilea, cu instrucțiunea pentru Excel
    await expect(page.locator("[data-template]").first()).toHaveAttribute("data-template", "xlsx");
    await expect(page.locator("[data-template]").first()).toContainText("recomandat");
    await expect(page.locator("[data-excel-help]")).toContainText("Date → Din text/CSV");
    const templateXlsx = await page.request.get("/api/admin/product-imports/template?format=xlsx");
    expect(e2eZipNames(new Uint8Array(await templateXlsx.body()))).toContain("xl/workbook.xml");

    const file = {
      name: `e2e-${tag}-produse.csv`,
      buffer: csvFile([
        ["SKU", "Titlu", "Preț (lei, cu TVA)", "Preț achiziție", "Categorii", "Brand", "EAN"],
        [existing, `E2E ${tag} Titlu actualizat`, "150,50", "9999,99", "", "", ""],
        [
          created,
          `E2E ${tag} Importat`,
          "1299",
          "1",
          refs.categoryName,
          refs.brandName,
          "5901234123457",
        ],
        [sku("BAD"), "Preț greșit", "abc", "", "", "", ""],
        [sku("CAT"), "Categorie lipsă", "10", "", "Categorie inexistentă xyz", "", ""],
      ]),
    };
    await upload(page, file);

    // maparea: câmpurile recunoscute; coloana de cost e blocată și nemapabilă
    await expect(page.getByRole("heading", { name: "Mapează coloanele" })).toBeVisible();
    await expect(page.getByText("Delimitator", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Importă în câmpul: Preț achiziție")).toBeDisabled();
    await expect(page.locator('[data-blocked="cost"]')).toContainText("Nu se importă niciodată");
    await expect(page.getByLabel("Importă în câmpul: SKU")).toHaveValue("sku");
    await expect(page.getByLabel("Importă în câmpul: Preț (lei, cu TVA)")).toHaveValue("price");
    await page.locator("[data-import-check]").click();

    // verificarea: contoare și raport pe rând, fără nicio modificare în catalog
    await expect(page.getByRole("heading", { name: "Rezultatul verificării" })).toBeVisible();
    await expect(count(page, "new")).toHaveText("1");
    await expect(count(page, "updated")).toHaveText("1");
    await expect(count(page, "errors")).toHaveText("2");
    await expect(page.locator("[data-file-warnings]")).toContainText("Preț achiziție");
    await expect(reportRow(page, 4)).toContainText("Eroare");
    await expect(reportRow(page, 4)).toContainText("valoare invalidă „abc”");
    await expect(reportRow(page, 5)).toContainText(
      "categoria „Categorie inexistentă xyz” nu există",
    );
    await expect(reportRow(page, 2)).toContainText("Actualizat");
    await expect(reportRow(page, 2)).toContainText("Titlu, Preț (lei, cu TVA)");
    expect(await readE2eVariantBySku(created)).toBeNull();
    expect((await readE2eVariantBySku(existing))?.title).toBe(`E2E ${tag} Produs 01`);
    expect((await readE2eVariantBySku(existing))?.price).toBe(10_100);

    // raportul CSV: rândurile cu probleme, fără valoarea din coloana de cost
    const importId = await importIdOf(page);
    const report = await page.request.get(`/api/admin/product-imports/${importId}/report`);
    expect(report.status()).toBe(200);
    expect(report.headers()["content-disposition"]).toContain("attachment");
    // octeții raportului: BOM UTF-16LE (FF FE), apoi direct antetul cu TAB (Excel: diacritice corecte și coloane separate)
    const reportBytes = new Uint8Array(await report.body());
    expect([...reportBytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    const reportText = decodeUtf16le(reportBytes).slice(1);
    expect(reportText.startsWith("Rând\tSKU\tRezultat\tMotiv")).toBe(true);
    expect(report.headers()["content-type"]).toContain("text/csv");
    // textele cu virgulă (ex. «Ciornă, Activ sau Arhivat») rămân într-o singură celulă, nu se sparg pe virgulă
    expect(reportText).toContain("valoare invalidă „abc”");
    const badLine =
      reportText.split(String.fromCharCode(13, 10)).find((l) => l.includes("-BAD\t")) ?? "";
    const cells = badLine.split("\t");
    expect(cells).toHaveLength(5); // Rând, SKU, Rezultat, Motiv, Câmpuri: virgulele din motiv nu adaugă coloane
    expect(cells[3]).toContain("cu virgulă sau punct");
    expect(reportText).toContain(`${sku("BAD")}\teroare\t`);
    expect(reportText).not.toContain("9999");

    // aplicarea, cu confirmare
    await page.locator("[data-import-apply]").click();
    const dialog = page.getByRole("dialog", { name: "Aplici importul?" });
    await expect(dialog.locator("[data-import-summary]")).toContainText(
      "1 produs nou și 1 produs actualizat",
    );
    await dialog.locator("[data-import-confirm]").click();
    await expect(page.locator("[data-import-done]")).toBeVisible();
    await expect(count(page, "new")).toHaveText("1");

    const updated = await readE2eVariantBySku(existing);
    expect(updated).toMatchObject({
      title: `E2E ${tag} Titlu actualizat`,
      price: 15_050,
      hasCost: true, // costul existent rămâne neatins
    });
    expect(updated?.priceHistoryRows).toBeGreaterThanOrEqual(1);
    const newOne = await readE2eVariantBySku(created);
    expect(newOne).toMatchObject({
      status: "draft",
      price: 129_900,
      ean: "5901234123457",
      brandName: refs.brandName,
      categoryNames: [refs.categoryName],
      hasCost: false,
    });
    expect(await readE2eVariantBySku(sku("BAD"))).toBeNull();
    expect(await readE2eVariantBySku(sku("CAT"))).toBeNull();

    // un singur eveniment de audit, doar numere
    const events = await readE2eAuditByEntity("product.import", importId);
    expect(events).toHaveLength(1);
    expect(events[0]?.after).toMatchObject({ created: 1, updated: 1, errors: 2 });
    expect(JSON.stringify(events)).not.toContain("9999");
    // fișierul a fost șters, importul e încheiat
    expect(await readE2eImport(importId)).toMatchObject({ status: "completed", storageKey: null });
    // costul din fișier nu apare nicăieri în pagină
    expect(await page.content()).not.toContain("9999,99");
    expect(await page.content()).not.toContain(String(E2E_COST_SENTINEL));

    // a doua rulare a aceluiași fișier: nimic de aplicat
    await page.getByRole("button", { name: "Import nou" }).click();
    await upload(page, file);
    await page.locator("[data-import-check]").click();
    await expect(count(page, "new")).toHaveText("0");
    await expect(count(page, "updated")).toHaveText("0");
    await expect(count(page, "unchanged")).toHaveText("2");
    await expect(count(page, "errors")).toHaveText("2");
    await expect(page.locator("[data-import-apply]")).toBeDisabled();
    await expect(page.getByText("Nu există nimic de aplicat")).toBeVisible();

    // renunțarea șterge importul și fișierul
    const secondId = await importIdOf(page);
    await page.getByRole("button", { name: "Renunț la import" }).click();
    await expect(page.getByRole("heading", { name: "Alege fișierul" })).toBeVisible();
    expect(await readE2eImport(secondId)).toBeNull();
  });

  test("CSV salvat din Excel (separator «,», Windows-1250, antet în ghilimele) și șablonul CSV al aplicației se importă corect", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const ti = String.fromCharCode(0x21b);
    const si = String.fromCharCode(0x219);
    const sku = `E2E-${tag.toUpperCase()}-XL`;
    const title = `E2E ${tag} Pomp${String.fromCharCode(0x103)} de circula${ti}ie ${si}i filtru`;
    trackE2eProduct(`e2e-${tag}-pompa-de-circulatie-si-filtru`);
    await login(page, owner, "/admin/produse/import");

    // ce salvează Excel în limba română la «CSV (delimitat prin virgulă)»: Windows-1250, câmpuri în ghilimele
    const excel = ['"SKU","Titlu","Preț (lei, cu TVA)"', `"${sku}","${title}","1299,50"`].join(
      String.fromCharCode(13, 10),
    );
    await upload(page, {
      name: `e2e-${tag}-excel.csv`,
      buffer: Buffer.from(encodeWindows1250(excel)),
    });
    await expect(page.getByRole("heading", { name: "Mapează coloanele" })).toBeVisible();
    await expect(page.getByLabel("Delimitator")).toHaveValue(",");
    await expect(page.getByText("Codificare: windows-1250")).toBeVisible();
    await expect(page.getByText("l-am citit ca Windows-1250")).toBeVisible();
    await expect(page.getByLabel("Importă în câmpul: Preț (lei, cu TVA)")).toHaveValue("price");
    await page.locator("[data-import-check]").click();
    await expect(count(page, "new")).toHaveText("1");
    await page.locator("[data-import-apply]").click();
    await page
      .getByRole("dialog", { name: "Aplici importul?" })
      .locator("[data-import-confirm]")
      .click();
    await expect(page.locator("[data-import-done]")).toBeVisible();
    // diacriticele ajung corect (ș, ț cu virgulă), prețul cu virgulă zecimală e exact
    expect(await readE2eVariantBySku(sku)).toMatchObject({
      title,
      price: 129_950,
      status: "draft",
    });
    await page.getByRole("button", { name: "Import nou" }).click();

    // șablonul CSV al aplicației (UTF-16LE, TAB), încărcat înapoi: delimitatorul se detectează, fără avertismente
    const template = await page.request.get("/api/admin/product-imports/template?format=csv");
    await upload(page, {
      name: `e2e-${tag}-sablon.csv`,
      buffer: Buffer.from(await template.body()),
    });
    await expect(page.getByRole("heading", { name: "Mapează coloanele" })).toBeVisible();
    await expect(page.getByLabel("Delimitator")).toHaveValue("\t");
    await expect(page.getByText("Detectat din primul rând al fișierului.")).toBeVisible();
    await expect(page.getByText("l-am citit ca Windows-1250")).toHaveCount(0);
    await expect(page.getByLabel("Importă în câmpul: SKU")).toHaveValue("sku");
    await expect(page.getByRole("columnheader", { name: "Coloană din fișier" })).toBeVisible();
    await expect(page.getByRole("rowheader", { name: /^sep=/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Renunț la import" }).click();
  });

  test("câmpul de fișier: buton vizibil în română, accesibil de la tastatură, cu fișierul ales anunțat", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse/import");

    // în română, ca buton vizibil; fără textele native ale browserului
    const button = page.locator('label[for="import-file"]', { hasText: "Alege fișierul" });
    await expect(button).toBeVisible();
    await expect(button).toHaveText("Alege fișierul");
    const status = page.locator("#import-file ~ [role=status]");
    await expect(status).toHaveText("Niciun fișier ales");
    expect(await page.locator("main").innerText()).not.toMatch(/Choose File|No file chosen/i);

    // de la tastatură: câmpul real primește focusul, butonul arată inelul de focus, Spațiu deschide fereastra
    const input = page.locator("#import-file");
    await input.focus();
    // focusul ajunge pe câmp prin tastatură (Shift+Tab, apoi Tab), ca inelul «focus-visible» să se aplice
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(input).toBeFocused();
    await expect(button).not.toHaveCSS("box-shadow", "none");
    // înainte de Spațiu: unde e focusul de fapt (diagnostic: un eșec arată elementul, nu doar un timeout)
    const focus = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        tag: active?.tagName ?? null,
        id: active?.id ?? null,
        type: active instanceof HTMLInputElement ? active.type : null,
        disabled: active instanceof HTMLInputElement ? active.disabled : null,
        documentHasFocus: document.hasFocus(),
        readyState: document.readyState,
      };
    });
    expect(focus, "focusul trebuie să fie pe câmpul de fișier înainte de Spațiu").toMatchObject({
      tag: "INPUT",
      id: "import-file",
      type: "file",
      disabled: false,
    });
    // termen scurt DOAR pe așteptarea ferestrei: un eșec costă 15 s, nu 180 s
    const chooser = page.waitForEvent("filechooser", { timeout: 15_000 });
    await page.keyboard.press("Space");
    const picked = await chooser;
    expect(picked.isMultiple()).toBe(false);
    await picked.setFiles({
      name: "produse-ales.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        "SKU;Titlu" + String.fromCharCode(13, 10) + "A1;b" + String.fromCharCode(13, 10),
      ),
    });

    // fișierul ales și mărimea lui, într-o regiune anunțată de cititoarele de ecran
    await expect(status).toHaveText("produse-ales.csv (17 B)");
    await expect(status).toHaveAttribute("aria-live", "polite");
    await expect(input).toHaveAttribute("aria-describedby", /.+/);
    await page.screenshot({
      path: "test-results/file-input.png",
      clip: { x: 0, y: 0, width: 1280, height: 720 },
    });
  });

  test("coloana de cost nu se poate mapa: nici din interfață, nici forțând cererea; maparea corectă merge", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    await login(page, owner, "/admin/produse/import");
    trackE2eProduct(`e2e-${tag}-cost`);
    await upload(page, {
      name: `e2e-${tag}-cost.csv`,
      buffer: csvFile([
        ["SKU", "Titlu", "Preț", "Preț achiziție"],
        [`E2E-${tag.toUpperCase()}-C1`, `E2E ${tag} Cost`, "10", "5,55"],
      ]),
    });
    const costSelect = page.getByLabel("Importă în câmpul: Preț achiziție");
    await expect(costSelect).toBeDisabled();

    // forțez controlul din DOM și încerc să mapez costul pe «Preț»: serverul refuză
    await costSelect.evaluate((el) => el.removeAttribute("disabled"));
    await costSelect.selectOption("price");
    await page.getByLabel("Importă în câmpul: Preț", { exact: true }).selectOption("");
    await page.locator("[data-import-check]").click();
    await expect(page.locator("[data-problem]").first()).toContainText(
      "Prețul de achiziție nu se importă",
    );
    await expect(page.getByRole("heading", { name: "Rezultatul verificării" })).toHaveCount(0);

    // maparea corectă: coloana de cost rămâne nemapată
    await costSelect.selectOption("");
    await page.getByLabel("Importă în câmpul: Preț", { exact: true }).selectOption("price");
    await page.locator("[data-import-check]").click();
    await expect(count(page, "new")).toHaveText("1");
    await page.getByRole("button", { name: "Renunț la import" }).click();
  });

  test("import mare (peste prag): rulează în fundal, cu progres vizibil, și se termină cu raport", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const total = 130; // peste pragul implicit de 100 de rânduri
    const rows: string[][] = [["SKU", "Titlu", "Preț"]];
    for (let i = 0; i < total; i++) {
      const nn = String(i).padStart(3, "0");
      rows.push([`E2E-${tag.toUpperCase()}-B${nn}`, `E2E ${tag} Bulk ${nn}`, `${10 + i},50`]);
      trackE2eProduct(`e2e-${tag}-bulk-${nn}`);
    }
    await login(page, owner, "/admin/produse/import");
    await upload(page, { name: `e2e-${tag}-mare.csv`, buffer: csvFile(rows) });
    await page.locator("[data-import-check]").click();
    await expect(count(page, "new")).toHaveText(String(total));
    await expect(page.getByText("Fișierul e mare: se aplică în fundal")).toBeVisible();
    const importId = await importIdOf(page);

    await page.locator("[data-import-apply]").click();
    await page
      .getByRole("dialog", { name: "Aplici importul?" })
      .locator("[data-import-confirm]")
      .click();
    // progresul: bara apare cât timp jobul rulează
    await expect(page.locator("[data-import-progress]")).toBeVisible();
    await expect(page.locator("[data-import-done]")).toBeVisible({ timeout: 150_000 });
    await expect(count(page, "new")).toHaveText(String(total));
    await expect(count(page, "errors")).toHaveText("0");

    expect(await readE2eImport(importId)).toMatchObject({
      status: "completed",
      storageKey: null,
      processedRows: total,
      rowCount: total,
    });
    const events = await readE2eAuditByEntity("product.import", importId);
    expect(events).toHaveLength(1);
    expect(events[0]?.after).toMatchObject({ created: total, background: true });
    const last = await readE2eVariantBySku(`E2E-${tag.toUpperCase()}-B129`);
    expect(last).toMatchObject({ status: "draft", price: 13_950 });
  });

  test("XLSX se încarcă și se aplică; fișierele nepotrivite sunt refuzate cu mesaj clar", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const xlsxSku = `E2E-${tag.toUpperCase()}-X1`;
    trackE2eProduct(`e2e-${tag}-din-xlsx`);
    await login(page, owner, "/admin/produse/import");

    // XLSX valid
    const xlsx = await e2eXlsx([
      ["SKU", "Titlu", "Preț (lei, cu TVA)", "EAN"],
      [xlsxSku, `E2E ${tag} Din XLSX`, "249,90", "05901234123457"],
    ]);
    await upload(page, { name: `e2e-${tag}.xlsx`, buffer: xlsx });
    await expect(page.getByText(`e2e-${tag}.xlsx (XLSX)`)).toBeVisible();
    await page.locator("[data-import-check]").click();
    await expect(count(page, "new")).toHaveText("1");
    await page.locator("[data-import-apply]").click();
    await page
      .getByRole("dialog", { name: "Aplici importul?" })
      .locator("[data-import-confirm]")
      .click();
    await expect(page.locator("[data-import-done]")).toBeVisible();
    expect(await readE2eVariantBySku(xlsxSku)).toMatchObject({
      price: 24_990,
      ean: "05901234123457",
    });
    await page.getByRole("button", { name: "Import nou" }).click();

    const refused = async (name: string, buffer: Buffer, message: string) => {
      await upload(page, { name, buffer });
      await expect(page.locator("[data-problem]").first()).toContainText(message);
      await expect(page.getByRole("heading", { name: "Mapează coloanele" })).toHaveCount(0);
    };
    // .xls vechi (OLE2)
    await refused(
      `e2e-${tag}-vechi.xls`,
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]),
      "Formatul fișierului nu este acceptat",
    );
    // binar deghizat în CSV
    await refused(
      `e2e-${tag}-binar.csv`,
      Buffer.from([0x53, 0x4b, 0x55, 0x00, 0x01, 0x02]),
      "Formatul fișierului nu este acceptat",
    );
    // XLSX cu macro-uri
    await refused(`e2e-${tag}-macro.xlsx`, e2eXlsxWithMacros(xlsx), "macro-uri");
    // arhivă-bombă: foaia are 70 MB decomprimat (peste plafonul de 60 MB), dar câțiva KB comprimată
    const bomb = e2eXlsxBomb(xlsx, 70);
    expect(bomb.length).toBeLessThan(200 * 1024);
    await refused(`e2e-${tag}-bomba.xlsx`, bomb, "depășește limita de mărime");
    // fără rânduri de date
    await refused(`e2e-${tag}-gol.csv`, csvFile([["SKU", "Titlu"]]), "gol sau nu are rânduri");
  });

  test("încărcarea e protejată: fără origine 403, fără sesiune 401, Editorul și Suportul refuzați; pagina cere products.write", async ({
    page,
    request,
    baseURL,
    browser,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse/import");
    const cookies = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const body = Buffer.from("SKU;Titlu\nA1;b\n");

    const noOrigin = await request.post(`${baseURL}/api/admin/product-imports`, {
      headers: { cookie: cookies },
      data: body,
    });
    expect(noOrigin.status()).toBe(403);
    expect((await noOrigin.json()).code).toBe("ORIGIN_INVALID");
    const foreign = await request.post(`${baseURL}/api/admin/product-imports`, {
      headers: { cookie: cookies, origin: "https://evil.example" },
      data: body,
    });
    expect(foreign.status()).toBe(403);
    const anonymous = await request.post(`${baseURL}/api/admin/product-imports`, {
      headers: { origin: baseURL as string },
      data: body,
    });
    expect(anonymous.status()).toBe(401);
    const anonymousTemplate = await request.get(
      `${baseURL}/api/admin/product-imports/template?format=csv`,
    );
    expect(anonymousTemplate.status()).toBe(401);

    for (const role of ["editor", "support"]) {
      const context = await browser.newContext({ baseURL: baseURL as string });
      const other = await context.newPage();
      const account = await createAccount(other.request, baseURL as string, role);
      await other.goto(`/autentificare?next=${encodeURIComponent("/admin/produse")}`);
      await other.getByLabel("Email").fill(account.email);
      await other.getByLabel("Parolă", { exact: true }).fill(account.password);
      await other.getByRole("button", { name: "Intră în cont" }).click();
      if (role === "editor") {
        await other.waitForURL((url) => url.pathname === "/admin/produse");
        // Editorul nu vede linkul de import și pagina îi e interzisă
        await expect(other.getByRole("link", { name: "Import produse" })).toHaveCount(0);
        await other.goto("/admin/produse/import");
        await expect(other).toHaveURL(/\/admin\/acces-interzis/);
        const editorCookies = (await context.cookies())
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");
        const refusedUpload = await other.request.post(`${baseURL}/api/admin/product-imports`, {
          headers: { cookie: editorCookies, origin: baseURL as string },
          data: body,
        });
        expect(refusedUpload.status()).toBe(403);
        expect((await refusedUpload.json()).code).toBe("AUTH_FORBIDDEN");
      } else {
        await expect(other).toHaveURL(/\/admin\/acces-interzis/);
      }
      await context.close();
    }
  });
});

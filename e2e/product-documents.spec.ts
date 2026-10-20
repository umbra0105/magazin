import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  countE2eMediaWithKey,
  e2eStorageFileExists,
  promoteE2eUser,
  readE2eConformity,
  readE2eDocuments,
  readE2eProductAudit,
  removeE2eProducts,
  seedE2eProducts,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Documentele de produs și tabul Conformitate, în browser: încărcare reală, tip din octeți, PDF cu
 * conținut activ, peste limită, origine, descărcare cu antete de securitate, ștergere și înlocuire
 * (fără fișiere orfane), drepturi pe roluri.
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

async function openProduct(page: Page, tag: string, title: string) {
  await page.goto(`/admin/produse?q=${encodeURIComponent(`E2E ${tag}`)}`);
  await page.getByRole("link", { name: `Deschide produsul ${title}` }).click();
  await page.waitForURL(/\/admin\/produse\/[A-Za-z0-9_-]+(\?|$)/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(title);
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });

const pdf = (extra = "", pad = 0): Buffer =>
  Buffer.from(
    `%PDF-1.7\n1 0 obj\n<< /Type /Catalog ${extra} >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n${"%".repeat(pad)}`,
    "latin1",
  );

const productId = (page: Page): string => new URL(page.url()).pathname.split("/").pop() as string;

test.describe.configure({ mode: "serial", timeout: 150_000 });

test.afterEach(async () => {
  await removeE2eProducts();
});

test.describe("documente de produs", () => {
  test("PDF real: încărcat sub private/, nu în biblioteca media; descărcare cu antete de securitate; ștergere și înlocuire fără orfani", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const [title] = (await seedE2eProducts(tag, 1)) as [string];
    const slug = `e2e-${tag}-01`;
    await login(page, owner, "/admin/produse");
    await openProduct(page, tag, title);
    await tab(page, "Documente").click();

    // încărcare
    await page.getByLabel("Fișier", { exact: true }).setInputFiles({
      name: "Manual pompă.pdf",
      mimeType: "application/pdf",
      buffer: pdf(),
    });
    await page.getByLabel("Tip de document").selectOption("manual");
    await page.getByLabel("Titlu (gol = numele fișierului)").fill("Manual de utilizare");
    await page.getByRole("button", { name: "Încarcă", exact: true }).click();
    const row = page.locator('[data-document-row="Manual de utilizare"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText("Manual");
    await expect(row).toContainText("PDF");

    const [doc] = await readE2eDocuments(slug);
    expect(doc).toMatchObject({
      title: "Manual de utilizare",
      type: "manual",
      mime: "application/pdf",
    });
    expect(doc?.storageKey).toMatch(/^private\/product-documents\/[0-9a-f-]{36}\.pdf$/);
    expect(doc?.storageKey).not.toContain("Manual");
    expect(await e2eStorageFileExists(doc?.storageKey as string)).toBe(true);
    // nu e în biblioteca media
    expect(await countE2eMediaWithKey(doc?.storageKey as string)).toBe(0);
    await page.goto("/admin/media");
    await expect(page.getByText("Manual de utilizare")).toHaveCount(0);
    await page.goBack();
    await tab(page, "Documente").click();

    // descărcare: redirecționare la link semnat, apoi antetele de securitate ale fișierului
    const href = await page
      .getByRole("link", { name: "Descarcă documentul Manual de utilizare" })
      .getAttribute("href");
    const redirect = await page.request.get(href as string, { maxRedirects: 0 });
    expect(redirect.status()).toBe(302);
    expect(redirect.headers()["cache-control"]).toContain("no-store");
    const signed = redirect.headers()["location"] as string;
    expect(signed).toContain("/storage/signed/private/product-documents/");
    const file = await request.get(signed);
    expect(file.status()).toBe(200);
    expect(file.headers()["content-type"]).toContain("application/pdf");
    expect(file.headers()["content-disposition"]).toContain("attachment");
    expect(file.headers()["x-content-type-options"]).toBe("nosniff");
    expect(file.headers()["content-security-policy"]).toContain("sandbox");
    expect((await file.body()).subarray(0, 5).toString()).toBe("%PDF-");

    // un PDF de peste 10 MB (limita implicită a Next la corpul cererii) se salvează ÎNTREG
    const bigId = productId(page);
    const cookies = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const big = pdf("", 12 * 1024 * 1024);
    const bigResponse = await request.post(
      `${baseURL}/api/admin/products/${bigId}/documents?type=datasheet&title=Mare`,
      {
        headers: { cookie: cookies, origin: baseURL as string, "x-file-name": "mare.pdf" },
        data: big,
      },
    );
    expect(bigResponse.status()).toBe(201);
    const stored = (await readE2eDocuments(slug)).find((d) => d.title === "Mare");
    expect(stored?.sizeBytes).toBe(big.length);
    expect(stored?.sizeBytes).toBeGreaterThan(10 * 1024 * 1024);
    // îl ștergem ca să nu atingă restul pașilor
    await request.get(`${baseURL}/api/admin/products/${bigId}/documents/${stored?.id}`, {
      headers: { cookie: cookies },
      maxRedirects: 0,
    });
    await page.reload();
    await tab(page, "Documente").click();
    await page.getByRole("button", { name: "Șterge documentul Mare" }).click();
    await page
      .getByRole("dialog", { name: "Ștergi documentul «Mare»?" })
      .getByRole("button", { name: "Șterge documentul" })
      .click();
    await expect(page.locator('[data-document-row="Mare"]')).toHaveCount(0);
    expect(await e2eStorageFileExists(stored?.storageKey as string)).toBe(false);

    // înlocuire: fișier nou, cheie nouă, cel vechi dispare
    await page
      .getByLabel("Înlocuiește fișierul pentru Manual de utilizare")
      .setInputFiles({ name: "v2.pdf", mimeType: "application/pdf", buffer: pdf("", 20) });
    await expect(page.getByRole("status").filter({ hasText: "înlocuit" })).toBeVisible();
    const [replaced] = await readE2eDocuments(slug);
    expect(replaced?.id).toBe(doc?.id);
    expect(replaced?.storageKey).not.toBe(doc?.storageKey);
    expect(await e2eStorageFileExists(replaced?.storageKey as string)).toBe(true);
    expect(await e2eStorageFileExists(doc?.storageKey as string)).toBe(false);

    // ștergere cu confirmare: rândul și fișierul dispar
    await page.getByRole("button", { name: "Șterge documentul Manual de utilizare" }).click();
    const dialog = page.getByRole("dialog", { name: "Ștergi documentul «Manual de utilizare»?" });
    await dialog.getByRole("button", { name: "Anulează" }).click();
    expect(await readE2eDocuments(slug)).toHaveLength(1);
    await page.getByRole("button", { name: "Șterge documentul Manual de utilizare" }).click();
    await page
      .getByRole("dialog", { name: "Ștergi documentul «Manual de utilizare»?" })
      .getByRole("button", { name: "Șterge documentul" })
      .click();
    await expect(row).toHaveCount(0);
    expect(await readE2eDocuments(slug)).toHaveLength(0);
    expect(await e2eStorageFileExists(replaced?.storageKey as string)).toBe(false);

    const actions = (await readE2eProductAudit(slug)).map((a) => `${a.action}:${a.outcome}`);
    expect(actions).toEqual(
      expect.arrayContaining([
        "product.document.upload:success",
        "product.document.replace:success",
        "product.document.delete:success",
      ]),
    );
  });

  test("refuzuri: .txt redenumit .pdf, PDF cu JavaScript, peste limită, fără origine; nimic nu se scrie", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const [title] = (await seedE2eProducts(tag, 1)) as [string];
    const slug = `e2e-${tag}-01`;
    await login(page, owner, "/admin/produse");
    await openProduct(page, tag, title);
    await tab(page, "Documente").click();

    const upload = async (name: string, buffer: Buffer) => {
      await page
        .getByLabel("Fișier", { exact: true })
        .setInputFiles({ name, mimeType: "application/pdf", buffer });
      await page.getByRole("button", { name: "Încarcă", exact: true }).click();
    };

    // 1) text redenumit .pdf
    await upload("fals.pdf", Buffer.from("Aceasta nu este un PDF, doar text."));
    await expect(page.locator("[data-problem]").first()).toContainText(
      "Tipul fișierului nu este acceptat",
    );

    // 2) PDF cu JavaScript: mesaj cu soluția
    await upload("activ.pdf", pdf("/OpenAction << /S /JavaScript /JS (app.alert(1)) >>"));
    await expect(page.locator("[data-problem]").first()).toContainText("Tipărește");
    await expect(page.locator("[data-problem]").first()).toContainText("Salvează ca PDF");

    // 3) peste limită, din interfață (verificarea clientului) și direct pe rută (autoritatea serverului)
    await upload("mare.pdf", pdf("", 16 * 1024 * 1024));
    await expect(page.getByText("depășește 15 MB").first()).toBeVisible();

    const id = productId(page);
    const cookies = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const post = (headers: Record<string, string>, body: Buffer, query = "type=manual") =>
      request.post(`${baseURL}/api/admin/products/${id}/documents?${query}`, {
        headers: { cookie: cookies, "x-file-name": "x.pdf", ...headers },
        data: body,
      });

    const tooBig = await post({ origin: baseURL as string }, pdf("", 16 * 1024 * 1024));
    expect(tooBig.status()).toBe(413);
    expect(await tooBig.json()).toMatchObject({ code: "DOCUMENT_TOO_LARGE" });

    // 4) fără origine (CSRF): refuzat înainte de orice altceva
    const noOrigin = await post({}, pdf());
    expect(noOrigin.status()).toBe(403);
    expect(await noOrigin.json()).toMatchObject({ code: "ORIGIN_INVALID" });
    const wrongOrigin = await post({ origin: "https://rau.example" }, pdf());
    expect(wrongOrigin.status()).toBe(403);

    // 5) fără sesiune
    const anonymous = await request.post(
      `${baseURL}/api/admin/products/${id}/documents?type=manual`,
      { headers: { origin: baseURL as string, "x-file-name": "x.pdf" }, data: pdf() },
    );
    expect(anonymous.status()).toBe(401);

    // nimic nu s-a scris; încercările refuzate sunt în audit, cu motivul și fără conținut
    expect(await readE2eDocuments(slug)).toHaveLength(0);
    const audit = await readE2eProductAudit(slug);
    const denied = audit.filter(
      (a) => a.action === "product.document.upload" && a.outcome === "denied",
    );
    expect(denied.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(audit)).not.toContain("%PDF");
  });

  test("Editor poate încărca; Depozit (doar products.read) vede lista dar serverul refuză încărcarea", async ({
    page,
    request,
    baseURL,
    browser,
  }) => {
    const editor = await createAccount(request, baseURL as string, "editor");
    const warehouse = await createAccount(request, baseURL as string, "warehouse");
    const tag = randomBytes(3).toString("hex");
    const [title] = (await seedE2eProducts(tag, 1)) as [string];
    const slug = `e2e-${tag}-01`;

    await login(page, editor, "/admin/produse");
    await openProduct(page, tag, title);
    await tab(page, "Documente").click();
    await page.getByLabel("Fișier", { exact: true }).setInputFiles({
      name: "fisa.pdf",
      mimeType: "application/pdf",
      buffer: pdf(),
    });
    await page.getByLabel("Tip de document").selectOption("datasheet");
    await page.getByRole("button", { name: "Încarcă", exact: true }).click();
    await expect(page.locator('[data-document-row="fisa"]')).toBeVisible();
    expect(await readE2eDocuments(slug)).toHaveLength(1);
    const id = productId(page);

    // Depozit: vede documentul, nu are formular de încărcare, iar ruta refuză
    const context = await browser.newContext({ baseURL: baseURL as string });
    const wPage = await context.newPage();
    await login(wPage, warehouse, "/admin/produse");
    await wPage.goto(`/admin/produse/${id}?tab=documente`);
    await expect(wPage.getByRole("tab", { name: "Documente", exact: true })).toBeVisible();
    await expect(wPage.locator('[data-document-row="fisa"]')).toBeVisible();
    await expect(wPage.getByLabel("Fișier", { exact: true })).toHaveCount(0);
    const cookies = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const refused = await request.post(
      `${baseURL}/api/admin/products/${id}/documents?type=manual`,
      {
        headers: { cookie: cookies, origin: baseURL as string, "x-file-name": "x.pdf" },
        data: pdf(),
      },
    );
    expect(refused.status()).toBe(403);
    expect(await readE2eDocuments(slug)).toHaveLength(1);
    await context.close();
  });

  test("Conformitate: clasă energetică, EPREL doar https, GPSR; Editorul le vede doar citire", async ({
    page,
    request,
    baseURL,
    browser,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const editor = await createAccount(request, baseURL as string, "editor");
    const tag = randomBytes(3).toString("hex");
    const [title] = (await seedE2eProducts(tag, 1)) as [string];
    const slug = `e2e-${tag}-01`;

    await login(page, owner, "/admin/produse");
    await openProduct(page, tag, title);
    await tab(page, "Conformitate").click();
    await page.getByLabel("Clasă energetică").selectOption("A++");
    await page.getByLabel("Link EPREL").fill("http://eprel.example/qr/1");
    await page.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(page.getByLabel("Link EPREL")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("[data-problem]").first()).toContainText("https://");

    await page.getByLabel("Link EPREL").fill("https://eprel.ec.europa.eu/qr/123456");
    await page.getByLabel("Producător: nume").fill("Pompe SRL");
    await page.getByLabel("Persoană responsabilă din UE: nume").fill("Responsabil UE SRL");
    await page
      .getByLabel("Avertismente de siguranță și instrucțiuni")
      .fill("Nu folosiți fără apă.");
    await page.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "salvate" })).toBeVisible();
    await expect
      .poll(async () => readE2eConformity(slug))
      .toMatchObject({
        energyClass: "A++",
        eprelUrl: "https://eprel.ec.europa.eu/qr/123456",
        gpsrManufacturerName: "Pompe SRL",
        gpsrResponsibleName: "Responsabil UE SRL",
        safetyWarnings: "Nu folosiți fără apă.",
      });

    // Editorul: câmpurile sunt dezactivate (și serverul le respinge oricum)
    const context = await browser.newContext({ baseURL: baseURL as string });
    const ePage = await context.newPage();
    await login(ePage, editor, "/admin/produse");
    await openProduct(ePage, tag, title);
    await tab(ePage, "Conformitate").click();
    await expect(ePage.getByLabel("Clasă energetică")).toBeDisabled();
    await expect(ePage.getByLabel("Link EPREL")).toBeDisabled();
    await expect(ePage.getByLabel("Producător: nume")).toBeDisabled();
    await expect(ePage.getByRole("button", { name: "Salvează", exact: true })).toHaveCount(0);
    await context.close();
  });
});

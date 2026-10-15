import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  countE2eProductAuditEvents,
  promoteE2eUser,
  readE2eDiagram,
  readE2eLifecycle,
  removeE2eDiagrams,
  removeE2eProducts,
  seedE2eDiagramWithHotspot,
  seedE2eProducts,
  setE2eModelSpecifics,
  trackE2eProduct,
} from "../packages/core/test/e2e-support";

/**
 * Ciclul de viață al produsului, în browser (punctul 13): duplicare (ce se copiază și ce NU),
 * arhivare, coș de gunoi cu restaurare pe selecție, ștergere definitivă cu hotspot-uri rămase fără
 * produs, drepturi pe roluri.
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

const titleOf = (tag: string, n: number): string =>
  `E2E ${tag} Produs ${String(n).padStart(2, "0")}`;
const slugOf = (tag: string, n: number): string => `e2e-${tag}-${String(n).padStart(2, "0")}`;
const skuOf = (tag: string, n: number): string =>
  `E2E-${tag.toUpperCase()}-${String(n).padStart(2, "0")}`;
const productRow = (page: Page, title: string) => page.locator(`[data-product-title="${title}"]`);

async function openList(page: Page, tag: string, view: "active" | "deleted" = "active") {
  const view_ = view === "deleted" ? "&view=deleted" : "";
  await page.goto(`/admin/produse?q=${encodeURIComponent(`E2E ${tag}`)}${view_}`);
  await expect(page.locator("[data-product-total]")).toBeVisible();
}

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.afterEach(async () => {
  await removeE2eDiagrams();
  await removeE2eProducts();
});

test.describe("ciclul de viață al produsului", () => {
  test("duplicare: ciornă cu cod și adresă noi; fără cost, EAN, documente, identificatori vechi, energie; istoric de preț nou", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    await seedE2eProducts(tag, 1);
    await setE2eModelSpecifics(slugOf(tag, 1), {
      ean: "5900000000017",
      energyClass: "A++",
      legacyId: `woo-${tag}`,
      documentTitle: `Manual ${tag}`,
    });
    const source = titleOf(tag, 1);
    const copySlug = `e2e-${tag}-produs-01-copie`;
    trackE2eProduct(copySlug);
    trackE2eProduct(`${copySlug}-2`);
    await login(page, owner, "/admin/produse");

    // din pagina produsului
    await openList(page, tag);
    await page.getByRole("link", { name: `Deschide produsul ${source}` }).click();
    await page.waitForURL(/\/admin\/produse\/[A-Za-z0-9_-]+(\?|$)/);
    await page.getByRole("button", { name: "Duplică", exact: true }).click();
    await page.waitForURL(/copied=1/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(`${source} (copie)`);
    await expect(page.locator("[data-copy-note]")).toContainText("-COPIE");
    await expect(page.getByText("Documentele (1) NU s-au copiat")).toBeVisible();
    // nicio urmă a prețului de achiziție al sursei în pagina copiei
    const html = await page.content();
    expect(html).not.toContain("777777");
    expect(html).not.toMatch(/7\.?777,77/);

    const copy = await readE2eLifecycle(copySlug);
    expect(copy).toMatchObject({
      title: `${source} (copie)`,
      status: "draft",
      deleted: false,
      legacyId: null,
      energyClass: null,
      documentCount: 0,
      priceHistoryRows: 1,
      costHistoryRows: 0,
    });
    expect(copy?.variants).toEqual([
      { sku: `${skuOf(tag, 1)}-COPIE`, ean: null, hasCost: false, hasCostDate: false },
    ]);
    // sursa rămâne neatinsă
    const original = await readE2eLifecycle(slugOf(tag, 1));
    expect(original).toMatchObject({
      legacyId: `woo-${tag}`,
      energyClass: "A++",
      documentCount: 1,
    });
    expect(original?.variants[0]).toMatchObject({ ean: "5900000000017", hasCost: true });
    expect(await countE2eProductAuditEvents("product.duplicate", [copySlug])).toBe(1);

    // a doua copie, din listă: adresa și codul rămân unice
    await openList(page, tag);
    await page.getByRole("button", { name: `Duplică produsul ${source}`, exact: true }).click();
    await page.waitForURL(/copied=1/);
    const second = await readE2eLifecycle(`${copySlug}-2`);
    expect(second?.variants[0]?.sku).toBe(`${skuOf(tag, 1)}-COPIE-2`);
    expect(second?.status).toBe("draft");
  });

  test("arhivare, coș de gunoi și restaurare pe selecție, cu confirmare și un singur eveniment de audit", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    await seedE2eProducts(tag, 3); // 01 și 02 ciorne, 03 activ
    await login(page, owner, "/admin/produse");
    await openList(page, tag);

    // arhivare pe selecție de 2
    await page.getByLabel(`Selectează ${titleOf(tag, 1)}`).check();
    await page.getByLabel(`Selectează ${titleOf(tag, 2)}`).check();
    const bar = page.locator("[data-lifecycle-bar]");
    await bar.getByRole("button", { name: "Arhivează", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: /Arhivează: 2 produse/ });
    await expect(dialog).toContainText("dispar din magazin");
    await dialog.locator("[data-lifecycle-confirm]").click();
    await expect(productRow(page, titleOf(tag, 1))).toContainText("Arhivat");
    await expect(productRow(page, titleOf(tag, 2))).toContainText("Arhivat");
    expect((await readE2eLifecycle(slugOf(tag, 1)))?.status).toBe("archived");
    // UN singur eveniment agregat pentru cele două produse
    expect(
      await countE2eProductAuditEvents("product.archive", [slugOf(tag, 1), slugOf(tag, 2)]),
    ).toBe(1);

    // o selecție mixtă (arhivat + ciornă) nu se poate arhiva din nou
    await page.getByLabel(`Selectează ${titleOf(tag, 1)}`).check();
    await page.getByLabel(`Selectează ${titleOf(tag, 3)}`).check();
    await expect(bar.getByRole("button", { name: "Arhivează", exact: true })).toBeDisabled();
    await expect(bar.getByRole("button", { name: "Dezarhivează", exact: true })).toBeDisabled();
    await page.getByLabel(`Selectează ${titleOf(tag, 3)}`).uncheck();

    // dezarhivare: revine ca ciornă
    await bar.getByRole("button", { name: "Dezarhivează", exact: true }).click();
    await page
      .getByRole("dialog", { name: /Dezarhivează: 1 produs/ })
      .locator("[data-lifecycle-confirm]")
      .click();
    await expect(productRow(page, titleOf(tag, 1))).toContainText("Ciornă");

    // coș de gunoi: 02 (arhivat) și 03 (activ) pleacă din listă, fără să-și piardă starea
    await page.getByLabel(`Selectează ${titleOf(tag, 2)}`).check();
    await page.getByLabel(`Selectează ${titleOf(tag, 3)}`).check();
    await bar.getByRole("button", { name: "Mută în coșul de gunoi" }).click();
    await page
      .getByRole("dialog", { name: /Mută în coșul de gunoi: 2 produse/ })
      .locator("[data-lifecycle-confirm]")
      .click();
    await expect(productRow(page, titleOf(tag, 2))).toHaveCount(0);
    await expect(productRow(page, titleOf(tag, 3))).toHaveCount(0);
    const deletedActive = await readE2eLifecycle(slugOf(tag, 3));
    expect(deletedActive).toMatchObject({ deleted: true, status: "active" });
    // produsul din coșul de gunoi nu mai are pagină de editare
    const gone = await page.goto(`/admin/produse/${deletedActive?.id as string}`);
    expect(gone?.status()).toBe(404);

    // vederea „Coș de gunoi”
    await openList(page, tag, "deleted");
    await expect(page.locator("[data-product-views]")).toContainText("Coș de gunoi");
    await expect(productRow(page, titleOf(tag, 2))).toContainText("Șters la");
    await expect(productRow(page, titleOf(tag, 3))).toBeVisible();
    await expect(productRow(page, titleOf(tag, 1))).toHaveCount(0);

    // restaurare: revine cu starea de dinainte (activ)
    await page.locator(`[data-restore="${deletedActive?.id as string}"]`).click();
    await page
      .getByRole("dialog", { name: /Restaurează: 1 produs/ })
      .locator("[data-lifecycle-confirm]")
      .click();
    await expect(productRow(page, titleOf(tag, 3))).toHaveCount(0);
    expect(await readE2eLifecycle(slugOf(tag, 3))).toMatchObject({
      deleted: false,
      status: "active",
    });
    await openList(page, tag);
    await expect(productRow(page, titleOf(tag, 3))).toContainText("Activ");
  });

  test("ștergere definitivă: doar din coșul de gunoi, cu adresa tastată; hotspot-ul rămâne în fișă, fără produs", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    await seedE2eProducts(tag, 1);
    const title = titleOf(tag, 1);
    const slug = slugOf(tag, 1);
    const diagramTitle = `E2E Fișă ${tag}`;
    await seedE2eDiagramWithHotspot(owner.email, slug, diagramTitle);
    await login(page, owner, "/admin/produse");

    // întâi în coșul de gunoi, din pagina produsului (revine la listă)
    await openList(page, tag);
    await page.getByRole("link", { name: `Deschide produsul ${title}` }).click();
    await page.waitForURL(/\/admin\/produse\/[A-Za-z0-9_-]+(\?|$)/);
    await page.getByRole("button", { name: "Mută în coșul de gunoi" }).click();
    await page
      .getByRole("dialog", { name: /Mută în coșul de gunoi: 1 produs/ })
      .locator("[data-lifecycle-confirm]")
      .click();
    await page.waitForURL((url) => url.pathname === "/admin/produse");
    expect((await readE2eLifecycle(slug))?.deleted).toBe(true);

    // ștergerea definitivă arată ce se șterge și ce rămâne (flag-ul fișelor e OPRIT: tot se vede)
    await openList(page, tag, "deleted");
    await page.getByRole("button", { name: `Șterge definitiv… ${title}` }).click();
    const dialog = page.getByRole("dialog", { name: `Ștergi definitiv „${title}”?` });
    await expect(dialog.locator("[data-purge-impact]")).toBeVisible();
    await expect(dialog.locator("[data-purge-diagrams]")).toContainText(diagramTitle);
    await expect(dialog.locator("[data-purge-hotspots]")).toContainText(
      `${diagramTitle}, hotspot 7`,
    );
    await expect(dialog).toContainText("1 variantă");

    // fără adresa corectă, butonul rămâne dezactivat
    const confirm = dialog.locator("[data-purge-confirm]");
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(/Scrie adresa produsului/).fill("alt-produs");
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(/Scrie adresa produsului/).fill(slug);
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(productRow(page, title)).toHaveCount(0);

    // produsul a dispărut; fișa și hotspot-ul rămân, hotspot-ul fără produs
    expect(await readE2eLifecycle(slug)).toBeNull();
    const diagram = await readE2eDiagram(diagramTitle);
    expect(diagram?.hotspots).toEqual([
      expect.objectContaining({ number: 7, productSlug: null, xBp: 2500, yBp: 4000 }),
    ]);
    expect(diagram?.productSlugs).toEqual([]);
  });

  test("drepturi: Editorul vede lista și coșul, dar nu are nicio acțiune de ciclu de viață", async ({
    page,
    request,
    baseURL,
  }) => {
    const editor = await createAccount(request, baseURL as string, "editor");
    const tag = randomBytes(3).toString("hex");
    await seedE2eProducts(tag, 1);
    await login(page, editor, "/admin/produse");
    await openList(page, tag);
    await expect(productRow(page, titleOf(tag, 1))).toBeVisible();
    await expect(page.locator("[data-duplicate]")).toHaveCount(0);
    await expect(page.getByLabel(`Selectează ${titleOf(tag, 1)}`)).toHaveCount(0);
    await expect(page.locator("[data-lifecycle-bar]")).toHaveCount(0);

    await page.getByRole("link", { name: `Deschide produsul ${titleOf(tag, 1)}` }).click();
    await page.waitForURL(/\/admin\/produse\/[A-Za-z0-9_-]+(\?|$)/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(titleOf(tag, 1));
    await expect(page.locator("[data-lifecycle-actions]")).toHaveCount(0);

    // coșul de gunoi: vizibil pentru citire, fără restaurare sau ștergere definitivă
    await openList(page, tag, "deleted");
    await expect(page.locator("[data-restore]")).toHaveCount(0);
    await expect(page.locator("[data-purge]")).toHaveCount(0);
  });
});

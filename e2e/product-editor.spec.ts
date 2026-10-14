import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  E2E_COST_SENTINEL,
  insertE2eMedia,
  promoteE2eUser,
  readE2eProduct,
  readE2eProductAudit,
  removeE2eCatalogRefs,
  removeE2eProducts,
  seedE2eCatalogRefs,
  seedE2eProducts,
  trackE2eProduct,
} from "../packages/core/test/e2e-support";

/**
 * Editorul de produs, în browser (blocul 11a): creare completă, taburi cu tastatură, drepturi pe roluri
 * (Editor: conținut; Manager: preț; Admin/Owner: tot), prețul de achiziție absent din HTML pentru cine
 * nu are voie, protecția la părăsirea paginii. Produsele de probă au adresa `e2e-…`.
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

/** Deschide editorul produsului dat prin linkul „Deschide” din listă (testează și legătura). */
async function openFromList(page: Page, tag: string, title: string) {
  await page.goto(`/admin/produse?q=${encodeURIComponent(`E2E ${tag}`)}`);
  await page.getByRole("link", { name: `Deschide produsul ${title}` }).click();
  await page.waitForURL(/\/admin\/produse\/[A-Za-z0-9_-]+(\?|$)/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(title);
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const save = (page: Page) => page.getByRole("button", { name: "Salvează", exact: true });

test.describe.configure({ mode: "serial", timeout: 150_000 });

test.afterEach(async () => {
  await removeE2eProducts();
  await removeE2eCatalogRefs();
});

test.describe("editorul de produs", () => {
  test("Owner: creează un produs complet (titlu, preț, brand, categorie), apoi preț redus, stare, imagine, SEO", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const { categoryName, brandName } = await seedE2eCatalogRefs(tag);
    const imageName = `poza-${tag}.png`;
    await insertE2eMedia(owner.email, { name: imageName, status: "ready" });
    const title = `E2E Produs ${tag}`;
    const slug = `e2e-produs-${tag}`;
    trackE2eProduct(slug);

    await login(page, owner, "/admin/produse/nou");
    await page.getByLabel("Titlu", { exact: true }).fill(title);
    await page.getByLabel("SKU (cod intern)").fill(`E2E-SKU-${tag.toUpperCase()}`);
    await page.getByLabel("Preț (lei, cu TVA)").fill("12,345");
    await page.getByRole("button", { name: "Creează produsul" }).click();
    // sumă invalidă: mesaj legat de câmp, fără apel la server
    await expect(page.locator("[data-problem]").first()).toBeVisible();
    await expect(page.getByLabel("Preț (lei, cu TVA)")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("Preț (lei, cu TVA)")).toBeFocused();
    await page.getByLabel("Preț (lei, cu TVA)").fill("249,50");
    await page.getByLabel("Brand").selectOption({ label: brandName });
    await page.getByLabel("Categorie").selectOption({ label: categoryName });
    await page.getByRole("button", { name: "Creează produsul" }).click();

    await page.waitForURL(/\/admin\/produse\/[A-Za-z0-9_-]+\?created=1/);
    await expect(page.getByText("Produsul a fost creat")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(title);

    const created = await readE2eProduct(slug);
    expect(created).toMatchObject({
      title,
      status: "draft",
      price: 24950,
      categoryNames: [categoryName],
    });

    // Prețuri: previzualizare fără TVA (cota din setări), validarea prețului redus și a ferestrei
    await tab(page, "Prețuri").click();
    await expect(page.getByLabel("Preț (lei, cu TVA)")).toHaveValue("249,50");
    await expect(page.getByText(/Fără TVA \(21%\)/).first()).toBeVisible();
    await page.getByLabel("Preț redus (lei, cu TVA)").fill("300");
    await save(page).click();
    await expect(page.getByLabel("Preț redus (lei, cu TVA)")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.locator("[data-problem]").first()).toContainText("nu poate depăși");
    await page.getByLabel("Preț redus (lei, cu TVA)").fill("199,90");
    await page.getByLabel("Promoția începe").fill("2026-11-10T00:00");
    await page.getByLabel("Promoția se termină").fill("2026-11-01T00:00");
    await save(page).click();
    await expect(page.getByLabel("Promoția se termină")).toHaveAttribute("aria-invalid", "true");
    await page.getByLabel("Promoția se termină").fill("2026-11-30T23:59");
    await save(page).click();
    await expect(page.getByRole("status").filter({ hasText: "salvate" })).toBeVisible();
    expect(await readE2eProduct(slug)).toMatchObject({ price: 24950, salePrice: 19990 });

    // General: starea „Activ” aplică garanția implicită din setare (24 de luni)
    await tab(page, "General").click();
    await page.getByLabel("Stare", { exact: true }).selectOption("active");
    await save(page).click();
    await expect(page.getByRole("status").filter({ hasText: "salvate" })).toBeVisible();
    await expect.poll(async () => (await readE2eProduct(slug))?.warrantyMonths).toBe(24);
    expect(await readE2eProduct(slug)).toMatchObject({ status: "active" });

    // Media: imaginea din bibliotecă, prin selector
    await tab(page, "Media").click();
    await page.getByRole("button", { name: "Adaugă din bibliotecă" }).click();
    const picker = page.getByRole("dialog", { name: "Alege imaginile produsului" });
    await picker.getByLabel("Caută după nume, text alternativ sau tag").fill(tag);
    await picker.getByRole("button", { name: "Caută" }).click();
    await picker.getByRole("button", { name: new RegExp(`^(Alege )?poza-${tag}`) }).click();
    await picker.getByRole("button", { name: "Alege 1 imagine" }).click();
    await expect(page.locator("[data-media-item]")).toHaveCount(1);
    await expect(page.locator("[data-media-item]")).toContainText(imageName);
    await expect.poll(async () => (await readE2eProduct(slug))?.mediaNames).toEqual([imageName]);

    // SEO
    await tab(page, "SEO").click();
    await page.getByLabel("Titlu SEO").fill(`Pompă ${tag} | Magazin`);
    await page.getByLabel("Descriere SEO").fill("Descriere pentru motoarele de căutare.");
    await save(page).click();
    await expect(page.getByRole("status").filter({ hasText: "salvate" })).toBeVisible();

    // după reîncărcare, totul persistă
    await page.reload();
    await expect(page.getByLabel("Titlu", { exact: true })).toHaveValue(title);
    await tab(page, "SEO").click();
    await expect(page.getByLabel("Titlu SEO")).toHaveValue(`Pompă ${tag} | Magazin`);
    await tab(page, "Prețuri").click();
    await expect(page.getByLabel("Preț redus (lei, cu TVA)")).toHaveValue("199,90");
    await tab(page, "Categorii").click();
    await expect(page.getByRole("checkbox", { name: categoryName })).toBeChecked();

    // audit: scrierile au rânduri (fără valori sensibile; rândurile de cost nu există aici)
    const actions = (await readE2eProductAudit(slug)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["product.create", "product.update"]));
  });

  test("Editor: vede prețul doar pentru citire, costul lipsește din HTML, editează doar conținutul", async ({
    page,
    request,
    baseURL,
  }) => {
    const editor = await createAccount(request, baseURL as string, "editor");
    const tag = randomBytes(3).toString("hex");
    const [title] = (await seedE2eProducts(tag, 1)) as [string];
    await login(page, editor, "/admin/produse");
    await openFromList(page, tag, title);

    await expect(page.getByText("Poți edita doar conținutul produsului")).toBeVisible();

    // preț doar pentru citire, vizibil
    await tab(page, "Prețuri").click();
    await expect(page.getByLabel("Preț (lei, cu TVA)")).toHaveValue("101,00");
    await expect(page.getByLabel("Preț (lei, cu TVA)")).toBeDisabled();
    await expect(save(page)).toHaveCount(0);

    // costul nu există nicăieri în pagină: nici valoarea, nici panoul, nici câmpul gol sau ascuns
    const html = await page.content();
    for (const needle of [
      String(E2E_COST_SENTINEL),
      "7777,77",
      "7.777,77",
      "Preț de achiziție",
      "purchase-amount",
    ]) {
      expect(html, `„${needle}” în pagina Editorului`).not.toContain(needle);
    }

    // stoc, categorii: doar citire
    await tab(page, "Stoc").click();
    await expect(page.getByLabel("Disponibilitate")).toBeDisabled();
    await tab(page, "Categorii").click();
    await expect(save(page)).toHaveCount(0);

    // General: titlul se poate edita, starea nu
    await tab(page, "General").click();
    await expect(page.getByLabel("Stare", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("Brand")).toBeDisabled();
    await page.getByLabel("Titlu", { exact: true }).fill(`${title} (de Editor)`);
    await save(page).click();
    await expect(page.getByRole("status").filter({ hasText: "salvate" })).toBeVisible();
    expect((await readE2eProduct(`e2e-${tag}-01`))?.title).toBe(`${title} (de Editor)`);

    // SEO și Media: editabile (conținut)
    await tab(page, "SEO").click();
    await expect(page.getByLabel("Titlu SEO")).toBeEnabled();
    await tab(page, "Media").click();
    await expect(page.getByRole("button", { name: "Adaugă din bibliotecă" })).toBeVisible();

    // navigarea cu tastatura între taburi: săgeată dreapta, Home, End
    await tab(page, "General").focus();
    await page.keyboard.press("ArrowRight");
    await expect(tab(page, "Prețuri")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    await expect(tab(page, "SEO")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await expect(tab(page, "General")).toHaveAttribute("aria-selected", "true");
  });

  test("Manager: vede prețul de achiziție doar pentru citire și poate edita prețul", async ({
    page,
    request,
    baseURL,
  }) => {
    const manager = await createAccount(request, baseURL as string, "manager");
    const tag = randomBytes(3).toString("hex");
    const [title] = (await seedE2eProducts(tag, 1)) as [string];
    await login(page, manager, "/admin/produse");
    await openFromList(page, tag, title);

    await tab(page, "Prețuri").click();
    // prețul public e editabil, costul e vizibil dar doar pentru citire, fără buton de salvare
    await expect(page.getByLabel("Preț (lei, cu TVA)")).toBeEnabled();
    const amount = page.getByLabel("Preț de achiziție (lei, fără TVA)");
    await expect(amount).toHaveValue("7777,77");
    await expect(amount).toHaveAttribute("readonly", "");
    await expect(page.getByRole("button", { name: "Salvează prețul de achiziție" })).toHaveCount(0);

    await page.getByLabel("Preț (lei, cu TVA)").fill("333,33");
    await save(page).click();
    await expect(page.getByRole("status").filter({ hasText: "salvate" })).toBeVisible();
    expect((await readE2eProduct(`e2e-${tag}-01`))?.price).toBe(33333);
  });

  test("Owner: editează prețul de achiziție (server action), cu istoric; auditul are rândul de cost", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const [title] = (await seedE2eProducts(tag, 1)) as [string];
    await login(page, owner, "/admin/produse");
    await openFromList(page, tag, title);
    await tab(page, "Prețuri").click();

    const amount = page.getByLabel("Preț de achiziție (lei, fără TVA)");
    await expect(amount).toHaveValue("7777,77");
    await amount.fill("8000,50");
    await page.getByRole("button", { name: "Salvează prețul de achiziție" }).click();
    await page.waitForURL(/purchase=saved/);
    await expect(page.locator("[data-purchase-status]")).toContainText("a fost salvat");
    await expect(tab(page, "Prețuri")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("Preț de achiziție (lei, fără TVA)")).toHaveValue("8000,50");
    // valoarea nu apare în URL
    expect(page.url()).not.toContain("8000");

    const actions = (await readE2eProductAudit(`e2e-${tag}-01`)).map((a) => a.action);
    expect(actions).toContain("product.cost.update");

    // sumă invalidă: mesaj, nimic salvat
    await page.getByLabel("Preț de achiziție (lei, fără TVA)").fill("12,345");
    await page.getByRole("button", { name: "Salvează prețul de achiziție" }).click();
    await page.waitForURL(/purchase=invalid/);
    await expect(page.locator("[data-purchase-status]")).toContainText("sumă validă");
    await expect(page.getByLabel("Preț de achiziție (lei, fără TVA)")).toHaveValue("8000,50");
  });

  test("avertisment la părăsirea paginii cu modificări nesalvate; fără modificări, navigarea merge liber", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const [title] = (await seedE2eProducts(tag, 1)) as [string];
    await login(page, owner, "/admin/produse");
    await openFromList(page, tag, title);
    const editorUrl = page.url();

    // modificare nesalvată → linkul „înapoi” cere confirmare; „rămân” păstrează pagina și textul
    await page.getByLabel("Titlu", { exact: true }).fill(`${title} (nesalvat)`);
    await expect(page.getByText("modificări nesalvate").first()).toBeVisible();
    page.once("dialog", (dialog) => void dialog.dismiss());
    await page.getByRole("link", { name: "Înapoi la lista de produse" }).click();
    await expect(page).toHaveURL(editorUrl);
    await expect(page.getByLabel("Titlu", { exact: true })).toHaveValue(`${title} (nesalvat)`);

    // „ies” confirmă și navighează
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("link", { name: "Înapoi la lista de produse" }).click();
    await expect(page).toHaveURL(/\/admin\/produse$/);

    // fără modificări: niciun dialog
    await page.goBack();
    await page.waitForURL(editorUrl);
    let dialogs = 0;
    page.on("dialog", (dialog) => {
      dialogs++;
      void dialog.dismiss();
    });
    await page.getByRole("link", { name: "Înapoi la lista de produse" }).click();
    await expect(page).toHaveURL(/\/admin\/produse$/);
    expect(dialogs).toBe(0);
  });

  test("Suport nu poate deschide produsul; produs inexistent dă 404", async ({
    page,
    request,
    baseURL,
  }) => {
    const support = await createAccount(request, baseURL as string, "support");
    await login(page, support, "/admin");
    await page.goto("/admin/produse/nu-exista");
    await expect(page).toHaveURL(/\/admin\/acces-interzis/);
    // și fără rol de produs, formularul de creare e interzis
    await page.goto("/admin/produse/nou");
    await expect(page).toHaveURL(/\/admin\/acces-interzis/);

    const owner = await createAccount(request, baseURL as string, "owner");
    const ownerPage = await page
      .context()
      .browser()!
      .newPage({ baseURL: baseURL as string });
    await login(ownerPage, owner, "/admin");
    const response = await ownerPage.goto("/admin/produse/nu-exista");
    expect(response?.status()).toBe(404);
    await ownerPage.close();
  });
});

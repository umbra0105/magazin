import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  E2E_COST_SENTINEL,
  promoteE2eUser,
  removeE2eProducts,
  seedE2eProducts,
} from "../packages/core/test/e2e-support";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Lista de produse din admin, în browser: căutare, filtre, paginare pe server, editare inline și în
 * masă, drepturi pe roluri și lipsa totală a prețului de achiziție din pagină. Produsele de probă au
 * adresa `e2e-…` și un preț de achiziție-santinelă; se șterg la final.
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

const row = (page: Page, title: string) => page.locator(`[data-product-title="${title}"]`);

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.afterEach(async () => {
  await removeE2eProducts();
});

test.describe("lista de produse", () => {
  test("căutare după titlu/SKU, filtru de stare, paginare pe server; costul nu apare nicăieri", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    await seedE2eProducts(tag, 30);
    await login(page, owner, "/admin/produse");

    // căutare după titlu: 30 de rezultate, paginate pe server (25 + 5)
    await page.getByLabel("Caută produse").fill(`E2E ${tag}`);
    await page.getByRole("button", { name: "Caută", exact: true }).click();
    await expect(page.locator("[data-product-total]")).toHaveText("30 de produse");
    await expect(page.locator("[data-product-row]")).toHaveCount(25);
    await expect(page.getByText("Pagina 1 din 2")).toBeVisible();
    await page.getByRole("link", { name: "Pagina următoare" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.locator("[data-product-row]")).toHaveCount(5);

    // căutare după SKU
    await page.goto(`/admin/produse?q=${`E2E-${tag.toUpperCase()}-07`}`);
    await expect(page.locator("[data-product-row]")).toHaveCount(1);
    await expect(row(page, `E2E ${tag} Produs 07`)).toBeVisible();

    // filtru de stare (10 active din 30) și sortare după titlu
    await page.goto(
      `/admin/produse?q=${encodeURIComponent(`E2E ${tag}`)}&status=active&sort=title_asc`,
    );
    await expect(page.locator("[data-product-total]")).toHaveText("10 produse");

    // costul nu apare în pagină, în sursa ei, în URL sau în opțiunile de sortare, pentru niciun rol
    const html = await page.content();
    for (const needle of [String(E2E_COST_SENTINEL), "7.777,77", "7777,77", "costPrice", "cost"]) {
      expect(html, `„${needle}” în pagină`).not.toContain(needle);
    }
    expect(page.url().toLowerCase()).not.toContain("cost");

    // un parametru de sortare după cost e ignorat (revine la ordinea implicită), fără eroare
    const response = await page.goto(
      `/admin/produse?q=${encodeURIComponent(`E2E ${tag}`)}&sort=costPrice_asc`,
    );
    expect(response?.status()).toBe(200);
    await expect(page.locator("[data-product-row]")).toHaveCount(25);
  });

  test("editare inline: titlu, stare, preț (produs cu o variantă); persistă după reîncărcare", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const [title] = await seedE2eProducts(tag, 3);
    await login(page, owner, `/admin/produse`);
    await page.goto(`/admin/produse?q=${encodeURIComponent(`E2E ${tag}`)}&sort=title_asc`);
    const first = row(page, title as string);

    // titlu
    await first.getByRole("button", { name: `Editează titlul pentru ${title}` }).click();
    await page.getByLabel(`Editează titlul pentru ${title}`).fill(`${title} (redenumit)`);
    await page.getByRole("button", { name: "Salvează" }).click();
    const renamed = row(page, `${title} (redenumit)`);
    await expect(renamed).toBeVisible();

    // stare
    await renamed
      .getByRole("button", { name: `Editează starea pentru ${title} (redenumit)` })
      .click();
    await page.getByLabel(`Editează starea pentru ${title} (redenumit)`).selectOption("archived");
    await page.getByRole("button", { name: "Salvează" }).click();
    await expect(renamed).toContainText("Arhivat");

    // preț: produs cu o singură variantă, în lei cu virgulă
    await renamed
      .getByRole("button", { name: `Editează prețul pentru ${title} (redenumit)` })
      .click();
    await page.getByLabel("Preț (lei, cu TVA)").fill("249,50");
    await page.getByRole("button", { name: "Salvează" }).click();
    await expect(renamed).toContainText("249,50");

    // sumă invalidă: mesaj clar, fără apel la server
    await renamed
      .getByRole("button", { name: `Editează prețul pentru ${title} (redenumit)` })
      .click();
    await page.getByLabel("Preț (lei, cu TVA)").fill("12,345");
    await page.getByRole("button", { name: "Salvează" }).click();
    await expect(page.locator("[data-problem]")).toContainText("cel mult 2 zecimale");
    await page.getByRole("button", { name: "Anulează" }).click();

    await page.reload();
    const after = row(page, `${title} (redenumit)`);
    await expect(after).toContainText("Arhivat");
    await expect(after).toContainText("249,50");
  });

  test("editare în masă: selecție, confirmare explicită, tot sau nimic; ajustare de preț în procente", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const titles = await seedE2eProducts(tag, 4);
    await login(page, owner, "/admin/produse");
    await page.goto(`/admin/produse?q=${encodeURIComponent(`E2E ${tag}`)}&sort=title_asc`);

    for (const title of titles.slice(0, 3)) {
      await page.getByLabel(`Selectează ${title}`).check();
    }
    const bar = page.locator("[data-bulk-bar]");
    await expect(bar).toContainText("3 produse selectate");

    // starea → Activ, cu confirmare explicită (rezumat + listă)
    await bar.getByLabel("Acțiune").selectOption("status");
    await bar.getByLabel("Valoare").selectOption("active");
    await bar.getByRole("button", { name: "Aplică…" }).click();
    const dialog = page.getByRole("dialog", { name: "Aplici modificarea la 3 produse?" });
    await expect(dialog.locator("[data-bulk-summary]")).toContainText("Starea devine: Activ");
    await expect(dialog).toContainText(titles[0] as string);
    // anulare: nu se schimbă nimic
    await dialog.getByRole("button", { name: "Anulează" }).click();
    await expect(row(page, titles[0] as string)).not.toContainText("Activ");

    await bar.getByRole("button", { name: "Aplică…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Confirm și aplic" }).click();
    await expect(page.getByRole("status")).toContainText("Modificate: 3 produse.");
    for (const title of titles.slice(0, 3)) {
      await expect(row(page, title)).toContainText("Activ");
    }
    await expect(page.locator("[data-bulk-bar]")).toHaveCount(0); // selecția s-a golit

    // preț +10%: 10400 → 11440 (104,00 → 114,40 lei)
    const fourth = titles[3] as string;
    await page.getByLabel(`Selectează ${fourth}`).check();
    await bar.getByLabel("Acțiune").selectOption("priceAdjust");
    await bar.getByLabel("Valoare").fill("10");
    await bar.getByRole("button", { name: "Aplică…" }).click();
    await expect(page.locator("[data-bulk-summary]")).toContainText("cu 10%");
    await page.getByRole("button", { name: "Confirm și aplic" }).click();
    await expect(row(page, fourth)).toContainText("114,40");

    // procent invalid: mesaj, fără confirmare
    await page.getByLabel(`Selectează ${fourth}`).check();
    await bar.getByLabel("Acțiune").selectOption("priceAdjust");
    await bar.getByLabel("Valoare").fill("900");
    await bar.getByRole("button", { name: "Aplică…" }).click();
    await expect(bar.locator("[data-problem]")).toContainText("între -90 și 300");
  });

  test("Editor: vede lista și poate edita doar titlul; fără selecție, fără acțiuni în masă, fără stare/preț", async ({
    page,
    request,
    baseURL,
  }) => {
    const editor = await createAccount(request, baseURL as string, "editor");
    const tag = randomBytes(3).toString("hex");
    const [title] = await seedE2eProducts(tag, 2);
    await login(page, editor, "/admin/produse");
    await page.goto(`/admin/produse?q=${encodeURIComponent(`E2E ${tag}`)}&sort=title_asc`);

    await expect(page.getByText("Poți edita titlul produselor")).toBeVisible();
    await expect(page.getByLabel("Selectează toate produsele din pagină")).toHaveCount(0);
    const first = row(page, title as string);
    await expect(first.getByRole("button", { name: /Editează starea/ })).toHaveCount(0);
    await expect(first.getByRole("button", { name: /Editează prețul/ })).toHaveCount(0);
    await expect(first.getByRole("button", { name: /Editează stocul/ })).toHaveCount(0);

    await first.getByRole("button", { name: `Editează titlul pentru ${title}` }).click();
    await page.getByLabel(`Editează titlul pentru ${title}`).fill(`${title} (de Editor)`);
    await page.getByRole("button", { name: "Salvează" }).click();
    await expect(row(page, `${title} (de Editor)`)).toBeVisible();

    // costul nu apare nici pentru Editor
    expect(await page.content()).not.toContain(String(E2E_COST_SENTINEL));
  });

  test("Manager: vede acțiunile în masă; Suport nu vede produsele (acces interzis)", async ({
    page,
    request,
    baseURL,
    browser,
  }) => {
    const manager = await createAccount(request, baseURL as string, "manager");
    const tag = randomBytes(3).toString("hex");
    const [title] = await seedE2eProducts(tag, 1);
    await login(page, manager, "/admin/produse");
    await page.goto(`/admin/produse?q=${encodeURIComponent(`E2E ${tag}`)}`);
    await page.getByLabel(`Selectează ${title}`).check();
    await expect(page.locator("[data-bulk-bar]")).toBeVisible();
    // costul (Manager are products.cost.view) tot nu apare în listă
    expect(await page.content()).not.toContain(String(E2E_COST_SENTINEL));

    const context = await browser.newContext({ baseURL: baseURL as string });
    const support = await context.newPage();
    const supportAccount = await createAccount(support.request, baseURL as string, "support");
    await support.goto(`/autentificare?next=${encodeURIComponent("/admin/produse")}`);
    await support.getByLabel("Email").fill(supportAccount.email);
    await support.getByLabel("Parolă", { exact: true }).fill(supportAccount.password);
    await support.getByRole("button", { name: "Intră în cont" }).click();
    await expect(support).toHaveURL(/\/admin\/acces-interzis/);
    await context.close();
  });
});

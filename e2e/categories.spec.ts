import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  attachProductToE2eBrand,
  attachProductToE2eCategory,
  promoteE2eUser,
  removeE2eProducts,
} from "../packages/core/test/e2e-support";
import { solidPng } from "./support/png";

/**
 * Categoriile și brandurile din admin, în browser: creare, mutare cu tastatura și prin glisare,
 * reordonare, ștergere refuzată cu număr de produse, imagine/logo din bibliotecă (ștergerea fișierului
 * folosit e refuzată din bibliotecă), rolurile (Editor, Manager, Admin). Conturile `e2e-*` și
 * categoriile/brandurile/produsele cu slug `e2e-…` se șterg la final.
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

const row = (page: Page, name: string): Locator => page.locator(`[data-category-name="${name}"]`);

async function createCategory(page: Page, name: string, parent?: string) {
  await page.getByRole("button", { name: "Categorie nouă" }).click();
  const dialog = page.getByRole("dialog", { name: "Categorie nouă" });
  await dialog.getByLabel("Nume").fill(name);
  if (parent) await dialog.getByLabel("Categorie părinte").selectOption({ label: parent });
  await dialog.getByRole("button", { name: "Salvează" }).click();
  await expect(row(page, name)).toBeVisible();
}

const slugOf = (name: string): string => name.toLowerCase().replace(/\s+/g, "-");

async function uploadReadyImage(
  page: Page,
  request: APIRequestContext,
  origin: string,
  name: string,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await request.post(`${origin}/api/media`, {
      headers: { origin, "x-file-name": name },
      data: solidPng(320, 180, [60, 120, 200]),
    });
    if (response.status() === 201) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const tag = name.replace(/\.png$/, "");
  await page.goto(`/admin/media?q=${tag}`);
  await expect(page.locator("[data-media-card]").getByText("Gata", { exact: true })).toHaveCount(
    1,
    {
      timeout: 90_000,
    },
  );
}

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.afterEach(async () => {
  await removeE2eProducts();
});

test.describe("categorii", () => {
  test("Owner: creează, mută cu tastatura, reordonează; ștergerea cu produse e refuzată cu numărul", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/categorii");
    await expect(page.getByRole("heading", { level: 1, name: "Categorii" })).toBeVisible();

    const tag = randomBytes(3).toString("hex");
    const root = `E2E Piscine ${tag}`;
    const child = `E2E Pompe ${tag}`;
    const other = `E2E Chimicale ${tag}`;

    await createCategory(page, root);
    await createCategory(page, child, root);
    await createCategory(page, other);

    // calea se vede sub nume: adresa copilului e sub cea a părintelui
    await expect(row(page, child)).toContainText(`/${slugOf(root)}/${slugOf(child)}`);
    await expect(row(page, child)).toContainText("nivel 2");

    // alternativa de tastatură: „Mută…” → la rădăcină
    await page.getByRole("button", { name: `Mută categoria ${child} în alt loc` }).click();
    const moveDialog = page.getByRole("dialog", { name: `Mută «${child}»` });
    await moveDialog.getByLabel("Mută sub").selectOption({ label: "— La rădăcină —" });
    await moveDialog.getByRole("button", { name: "Mută", exact: true }).click();
    await expect(row(page, child)).toContainText(`/${slugOf(child)} `);
    await expect(row(page, child)).toContainText("nivel 1");

    // reordonare: „mai sus” o pune înaintea lui „other” (ordinea în DOM)
    const names = async () =>
      (
        await page
          .locator("[data-category-row]")
          .evaluateAll((els) => els.map((el) => el.getAttribute("data-category-name") ?? ""))
      ).filter((n) => n.endsWith(tag));
    expect(await names()).toEqual([root, other, child]);
    await page.getByRole("button", { name: `Mută ${child} mai sus` }).click();
    await expect.poll(names).toEqual([root, child, other]);

    // ștergerea unei categorii cu produse: refuz cu numărul, nu eroare de bază
    await attachProductToE2eCategory(slugOf(child), `Pompă ${tag}`, `prod-${tag}`);
    await page.reload();
    await page.getByRole("button", { name: `Șterge categoria ${child}` }).click();
    await page
      .getByRole("dialog", { name: `Ștergi «${child}»?` })
      .getByRole("button", { name: "Șterge definitiv" })
      .click();
    const alert = page.locator("[data-problem]");
    await expect(alert).toContainText("nu poate fi ștearsă");
    await expect(alert).toContainText("1 produs");
    await expect(row(page, child)).toBeVisible();

    // ștergerea unei categorii părinte cu subcategorii: refuz cu numărul de subcategorii
    await createCategory(page, `E2E Sub ${tag}`, other);
    await page.getByRole("button", { name: `Șterge categoria ${other}` }).click();
    await page
      .getByRole("dialog", { name: `Ștergi «${other}»?` })
      .getByRole("button", { name: "Șterge definitiv" })
      .click();
    await expect(page.locator("[data-problem]")).toContainText("1 subcategorie");

    // după ce produsul dispare, ștergerea reușește
    await removeE2eProducts();
    await page.reload();
    await page.getByRole("button", { name: `Șterge categoria ${child}` }).click();
    await page
      .getByRole("dialog", { name: `Ștergi «${child}»?` })
      .getByRole("button", { name: "Șterge definitiv" })
      .click();
    await expect(row(page, child)).toHaveCount(0, { timeout: 15_000 });
  });

  test("glisare: o categorie trasă peste alta devine subcategoria ei; mutarea ilegală e refuzată", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/categorii");
    const tag = randomBytes(3).toString("hex");
    const a = `E2E Alfa ${tag}`;
    const b = `E2E Beta ${tag}`;
    await createCategory(page, a);
    await createCategory(page, b);

    const source = row(page, a);
    const target = row(page, b);
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    await source.dragTo(target, { targetPosition: { x: 40, y: (box?.height ?? 40) / 2 } });
    await expect(row(page, a)).toContainText(`/${slugOf(b)}/${slugOf(a)}`, { timeout: 15_000 });

    // tras înapoi peste propriul părinte la rădăcină: „B” nu se poate muta sub „A” (ciclu)
    const boxA = await row(page, a).boundingBox();
    await row(page, b).dragTo(row(page, a), {
      targetPosition: { x: 40, y: (boxA?.height ?? 40) / 2 },
    });
    await expect(page.locator("[data-problem]")).toContainText("Nu poți muta categoria acolo");
    await expect(row(page, b)).toContainText(`/${slugOf(b)} `);
  });

  test("Editor: poate edita conținutul, nu structura; Manager nu vede câmpurile legacy, Admin da", async ({
    page,
    request,
    baseURL,
    browser,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/categorii");
    const tag = randomBytes(3).toString("hex");
    const name = `E2E Editabilă ${tag}`;
    await createCategory(page, name);

    const open = async (role: string) => {
      const context = await browser.newContext({ baseURL: baseURL as string });
      const p = await context.newPage();
      const account = await createAccount(p.request, baseURL as string, role);
      await login(p, account, "/admin/categorii");
      return { p, context };
    };

    // Editor
    const editor = await open("editor");
    await expect(editor.p.getByRole("button", { name: "Categorie nouă" })).toHaveCount(0);
    await expect(
      editor.p.getByRole("button", { name: `Mută categoria ${name} în alt loc` }),
    ).toHaveCount(0);
    await expect(editor.p.getByRole("button", { name: `Șterge categoria ${name}` })).toHaveCount(0);
    await editor.p.getByRole("button", { name: `Editează categoria ${name}` }).click();
    const dialog = editor.p.getByRole("dialog", { name: `Editează «${name}»` });
    await expect(dialog.getByLabel("Adresă (slug)")).toHaveCount(0);
    await expect(dialog.getByLabel("Exclude de la discountul de grup")).toHaveCount(0);
    await expect(dialog.getByLabel("Identificator din magazinul vechi")).toHaveCount(0);
    await dialog.getByLabel("Descriere", { exact: true }).fill("Descriere scrisă de Editor");
    await dialog.getByRole("button", { name: "Salvează" }).click();
    await expect(row(editor.p, name)).toBeVisible();
    await editor.context.close();

    // Manager: structura da, legacy nu
    const manager = await open("manager");
    await manager.p.getByRole("button", { name: `Editează categoria ${name}` }).click();
    const mDialog = manager.p.getByRole("dialog", { name: `Editează «${name}»` });
    await expect(mDialog.getByLabel("Adresă (slug)")).toBeVisible();
    await expect(mDialog.getByLabel("Descriere", { exact: true })).toHaveValue(
      "Descriere scrisă de Editor",
    );
    await expect(mDialog.getByLabel("Identificator din magazinul vechi")).toHaveCount(0);
    await manager.context.close();

    // Admin: legacy da, cu valori păstrate
    const admin = await open("admin");
    await admin.p.getByRole("button", { name: `Editează categoria ${name}` }).click();
    const aDialog = admin.p.getByRole("dialog", { name: `Editează «${name}»` });
    await aDialog.getByLabel("Identificator din magazinul vechi").fill(`wc-${tag}`);
    await aDialog
      .getByLabel("Adresă din magazinul vechi")
      .fill(`https://vechi.example/categorie/${tag}`);
    await aDialog.getByRole("button", { name: "Salvează" }).click();
    await expect(row(admin.p, name)).toBeVisible();
    await admin.p.reload();
    await admin.p.getByRole("button", { name: `Editează categoria ${name}` }).click();
    await expect(
      admin.p
        .getByRole("dialog", { name: `Editează «${name}»` })
        .getByLabel("Identificator din magazinul vechi"),
    ).toHaveValue(`wc-${tag}`);
    await admin.context.close();
  });

  test("imaginea categoriei: fișierul nu se poate șterge din bibliotecă (categoria ca loc de folosire); după scoatere, da", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/media");
    const tag = randomBytes(3).toString("hex");
    const fileName = `categorie-${tag}.png`;
    await uploadReadyImage(page, page.request, baseURL as string, fileName);

    // creează categoria cu imaginea aleasă din selector
    await page.goto("/admin/categorii");
    const name = `E2E Cu imagine ${tag}`;
    await page.getByRole("button", { name: "Categorie nouă" }).click();
    const dialog = page.getByRole("dialog", { name: "Categorie nouă" });
    await dialog.getByLabel("Nume").fill(name);
    await dialog.getByRole("button", { name: "Alege imaginea" }).click();
    const picker = page.getByRole("dialog", { name: "Alege o imagine" });
    await picker.getByLabel("Caută după nume, text alternativ sau tag").fill(tag);
    await picker.getByRole("button", { name: "Caută" }).click();
    await picker.getByRole("button", { name: new RegExp(`^(Alege )?categorie-${tag}`) }).click();
    await picker.getByRole("button", { name: "Alege 1 imagine" }).click();
    await expect(dialog.getByAltText("Imaginea categoriei")).toBeVisible();
    await dialog.getByRole("button", { name: "Salvează" }).click();
    await expect(row(page, name)).toBeVisible();

    // din bibliotecă: ștergerea e refuzată, cu categoria ca loc de folosire
    await page.goto(`/admin/media?q=${tag}`);
    await page.getByRole("button", { name: `Deschide ${fileName}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Șterge…" }).click();
    await page.getByRole("button", { name: "Șterge definitiv" }).click();
    const refusal = page.getByRole("dialog", { name: "Fișierul este folosit" });
    await expect(refusal).toBeVisible();
    const link = refusal.getByRole("link", { name: `Categorie: ${name}` });
    await expect(link).toBeVisible();

    // linkul duce la categorie, cu editorul deschis
    await link.click();
    await expect(page).toHaveURL(/\/admin\/categorii\?edit=/);
    const editor = page.getByRole("dialog", { name: `Editează «${name}»` });
    await expect(editor).toBeVisible();

    // scoate imaginea, apoi fișierul se poate șterge
    await editor.getByRole("button", { name: "Scoate imaginea" }).click();
    await editor.getByRole("button", { name: "Salvează" }).click();
    await expect(editor).toBeHidden();
    await page.goto(`/admin/media?q=${tag}`);
    await page.getByRole("button", { name: `Deschide ${fileName}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Șterge…" }).click();
    await page.getByRole("button", { name: "Șterge definitiv" }).click();
    await expect(page.locator("[data-media-card]")).toHaveCount(0, { timeout: 15_000 });
  });
});

test.describe("branduri", () => {
  test("creare cu adresă generată, ștergere refuzată cu numărul de produse, apoi reușită", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/branduri");
    await expect(page.getByRole("heading", { level: 1, name: "Branduri" })).toBeVisible();
    const tag = randomBytes(3).toString("hex");
    const name = `E2E Brand ${tag}`;

    await page.getByRole("button", { name: "Brand nou" }).click();
    const dialog = page.getByRole("dialog", { name: "Brand nou" });
    await dialog.getByLabel("Nume").fill(name);
    await dialog.getByRole("button", { name: "Salvează" }).click();
    const tableRow = page.locator("tr[data-brand-row]").filter({ hasText: name });
    await expect(tableRow).toContainText(slugOf(name));
    await expect(tableRow).toContainText("0 produse");

    await attachProductToE2eBrand(slugOf(name), `Produs ${tag}`, `bprod-${tag}`);
    await page.reload();
    await page.getByRole("button", { name: `Șterge brandul ${name}` }).click();
    await page
      .getByRole("dialog", { name: `Ștergi brandul «${name}»?` })
      .getByRole("button", { name: "Șterge definitiv" })
      .click();
    await expect(page.locator("[data-problem]")).toContainText("nu poate fi șters");
    await expect(page.locator("[data-problem]")).toContainText("1 produs");

    await removeE2eProducts();
    await page.reload();
    await page.getByRole("button", { name: `Șterge brandul ${name}` }).click();
    await page
      .getByRole("dialog", { name: `Ștergi brandul «${name}»?` })
      .getByRole("button", { name: "Șterge definitiv" })
      .click();
    await expect(page.locator("tr[data-brand-row]").filter({ hasText: name })).toHaveCount(0, {
      timeout: 15_000,
    });
  });
});

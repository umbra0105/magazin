import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  E2E_COST_SENTINEL,
  promoteE2eUser,
  readE2eAttributeValues,
  readE2eRelations,
  readE2eVariantSkus,
  removeE2eAttributes,
  removeE2eProducts,
  seedE2eProducts,
  trackE2eAttribute,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Blocul 11b în browser: atribute (pagina `/admin/atribute` și tabul Atribute), relații (tabul
 * Asociate, din ambele părți) și variante (generator cu plan, editare în rând, ștergere explicită).
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
const save = (page: Page) => page.getByRole("button", { name: "Salvează", exact: true });

test.describe.configure({ mode: "serial", timeout: 150_000 });

test.afterEach(async () => {
  await removeE2eProducts();
  await removeE2eAttributes();
});

test.describe("atribute, relații și variante", () => {
  test("atribute: definiții, valori numerice exacte pe produs, tip blocat, ștergere refuzată cu număr", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const [title] = (await seedE2eProducts(tag, 1)) as [string];
    const diam = { code: `e2e_diam_${tag}`, name: `Diametru ${tag}` };
    const debit = { code: `e2e_debit_${tag}`, name: `Debit ${tag}` };
    const material = { code: `e2e_material_${tag}`, name: `Material ${tag}` };
    for (const a of [diam, debit, material]) trackE2eAttribute(a.code);

    await login(page, owner, "/admin/atribute");
    const dialog = page.getByRole("dialog");

    // „Diametru”: numeric, unitate mm, filtrabil
    await page.getByRole("button", { name: "Atribut nou" }).click();
    await dialog.getByLabel("Nume", { exact: true }).fill(diam.name);
    await dialog.getByLabel("Cod", { exact: true }).fill("Cod Invalid");
    await dialog.getByRole("button", { name: "Creează atributul" }).click();
    await expect(dialog.getByLabel("Cod", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await dialog.getByLabel("Cod", { exact: true }).fill(diam.code);
    await dialog.getByLabel("Unitate de măsură").fill("mm");
    await dialog.getByLabel("Filtrabil în magazin").check();
    await dialog.getByRole("button", { name: "Creează atributul" }).click();
    const diamRow = page.locator(`[data-attribute-row="${diam.code}"]`);
    await expect(diamRow).toContainText("Număr");
    await expect(diamRow).toContainText("mm");
    await expect(diamRow).toContainText("Da");

    // „Debit”: numeric în m³/h
    await page.getByRole("button", { name: "Atribut nou" }).click();
    await dialog.getByLabel("Nume", { exact: true }).fill(debit.name);
    await dialog.getByLabel("Cod", { exact: true }).fill(debit.code);
    await dialog.getByLabel("Unitate de măsură").fill("m³/h");
    await dialog.getByRole("button", { name: "Creează atributul" }).click();
    await expect(page.locator(`[data-attribute-row="${debit.code}"]`)).toContainText("m³/h");

    // „Material”: listă; după creare se deschide editarea ca să adaugi opțiuni
    await page.getByRole("button", { name: "Atribut nou" }).click();
    await dialog.getByLabel("Nume", { exact: true }).fill(material.name);
    await dialog.getByLabel("Cod", { exact: true }).fill(material.code);
    await dialog.getByLabel("Tip", { exact: true }).selectOption("select");
    await dialog.getByLabel("Opțiuni inițiale (câte una pe rând)").fill("Inox\nPVC");
    await dialog.getByRole("button", { name: "Creează atributul" }).click();
    await expect(page.getByRole("dialog", { name: `Atribut: ${material.name}` })).toBeVisible();
    const editDialog = page.getByRole("dialog", { name: `Atribut: ${material.name}` });
    await expect(editDialog.locator("[data-option-row]")).toHaveCount(2);
    await editDialog.getByLabel("Opțiune nouă").fill("ABS");
    await editDialog.getByRole("button", { name: "Adaugă opțiunea" }).click();
    await expect(editDialog.locator("[data-option-row]")).toHaveCount(3);
    // dublură (fără diferență de majuscule): refuz cu mesaj
    await editDialog.getByLabel("Opțiune nouă").fill("abs");
    await editDialog.getByRole("button", { name: "Adaugă opțiunea" }).click();
    await expect(editDialog.locator("[data-problem]").first()).toContainText("există deja");
    await editDialog.getByRole("button", { name: "Închide" }).click();

    // pe produs: valori cu virgulă și cu punct, stocate exact
    await openProduct(page, tag, title);
    await tab(page, "Atribute").click();
    await page.getByLabel(`${diam.name} (mm)`).fill("12,5,3");
    await save(page).click();
    await expect(page.getByLabel(`${diam.name} (mm)`)).toHaveAttribute("aria-invalid", "true");
    await page.getByLabel(`${diam.name} (mm)`).fill("63,5");
    await page.getByLabel(`${debit.name} (m³/h)`).fill("0.1");
    await page.getByLabel(material.name, { exact: true }).selectOption({ label: "Inox" });
    await save(page).click();
    await expect(page.getByRole("status").filter({ hasText: "salvate" })).toBeVisible();
    await expect
      .poll(async () => readE2eAttributeValues(`e2e-${tag}-01`))
      .toMatchObject({ [diam.code]: "63.5000", [debit.code]: "0.1000", [material.code]: "Inox" });

    await page.reload();
    await tab(page, "Atribute").click();
    await expect(page.getByLabel(`${diam.name} (mm)`)).toHaveValue("63,5");
    await expect(page.getByLabel(`${debit.name} (m³/h)`)).toHaveValue("0,1");

    // tipul blocat și ștergerile refuzate, cu numărul de produse
    await page.goto("/admin/atribute");
    await page.getByRole("button", { name: `Editează atributul ${diam.name}` }).click();
    const lockedDialog = page.getByRole("dialog", { name: `Atribut: ${diam.name}` });
    await expect(lockedDialog.getByLabel("Tip", { exact: true })).toBeDisabled();
    await expect(lockedDialog).toContainText("valori la 1 produs");
    await lockedDialog.getByRole("button", { name: "Închide" }).click();

    await page.getByRole("button", { name: `Șterge atributul ${diam.name}` }).click();
    await page
      .getByRole("dialog", { name: `Ștergi atributul «${diam.name}»?` })
      .getByRole("button", { name: "Șterge definitiv" })
      .click();
    await expect(page.locator("[data-problem]").first()).toContainText("1 produs");
    await page.getByRole("dialog").getByRole("button", { name: "Anulează" }).click();

    await page.getByRole("button", { name: `Editează atributul ${material.name}` }).click();
    const materialDialog = page.getByRole("dialog", { name: `Atribut: ${material.name}` });
    await materialDialog.getByRole("button", { name: "Șterge opțiunea Inox" }).click();
    await expect(materialDialog.locator("[data-problem]").first()).toContainText("1 produs");
    // opțiunea nefolosită se șterge
    await materialDialog.getByRole("button", { name: "Șterge opțiunea ABS" }).click();
    await expect(materialDialog.locator('[data-option-row="ABS"]')).toHaveCount(0);
  });

  test("relații: accesoriu și piesă de schimb, vizibile din ambele părți; fără auto-relație și fără dubluri", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const [pump, cover] = (await seedE2eProducts(tag, 2)) as [string, string];
    await login(page, owner, "/admin/produse");
    await openProduct(page, tag, pump);
    await tab(page, "Asociate").click();

    // căutarea exclude produsul însuși
    await page.getByLabel("Caută produsul asociat (titlu sau SKU)").fill(pump);
    await page.getByRole("button", { name: "Caută", exact: true }).click();
    await expect(page.getByText("Niciun produs găsit")).toBeVisible();

    // accesoriu
    await page.getByLabel("Tip de relație").selectOption("accessory");
    await page
      .getByLabel("Caută produsul asociat (titlu sau SKU)")
      .fill(`E2E-${tag.toUpperCase()}-02`);
    await page.getByRole("button", { name: "Caută", exact: true }).click();
    await page.getByRole("button", { name: `Adaugă: ${cover}` }).click();
    await expect(page.locator('[data-relation-row="outgoing:accessory"]')).toContainText(cover);

    // același tip, aceeași pereche: refuzat cu mesaj
    await page.getByRole("button", { name: `Adaugă: ${cover}` }).click();
    await expect(page.locator("[data-problem]").first()).toContainText("există deja");

    // piesă de schimb (alt tip, aceeași pereche: permis)
    await page.getByLabel("Tip de relație").selectOption("spare_part");
    await page.getByRole("button", { name: `Adaugă: ${cover}` }).click();
    await expect(page.locator('[data-relation-row="outgoing:spare_part"]')).toContainText(cover);
    await expect
      .poll(async () => readE2eRelations(`e2e-${tag}-01`))
      .toEqual([`accessory→${cover}`, `spare_part→${cover}`]);

    // din partea produsului asociat: ambele relații, ca „primite”
    await page
      .getByRole("link", { name: `Deschide produsul ${cover}` })
      .first()
      .click();
    await page.waitForURL(/\/admin\/produse\/[A-Za-z0-9_-]+$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(cover);
    await tab(page, "Asociate").click();
    await expect(page.locator('[data-relation-row="incoming:accessory"]')).toContainText(pump);
    await expect(page.locator('[data-relation-row="incoming:spare_part"]')).toContainText(pump);
    await expect(page.getByText("Acest produs nu are încă produse asociate")).toBeVisible();

    // ștergerea din partea produsului asociat: același rând
    await page
      .getByRole("button", { name: `Șterge relația cu ${pump}` })
      .first()
      .click();
    await expect(page.locator('[data-relation-row^="incoming:"]')).toHaveCount(1);
    await expect.poll(async () => readE2eRelations(`e2e-${tag}-01`)).toHaveLength(1);
  });

  test("variante: generator cu plan (nimic șters), editare în rând cu validări, ștergere explicită; fără cost în tab", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const [title] = (await seedE2eProducts(tag, 1)) as [string];
    const base = `E2E-${tag.toUpperCase()}-01`;
    await login(page, owner, "/admin/produse");
    await openProduct(page, tag, title);
    await tab(page, "Variante").click();

    await expect(page.locator(`[data-variant-row="${base}"]`)).toContainText("Fără opțiuni");

    // generator: Culoare = Alb, Albastru
    await page.getByLabel("Opțiunea 1: Numele opțiunii").fill("Culoare");
    await page.getByLabel("Opțiunea 1: Valori (separate prin virgulă)").fill("Alb, Albastru");
    await page.getByLabel("Preț pentru variantele noi (lei, cu TVA)").fill("99,90");
    await page.getByRole("button", { name: "Previzualizează" }).click();
    const plan = page.locator("[data-variant-plan]");
    await expect(plan).toContainText("2 variante noi");
    await expect(plan).toContainText(`${base}-ALB`);
    await expect(plan).toContainText("1 variantă fără opțiuni rămâne neatinsă");
    // previzualizarea nu a scris nimic
    expect(await readE2eVariantSkus(`e2e-${tag}-01`)).toEqual([base]);

    await page.getByRole("button", { name: "Creează variantele noi" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Am creat 2 variante" })).toBeVisible();
    await expect
      .poll(async () => readE2eVariantSkus(`e2e-${tag}-01`))
      .toEqual([base, `${base}-ALB`, `${base}-ALBASTRU`]);
    await expect(page.locator("[data-variant-row]")).toHaveCount(3);

    // schimbarea opțiunilor: „Albastru” devine orfan (raportat, nu șters)
    await page.getByLabel("Opțiunea 1: Valori (separate prin virgulă)").fill("Alb, Roșu");
    await page.getByRole("button", { name: "Previzualizează" }).click();
    await expect(plan).toContainText("1 variantă nouă");
    await expect(plan).toContainText("NU se șterge");
    await expect(plan).toContainText(`${base}-ALBASTRU`);
    expect(await readE2eVariantSkus(`e2e-${tag}-01`)).toHaveLength(3);

    // editare în rând: EAN invalid, SKU duplicat, redus > întreg
    await page.getByRole("button", { name: `Editează varianta ${base}-ALB`, exact: true }).click();
    const edit = page.locator(`[data-variant-edit="${base}-ALB"]`);
    await edit.getByLabel("EAN (cod de bare)").fill("123");
    await edit.getByRole("button", { name: "Salvează varianta" }).click();
    await expect(edit.getByLabel("EAN (cod de bare)")).toHaveAttribute("aria-invalid", "true");
    await edit.getByLabel("EAN (cod de bare)").fill("5901234123457");
    await edit.getByLabel("Preț redus (lei, cu TVA)").fill("500");
    await edit.getByRole("button", { name: "Salvează varianta" }).click();
    await expect(edit.getByLabel("Preț redus (lei, cu TVA)")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await edit.getByLabel("Preț redus (lei, cu TVA)").fill("89,90");
    await edit.getByLabel("SKU (cod intern)").fill(base); // deja folosit de varianta implicită
    await edit.getByRole("button", { name: "Salvează varianta" }).click();
    await expect(edit.locator("[data-problem]").first()).toContainText("deja folosit");
    await edit.getByLabel("SKU (cod intern)").fill(`${base}-ALB`);
    await edit.getByLabel("Garanție (luni)").fill("36");
    await edit.getByRole("button", { name: "Salvează varianta" }).click();
    const row = page.locator(`[data-variant-row="${base}-ALB"]`);
    await expect(row).toContainText("5901234123457");
    await expect(row).toContainText("89,90");
    await expect(row).toContainText("36");

    // ștergere explicită, cu confirmare
    await page.getByRole("button", { name: `Șterge varianta ${base}-ALBASTRU` }).click();
    const confirm = page.getByRole("dialog", { name: `Ștergi varianta «${base}-ALBASTRU»?` });
    await confirm.getByRole("button", { name: "Anulează" }).click();
    expect(await readE2eVariantSkus(`e2e-${tag}-01`)).toHaveLength(3);
    await page.getByRole("button", { name: `Șterge varianta ${base}-ALBASTRU` }).click();
    await page
      .getByRole("dialog", { name: `Ștergi varianta «${base}-ALBASTRU»?` })
      .getByRole("button", { name: "Șterge varianta" })
      .click();
    await expect(page.locator(`[data-variant-row="${base}-ALBASTRU"]`)).toHaveCount(0);
    await expect
      .poll(async () => readE2eVariantSkus(`e2e-${tag}-01`))
      .toEqual([base, `${base}-ALB`]);

    // costul nu apare în tabul Variante (panoul lui e doar în Prețuri)
    const variantsPanel = await page.getByRole("tabpanel", { name: "Variante" }).innerHTML();
    expect(variantsPanel).not.toContain(String(E2E_COST_SENTINEL));
    expect(variantsPanel).not.toContain("7777,77");
  });

  test("Editor: atributele și relațiile doar pentru citire; pagina Atribute fără butoane de scriere; Suport interzis", async ({
    page,
    request,
    baseURL,
  }) => {
    const editor = await createAccount(request, baseURL as string, "editor");
    const tag = randomBytes(3).toString("hex");
    const [title] = (await seedE2eProducts(tag, 1)) as [string];
    await login(page, editor, "/admin/atribute");
    await expect(page.getByRole("button", { name: "Atribut nou" })).toHaveCount(0);
    await expect(page.getByText("Poți vedea atributele, dar nu le poți modifica")).toBeVisible();

    await openProduct(page, tag, title);
    await tab(page, "Atribute").click();
    await expect(save(page)).toHaveCount(0);
    await tab(page, "Asociate").click();
    await expect(page.getByLabel("Tip de relație")).toHaveCount(0);
    await tab(page, "Variante").click();
    await expect(page.getByRole("button", { name: /Editează varianta/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Previzualizează" })).toHaveCount(0);

    const support = await createAccount(request, baseURL as string, "support");
    const context = await page
      .context()
      .browser()!
      .newContext({ baseURL: baseURL as string });
    const supportPage = await context.newPage();
    await login(supportPage, support, "/admin");
    await supportPage.goto("/admin/atribute");
    await expect(supportPage).toHaveURL(/\/admin\/acces-interzis/);
    await context.close();
  });
});

import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  promoteE2eUser,
  readE2eProductSale,
  readE2eUnit,
  removeE2eProducts,
  removeE2eUnits,
  seedE2eProducts,
  seedE2eUnit,
  seedE2eVariants,
  trackE2eUnit,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Faza 5, punctul 3, în browser: pagina «Unități de măsură» (creare, editare, dezactivare, «buc» protejată), tabul
 * «Unitate și pas» al produsului (cele 6 produse-model), pasul pe fiecare variantă cu moștenire din produs și conversia
 * SmartBill. Unitățile și produsele de probă au codul/adresa `e2e…` și se șterg la final.
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

async function openFromList(page: Page, tag: string, title: string) {
  await page.goto(`/admin/produse?q=${encodeURIComponent(`E2E ${tag}`)}`);
  await page.getByRole("link", { name: `Deschide produsul ${title}` }).click();
  await page.waitForURL(/\/admin\/produse\/[A-Za-z0-9_-]+(\?|$)/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(title);
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const unitRow = (page: Page, code: string) => page.locator(`[data-unit-row="${code}"]`);

test.describe.configure({ mode: "serial", timeout: 150_000 });

test.afterEach(async () => {
  await removeE2eProducts();
  await removeE2eUnits();
});

test.describe("pagina «Unități de măsură»", () => {
  test("Owner: creează, validează, redenumește, schimbă zecimalele, dezactivează și reactivează o unitate", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const code = `e2e_u_${tag}`;
    trackE2eUnit(code);
    await login(page, owner, "/admin/produse/unitati-de-masura");
    await expect(page.getByRole("heading", { level: 1, name: "Unități de măsură" })).toBeVisible();
    // unitățile de pornire, cu «buc» marcată implicită
    await expect(unitRow(page, "buc")).toBeVisible();
    await expect(unitRow(page, "buc").getByText("Implicită")).toBeVisible();
    await expect(unitRow(page, "mp")).toContainText("4 zecimale");

    await page.getByRole("button", { name: "Unitate nouă" }).click();
    const dialog = page.getByRole("dialog");
    // validare proprie, în română, cu focus pe primul câmp greșit
    await dialog.getByRole("button", { name: "Salvează" }).click();
    await expect(dialog.getByText("Codul e obligatoriu.")).toBeVisible();
    await expect(dialog.getByLabel("Cod", { exact: true })).toBeFocused();
    await dialog.getByLabel("Cod", { exact: true }).fill("Palet Mare");
    await dialog.getByLabel("Nume", { exact: true }).fill(`E2E Palet ${tag}`);
    await dialog.getByLabel("Simbol afișat lângă cantitate").fill("pal");
    await dialog.getByRole("button", { name: "Salvează" }).click();
    await expect(dialog.getByText(/Codul poate conține doar litere mici/).last()).toBeVisible();
    await dialog.getByLabel("Cod", { exact: true }).fill(code);
    await dialog.getByLabel("Zecimale permise la cantitate").selectOption("2");
    await dialog.getByLabel("Numele în SmartBill").fill("palet.");
    await dialog.getByRole("button", { name: "Salvează" }).click();
    await expect(dialog).toBeHidden();
    await expect(unitRow(page, code)).toContainText(`E2E Palet ${tag}`);
    await expect(unitRow(page, code)).toContainText("2 zecimale");
    await expect(unitRow(page, code)).toContainText("palet.");
    expect(await readE2eUnit(code)).toMatchObject({
      name: `E2E Palet ${tag}`,
      symbol: "pal",
      decimals: 2,
      smartbillName: "palet.",
      isActive: true,
      isSystem: false,
    });

    // același cod a doua oară: mesaj de la server, dialogul rămâne deschis
    await page.getByRole("button", { name: "Unitate nouă" }).click();
    const again = page.getByRole("dialog");
    await again.getByLabel("Cod", { exact: true }).fill(code);
    await again.getByLabel("Nume", { exact: true }).fill("Alt palet");
    await again.getByLabel("Simbol afișat lângă cantitate").fill("p");
    await again.getByRole("button", { name: "Salvează" }).click();
    await expect(again.getByRole("alert")).toContainText("e deja folosit");
    await again.getByRole("button", { name: "Anulează" }).click();
    await expect(again).toBeHidden();

    // editare: codul e blocat, numele și zecimalele se schimbă
    await page.getByRole("button", { name: `Editează unitatea E2E Palet ${tag}` }).click();
    const edit = page.getByRole("dialog");
    await expect(edit.getByLabel("Cod", { exact: true })).toBeDisabled();
    await edit.getByLabel("Nume", { exact: true }).fill(`E2E Palet EUR ${tag}`);
    await edit.getByLabel("Zecimale permise la cantitate").selectOption("3");
    await edit.getByRole("button", { name: "Salvează" }).click();
    await expect(edit).toBeHidden();
    await expect(unitRow(page, code)).toContainText(`E2E Palet EUR ${tag}`);
    await expect(unitRow(page, code)).toContainText("3 zecimale");
    expect(await readE2eUnit(code)).toMatchObject({ name: `E2E Palet EUR ${tag}`, decimals: 3 });

    // dezactivare și reactivare
    await page.getByRole("button", { name: `Dezactivează unitatea E2E Palet EUR ${tag}` }).click();
    await expect(unitRow(page, code)).toHaveAttribute("data-active", "false");
    await expect(unitRow(page, code)).toContainText("Dezactivată");
    expect((await readE2eUnit(code))?.isActive).toBe(false);
    await page.getByRole("button", { name: `Activează unitatea E2E Palet EUR ${tag}` }).click();
    await expect(unitRow(page, code)).toHaveAttribute("data-active", "true");
    expect((await readE2eUnit(code))?.isActive).toBe(true);
  });

  test("«buc» (unitatea implicită): fără buton de dezactivare, fără zecimale; numele se poate schimba", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse/unitati-de-masura");
    await expect(unitRow(page, "buc")).toBeVisible();
    await expect(
      unitRow(page, "buc").getByRole("button", { name: /Dezactivează unitatea/ }),
    ).toHaveCount(0);
    await unitRow(page, "buc")
      .getByRole("button", { name: /^Editează unitatea/ })
      .click();
    const edit = page.getByRole("dialog");
    await expect(edit.getByLabel("Zecimale permise la cantitate")).toBeDisabled();
    await expect(edit.getByLabel("Zecimale permise la cantitate")).toHaveValue("0");
    await expect(edit.getByText("Unitatea implicită rămâne fără zecimale.")).toBeVisible();
    await expect(edit.getByLabel("Cod", { exact: true })).toBeDisabled();
    await edit.getByRole("button", { name: "Anulează" }).click();
    await expect(edit).toBeHidden();
    expect(await readE2eUnit("buc")).toMatchObject({ decimals: 0, isActive: true, isSystem: true });
  });

  test("Editor: vede unitățile, dar nu are butoane de scriere", async ({
    page,
    request,
    baseURL,
  }) => {
    const editor = await createAccount(request, baseURL as string, "editor");
    await login(page, editor, "/admin/produse/unitati-de-masura");
    await expect(unitRow(page, "mp")).toBeVisible();
    await expect(page.getByText("Poți vedea unitățile, dar nu le poți modifica.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Unitate nouă" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Editează unitatea/ })).toHaveCount(0);
  });
});

test.describe("produsul: unitate, pas și minim (cele 6 produse-model)", () => {
  test("mozaic: mp cu 2 zecimale, cutia de 2,03 mp, minim 2 cutii; refuzuri în română; valorile rămân după reîncărcare", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const unitName = `E2E Mozaic mp ${tag}`;
    await seedE2eUnit({ code: `e2e_mp_${tag}`, name: unitName, symbol: "e2mp", decimals: 2 });
    const [title] = await seedE2eProducts(tag, 1);
    await login(page, owner, "/admin/produse");
    await openFromList(page, tag, title as string);

    await tab(page, "Unitate și pas").click();
    await page
      .getByLabel("Unitate de măsură", { exact: true })
      .selectOption({ label: `${unitName} (e2mp)` });
    // 5 zecimale: refuzat, fără apel la server
    await page.getByLabel("Pas de vânzare", { exact: true }).fill("2,03456");
    await page.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(page.getByLabel("Pas de vânzare", { exact: true })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.getByLabel("Pas de vânzare", { exact: true })).toBeFocused();
    await expect(
      page.getByText("Pasul poate avea cel mult 2 zecimale la această unitate."),
    ).toBeVisible();
    // 3 zecimale pe o unitate cu 2: refuzat
    await page.getByLabel("Pas de vânzare", { exact: true }).fill("2,031");
    await page.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(
      page.getByText("Pasul poate avea cel mult 2 zecimale la această unitate."),
    ).toBeVisible();
    // zero și text
    await page.getByLabel("Pas de vânzare", { exact: true }).fill("0");
    await page.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(page.getByText("Pasul trebuie să fie mai mare decât zero.")).toBeVisible();
    await page.getByLabel("Pas de vânzare", { exact: true }).fill("abc");
    await page.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(page.getByText("Introdu un număr valid, cu virgulă (ex. 2,03).")).toBeVisible();

    await page.getByLabel("Pas de vânzare", { exact: true }).fill("2,03");
    await page.getByLabel("Cantitate minimă (în pași)").fill("2");
    await expect(page.locator("[data-sale-preview-list]")).toHaveText(
      "2,03 · 4,06 · 6,09 · 8,12 … e2mp",
    );
    await page.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(page.getByText("Modificările au fost salvate.")).toBeVisible();

    const slug = `e2e-${tag}-01`;
    expect(await readE2eProductSale(slug)).toMatchObject({
      unit: `e2e_mp_${tag}`,
      priceBasis: "unit",
      saleStep: 20_300,
      minSteps: 2,
    });

    // după reîncărcare, valorile sunt cele salvate (cu virgulă)
    await page.reload();
    await tab(page, "Unitate și pas").click();
    await expect(page.getByLabel("Pas de vânzare", { exact: true })).toHaveValue("2,03");
    await expect(page.getByLabel("Cantitate minimă (în pași)")).toHaveValue("2");
    await expect(page.getByText("Minimum: 4,06 e2mp")).toBeVisible();
  });

  test("bisulfat: kg fără zecimale, sacul de 25 kg, preț pe pas; pasul 2,5 e refuzat pe o unitate fără zecimale", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const unitName = `E2E Kilogram ${tag}`;
    await seedE2eUnit({ code: `e2e_kg_${tag}`, name: unitName, symbol: "e2kg", decimals: 0 });
    const [title] = await seedE2eProducts(tag, 1);
    await login(page, owner, "/admin/produse");
    await openFromList(page, tag, title as string);

    await tab(page, "Unitate și pas").click();
    await page
      .getByLabel("Unitate de măsură", { exact: true })
      .selectOption({ label: `${unitName} (e2kg)` });
    await page.getByLabel("Prețul introdus la variante este").selectOption("step");
    await page.getByLabel("Pas de vânzare", { exact: true }).fill("2,5");
    await page.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(
      page.getByText("Unitatea aleasă nu admite zecimale: introdu un număr întreg."),
    ).toBeVisible();
    await page.getByLabel("Pas de vânzare", { exact: true }).fill("25");
    await expect(page.locator("[data-sale-preview-list]")).toHaveText("25 · 50 · 75 · 100 … e2kg");
    await page.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(page.getByText("Modificările au fost salvate.")).toBeVisible();
    expect(await readE2eProductSale(`e2e-${tag}-01`)).toMatchObject({
      unit: `e2e_kg_${tag}`,
      priceBasis: "step",
      saleStep: 250_000,
    });
  });

  test("fără unitate aleasă produsul se vinde la «buc»: un pas cu zecimale e refuzat de server", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const [title] = await seedE2eProducts(tag, 1);
    await login(page, owner, "/admin/produse");
    await openFromList(page, tag, title as string);
    await tab(page, "Unitate și pas").click();
    await expect(page.getByLabel("Unitate de măsură", { exact: true })).toHaveValue("");
    await expect(
      page.getByLabel("Unitate de măsură", { exact: true }).locator("option").first(),
    ).toContainText("Bucată (buc)");
    await page.getByLabel("Pas de vânzare", { exact: true }).fill("2,5");
    await page.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(
      page.getByText("Unitatea aleasă nu admite zecimale: introdu un număr întreg."),
    ).toBeVisible();
    await page.getByLabel("Pas de vânzare", { exact: true }).fill("2");
    await page.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(page.getByText("Modificările au fost salvate.")).toBeVisible();
    expect(await readE2eProductSale(`e2e-${tag}-01`)).toMatchObject({
      unit: null,
      saleStep: 20_000,
    });
  });

  test("Editor (doar conținut): tabul e doar pentru citire", async ({ page, request, baseURL }) => {
    const editor = await createAccount(request, baseURL as string, "editor");
    const tag = randomBytes(3).toString("hex");
    const [title] = await seedE2eProducts(tag, 1);
    await login(page, editor, "/admin/produse");
    await openFromList(page, tag, title as string);
    await tab(page, "Unitate și pas").click();
    await expect(page.getByLabel("Pas de vânzare", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("Unitate de măsură", { exact: true })).toBeDisabled();
    await expect(
      page
        .getByRole("tabpanel", { name: "Unitate și pas" })
        .getByText("Acest tab e doar pentru citire cu permisiunile tale."),
    ).toBeVisible();
  });
});

test.describe("variantele: pas propriu (abachi) și conversia SmartBill", () => {
  test("abachi 1,5 / 1,8 / 2,1 / 2,6 ml: pasul propriu, moștenirea și refuzul cu prea multe zecimale", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const unitName = `E2E Metru liniar ${tag}`;
    await seedE2eUnit({ code: `e2e_ml_${tag}`, name: unitName, symbol: "e2ml", decimals: 1 });
    const [title] = await seedE2eProducts(tag, 1);
    const slug = `e2e-${tag}-01`;
    const skuBase = `E2E-${tag.toUpperCase()}`;
    await seedE2eVariants(slug, [`${skuBase}-18`, `${skuBase}-21`, `${skuBase}-26`]);
    await login(page, owner, "/admin/produse");
    await openFromList(page, tag, title as string);

    // produsul: ml, pas 1,5 (moștenit de variantele fără pas propriu)
    await tab(page, "Unitate și pas").click();
    await page
      .getByLabel("Unitate de măsură", { exact: true })
      .selectOption({ label: `${unitName} (e2ml)` });
    await page.getByLabel("Pas de vânzare", { exact: true }).fill("1,5");
    await page.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(page.getByText("Modificările au fost salvate.")).toBeVisible();

    await tab(page, "Variante").click();
    const firstSku = `${skuBase}-01`;
    await expect(page.locator(`[data-variant-step="${firstSku}"]`)).toContainText("1,5 e2ml");
    await expect(page.locator(`[data-variant-step="${firstSku}"]`)).toContainText("de la produs");

    const steps: Array<[string, string, number]> = [
      [`${skuBase}-18`, "1,8", 18_000],
      [`${skuBase}-21`, "2,1", 21_000],
      [`${skuBase}-26`, "2,6", 26_000],
    ];
    for (const [sku, text] of steps) {
      await page.getByRole("button", { name: `Editează varianta ${sku}` }).click();
      const edit = page.locator(`[data-variant-edit="${sku}"]`);
      await edit.getByLabel("Pas de vânzare", { exact: true }).fill(text);
      await edit.getByRole("button", { name: "Salvează varianta" }).click();
      await expect(edit).toBeHidden();
      await expect(page.locator(`[data-variant-step="${sku}"]`)).toContainText(`${text} e2ml`);
      await expect(page.locator(`[data-variant-step="${sku}"]`)).not.toContainText("de la produs");
    }
    const sale = await readE2eProductSale(slug);
    expect(sale?.variants.map((v) => [v.sku, v.saleStep])).toEqual([
      [firstSku, null],
      [`${skuBase}-18`, 18_000],
      [`${skuBase}-21`, 21_000],
      [`${skuBase}-26`, 26_000],
    ]);

    // 1,83 pe o unitate cu o zecimală: refuzat, fără salvare
    await page.getByRole("button", { name: `Editează varianta ${skuBase}-18` }).click();
    const bad = page.locator(`[data-variant-edit="${skuBase}-18"]`);
    await bad.getByLabel("Pas de vânzare", { exact: true }).fill("1,83");
    await bad.getByRole("button", { name: "Salvează varianta" }).click();
    await expect(
      bad.getByText("Pasul poate avea cel mult 1 zecimală la această unitate."),
    ).toBeVisible();
    await expect(bad.getByLabel("Pas de vânzare", { exact: true })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    // golirea întoarce varianta la pasul produsului
    await bad.getByLabel("Pas de vânzare", { exact: true }).fill("");
    await bad.getByRole("button", { name: "Salvează varianta" }).click();
    await expect(bad).toBeHidden();
    await expect(page.locator(`[data-variant-step="${skuBase}-18"]`)).toContainText("de la produs");
  });

  test("conversia SmartBill: raport care nu împarte pasul e refuzat de server, cu explicația; raportul bun se salvează", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const unitName = `E2E Metru pătrat ${tag}`;
    await seedE2eUnit({ code: `e2e_mpv_${tag}`, name: unitName, symbol: "e2mp", decimals: 2 });
    const [title] = await seedE2eProducts(tag, 1);
    const slug = `e2e-${tag}-01`;
    const sku = `E2E-${tag.toUpperCase()}-01`;
    await login(page, owner, "/admin/produse");
    await openFromList(page, tag, title as string);
    await tab(page, "Unitate și pas").click();
    await page
      .getByLabel("Unitate de măsură", { exact: true })
      .selectOption({ label: `${unitName} (e2mp)` });
    await page.getByLabel("Pas de vânzare", { exact: true }).fill("41,25");
    await page.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(page.getByText("Modificările au fost salvate.")).toBeVisible();

    await tab(page, "Variante").click();
    await page.getByRole("button", { name: `Editează varianta ${sku}` }).click();
    const edit = page.locator(`[data-variant-edit="${sku}"]`);
    await edit.getByLabel("Cum ține SmartBill stocul").selectOption("ratio");
    // fără raport: mesaj local, în română
    await edit.getByRole("button", { name: "Salvează varianta" }).click();
    await expect(
      edit.getByText("Introdu raportul: câte unități ale magazinului are o unitate SmartBill."),
    ).toBeVisible();
    // raport care nu împarte pasul (1 unitate SmartBill = 40 mp, pasul 41,25): refuz de la server
    await edit.getByLabel("O unitate SmartBill = … e2mp").fill("40");
    await edit.getByRole("button", { name: "Salvează varianta" }).click();
    await expect(edit.getByText(/nu se convertește exact în unitatea SmartBill/)).toBeVisible();
    expect((await readE2eProductSale(slug))?.variants[0]).toMatchObject({
      smartbillMode: null,
      smartbillRatio: null,
    });
    // raportul corect: rola de 41,25 mp
    await edit.getByLabel("O unitate SmartBill = … e2mp").fill("41,25");
    await edit.getByLabel("Numele unității în SmartBill").fill("rolă");
    await edit.getByRole("button", { name: "Salvează varianta" }).click();
    await expect(edit).toBeHidden();
    expect((await readE2eProductSale(slug))?.variants[0]).toMatchObject({
      smartbillMode: "ratio",
      smartbillRatio: 412_500,
      smartbillUnitName: "rolă",
    });
  });
});

import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { promoteE2eUser, removeE2eStock, seedE2eStock } from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Faza 5, punctul 9a, în browser: tabul «Stoc» din editorul de produs (gestiune, disponibilitate, hibrid, termen de livrare,
 * suprascrieri pe variantă, cantități cu «Ajustează»), «Denumirea pasului» în «Unitate și pas», termenul implicit pe brand
 * (dialog și coloană) și coloana «Stoc» din «Toate produsele». Produsele de probă au adresa `e2e-stoc-…` și se șterg la final.
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
  await page.waitForURL((url) => url.pathname !== "/autentificare");
}

test.describe.configure({ mode: "serial", timeout: 150_000 });

const tag = randomBytes(3).toString("hex");
const search = `E2E ${tag}`;
/** Pozițiile SKU-urilor în `skus` (în ordinea seed-ului): abachi are două variante, restul una. */
const SKU = { abachiA: 0, abachiB: 1, liner: 5 } as const;
const title = (name: string) => `${name} ${search}`;
const BRAND_A = `Brand A ${tag}`;
const BRAND_T = `Brand T ${tag}`;
let skus: string[] = [];

test.beforeAll(async () => {
  skus = await seedE2eStock(tag, [
    {
      title: title("Abachi"),
      unit: { symbol: "ml", decimals: 1 },
      brand: { name: BRAND_A, defaultLeadTimeDays: 8 },
      variants: [
        { sku: "A", physical: "10" },
        { sku: "B", physical: "10" },
      ],
    },
    { title: title("Pompă"), variants: [{ sku: "P", physical: "0" }] },
    {
      title: title("Cartuș"),
      manageStock: false,
      stockStatus: "outofstock",
      variants: [{ sku: "C", physical: null }],
    },
    {
      title: title("Ghid"),
      type: "digital",
      manageStock: false,
      variants: [{ sku: "G", physical: null }],
    },
    {
      title: title("Liner"),
      unit: { symbol: "mp", decimals: 2 },
      step: "41,25",
      variants: [{ sku: "L", physical: "100" }],
    },
    {
      title: title("Termen"),
      manageStock: false,
      stockStatus: "onbackorder",
      brand: { name: BRAND_T, defaultLeadTimeDays: 8 },
      variants: [{ sku: "T", physical: null }],
    },
  ]);
});

test.afterAll(async () => {
  await removeE2eStock({ tag });
});

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const saveProduct = (page: Page) => page.getByRole("button", { name: "Salvează", exact: true });
const listRow = (page: Page, name: string): Locator => page.locator("tr", { hasText: title(name) });
const stockCell = (page: Page, name: string): Locator =>
  listRow(page, name).locator('[data-cell="stock"]');

/** Deschide editorul produsului din listă (testează și linkul) și trece pe tabul dat. */
async function openProduct(page: Page, name: string, tabName?: string) {
  await page.goto(`/admin/produse?q=${encodeURIComponent(search)}`);
  await page.getByRole("link", { name: `Deschide produsul ${title(name)}` }).click();
  await page.waitForURL(/\/admin\/produse\/[A-Za-z0-9_-]+(\?|$)/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(title(name));
  if (tabName) await tab(page, tabName).click();
}

test.describe("coloana «Stoc» din lista de produse", () => {
  test("starea cea mai bună și cantitatea: gestionat, mai multe variante, negestionat, digital", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, `/admin/produse?q=${encodeURIComponent(search)}`);
    await expect(listRow(page, "Abachi")).toBeVisible();
    await expect(stockCell(page, "Abachi")).toContainText("În stoc");
    await expect(stockCell(page, "Abachi")).toContainText("2 variante · Disponibil 20 ml");
    await expect(stockCell(page, "Liner")).toContainText("Disponibil 100 mp");
    await expect(stockCell(page, "Pompă")).toContainText("Indisponibil");
    await expect(stockCell(page, "Pompă")).toContainText("Disponibil 0");
    await expect(stockCell(page, "Cartuș")).toContainText("Indisponibil");
    await expect(stockCell(page, "Cartuș")).toContainText("Negestionat");
    await expect(stockCell(page, "Ghid")).toContainText("În stoc");
    await expect(stockCell(page, "Ghid")).toContainText("Digital");
    await expect(stockCell(page, "Termen")).toContainText("La comandă");
    await expect(stockCell(page, "Termen")).toContainText("termen 8 zile");
  });

  test("Editorul vede starea, dar nicio cantitate", async ({ page, request, baseURL }) => {
    const editor = await createAccount(request, baseURL as string, "editor");
    await login(page, editor, `/admin/produse?q=${encodeURIComponent(search)}`);
    await expect(stockCell(page, "Abachi")).toContainText("În stoc");
    await expect(stockCell(page, "Abachi")).not.toContainText("Disponibil");
    await expect(stockCell(page, "Liner")).not.toContainText("mp");
    await expect(stockCell(page, "Cartuș")).toContainText("Negestionat");
  });
});

test.describe("tabul Stoc din produs", () => {
  test("gestionat → negestionat: apare «Negestionat până la inventar» și disponibilitatea; revenirea reface cantitățile", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse");
    await openProduct(page, "Liner", "Stoc");

    const manage = page.getByLabel("Gestionează stocul acestui produs");
    await expect(manage).toBeChecked();
    const quantities = page.locator("[data-stock-quantities]");
    await expect(quantities).toContainText("100 mp");
    await expect(page.getByRole("button", { name: /^Ajustează stocul:/ })).toHaveCount(1);
    await expect(page.getByLabel("Disponibilitate", { exact: true })).toHaveCount(0);

    await manage.uncheck();
    await expect(page.locator("[data-stock-unmanaged]")).toContainText(
      "Negestionat până la inventar",
    );
    await page.getByLabel("Disponibilitate", { exact: true }).selectOption("outofstock");
    await saveProduct(page).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Modificările au fost salvate." }),
    ).toBeVisible();

    // după reîncărcare: negestionat, fără cantități, starea aleasă
    await page.reload();
    await tab(page, "Stoc").click();
    await expect(page.getByLabel("Gestionează stocul acestui produs")).not.toBeChecked();
    await expect(page.getByLabel("Disponibilitate", { exact: true })).toHaveValue("outofstock");
    await expect(page.locator("[data-stock-quantities]")).toContainText(
      "Negestionat până la inventar",
    );
    await expect(page.getByRole("button", { name: /^Ajustează stocul:/ })).toHaveCount(0);
    await page.goto(`/admin/produse?q=${encodeURIComponent(search)}`);
    await expect(stockCell(page, "Liner")).toContainText("Negestionat");

    // înapoi la gestionat: cantitatea reală reapare (nu s-a pierdut nimic)
    await openProduct(page, "Liner", "Stoc");
    await page.getByLabel("Gestionează stocul acestui produs").check();
    await saveProduct(page).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Modificările au fost salvate." }),
    ).toBeVisible();
    await page.reload();
    await tab(page, "Stoc").click();
    await expect(page.locator("[data-stock-quantities]")).toContainText("100 mp");
  });

  test("hibrid și termen propriu: «La comandă» cu termenul ales; golirea lasă setarea magazinului", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse");
    await openProduct(page, "Pompă", "Stoc");
    await expect(page.getByLabel("Vinde «La comandă» când stocul se epuizează")).not.toBeChecked();

    await page.getByLabel("Vinde «La comandă» când stocul se epuizează").check();
    await page.getByLabel("Termen de livrare «La comandă» (zile)").fill("5");
    await expect(page.locator("[data-stock-lead-now]")).toHaveText(
      "Se aplică: 5 zile (setat pe produs).",
    );
    await saveProduct(page).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Modificările au fost salvate." }),
    ).toBeVisible();

    await page.goto(`/admin/produse?q=${encodeURIComponent(search)}`);
    await expect(stockCell(page, "Pompă")).toContainText("La comandă");
    await expect(stockCell(page, "Pompă")).toContainText("termen 5 zile");

    // golirea termenului: se aplică setarea magazinului (nu există brand)
    await openProduct(page, "Pompă", "Stoc");
    await page.getByLabel("Termen de livrare «La comandă» (zile)").fill("");
    await expect(page.locator("[data-stock-lead-now]")).toContainText("(setarea magazinului)");
    await saveProduct(page).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Modificările au fost salvate." }),
    ).toBeVisible();
    await page.goto(`/admin/produse?q=${encodeURIComponent(search)}`);
    await expect(stockCell(page, "Pompă")).toContainText("La comandă");
    await expect(stockCell(page, "Pompă")).not.toContainText("termen 5 zile");

    // înapoi la starea inițială (fără hibrid)
    await openProduct(page, "Pompă", "Stoc");
    await page.getByLabel("Vinde «La comandă» când stocul se epuizează").uncheck();
    await saveProduct(page).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Modificările au fost salvate." }),
    ).toBeVisible();
    await page.goto(`/admin/produse?q=${encodeURIComponent(search)}`);
    await expect(stockCell(page, "Pompă")).toContainText("Indisponibil");
  });

  test("termenul vine din brand, produsul îl bate; text live «Se aplică acum»", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse");
    await openProduct(page, "Termen", "Stoc");
    await expect(page.locator("[data-stock-lead-now]")).toHaveText(
      `Se aplică: 8 zile (implicit din brandul ${BRAND_T}).`,
    );
    await page.getByLabel("Termen de livrare «La comandă» (zile)").fill("3");
    await expect(page.locator("[data-stock-lead-now]")).toHaveText(
      "Se aplică: 3 zile (setat pe produs).",
    );
    // 0 zile e o valoare, nu «lipsă»
    await page.getByLabel("Termen de livrare «La comandă» (zile)").fill("0");
    await expect(page.locator("[data-stock-lead-now]")).toHaveText(
      "Se aplică: 0 zile (setat pe produs).",
    );
    await page.getByLabel("Termen de livrare «La comandă» (zile)").fill("3");
    await saveProduct(page).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Modificările au fost salvate." }),
    ).toBeVisible();
    await page.goto(`/admin/produse?q=${encodeURIComponent(search)}`);
    await expect(stockCell(page, "Termen")).toContainText("termen 3 zile");
  });

  test("termen invalid: mesaj în română la câmp, nimic salvat; corectat, se salvează", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse");
    await openProduct(page, "Termen", "Stoc");
    const lead = page.getByLabel("Termen de livrare «La comandă» (zile)");
    await lead.fill("abc");
    await saveProduct(page).click();
    await expect(page.getByText("Introdu un număr întreg de zile, între 0 și 365.")).toBeVisible();
    await expect(lead).toHaveAttribute("aria-invalid", "true");
    await expect(lead).toBeFocused();
    await lead.fill("400");
    await saveProduct(page).click();
    await expect(page.getByText("Termenul poate avea cel mult 365 de zile.")).toBeVisible();
    await lead.fill("12");
    await saveProduct(page).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Modificările au fost salvate." }),
    ).toBeVisible();
    await expect(page.getByText("Termenul poate avea cel mult 365 de zile.")).toHaveCount(0);
    // la loc, ca testele următoare să știe starea
    await lead.fill("3");
    await saveProduct(page).click();
    await expect(page.getByText("Se aplică: 3 zile (setat pe produs).")).toBeVisible();
  });

  test("suprascriere pe variantă: o variantă negestionată într-un produs gestionat", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse");
    await openProduct(page, "Abachi", "Stoc");
    const rowA = page.locator(`[data-variant-stock-row="${skus[SKU.abachiA] ?? ""}"]`);
    const rowB = page.locator(`[data-variant-stock-row="${skus[SKU.abachiB] ?? ""}"]`);
    await expect(rowA).toBeVisible();
    // varianta moștenește «gestionat»: disponibilitatea e dezactivată
    await expect(rowA.getByLabel(/^Disponibilitate:/)).toBeDisabled();

    await rowB.getByLabel(/^Gestiune:/).selectOption("unmanaged");
    await expect(rowB.getByLabel(/^Disponibilitate:/)).toBeEnabled();
    await rowB.getByLabel(/^Disponibilitate:/).selectOption("outofstock");
    await page.getByRole("button", { name: "Salvează variantele" }).click();
    await expect(page.getByText("Variantele au fost salvate.")).toBeVisible();

    await page.reload();
    await tab(page, "Stoc").click();
    await expect(rowB.getByLabel(/^Gestiune:/)).toHaveValue("unmanaged");
    await expect(rowB.getByLabel(/^Disponibilitate:/)).toHaveValue("outofstock");
    await expect(rowA.getByLabel(/^Gestiune:/)).toHaveValue("inherit");
    // tabelul de cantități: varianta B nu mai are cantități
    const quantities = page.locator("[data-stock-quantities]");
    await expect(
      quantities.locator(`[data-product-stock-row="${skus[SKU.abachiB] ?? ""}"]`),
    ).toHaveAttribute("data-kind", "unmanaged");
    await expect(
      quantities.locator(`[data-product-stock-row="${skus[SKU.abachiA] ?? ""}"]`),
    ).toHaveAttribute("data-kind", "managed");
    // lista: doar varianta gestionată contribuie la cantitate; produsul rămâne «În stoc»
    await page.goto(`/admin/produse?q=${encodeURIComponent(search)}`);
    await expect(stockCell(page, "Abachi")).toContainText("În stoc");
    await expect(stockCell(page, "Abachi")).toContainText("Disponibil 10 ml");

    // revenire: ambele moștenesc
    await openProduct(page, "Abachi", "Stoc");
    // întâi disponibilitatea (se dezactivează odată ce varianta moștenește «gestionat»), apoi gestiunea
    await rowB.getByLabel(/^Disponibilitate:/).selectOption("");
    await rowB.getByLabel(/^Gestiune:/).selectOption("inherit");
    await page.getByRole("button", { name: "Salvează variantele" }).click();
    await expect(page.getByText("Variantele au fost salvate.")).toBeVisible();
  });

  test("«Deschide în Stoc» duce la ecranul de stoc, cu căutarea după SKU", async ({
    page,
    request,
    baseURL,
  }) => {
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, "/admin/produse");
    await openProduct(page, "Liner", "Stoc");
    await page.getByRole("link", { name: "Deschide în Stoc" }).click();
    await expect(page).toHaveURL(/\/admin\/produse\/stoc\?q=E2ESTOC/);
    await expect(page.locator(`[data-variant-row="${skus[SKU.liner] ?? ""}"]`)).toBeVisible();
  });

  test("produs digital: doar nota, fără controale de stoc", async ({ page, request, baseURL }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse");
    await openProduct(page, "Ghid", "Stoc");
    await expect(page.locator("[data-stock-digital]")).toContainText(
      "Produs digital: nu are stoc.",
    );
    await expect(page.getByLabel("Gestionează stocul acestui produs")).toHaveCount(0);
    await expect(page.locator("[data-stock-quantities]")).toHaveCount(0);
  });
});

test.describe("drepturi pe tabul Stoc", () => {
  test("Editorul vede starea variantelor, fără cantități și fără acțiuni; câmpurile sunt dezactivate", async ({
    page,
    request,
    baseURL,
  }) => {
    const editor = await createAccount(request, baseURL as string, "editor");
    await login(page, editor, "/admin/produse");
    await openProduct(page, "Abachi", "Stoc");
    await expect(page.getByLabel("Gestionează stocul acestui produs")).toBeDisabled();
    await expect(page.getByLabel("Termen de livrare «La comandă» (zile)")).toBeDisabled();
    await expect(saveProduct(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Salvează variantele" })).toHaveCount(0);
    await expect(page.locator("[data-stock-no-quantities]")).toContainText("nu și cantitățile");
    await expect(
      page.locator(`[data-variant-state-row="${skus[SKU.abachiA] ?? ""}"]`),
    ).toContainText("În stoc");
    await expect(page.getByRole("button", { name: /^Ajustează stocul:/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Deschide în Stoc" })).toHaveCount(0);
    const html = await page.content();
    expect(html).not.toContain("Disponibil 10");
  });

  test("Depozit vede cantitățile și poate ajusta, dar nu modifică gestiunea produsului", async ({
    page,
    request,
    baseURL,
  }) => {
    const warehouse = await createAccount(request, baseURL as string, "warehouse");
    await login(page, warehouse, "/admin/produse");
    await openProduct(page, "Abachi", "Stoc");
    await expect(page.locator("[data-stock-quantities]")).toContainText("10 ml");
    await expect(page.getByRole("button", { name: /^Ajustează stocul:/ })).toHaveCount(2);
    await expect(page.getByLabel("Gestionează stocul acestui produs")).toBeDisabled();
    await expect(saveProduct(page)).toHaveCount(0);
  });

  test("Suport nu vede nici lista, nici editorul", async ({ page, request, baseURL }) => {
    const support = await createAccount(request, baseURL as string, "support");
    await login(page, support, "/admin/produse");
    await expect(page).toHaveURL(/\/admin\/acces-interzis/);
  });
});

test.describe("denumirea pasului", () => {
  test("se salvează în «Unitate și pas»; peste 30 de caractere: mesaj la câmp, nimic salvat", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse");
    await openProduct(page, "Liner", "Unitate și pas");
    const label = page.getByLabel("Denumirea pasului");
    await expect(label).toHaveValue("");
    await label.fill("x".repeat(31));
    await saveProduct(page).click();
    await expect(page.getByText("Denumirea poate avea cel mult 30 de caractere.")).toBeVisible();
    await expect(label).toHaveAttribute("aria-invalid", "true");
    await label.fill("  rolă  ");
    await saveProduct(page).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Modificările au fost salvate." }),
    ).toBeVisible();
    await page.reload();
    await tab(page, "Unitate și pas").click();
    await expect(page.getByLabel("Denumirea pasului")).toHaveValue("rolă");
  });
});

test.describe("termenul implicit pe brand", () => {
  const brandRow = (page: Page, name: string) =>
    page.locator(`tr[data-brand-row]`, { hasText: name });

  test("coloana arată termenul sau «Setarea magazinului»; Managerul îl schimbă din dialog; valoare invalidă: mesaj, dialogul rămâne", async ({
    page,
    request,
    baseURL,
  }) => {
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, "/admin/produse/branduri");
    await expect(brandRow(page, BRAND_A).locator('[data-cell="lead-time"]')).toHaveText("8 zile");

    await page.getByRole("button", { name: `Editează brandul ${BRAND_A}` }).click();
    const dialog = page.getByRole("dialog");
    const lead = dialog.getByLabel("Termen implicit «La comandă» (zile)");
    await expect(lead).toHaveValue("8");
    await lead.fill("abc");
    await dialog.getByRole("button", { name: "Salvează" }).click();
    await expect(
      dialog.getByText("Introdu un număr întreg de zile, între 0 și 365."),
    ).toBeVisible();
    await expect(dialog).toBeVisible();
    await lead.fill("12");
    await dialog.getByRole("button", { name: "Salvează" }).click();
    await expect(dialog).toBeHidden();
    await expect(brandRow(page, BRAND_A).locator('[data-cell="lead-time"]')).toHaveText("12 zile");

    // golit: se aplică setarea magazinului
    await page.getByRole("button", { name: `Editează brandul ${BRAND_A}` }).click();
    await page.getByRole("dialog").getByLabel("Termen implicit «La comandă» (zile)").fill("");
    await page.getByRole("dialog").getByRole("button", { name: "Salvează" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(brandRow(page, BRAND_A).locator('[data-cell="lead-time"]')).toHaveText(
      "Setarea magazinului",
    );
  });

  test("Editorul vede termenul, dar nu îl poate modifica", async ({ page, request, baseURL }) => {
    const editor = await createAccount(request, baseURL as string, "editor");
    await login(page, editor, "/admin/produse/branduri");
    await expect(brandRow(page, BRAND_T).locator('[data-cell="lead-time"]')).toHaveText("8 zile");
    await page.getByRole("button", { name: `Editează brandul ${BRAND_T}` }).click();
    await expect(
      page.getByRole("dialog").getByLabel("Termen implicit «La comandă» (zile)"),
    ).toBeDisabled();
  });
});

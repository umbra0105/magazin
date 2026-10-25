import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { promoteE2eUser, removeE2eStock, seedE2eStock } from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Faza 5, punctul 9b, în browser: afișarea prețului pe unitate și pe pas în lista de produse (coloana «Preț») și în
 * previzualizarea din tabul «Prețuri». Cele 6 produse-model: bisulfat (pe pas), liner, mozaic, țeavă, furtun/simplu, abachi (pas pe
 * variantă). Afișare PROVIZORIE: «≈» doar când suma nu iese exactă în bani. Produsele de probă au adresa `e2e-stoc-…`.
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
const title = (name: string) => `${name} ${search}`;

test.beforeAll(async () => {
  await seedE2eStock(tag, [
    {
      title: title("Bisulfat"),
      unit: { symbol: "kg", decimals: 0 },
      step: "25",
      priceBasis: "step",
      price: 12_000,
      saleStepLabel: "sac",
      variants: [{ sku: "B", physical: "80" }],
    },
    {
      title: title("Liner"),
      unit: { symbol: "mp", decimals: 2 },
      step: "41,25",
      price: 8_735,
      saleStepLabel: "rolă",
      showStepPrice: true,
      variants: [{ sku: "L", physical: "100" }],
    },
    {
      title: title("Mozaic"),
      unit: { symbol: "mp", decimals: 2 },
      step: "2,03",
      price: 14_990,
      saleStepLabel: "cutie",
      showStepPrice: true,
      variants: [{ sku: "M", physical: "10" }],
    },
    {
      title: title("Teava"),
      unit: { symbol: "ml", decimals: 1 },
      step: "2,5",
      price: 3_600,
      variants: [{ sku: "T", physical: "100" }],
    },
    { title: title("Simplu"), price: 19_900, variants: [{ sku: "S", physical: "5" }] },
    {
      title: title("Abachi"),
      unit: { symbol: "ml", decimals: 1 },
      step: "1,5",
      price: 4_500,
      saleStepLabel: "bucată",
      showStepPrice: true,
      variants: [
        { sku: "A", physical: "10" },
        { sku: "B", physical: "10", step: "1,8" },
      ],
    },
  ]);
});

test.afterAll(async () => {
  await removeE2eStock({ tag });
});

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const priceCell = (page: Page, name: string): Locator =>
  page.locator("tr", { hasText: title(name) }).locator('[data-cell="price"]');

async function openProduct(page: Page, name: string, tabName?: string) {
  await page.goto(`/admin/produse?q=${encodeURIComponent(search)}`);
  await page.getByRole("link", { name: `Deschide produsul ${title(name)}` }).click();
  await page.waitForURL(/\/admin\/produse\/[A-Za-z0-9_-]+(\?|$)/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(title(name));
  if (tabName) await tab(page, tabName).click();
}

test.describe("coloana «Preț» din lista de produse", () => {
  test("prețul pe unitate și pe pas, cu «≈» doar când suma nu iese exactă; produsul la bucată rămâne ca înainte", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, `/admin/produse?q=${encodeURIComponent(search)}`);
    await expect(priceCell(page, "Bisulfat")).toBeVisible();

    // bisulfat: pe pas, cu prețul pe kg lângă (exact)
    await expect(priceCell(page, "Bisulfat")).toContainText("120,00");
    await expect(priceCell(page, "Bisulfat").locator("[data-price-per]")).toHaveText(
      "/ sac de 25 kg",
    );
    await expect(priceCell(page, "Bisulfat").locator("[data-price-unit]")).toContainText("(4,80");
    await expect(priceCell(page, "Bisulfat").locator("[data-price-unit]")).toContainText("RON/kg)");
    await expect(priceCell(page, "Bisulfat").locator("[data-price-unit]")).not.toContainText("≈");

    // liner: pe unitate, cu prețul rolei neexact («≈»)
    await expect(priceCell(page, "Liner")).toContainText("87,35");
    await expect(priceCell(page, "Liner").locator("[data-price-per]")).toHaveText("/ mp");
    await expect(priceCell(page, "Liner").locator("[data-price-step]")).toContainText(
      "Rolă de 41,25 mp ≈ 3.603,19",
    );

    // mozaic: ≈ 304,30
    await expect(priceCell(page, "Mozaic").locator("[data-price-step]")).toContainText(
      "Cutie de 2,03 mp ≈ 304,30",
    );

    // țeavă: fără «arată prețul pasului»: doar referința pe ml
    await expect(priceCell(page, "Teava").locator("[data-price-per]")).toHaveText("/ ml");
    await expect(priceCell(page, "Teava").locator("[data-price-step]")).toHaveCount(0);

    // abachi: produs cu variante cu același preț; pasul produsului (1,5 ml) = 67,50 exact
    await expect(priceCell(page, "Abachi").locator("[data-price-step]")).toContainText(
      "Bucată de 1,5 ml = 67,50",
    );

    // simplu (la bucată): fără sufix și fără linii în plus
    await expect(priceCell(page, "Simplu")).toContainText("199,00");
    await expect(priceCell(page, "Simplu").locator("[data-price-per]")).toHaveCount(0);
    await expect(priceCell(page, "Simplu").locator("[data-price-step]")).toHaveCount(0);
  });
});

test.describe("«Cum se afișează prețul» în tabul Prețuri", () => {
  test("liner: prețul și prețul rolei; se actualizează cât scrii prețul; afișare marcată provizorie", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse");
    await openProduct(page, "Liner", "Prețuri");
    const preview = page.locator("[data-price-preview]");
    await expect(preview).toContainText("87,35 RON / mp");
    await expect(preview.locator("[data-preview-step]")).toContainText(
      "Rolă de 41,25 mp ≈ 3.603,19 RON",
    );
    await expect(preview.locator("[data-price-provisional]")).toContainText("Afișare provizorie");

    // în timp ce scrii: previzualizarea urmărește câmpul; 90,00 × 41,25 = 3.712,50 exact (fără «≈»)
    await page.getByLabel("Preț (lei, cu TVA)").fill("90,00");
    await expect(preview).toContainText("90,00 RON / mp");
    await expect(preview.locator("[data-preview-step]")).toContainText(
      "Rolă de 41,25 mp = 3.712,50 RON",
    );
  });

  test("bisulfat: «120,00 RON / sac de 25 kg» și «(4,80 RON/kg)»", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse");
    await openProduct(page, "Bisulfat", "Prețuri");
    const preview = page.locator("[data-price-preview]");
    await expect(preview.locator("[data-preview-price]")).toContainText(
      "120,00 RON / sac de 25 kg",
    );
    await expect(preview.locator("[data-preview-price]")).toContainText("(4,80 RON/kg)");
  });

  test("abachi (două variante, pas pe variantă): fiecare variantă cu pasul ei efectiv", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse");
    await openProduct(page, "Abachi", "Prețuri");
    const preview = page.locator("[data-price-preview]");
    await expect(preview.locator("[data-preview-row]")).toHaveCount(2);
    await expect(preview.locator("[data-preview-row]").nth(0)).toContainText(
      "Bucată de 1,5 ml = 67,50 RON",
    );
    await expect(preview.locator("[data-preview-row]").nth(1)).toContainText(
      "Bucată de 1,8 ml = 81,00 RON",
    );
  });

  test("Editorul vede aceeași previzualizare (citire)", async ({ page, request, baseURL }) => {
    const editor = await createAccount(request, baseURL as string, "editor");
    await login(page, editor, "/admin/produse");
    await openProduct(page, "Liner", "Prețuri");
    await expect(page.locator("[data-price-preview]")).toContainText("87,35 RON / mp");
  });
});

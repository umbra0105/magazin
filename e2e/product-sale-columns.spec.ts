import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Download, type Page } from "@playwright/test";
import {
  promoteE2eUser,
  readE2eSale,
  removeE2eImports,
  removeE2eStock,
  seedE2eStock,
  trackE2eImportFile,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Faza 5, punctul 9b, în browser: coloanele noi la import și export (unitate, bază, pas, minim, denumire, conversie SmartBill,
 * stare stoc, termen). Exportul: CSV pentru Excel (BOM + «sep=;», antete în română, virgulă zecimală, fără cost); fișierul
 * exportat și reimportat = «neschimbat». Importul: regula «aceeași valoare la toate rândurile → pe produs; diferite → pe
 * variantă», «Stare stoc» doar la negestionate, produsele noi create NEGESTIONATE. Produsele de probă au adresa `e2e-stoc-…`.
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

test.describe.configure({ mode: "serial", timeout: 180_000 });

const tag = randomBytes(3).toString("hex");
const search = `E2E ${tag}`;
const title = (name: string) => `${name} ${search}`;
/** Codul unității unui produs de test (primește simbolul cerut, dar simbolul se ciocnește cu unitatea de sistem: exportul scrie codul). */
const unitCode = (index: number) => `e2e${tag}${index}`;
const IDX = { liner: 0, abachi: 1, cartus: 2, simplu: 3 } as const;
let skus: string[] = [];

test.beforeAll(async () => {
  skus = await seedE2eStock(tag, [
    {
      title: title("Liner"),
      unit: { symbol: "mp", decimals: 2 },
      step: "41,25",
      price: 8_735,
      saleStepLabel: "rolă",
      variants: [{ sku: "L", physical: "100" }],
    },
    {
      title: title("Abachi"),
      unit: { symbol: "ml", decimals: 1 },
      step: "1,5",
      price: 4_500,
      variants: [
        { sku: "A", physical: "10" },
        { sku: "B", physical: "10", step: "1,8" },
      ],
    },
    {
      title: title("Cartus"),
      manageStock: false,
      stockStatus: "outofstock",
      leadTimeDays: 5,
      variants: [{ sku: "C", physical: null }],
    },
    { title: title("Simplu"), variants: [{ sku: "S", physical: "1" }] },
  ]);
});

test.afterEach(async () => {
  await removeE2eImports();
});

test.afterAll(async () => {
  await removeE2eStock({ tag });
});

const SKU = { liner: 0, abachiA: 1, abachiB: 2, cartus: 3, simplu: 4 } as const;
const sku = (key: keyof typeof SKU) => skus[SKU[key]] as string;

const NEW_COLUMNS =
  "Unitate de măsură;Baza prețului;Pas de vânzare;Minim (pași);Denumire pas;Mod conversie SmartBill;" +
  "Unitate SmartBill;Raport SmartBill;Stare stoc;Termen livrare (zile)";

const csvFile = (rows: string[][]): Buffer =>
  Buffer.from(
    rows.map((r) => r.join(";")).join(String.fromCharCode(13, 10)) + String.fromCharCode(13, 10),
    "utf8",
  );

const readDownload = async (download: Download): Promise<Buffer> =>
  readFileSync((await download.path()) as string);

const count = (page: Page, key: "new" | "updated" | "unchanged" | "skipped" | "errors") =>
  page.locator(`[data-count="${key}"] dd`);

async function upload(page: Page, name: string, buffer: Buffer) {
  trackE2eImportFile(name);
  await page.goto("/admin/produse/import");
  await page.getByLabel("Fișier CSV sau XLSX").setInputFiles({
    name,
    mimeType: "application/octet-stream",
    buffer,
  });
  await page.getByRole("button", { name: "Încarcă și analizează" }).click();
  await expect(page.getByRole("heading", { name: "Mapează coloanele" })).toBeVisible();
}

async function check(page: Page) {
  await page.locator("[data-import-check]").click();
  await expect(page.getByRole("heading", { name: "Rezultatul verificării" })).toBeVisible();
}

test.describe("export cu coloanele de vânzare", () => {
  test("CSV pentru Excel: BOM + «sep=;», antetele noi în română, valorile EFECTIVE cu virgulă zecimală, fără cost; reimportat = «neschimbat»", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse");
    await page.goto(`/admin/produse?q=${encodeURIComponent(search)}`);
    await page.getByRole("button", { name: "Exportă…" }).click();
    const dialog = page.getByRole("dialog", { name: "Exportă produsele" });
    await dialog.getByLabel(/^CSV/).check();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      dialog.getByRole("button", { name: "Exportă", exact: true }).click(),
    ]);
    const bytes = await readDownload(download);

    // fișierul pentru Excel: BOM UTF-8, apoi «sep=;», apoi antetul
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    const lines = text.split(String.fromCharCode(13, 10)).filter((l) => l !== "");
    expect(lines[0]).toBe("sep=;");
    expect(lines[1]).toContain(`;Stare;${NEW_COLUMNS};ID produs;Modificat la`);
    const header = (lines[1] as string).split(";");
    const cell = (skuValue: string, label: string): string | undefined => {
      const row = lines.find((l) => l.startsWith(`${skuValue};`));
      return row?.split(";")[header.indexOf(label)];
    };

    // simbolul «mp» se ciocnește cu unitatea de sistem: exportul scrie CODUL unității (altfel fișierul nu s-ar reimporta)
    expect(cell(sku("liner"), "Unitate de măsură")).toBe(unitCode(IDX.liner));
    expect(cell(sku("liner"), "Baza prețului")).toBe("Pe unitate");
    expect(cell(sku("liner"), "Pas de vânzare")).toBe("41,25");
    expect(cell(sku("liner"), "Denumire pas")).toBe("rolă");
    // valorile EFECTIVE ale variantelor abachi (produs 1,5; varianta B suprascrie cu 1,8)
    expect(cell(sku("abachiA"), "Pas de vânzare")).toBe("1,5");
    expect(cell(sku("abachiB"), "Pas de vânzare")).toBe("1,8");
    // negestionat: starea apare, la gestionat lipsește; termenul propriu al produsului
    expect(cell(sku("cartus"), "Stare stoc")).toBe("Stoc epuizat");
    expect(cell(sku("cartus"), "Termen livrare (zile)")).toBe("5");
    expect(cell(sku("liner"), "Stare stoc")).toBe("");
    // produs la bucată
    expect(cell(sku("simplu"), "Unitate de măsură")).toBe("buc");
    expect(cell(sku("simplu"), "Pas de vânzare")).toBe("1");

    // dus-întors: tot «neschimbat» (patru produse, cinci rânduri)
    await upload(page, `e2e-${tag}-export.csv`, bytes);
    await check(page);
    await expect(count(page, "unchanged")).toHaveText("5");
    await expect(count(page, "updated")).toHaveText("0");
    await expect(count(page, "errors")).toHaveText("0");
  });

  test("șablonul de import conține coloanele noi, în ordine", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse/import");
    const template = await page.request.get("/api/admin/product-imports/template?format=csv");
    const text = new TextDecoder().decode(new Uint8Array(await template.body()));
    expect(text).toContain(NEW_COLUMNS);
  });
});

test.describe("import cu coloanele de vânzare", () => {
  test("verificare apoi aplicare: pe produs când e uniform, pe variantă când diferă; «Stare stoc» doar la negestionate; produs nou negestionat", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse/import");
    const newSku = `E2ESTOC${tag.toUpperCase()}NEW`;
    const ml = unitCode(IDX.abachi);
    const file = csvFile([
      [
        "SKU",
        "Titlu",
        "Preț (lei, cu TVA)",
        "Unitate de măsură",
        "Pas de vânzare",
        "Denumire pas",
        "Stare stoc",
        "Termen livrare (zile)",
      ],
      // liner (o singură variantă, gestionat): pas nou și denumire nouă pe produs; starea se ignoră (gestionat)
      [sku("liner"), "", "", unitCode(IDX.liner), "82,5", "rolă mare", "La comandă", ""],
      // abachi: aceeași valoare la ambele variante → pe produs; varianta B își pierde suprascrierea
      [sku("abachiA"), "", "", ml, "3", "", "", ""],
      [sku("abachiB"), "", "", ml, "3", "", "", ""],
      // cartuș (negestionat): starea se aplică; termenul se schimbă
      [sku("cartus"), "", "", "", "", "", "În stoc", "12"],
      // produs nou: se creează NEGESTIONAT, cu unitatea și pasul din fișier
      [newSku, `E2E Stoc ${tag} Import`, "10,00", ml, "0,5", "", "La comandă", "7"],
    ]);
    await upload(page, `e2e-${tag}-vanzare.csv`, file);
    await expect(page.getByLabel("Importă în câmpul: Pas de vânzare")).toHaveValue("saleStep");
    await expect(page.getByLabel("Importă în câmpul: Unitate de măsură")).toHaveValue("unit");
    await expect(page.getByLabel("Importă în câmpul: Stare stoc")).toHaveValue("stockStatus");
    await check(page);
    await expect(count(page, "new")).toHaveText("1");
    await expect(count(page, "updated")).toHaveText("4");
    await expect(count(page, "errors")).toHaveText("0");
    // avertismentul pentru starea ignorată la produsul gestionat
    await expect(page.getByText(/Stare stoc: ignorată/).first()).toBeVisible();

    await page.locator("[data-import-apply]").click();
    const dialog = page.getByRole("dialog", { name: "Aplici importul?" });
    await dialog.locator("[data-import-confirm]").click();
    await expect(page.locator("[data-import-done]")).toBeVisible();

    // liner: pe produs (o singură variantă); gestionat rămâne gestionat și starea nu s-a schimbat
    expect(await readE2eSale(sku("liner"))).toMatchObject({
      product: {
        saleStep: 825_000,
        saleStepLabel: "rolă mare",
        manageStock: true,
        stockStatus: "instock",
      },
    });
    // abachi: pasul 3 pe produs, suprascrierea variantei B golită
    expect(await readE2eSale(sku("abachiA"))).toMatchObject({
      product: { saleStep: 30_000 },
      variant: { saleStep: null },
    });
    expect(await readE2eSale(sku("abachiB"))).toMatchObject({ variant: { saleStep: null } });
    // cartuș negestionat: starea și termenul aplicate
    expect(await readE2eSale(sku("cartus"))).toMatchObject({
      product: { stockStatus: "instock", leadTimeDays: 12, manageStock: false },
    });
    // produsul nou: negestionat explicit, cu unitatea, pasul, starea și termenul din fișier
    expect(await readE2eSale(newSku)).toMatchObject({
      product: { manageStock: false, saleStep: 5_000, stockStatus: "onbackorder", leadTimeDays: 7 },
    });
  });

  test("erorile apar în română, pe rând, și nimic nu se aplică: unitate necunoscută, pas cu prea multe zecimale, raport inexact", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse/import");
    const before = await readE2eSale(sku("liner"));
    const file = csvFile([
      ["SKU", "Unitate de măsură", "Pas de vânzare", "Mod conversie SmartBill", "Raport SmartBill"],
      [sku("simplu"), "litri neexistenți", "", "", ""],
      [sku("liner"), "", "2,033", "", ""],
      [sku("cartus"), "", "", "Raport", "0,3"],
    ]);
    await upload(page, `e2e-${tag}-erori.csv`, file);
    await check(page);
    await expect(count(page, "errors")).toHaveText("3");
    await expect(count(page, "updated")).toHaveText("0");
    await expect(page.getByText(/unitatea „litri neexistenți” nu există/)).toBeVisible();
    await expect(page.locator("[data-import-apply]")).toBeDisabled();
    // nimic scris
    expect(await readE2eSale(sku("liner"))).toEqual(before);
  });
});

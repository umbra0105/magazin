import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  readE2eVariantCost,
  removeE2eCarts,
  removeE2eNirImports,
  removeE2eProducts,
  seedE2eCartProduct,
  setE2eVariantCost,
  type E2eCartProduct,
} from "../packages/core/test/e2e-support";
import { decodeUtf16le, encodeUtf16le, head } from "../packages/core/test/utf-16le";
import { createAccount, login, type Account } from "./support/card-flow";

/**
 * Importul prețurilor de achiziție (NIR) din exportul SmartBill «mișcări produse» (Faza 15), din browser, cu un fișier SINTETIC
 * (coduri inventate pe tag, costuri inventate; fișierul real SmartBill nu intră în teste): previzualizare fără scriere (dry-run) →
 * confirmare → procesare în fundal → raport descărcat (CSV pentru Excel: UTF-16LE cu BOM, TAB, fără linia de separator, diacritice
 * corecte). Repetarea aceluiași fișier nu schimbă nimic; o dată mai veche e «neschimbat»; un cod inexistent apare la «coduri necunoscute».
 * Filtrul «fără preț NIR». Permisiuni: fără `products.cost.import` nu se vede ecranul, iar rutele refuză pe server.
 */
const tag = randomBytes(3).toString("hex");
const FILE_PREFIX = `e2e-${tag}`;

test.describe.configure({ mode: "serial", timeout: 180_000 });

let a: E2eCartProduct;
let b: E2eCartProduct;
let c: E2eCartProduct; // are deja un preț NIR cu o dată mai nouă decât a fișierului
let fara: E2eCartProduct; // rămâne fără preț NIR
let admin: Account;
let manager: Account;
let editor: Account;

const BOM = String.fromCharCode(0xfeff);
const DAY = 86_400_000;
const two = (n: number) => String(n).padStart(2, "0");
const ago = (days: number): Date => new Date(Date.now() - days * DAY);
const fileDate = (days: number): string => {
  const d = ago(days);
  return `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
};
const isoDay = (days: number): string => ago(days).toISOString().slice(0, 10);

const HEADER = [
  "Gestiune",
  "Produs",
  "Cod",
  "Data",
  "Tip document",
  "Document",
  "U.M.",
  "Intrari",
  "Iesiri",
  "Cost unitar",
  "Intrari (valoare)",
  "Iesiri (valoare)",
];

function csvBytes(rows: string[][]): Buffer {
  const text = rows.map((row) => row.join("\t")).join("\r\n") + "\r\n";
  return Buffer.from(encodeUtf16le(text));
}

const line = (code: string, date: string, qty: string, cost: string): string[] => [
  "Depozit",
  "Produs inventat",
  code,
  date,
  "Receptie",
  "NIR 1",
  "buc",
  qty,
  "0",
  cost,
  "0",
  "0",
];

test.beforeAll(async ({ request, baseURL }) => {
  a = await seedE2eCartProduct(tag, "a", { price: 19_900 });
  b = await seedE2eCartProduct(tag, "b", { price: 29_900 });
  c = await seedE2eCartProduct(tag, "c", { price: 9_900 });
  fara = await seedE2eCartProduct(tag, "fara", { price: 5_900 });
  await setE2eVariantCost(c.sku, { minor: 5_000, day: isoDay(1) });
  admin = await createAccount(request, baseURL as string, "owner");
  manager = await createAccount(request, baseURL as string, "manager");
  editor = await createAccount(request, baseURL as string, "editor");
});

test.afterAll(async () => {
  await removeE2eNirImports(tag);
  await removeE2eCarts();
  await removeE2eProducts();
});

async function upload(page: Page, name: string, rows: string[][]) {
  await page.goto("/admin/produse/import-nir");
  await page.setInputFiles("#nir-file", {
    name,
    mimeType: "text/csv",
    buffer: csvBytes(rows),
  });
  await page.locator("[data-nir-upload]").click();
  await expect(page.locator("[data-nir-preview]")).toBeVisible();
}

const counter = (page: Page, tone: string) => page.locator(`[data-nir-counter="${tone}"] dd`);

test("previzualizarea nu scrie nimic; confirmarea aplică în fundal; raportul se descarcă pentru Excel", async ({
  page,
}) => {
  await login(page, admin, "/admin");
  const rows = [
    HEADER,
    line(a.sku, fileDate(3), "10", "123.4549"),
    line(b.sku, fileDate(2), "4", "49,9900"),
    line(c.sku, fileDate(6), "7", "11.1100"), // mai veche decât ce are produsul: neschimbat
    line("COD-INEXISTENT", fileDate(2), "1", "10"), // cod necunoscut
    line(a.sku, "2/2/2030", "1", "5"), // dată greșită: invalid
    line(b.sku, fileDate(1), "-3", "999"), // storno: ignorat
    ["Total", "", "", "", "", "", "", "22", "0", "", "0", "0"],
  ];
  await upload(page, `${FILE_PREFIX}-miscari.csv`, rows);

  // cifrele previzualizării
  await expect(counter(page, "updated")).toHaveText("2");
  await expect(counter(page, "unchanged")).toHaveText("1");
  await expect(counter(page, "unknown")).toHaveText("1");
  await expect(counter(page, "invalid")).toHaveText("1");
  await expect(counter(page, "ignored")).toHaveText("1");
  await expect(page.locator("[data-nir-preview]")).toContainText("COD-INEXISTENT");
  // dry-run: în catalog nu s-a schimbat nimic
  expect((await readE2eVariantCost(a.sku)).costPrice).toBeNull();
  expect((await readE2eVariantCost(b.sku)).costPrice).toBeNull();
  // prețurile de achiziție nu apar pe ecran
  await expect(page.locator("[data-nir-preview]")).not.toContainText("123,45");

  // confirmare → coadă → terminat
  await page.locator("[data-nir-confirm]").click();
  await page.locator("[data-nir-confirm-yes]").click();
  await expect(page.locator('[data-nir-status="completed"]')).toBeVisible({ timeout: 60_000 });
  await expect(counter(page, "updated")).toHaveText("2");

  // costul în bani (rotunjit o singură dată, half-up), data intrării și un rând de istoric, legat de import
  const costA = await readE2eVariantCost(a.sku);
  expect(costA).toMatchObject({ costPrice: 12_345, costDay: isoDay(3), history: 1 });
  const costB = await readE2eVariantCost(b.sku);
  expect(costB).toMatchObject({ costPrice: 4_999, costDay: isoDay(2), history: 1 });
  expect(costA.importIds[0]).toBeTruthy();
  // produsul cu intrare mai nouă a rămas neatins
  expect(await readE2eVariantCost(c.sku)).toMatchObject({ costPrice: 5_000, history: 0 });

  // raportul: CSV UTF-16LE cu BOM și TAB, fără linia de separator, cu diacritice corecte
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("[data-nir-report-link]").click(),
  ]);
  const bytes = readFileSync(await download.path());
  expect(head(bytes, 2)).toEqual([0xff, 0xfe]);
  const text = decodeUtf16le(bytes).replace(BOM, ""); // BOM-ul se verifică separat, pe octeți
  expect(text).not.toMatch(/^sep=/i);
  expect(text.split("\r\n")[0]).toBe(
    ["Categorie", "Rând", "Cod", "Data intrării", "Preț fără TVA (lei)", "Detalii"].join("\t"),
  );
  expect(text).toContain("Actualizat");
  expect(text).toContain("Cod necunoscut");
  expect(text).toContain("Rând invalid");
  expect(text).toContain("123,45"); // costul lui A în lei, 2 zecimale
  expect(text).not.toContain("Ã"); // fără diacritice stricate
});

test("același fișier a doua oară: totul «neschimbat», fără rânduri noi de istoric; confirmarea nu mai are ce aplica", async ({
  page,
}) => {
  await login(page, admin, "/admin");
  await upload(page, `${FILE_PREFIX}-repetat.csv`, [
    HEADER,
    line(a.sku, fileDate(3), "10", "123.4549"),
    line(b.sku, fileDate(2), "4", "49,9900"),
  ]);
  await expect(counter(page, "updated")).toHaveText("0");
  await expect(counter(page, "unchanged")).toHaveText("2");
  await expect(page.locator("[data-nir-confirm]")).toBeDisabled();
  expect((await readE2eVariantCost(a.sku)).history).toBe(1);
  expect((await readE2eVariantCost(b.sku)).history).toBe(1);

  // o dată mai nouă, chiar cu preț mai mic, se aplică (nu se păstrează maximul)
  await page.getByRole("button", { name: "Renunță" }).click();
  await upload(page, `${FILE_PREFIX}-nou.csv`, [HEADER, line(a.sku, fileDate(1), "2", "50")]);
  await expect(counter(page, "updated")).toHaveText("1");
  await page.locator("[data-nir-confirm]").click();
  await page.locator("[data-nir-confirm-yes]").click();
  await expect(page.locator('[data-nir-status="completed"]')).toBeVisible({ timeout: 60_000 });
  expect(await readE2eVariantCost(a.sku)).toMatchObject({
    costPrice: 5_000,
    costDay: isoDay(1),
    history: 2,
  });
});

test("fără preț NIR: indicator și filtru în lista de produse, doar pentru cine vede costul", async ({
  page,
}) => {
  await login(page, admin, "/admin");
  await page.goto(`/admin/produse?q=${tag}`);
  await expect(page.locator("[data-nir-missing]")).toBeVisible();
  await page.goto(`/admin/produse?q=${tag}&nir=lipsa`);
  await expect(page.locator("tbody tr", { hasText: fara.title })).toHaveCount(1);
  await expect(page.locator("tbody tr", { hasText: a.title })).toHaveCount(0);
  await expect(page.locator("tbody tr", { hasText: c.title })).toHaveCount(0);

  // editorul nu vede costul: filtrul se ignoră (lista nu trădează ce are preț de achiziție)
  await page.context().clearCookies();
  await login(page, editor, "/admin");
  await page.goto(`/admin/produse?q=${tag}&nir=lipsa`);
  await expect(page.locator("tbody tr", { hasText: a.title })).toHaveCount(1);
  await expect(page.locator("[data-nir-missing]")).toHaveCount(0);
});

test("permisiuni: managerul vede costul, dar nu importă; editorul nu vede nimic; rutele refuză pe server", async ({
  page,
  baseURL,
}) => {
  const origin = baseURL as string;
  await login(page, manager, "/admin");
  // fără products.cost.import: ecranul nu se deschide și nu e în meniu
  await page.goto("/admin/produse/import-nir");
  await expect(page.locator("[data-nir-upload]")).toHaveCount(0);
  const post = await page.request.post(`${origin}/api/admin/nir-imports`, {
    headers: { origin, "x-file-name": "x.csv" },
    data: Buffer.from("x"),
  });
  expect(post.status()).toBe(403);
  // șablonul cere doar products.cost.view: managerul îl primește, în formatul pentru Excel
  const template = await page.request.get(`${origin}/api/admin/nir-imports/template`);
  expect(template.status()).toBe(200);
  expect(Array.from(await template.body()).slice(0, 2)).toEqual([0xff, 0xfe]);
  expect(decodeUtf16le(await template.body())).toContain("Cost unitar");

  await page.context().clearCookies();
  await login(page, editor, "/admin");
  expect((await page.request.get(`${origin}/api/admin/nir-imports/template`)).status()).toBe(403);
  const missing = await page.request.get(`${origin}/api/admin/nir-imports/zzzzzzzzzzzz/report`);
  expect(missing.status()).toBe(403);
  await page.goto("/admin/produse/import-nir");
  await expect(page.locator("[data-nir-upload]")).toHaveCount(0);

  // fără sesiune: 401
  await page.context().clearCookies();
  const anonymous = await page.request.get(`${origin}/api/admin/nir-imports/template`);
  expect(anonymous.status()).toBe(401);
});

import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  ensureE2eSystemGroup,
  readE2eGroupAudit,
  readE2eUserGroup,
  removeE2eCarts,
  removeE2eCustomerGroups,
  removeE2eGroupsByName,
  removeE2eProducts,
  seedE2eCartProduct,
  seedE2eCheckoutSettings,
  setE2eUserGroup,
  setE2eVariantCost,
  type E2eCartProduct,
  type E2eGroup,
  seedE2eCustomerGroup,
} from "../packages/core/test/e2e-support";
import { createAccount, login, type Account } from "./support/card-flow";

/**
 * Grupuri de clienți și prețuri de grup (Faza 15), din browser. Admin: CRUD de grupuri (selector de tip + procent), «Client standard»
 * neștergibil, atribuire individuală și în masă (cu badge în listă), audit fără email. Vitrină: clientul Fidel (−5%) și Partenerul
 * (preț de achiziție + adaos + TVA, plafonat la prețul public) văd prețul lor pe listă, pe pagina produsului și în coș, cu «Preț
 * standard» tăiat, eticheta grupului și linia informativă din coș; produsul fără preț NIR rămâne la prețul public; oaspetele și clientul
 * fără grup văd exact prețurile publice, iar pagina publică (din cache) nu conține NICIODATĂ prețul unui grup. Conturile au parole
 * generate în test; fiecare test curăță ce a creat (grupuri, produse, coșuri).
 *
 * Cifre de mână (TVA 21%): 199,00 − 5% = 189,05; costNet 100,00 · 1,12 · 1,21 = 135,52.
 */
const tag = randomBytes(3).toString("hex");

test.describe.configure({ mode: "serial", timeout: 120_000 });

let fidel: E2eGroup;
let partener: E2eGroup;
let produs: E2eCartProduct; // 199,00 lei, cost NIR 100,00
let faraNir: E2eCartProduct; // 199,00 lei, fără cost
let admin: Account;
let clientFidel: Account;
let clientPartener: Account;
let clientStandard: Account;
let clientA: Account;
let clientB: Account;

const FIDEL_NAME = "Client fidel";
const PARTENER_NAME = "Partener 1";

test.beforeAll(async ({ request, baseURL }) => {
  await seedE2eCheckoutSettings();
  await ensureE2eSystemGroup();
  fidel = await seedE2eCustomerGroup(tag, "fidel", {
    name: FIDEL_NAME,
    pricingType: "discount",
    discountBps: 500,
    tone: "success",
  });
  partener = await seedE2eCustomerGroup(tag, "partener", {
    name: PARTENER_NAME,
    pricingType: "cost_plus",
    markupBps: 1200,
    earnsLoyaltyPoints: false,
    tone: "warning",
  });
  produs = await seedE2eCartProduct(tag, "pret", { price: 19_900 });
  faraNir = await seedE2eCartProduct(tag, "fara", { price: 19_900 });
  await setE2eVariantCost(produs.sku, { minor: 10_000, day: "2030-01-01" });
  admin = await createAccount(request, baseURL as string, "owner");
  clientFidel = await createAccount(request, baseURL as string, "");
  clientPartener = await createAccount(request, baseURL as string, "");
  clientStandard = await createAccount(request, baseURL as string, "");
  clientA = await createAccount(request, baseURL as string, "");
  clientB = await createAccount(request, baseURL as string, "");
  await setE2eUserGroup(clientFidel.email, fidel.id);
  await setE2eUserGroup(clientPartener.email, partener.id);
});

test.afterAll(async () => {
  await removeE2eCarts();
  await removeE2eProducts();
  await removeE2eGroupsByName(tag);
  await removeE2eCustomerGroups(tag);
});

const price = (page: Page) => page.locator("[data-purchase-panel] [data-price]");

async function addAndOpenCart(page: Page, product: E2eCartProduct) {
  await page.goto(`/produs/${product.slug}`);
  await page.locator("[data-add-button]").click();
  await expect(page.locator("[data-cart-drawer] [data-cart-line]").first()).toBeVisible();
  await page.goto("/cos");
}

test("admin: grupurile — CRUD cu selector de tip, «Client standard» neștergibil", async ({
  page,
}) => {
  await login(page, admin, "/admin/clienti/grupuri");
  await expect(page.getByRole("heading", { name: "Grupuri de clienți" })).toBeVisible();
  const standard = page.locator('[data-group-row="Client standard"]').first();
  await expect(standard).toBeVisible();
  // grupul de sistem: editabil, dar fără buton de ștergere
  await expect(
    standard.getByRole("button", { name: /Editează grupul Client standard/ }),
  ).toBeVisible();
  await expect(standard.getByRole("button", { name: /Șterge grupul/ })).toHaveCount(0);

  const name = `Grup nou ${tag}`;
  await page.locator("[data-create-group]").click();
  await page.getByLabel("Numele grupului").fill(name);
  // la «discount» apare câmpul de reducere; la «cost_plus», cel de adaos
  await page.getByLabel("Cum se calculează prețul").selectOption("discount");
  await expect(page.getByLabel("Reducerea (%)")).toBeVisible();
  await page.getByLabel("Reducerea (%)").fill("");
  await page.locator("[data-save-group]").click();
  await expect(page.getByText("Scrie procentul.")).toBeVisible(); // validare în română, fără baloane native
  await page.getByLabel("Reducerea (%)").fill("7,5");
  await page.getByLabel("Cum se calculează prețul").selectOption("cost_plus");
  await expect(page.getByLabel("Adaosul (%)")).toBeVisible();
  await expect(page.getByLabel("Reducerea (%)")).toHaveCount(0);
  await page.getByLabel("Adaosul (%)").fill("17");
  await page.locator("[data-save-group]").click();

  const row = page.locator(`[data-group-row="${name}"]`);
  await expect(row).toBeVisible(); // apare abia după salvare (dialogul s-a închis, lista s-a reîncărcat)
  await expect(row.locator('[data-cell="percent"]')).toHaveText("+17% adaos");

  // editare: schimb tipul în «discount» cu 7,5%
  await row.getByRole("button", { name: new RegExp(`Editează grupul ${name}`) }).click();
  await page.getByLabel("Cum se calculează prețul").selectOption("discount");
  await page.getByLabel("Reducerea (%)").fill("7,5");
  await page.locator("[data-save-group]").click();
  await expect(row.locator('[data-cell="percent"]')).toHaveText("−7,5%");

  // ștergere (grup fără clienți)
  await row.getByRole("button", { name: new RegExp(`Șterge grupul ${name}`) }).click();
  await page.locator("[data-confirm-remove]").click();
  await expect(page.locator(`[data-group-row="${name}"]`)).toHaveCount(0);
});

test("admin: atribuire individuală și în masă, cu badge și filtru în lista de clienți", async ({
  page,
}) => {
  await login(page, admin, "/admin/clienti");
  const rowOf = (account: Account) => page.locator("tr", { hasText: account.email });

  // individual: din selectorul de pe rând
  await page.goto(`/admin/clienti?q=${encodeURIComponent(clientA.email)}`);
  await expect(rowOf(clientA)).toBeVisible();
  await rowOf(clientA).locator("[data-group-select]").selectOption({ label: FIDEL_NAME });
  await page.waitForTimeout(4000);
  const diag = {
    problems: await page.locator("[data-problem]").allTextContents(),
    dbGroup: await readE2eUserGroup(clientA.email),
    selectValue: await rowOf(clientA).locator("[data-group-select]").inputValue(),
  };
  expect(diag, "diagnostic mutare individuală").toEqual({
    problems: [],
    dbGroup: fidel.id,
    selectValue: fidel.id,
  });
  await expect(rowOf(clientA).locator("[data-group-badge]")).toContainText(FIDEL_NAME);
  expect(await readE2eUserGroup(clientA.email)).toBe(fidel.id);

  // în masă: aleg doi clienți, apoi grupul, cu confirmare
  await page.goto(`/admin/clienti?q=${encodeURIComponent("example.test")}`);
  for (const account of [clientA, clientB]) {
    await rowOf(account).locator('input[type="checkbox"]').check();
  }
  await expect(page.locator("[data-bulk-count]")).toContainText("2 clienți aleși");
  await page.locator("#bulk-group").selectOption({ label: PARTENER_NAME });
  await page.locator("[data-bulk-apply]").click();
  await page.locator("[data-bulk-confirm]").click();
  await expect(page.locator("[data-bulk-bar]")).toHaveCount(0); // bara dispare abia după ce mutarea s-a terminat
  expect(await readE2eUserGroup(clientA.email)).toBe(partener.id);
  expect(await readE2eUserGroup(clientB.email)).toBe(partener.id);

  // filtrul de grup
  await page.goto(`/admin/clienti?grup=${partener.id}&q=${encodeURIComponent("example.test")}`);
  await expect(rowOf(clientB)).toBeVisible();
  await expect(rowOf(clientFidel)).toHaveCount(0);

  // «Client standard» include și clienții fără grup
  const standardId = await page
    .locator("#customer-group option", { hasText: "Client standard" })
    .first()
    .getAttribute("value");
  await page.goto(
    `/admin/clienti?grup=${standardId}&q=${encodeURIComponent(clientStandard.email)}`,
  );
  await expect(rowOf(clientStandard)).toBeVisible();

  // auditul atribuirii: identificatori și numere, fără emailuri de clienți
  const dumps = (await readE2eGroupAudit("customer.group.assign_bulk")).join(" ");
  expect(dumps).toContain("userCount");
  expect(dumps).not.toContain(clientA.email);
  expect(dumps).not.toContain(clientB.email);

  await setE2eUserGroup(clientA.email, null);
  await setE2eUserGroup(clientB.email, null);
});

test("clientul Fidel: prețul −5% pe pagina produsului, «Preț standard» tăiat, eticheta și linia din coș", async ({
  page,
}) => {
  await login(page, clientFidel, "/cont");
  await page.goto(`/produs/${produs.slug}`);
  await expect(price(page)).toContainText("189,05");
  await expect(page.locator("[data-purchase-panel] [data-group-standard]")).toContainText(
    "Preț standard 199,00",
  );
  await expect(page.locator("[data-purchase-panel] [data-group-badge]")).toContainText(
    "Preț client fidel −5%",
  );

  // pe listă: același preț, același tratament
  await page.goto(`/cautare?q=${encodeURIComponent(produs.title)}`);
  const card = page.locator("article", { hasText: produs.title }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText("189,05");
  await expect(card.locator("[data-group-badge]")).toContainText("Preț client fidel −5%");

  // în coș: preț, total și linia informativă de reducere
  await addAndOpenCart(page, produs);
  await expect(page.locator("[data-cart-line]").first()).toContainText("189,05");
  await expect(page.locator("[data-cart-total]")).toContainText("189,05");
  await expect(page.locator("[data-group-line]")).toContainText("Reducere client fidel (−5%)");
  await expect(page.locator("[data-group-line]")).toContainText("9,95");
});

test("clientul Partener: prețul cost-plus (135,52) pe pagină și în coș; produsul fără preț NIR rămâne la prețul public", async ({
  page,
}) => {
  await login(page, clientPartener, "/cont");
  await page.goto(`/produs/${produs.slug}`);
  await expect(price(page)).toContainText("135,52");
  await expect(page.locator("[data-purchase-panel] [data-group-standard]")).toContainText(
    "Preț standard 199,00",
  );
  await expect(page.locator("[data-purchase-panel] [data-group-badge]")).toContainText(
    "Preț partener",
  );
  // fără preț NIR: prețul public, fără etichetă de grup (așteptăm să treacă timpul cererii de grup)
  await page.goto(`/produs/${faraNir.slug}`);
  await expect(price(page)).toContainText("199,00");
  await page.waitForTimeout(800);
  await expect(page.locator("[data-purchase-panel] [data-group-badge]")).toHaveCount(0);

  await addAndOpenCart(page, produs);
  await expect(page.locator("[data-cart-total]")).toContainText("135,52");
  await expect(page.locator("[data-group-line]")).toContainText("Avantaj partener");
  await expect(page.locator("[data-group-line]")).toContainText("63,48");
  // nimic despre adaos sau cost în pagina coșului
  const html = await page.content();
  expect(html).not.toMatch(/adaos|markup|costNet|costPrice/i);
});

test("oaspetele și clientul fără grup văd prețurile publice, iar pagina publică din cache nu conține prețul unui grup", async ({
  page,
  request,
  baseURL,
}) => {
  // pagina cerută ca anonim, după ce clienții cu grup au vizitat-o, e cea publică
  const response = await request.get(`${baseURL}/produs/${produs.slug}`);
  expect(response.ok()).toBe(true);
  const html = await response.text();
  expect(html).toContain("199,00");
  expect(html).not.toContain("135,52");
  expect(html).not.toContain("189,05");
  expect(html).not.toContain("Preț partener");
  expect(html).not.toContain("Preț client fidel");

  // oaspete în browser: preț public, fără etichetă
  await page.goto(`/produs/${produs.slug}`);
  await expect(price(page)).toContainText("199,00");
  await page.waitForTimeout(800);
  await expect(price(page)).not.toContainText("189,05");
  await expect(page.locator("[data-group-badge]")).toHaveCount(0);

  // client «Client standard» (grup de sistem, fără preț special): la fel
  await login(page, clientStandard, "/cont");
  await page.goto(`/produs/${produs.slug}`);
  await expect(price(page)).toContainText("199,00");
  await page.waitForTimeout(800);
  await expect(price(page)).not.toContainText("189,05");
  await expect(price(page)).not.toContainText("135,52");
  await expect(page.locator("[data-group-badge]")).toHaveCount(0);
  await addAndOpenCart(page, produs);
  await expect(page.locator("[data-cart-total]")).toContainText("199,00");
  await expect(page.locator("[data-group-line]")).toHaveCount(0);
});

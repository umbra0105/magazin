import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  promoteE2eUser,
  readE2eShippingZone,
  removeE2eShippingZones,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Ecranul «Zone de livrare» (`/admin/setari/livrare`, Faza 9): zonele pe județe cu tarife fixe (rezerva când furnizorul de tarife
 * nu răspunde). Zonele de test au numele care începe cu «E2E ». Județele se aleg din lista SIRUTA din baza de test: specul ia
 * primele două județe bifabile din interfață, ca să nu depindă de date fixe.
 */
const tag = randomBytes(3).toString("hex");

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await removeE2eShippingZones();
});
test.afterAll(async () => {
  await removeE2eShippingZones();
});

async function createOwner(request: APIRequestContext, baseURL: string) {
  const email = `e2e-${randomBytes(5).toString("hex")}@example.test`;
  const password = randomBytes(18).toString("base64url");
  const response = await request.post(`${baseURL}/api/auth/sign-up/email`, {
    headers: { origin: baseURL, "x-forwarded-for": uniqueClientIp() },
    data: { name: "Owner E2E", email, password },
  });
  await expectResponseOk(response, "înregistrarea contului de test");
  await promoteE2eUser(email, "owner");
  return { email, password };
}

async function login(page: Page, account: { email: string; password: string }, next: string) {
  await page.goto(`/autentificare?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Parolă", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Intră în cont" }).click();
  await page.waitForURL((url) => url.pathname === next);
}

const form = (page: Page) => page.locator("[data-zone-form]");
const countyBoxes = (page: Page) => form(page).locator("[data-zone-counties] input[type=checkbox]");

test("creează, editează și șterge o zonă; județul nu poate fi în două zone active; erorile apar pe câmp", async ({
  page,
  request,
  baseURL,
}) => {
  const owner = await createOwner(request, baseURL as string);
  await login(page, owner, "/admin/setari/livrare");
  await expect(page.getByRole("heading", { level: 1, name: /Zone de livrare/ })).toBeVisible();
  const zoneA = `E2E zona A ${tag}`;
  const zoneB = `E2E zona B ${tag}`;

  // creare cu erori: numele, județele și prețul lipsesc → mesaje pe câmp, focus pe primul, nimic salvat
  await page.getByRole("button", { name: "Adaugă o zonă" }).first().click();
  await expect(form(page)).toBeVisible();
  await form(page).getByRole("button", { name: "Salvează zona" }).click();
  await expect(form(page).getByText("Scrie numele zonei (cel puțin 2 caractere).")).toBeVisible();
  await expect(form(page).getByText("Alege cel puțin un județ.")).toBeVisible();
  await expect(
    form(page).getByText("Introdu o sumă în lei, cu cel mult două zecimale."),
  ).toBeVisible();
  await expect(form(page).locator("#zone-name")).toBeFocused();

  // zonă validă: primele două județe
  await form(page).locator("#zone-name").fill(zoneA);
  await form(page).locator("#zone-methodName").fill("Curier rapid");
  await form(page).locator("#zone-price").fill("25,90");
  await form(page).locator("#zone-codFee").fill("7");
  await form(page).locator("#zone-freeAbove").fill("800");
  await form(page).locator("#zone-days").fill("2");
  await countyBoxes(page).nth(0).check();
  await countyBoxes(page).nth(1).check();
  await form(page).getByRole("button", { name: "Salvează zona" }).click();
  await expect(form(page)).toBeHidden(); // dialogul s-a închis = salvat
  const row = page.locator(`[data-zone-row="${zoneA}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('[data-cell="counties"]')).toContainText("2 județe");
  await expect(row.locator('[data-cell="tariff"]')).toContainText("25,90 RON, 2 zile");

  const saved = await readE2eShippingZone(zoneA);
  expect(saved?.isActive).toBe(true);
  expect(saved?.countyCodes.length).toBe(2);
  expect(saved?.method).toEqual({ priceMinor: 2590, codFeeMinor: 700, freeAboveMinor: 80_000 });

  // o a doua zonă activă cu un județ deja luat: refuz cu numele zonei, pe câmpul județelor
  await page.getByRole("button", { name: "Adaugă o zonă" }).first().click();
  await form(page).locator("#zone-name").fill(zoneB);
  await form(page).locator("#zone-methodName").fill("Curier");
  await form(page).locator("#zone-price").fill("30");
  await countyBoxes(page).nth(0).check();
  await form(page).getByRole("button", { name: "Salvează zona" }).click();
  await expect(form(page).getByText(`aparține deja zonei active «${zoneA}»`)).toBeVisible();
  expect(await readE2eShippingZone(zoneB)).toBeNull();
  await form(page).getByRole("button", { name: "Renunță la modificări" }).click();
  await expect(form(page)).toBeHidden();

  // editare: prețul se schimbă, zona se dezactivează
  await row.getByRole("button", { name: `Editează: ${zoneA}` }).click();
  await form(page).locator("#zone-price").fill("19,90");
  await form(page).getByLabel("Zona e activă").uncheck();
  await form(page).getByRole("button", { name: "Salvează zona" }).click();
  await expect(form(page)).toBeHidden();
  await expect(row.locator('[data-cell="tariff"]')).toContainText("19,90 RON");
  await expect(row.locator('[data-cell="status"]')).toContainText("Inactivă");
  expect((await readE2eShippingZone(zoneA))?.method?.priceMinor).toBe(1990);

  // ștergere cu confirmare
  await row.getByRole("button", { name: `Șterge: ${zoneA}` }).click();
  await page.getByRole("button", { name: "Șterge zona" }).click();
  await expect(row).toHaveCount(0);
  expect(await readE2eShippingZone(zoneA)).toBeNull();
});

test("la 390 px lista și formularul nu au derulare orizontală", async ({
  page,
  request,
  baseURL,
}) => {
  const owner = await createOwner(request, baseURL as string);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, owner, "/admin/setari/livrare");
  await page.getByRole("button", { name: "Adaugă o zonă" }).first().click();
  await expect(form(page)).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

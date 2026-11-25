import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  countE2eCartLines,
  e2eCartIdOfUser,
  e2eCartIdOfVariant,
  holdE2eCartRowShare,
  promoteE2eUser,
  removeE2eCarts,
  removeE2eProducts,
  seedE2eCartProduct,
  type E2eCartProduct,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Blocarea rândului coșului (`CartService.lock`, `FOR UPDATE`) în BUILD-UL DE PRODUCȚIE (mini-faza `prisma-join-tema`).
 * Un test de integrare (Node, fără pachetul Next) nu vede dacă blocarea se ia: în build-ul Next, un fragment `Prisma.join`
 * într-un șablon etichetat `$queryRaw` nu era recunoscut ca SQL, iar interogarea nu dădea eroare, dar nu bloca nimic.
 *
 * Dovada: testul ține pe o conexiune proprie `FOR KEY SHARE` pe rândul coșului (nu se ciocnește cu scrierile obișnuite,
 * dar blochează `FOR UPDATE`). O cerere care ia blocarea trebuie să aștepte; una care nu o ia trece imediat.
 */
const tag = randomBytes(3).toString("hex");
const HELD_MS = 2_000;

test.describe.configure({ mode: "serial" });

let product: E2eCartProduct;
let second: E2eCartProduct;

test.beforeAll(async () => {
  product = await seedE2eCartProduct(tag, "bucati", { price: 19900 });
  second = await seedE2eCartProduct(tag, "alta", { price: 9900 });
});

test.afterAll(async () => {
  await removeE2eCarts();
  await removeE2eProducts();
});

const drawer = (page: Page) => page.locator("[data-cart-drawer]");

async function addOnce(page: Page) {
  await page.goto(`/produs/${product.slug}`);
  await page.locator("[data-add-button]").click();
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).locator("[data-cart-line]").first()).toBeVisible();
  await drawer(page).getByRole("button", { name: "Închide coșul" }).click();
  await expect(drawer(page)).toBeHidden();
}

test.describe("blocarea coșului în producție", () => {
  test("adăugarea în coș așteaptă blocarea rândului coșului, apoi se termină", async ({ page }) => {
    await addOnce(page);
    await expect(page.locator("[data-cart-badge]")).toHaveText("1");
    const cartId = await e2eCartIdOfVariant(product.variantId);
    expect(cartId).not.toBeNull();

    const held = await holdE2eCartRowShare(cartId as string);
    try {
      await page.locator("[data-add-button]").click();
      await page.waitForTimeout(HELD_MS);
      // cât blocarea e ținută, acțiunea nu s-a terminat: sertarul nu s-a deschis
      await expect(drawer(page)).toBeHidden({ timeout: 500 });
    } finally {
      await held.release();
    }
    // după eliberare acțiunea se termină: apare sertarul și linia are 2 bucăți
    await expect(drawer(page)).toBeVisible();
    await expect(drawer(page).locator("[data-cart-line]").first()).toContainText("2");
  });

  test("îmbinarea coșului de oaspete la autentificare așteaptă blocarea coșului contului", async ({
    page,
    browser,
    request,
    baseURL,
  }) => {
    const email = `e2e-${randomBytes(5).toString("hex")}@example.test`;
    const password = randomBytes(18).toString("base64url");
    const response = await request.post(`${baseURL as string}/api/auth/sign-up/email`, {
      headers: { origin: baseURL as string, "x-forwarded-for": uniqueClientIp() },
      data: { name: "Client E2E", email, password },
    });
    await expectResponseOk(response, "înregistrarea clientului de test");
    await promoteE2eUser(email, null);

    const login = async (target: Page) => {
      await target.goto("/autentificare?next=%2Fmagazin");
      await target.getByLabel("Email").fill(email);
      await target.getByLabel("Parolă", { exact: true }).fill(password);
    };
    const addProduct = async (target: Page, item: E2eCartProduct) => {
      await target.goto(`/produs/${item.slug}`);
      await target.locator("[data-add-button]").click();
      await expect(drawer(target)).toBeVisible();
      await expect(drawer(target).locator("[data-cart-line]").first()).toBeVisible();
    };

    // coșul contului există dinainte (cu produsul de bază); îmbinarea nu îl șterge, doar îl blochează prin `lock`
    await login(page);
    await page.getByRole("button", { name: "Intră în cont" }).click();
    await page.waitForURL((url) => url.pathname === "/magazin");
    await addProduct(page, product);
    expect(await countE2eCartLines(email)).toBe(1);
    const accountCartId = await e2eCartIdOfUser(email);
    expect(accountCartId).not.toBeNull();

    // alt browser, ca oaspete, cu alt produs în coș
    const guestContext = await browser.newContext();
    try {
      const guest = await guestContext.newPage();
      await addProduct(guest, second);
      await login(guest);

      const held = await holdE2eCartRowShare(accountCartId as string);
      try {
        const signedIn = guest.waitForResponse(
          (res) =>
            res.url().includes("/api/auth/sign-in/email") && res.request().method() === "POST",
        );
        await guest.getByRole("button", { name: "Intră în cont" }).click();
        await signedIn;
        await guest.waitForTimeout(HELD_MS);
        // autentificarea s-a terminat, dar îmbinarea așteaptă blocarea coșului contului: linia oaspetelui nu a ajuns încă acolo
        expect(await countE2eCartLines(email)).toBe(1);
      } finally {
        await held.release();
      }
      // după eliberare îmbinarea se termină: ambele linii sunt în coșul contului și formularul trece la /magazin
      await guest.waitForURL((url) => url.pathname === "/magazin");
      expect(await countE2eCartLines(email)).toBe(2);
    } finally {
      await guestContext.close();
    }
  });
});

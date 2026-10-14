import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  attachMediaToE2eProduct,
  promoteE2eUser,
  removeE2eProducts,
} from "../packages/core/test/e2e-support";
import { solidPng } from "./support/png";

/**
 * Biblioteca media, în browser: încărcare multiplă cu progres, procesare în fundal (workerul din
 * serverul de dev), editare, foldere, ștergere, citire-doar pentru Manager, telefon, mod întunecat,
 * tastatură. Conturile `e2e-*@example.test` se șterg la final; fișierele stau într-un director
 * temporar.
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

async function login(page: Page, account: Account, next = "/admin") {
  await page.goto(`/autentificare?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Parolă", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Intră în cont" }).click();
  await page.waitForURL((url) => url.pathname === new URL(next, "http://x").pathname);
}

/**
 * Încarcă prin API ca browserul, cu aceeași regulă ca UI-ul: la `503 MEDIA_BUSY` (limita globală de
 * 2 decodări, atinsă când testele rulează în paralel) așteaptă `Retry-After` și reîncearcă.
 */
async function uploadViaApi(
  request: APIRequestContext,
  origin: string,
  name: string,
  body: Buffer,
): Promise<number> {
  let status = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await request.post(`${origin}/api/media`, {
      headers: { origin, "x-file-name": name },
      data: body,
    });
    status = response.status();
    if (status !== 503) return status;
    const wait = Number(response.headers()["retry-after"] ?? "2");
    await new Promise((r) => setTimeout(r, Math.min(wait, 5) * 1000));
  }
  return status;
}

const png = (name: string, color: [number, number, number]) => ({
  name,
  mimeType: "image/png",
  buffer: solidPng(640, 360, color),
});

// Pe rând în fișier: testele încarcă imagini, iar limita globală e de 2 decodări simultane.
// Cu cache-ul `next dev` rece, testul „Owner” durează 1,2–1,3 min singur (compilarea rutelor noi + 3 imagini
// procesate); limita implicită de 90 s lăsa prea puțină marjă și pica sporadic în suita completă.
test.describe.configure({ mode: "serial", timeout: 180_000 });

test.describe("biblioteca media", () => {
  test("Owner: încarcă 3 imagini, se procesează singure, editează, folder, caută, șterge", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/media");
    await expect(page.getByRole("heading", { level: 1, name: "Biblioteca media" })).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Navigare principală" })
        .getByRole("link", { name: "Media" }),
    ).toBeVisible();

    // 1. Încărcare multiplă, cu progres și rezumat.
    const tag = randomBytes(3).toString("hex");
    await page
      .locator('input[type="file"]')
      .setInputFiles([
        png(`pompa-${tag}.png`, [200, 60, 60]),
        png(`liner-${tag}.png`, [60, 120, 200]),
        png(`filtru-${tag}.png`, [60, 180, 90]),
      ]);
    await expect(page.getByText("3 din 3 încărcate")).toBeVisible({ timeout: 60_000 });

    // 2. Cardurile apar (după refresh) și trec singure la „Gata”, cu thumb, nu cu originalul.
    // Testele rulează în paralel pe aceeași bibliotecă: ne uităm doar la fișierele acestui test.
    await page.goto(`/admin/media?q=${tag}`);
    const cards = page.locator("[data-media-card]");
    await expect(cards).toHaveCount(3, { timeout: 30_000 });
    await expect(cards.getByText("Gata", { exact: true })).toHaveCount(3, { timeout: 90_000 });
    const sources = await page
      .locator("[data-media-card] img")
      .evaluateAll((els) => els.map((el) => (el as HTMLImageElement).src));
    expect(sources).toHaveLength(3);
    for (const src of sources) {
      expect(src).toMatch(/\/media\/media\/[0-9a-f-]{36}\/thumb\.[0-9a-f]{8}\.(webp|jpg|avif)$/);
      expect(src).not.toContain("original");
    }
    const thumbStatus = await request.get(sources[0] as string);
    expect(thumbStatus.status()).toBe(200);
    expect(thumbStatus.headers()["x-content-type-options"]).toBe("nosniff");

    // 3. Editare: alt-text și taguri.
    await page.getByRole("button", { name: `Deschide pompa-${tag}.png` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Recomandat: descrie")).toBeVisible();
    await dialog.getByLabel("Text alternativ").fill(`Pompă de căldură aer-apă ${tag}`);
    await dialog.getByLabel("Taguri").fill(`piscină, promo-${tag}`);
    await dialog.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(dialog.getByText("Salvat.")).toBeVisible();
    await dialog.getByRole("button", { name: "Închide" }).first().click();

    // 4. Căutare după tag (formular GET: merge și ca link) și după alt.
    await page.goto(`/admin/media?q=promo-${tag}`);
    await expect(page.locator("[data-media-card]")).toHaveCount(1);
    await page.goto(`/admin/media?q=${encodeURIComponent(`aer-apă ${tag}`)}`);
    await expect(page.locator("[data-media-card]")).toHaveCount(1);

    // 5. Folder nou și mutarea fișierului în el.
    await page.goto("/admin/media");
    await page.getByRole("button", { name: "Folder nou" }).click();
    const folderName = `Produse ${tag}`;
    await page.getByLabel("Nume folder").fill(folderName);
    await page.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(page.getByRole("link", { name: new RegExp(folderName) })).toBeVisible();

    // Biblioteca e partajată cu testele paralele (alte încărcări împing fișierul pe pagina 2): îl găsim
    // după etichetă, nu după poziția pe prima pagină.
    await page.goto(`/admin/media?q=${tag}`);
    await page.getByRole("button", { name: `Deschide liner-${tag}.png` }).click();
    await page.getByRole("dialog").getByLabel("Folder").selectOption({ label: folderName });
    await page.getByRole("dialog").getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(page.getByRole("dialog").getByText("Salvat.")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("link", { name: new RegExp(folderName) }).click();
    await expect(page.locator("[data-media-card]")).toHaveCount(1);

    // 6. Ștergere cu confirmare explicită.
    await page.getByRole("button", { name: `Deschide liner-${tag}.png` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Șterge…" }).click();
    await expect(page.getByRole("dialog", { name: "Ștergi acest fișier?" })).toBeVisible();
    await page.getByRole("button", { name: "Șterge definitiv" }).click();
    await expect(page.getByRole("button", { name: `Deschide liner-${tag}.png` })).toHaveCount(0);
  });

  test("fișier folosit de un produs: ștergerea e refuzată cu lista produselor; după scoatere se șterge", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/media");
    const tag = randomBytes(3).toString("hex");
    const fileName = `folosit-${tag}.png`;
    await page.locator('input[type="file"]').setInputFiles([png(fileName, [120, 60, 200])]);
    await expect(page.getByText("1 din 1 încărcate")).toBeVisible({ timeout: 60_000 });

    const productTitle = `Pompă de test ${tag}`;
    await attachMediaToE2eProduct(fileName, productTitle, tag);
    try {
      await page.goto(`/admin/media?q=${tag}`);
      await page.getByRole("button", { name: `Deschide ${fileName}` }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Șterge…" }).click();
      await page.getByRole("button", { name: "Șterge definitiv" }).click();

      // Refuz explicit, cu produsul care îl folosește (și link spre el), nu o eroare generică.
      const refusal = page.getByRole("dialog", { name: "Fișierul este folosit" });
      await expect(refusal).toBeVisible();
      await expect(refusal.getByText("Nu poate fi șters cât timp e folosit")).toBeVisible();
      const link = refusal.getByRole("link", { name: `Produs: ${productTitle}` });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("href", /^\/admin\/produse\/.+/);
      await expect(refusal.getByRole("button", { name: "Șterge definitiv" })).toHaveCount(0);
      await refusal.getByRole("button", { name: "Anulează" }).click();

      // Fișierul e încă în bibliotecă.
      await page.goto(`/admin/media?q=${tag}`);
      await expect(page.locator("[data-media-card]")).toHaveCount(1);
    } finally {
      await removeE2eProducts();
    }

    // Produsul nu mai există: ștergerea reușește.
    await page.goto(`/admin/media?q=${tag}`);
    await page.getByRole("button", { name: `Deschide ${fileName}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Șterge…" }).click();
    await page.getByRole("button", { name: "Șterge definitiv" }).click();
    await expect(page.locator("[data-media-card]")).toHaveCount(0, { timeout: 15_000 });
  });

  test("Manager (doar media.read): vede biblioteca, fără butoane de scriere; serverul refuză oricum", async ({
    page,
    request,
    baseURL,
    browser,
  }) => {
    const origin = baseURL as string;
    // Owner încarcă un fișier prin API (cu sesiunea lui), ca să existe ceva de văzut.
    const owner = await createAccount(request, origin, "owner");
    const ownerContext = await browser.newContext({ baseURL: origin });
    const ownerPage = await ownerContext.newPage();
    await login(ownerPage, owner, "/admin/media");
    expect(
      await uploadViaApi(
        ownerPage.request,
        origin,
        "doar-citire.png",
        solidPng(320, 180, [10, 10, 10]),
      ),
    ).toBe(201);
    await ownerContext.close();

    const manager = await createAccount(request, origin, "manager");
    await login(page, manager, "/admin/media");
    await expect(page.getByRole("heading", { level: 1, name: "Biblioteca media" })).toBeVisible();
    await expect(page.getByText("Ai acces doar de citire")).toBeVisible();
    await expect(page.locator("[data-media-card]").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Folder nou" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Alege fișiere" })).toHaveCount(0);

    await page.locator("[data-media-card]").first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "Salvează", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Șterge…" })).toHaveCount(0);
    await expect(dialog.getByLabel("Text alternativ")).toHaveAttribute("readonly", "");
    await page.keyboard.press("Escape");

    // Chiar și cu un apel direct, serverul refuză încărcarea.
    const direct = await page.request.post(`${origin}/api/media`, {
      headers: { origin, "x-file-name": "x.png" },
      data: solidPng(32, 32, [1, 2, 3]),
    });
    expect(direct.status()).toBe(403);
  });

  test("tastatură: săgețile mută focusul între carduri, Enter deschide, Escape închide", async ({
    page,
    request,
    baseURL,
  }) => {
    const origin = baseURL as string;
    const owner = await createAccount(request, origin, "owner");
    await login(page, owner, "/admin/media");
    for (const name of ["tastatura-1.png", "tastatura-2.png"]) {
      expect(
        await uploadViaApi(page.request, origin, name, solidPng(320, 180, [90, 90, 200])),
      ).toBe(201);
    }
    await page.reload();
    const cards = page.locator("[data-media-card]");
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThanOrEqual(2);

    await cards.first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(cards.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(cards.first()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(cards.first()).toBeFocused(); // focusul revine pe card
  });

  test("telefon (375 px): fără scroll orizontal; mod întunecat: altă culoare de fundal", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/media");

    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();
    const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload();
    const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(dark).not.toBe(light);

    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Biblioteca media" })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.getByRole("button", { name: "Alege fișiere" })).toBeVisible();
  });
});

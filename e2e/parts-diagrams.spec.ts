import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  hardDeleteE2eProduct,
  promoteE2eUser,
  readE2eDiagram,
  readE2eMediaByName,
  removeE2eDiagrams,
  removeE2eProducts,
  seedE2eProducts,
  setE2eFeatureFlag,
  trackE2eDiagram,
} from "../packages/core/test/e2e-support";
import { solidPng } from "./support/png";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Fișa explodată, în browser (blocul 11d): flag-ul `partsDiagrams` (meniu, rută 404, tab), creare cu
 * imagine din bibliotecă, hotspot-uri (numeric, click, săgeți), asociere la produs, ștergerea imaginii
 * folosite (refuzată cu fișa ca loc de folosire), produs șters definitiv, ștergerea fișei cu confirmare.
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

/** Încarcă o imagine în bibliotecă (prin API, ca browserul) și așteaptă să fie „gata”. */
async function uploadReadyImage(page: Page, baseURL: string, name: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await page.request.post(`${baseURL}/api/media`, {
      headers: { origin: baseURL, "x-file-name": name },
      data: solidPng(640, 480, [40, 120, 200]),
    });
    if (response.status() === 201) break;
    expect(response.status()).toBe(503); // MEDIA_BUSY: se reîncearcă
    await new Promise((r) => setTimeout(r, 2000));
  }
  await expect
    .poll(async () => (await readE2eMediaByName(name))?.status, { timeout: 60_000 })
    .toBe("ready");
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const row = (page: Page, n: number) => page.locator(`[data-hotspot-row="${n}"]`);

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.afterEach(async () => {
  await removeE2eDiagrams();
  await removeE2eProducts();
  await setE2eFeatureFlag("partsDiagrams", false);
});

test.describe("fișa explodată", () => {
  test("flag oprit: fără meniu, rută 404, fără tab pe produs; pornit: apar toate", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const [title] = (await seedE2eProducts(tag, 1)) as [string];
    await setE2eFeatureFlag("partsDiagrams", false);
    await login(page, owner, "/admin/produse");

    // flag oprit
    await expect(page.getByRole("link", { name: "Fișe explodate" })).toHaveCount(0);
    const off = await page.goto("/admin/fise-explodate");
    expect(off?.status()).toBe(404);
    await page.goto(`/admin/produse?q=${encodeURIComponent(`E2E ${tag}`)}`);
    await page.getByRole("link", { name: `Deschide produsul ${title}` }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(title);
    await expect(tab(page, "Piese de schimb")).toHaveCount(0);

    // flag pornit
    await setE2eFeatureFlag("partsDiagrams", true);
    await page.goto("/admin/produse");
    await expect(page.getByRole("link", { name: "Fișe explodate" })).toBeVisible();
    const on = await page.goto("/admin/fise-explodate");
    expect(on?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Fișe explodate");
  });

  test("creare cu imagine din bibliotecă, 3 hotspot-uri (numeric, click, săgeți), legate la 2 produse, asociere, imagine protejată, ștergere", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const [pumpTitle, partATitle, partBTitle] = (await seedE2eProducts(tag, 3)) as [
      string,
      string,
      string,
    ];
    const diagramTitle = `E2E Fișă ${tag}`;
    const imageName = `fisa-${tag}.png`;
    trackE2eDiagram(diagramTitle);
    await setE2eFeatureFlag("partsDiagrams", true);
    await login(page, owner, "/admin/media");
    await uploadReadyImage(page, baseURL as string, imageName);

    // creare
    await page.goto("/admin/fise-explodate");
    await page.getByRole("button", { name: "Fișă nouă" }).click();
    const dialog = page.getByRole("dialog", { name: "Fișă explodată nouă" });
    await dialog.getByRole("button", { name: "Creează fișa" }).click();
    await expect(dialog.locator("[data-problem]").first()).toBeVisible(); // titlu și imagine lipsă
    await dialog.getByLabel("Titlu", { exact: true }).fill(diagramTitle);
    await dialog.getByRole("button", { name: "Alege imaginea" }).click();
    const picker = page.getByRole("dialog", { name: "Alege imaginea fișei" });
    await picker.getByLabel("Caută după nume, text alternativ sau tag").fill(tag);
    await picker.getByRole("button", { name: "Caută" }).click();
    await picker.getByRole("button", { name: new RegExp(`^(Alege )?fisa-${tag}`) }).click();
    await picker.getByRole("button", { name: "Alege 1 imagine" }).click();
    await dialog.getByRole("button", { name: "Creează fișa" }).click();
    await page.waitForURL(/\/admin\/fise-explodate\/[A-Za-z0-9_-]+$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(diagramTitle);
    await expect(page.locator("[data-diagram-canvas] img")).toBeVisible();

    // hotspot 1: produs A, poziție prin câmpuri numerice (fără mouse)
    await page.getByRole("button", { name: "Adaugă hotspot" }).click();
    const r1 = row(page, 1);
    await r1.getByLabel("Caută produsul (titlu sau SKU)").fill(`E2E-${tag.toUpperCase()}-02`);
    await r1.getByRole("button", { name: "Caută", exact: true }).click();
    await r1.getByRole("button", { name: `Alege produsul ${partATitle}` }).click();
    await r1.getByLabel("Poziția orizontală a hotspot-ului 1 (%)").fill("25,5");
    await r1.getByLabel("Poziția verticală a hotspot-ului 1 (%)").fill("40");
    await r1.getByRole("button", { name: "Salvează hotspot-ul 1" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Hotspot-ul 1 a fost salvat" }),
    ).toBeVisible();

    // hotspot 2: produs B, poziție prin click pe imagine (hotspot ales)
    await page.getByRole("button", { name: "Adaugă hotspot" }).click();
    const r2 = row(page, 2);
    await r2.getByLabel("Caută produsul (titlu sau SKU)").fill(`E2E-${tag.toUpperCase()}-03`);
    await r2.getByRole("button", { name: "Caută", exact: true }).click();
    await r2.getByRole("button", { name: `Alege produsul ${partBTitle}` }).click();
    await r2.getByRole("button", { name: "Alege hotspot-ul 2" }).click();
    const canvas = page.locator("[data-diagram-canvas]");
    await canvas.scrollIntoViewIfNeeded();
    const box = (await canvas.boundingBox()) as { width: number; height: number };
    // click în mijlocul imaginii (locator.click derulează la imagine și folosește coordonate relative)
    await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
    // mijlocul imaginii, rotunjit la pixel: aproximativ 50% (49,xx sau 50,xx)
    await expect(r2.getByLabel("Poziția orizontală a hotspot-ului 2 (%)")).toHaveValue(
      /^(49|50)(,\d{1,2})?$/,
    );
    await r2.getByRole("button", { name: "Salvează hotspot-ul 2" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Hotspot-ul 2 a fost salvat" }),
    ).toBeVisible();

    // hotspot 3: doar etichetă, fără poziție
    await page.getByRole("button", { name: "Adaugă hotspot" }).click();
    const r3 = row(page, 3);
    await r3.getByRole("button", { name: "Salvează hotspot-ul 3" }).click();
    await expect(r3.locator("[data-problem]")).toContainText("produs sau scrie o etichetă");
    await r3.getByLabel("Eticheta hotspot-ului 3").fill("Șurub M6");
    await r3.getByRole("button", { name: "Salvează hotspot-ul 3" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Hotspot-ul 3 a fost salvat" }),
    ).toBeVisible();

    // număr duplicat: refuzat cu mesaj
    // (rândul își schimbă eticheta după numărul tastat: acum e al doilea rând „1”)
    await r3.getByLabel("Numărul hotspot-ului 3").fill("1");
    const dup = page.locator('[data-hotspot-row="1"]').last();
    await dup.getByRole("button", { name: "Salvează hotspot-ul 1" }).click();
    await expect(dup.locator("[data-problem]")).toContainText("deja folosit");
    await dup.getByLabel("Numărul hotspot-ului 1").fill("3");

    // săgeți pe marcaj: hotspot 1 → +1% pe orizontală, apoi Shift+Jos = +0,1% pe verticală, Enter salvează
    const marker = page.locator('[data-marker="1"]');
    await marker.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(r1.getByLabel("Poziția orizontală a hotspot-ului 1 (%)")).toHaveValue("26,5");
    await expect(r1.getByLabel("Poziția verticală a hotspot-ului 1 (%)")).toHaveValue("40,1");
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await readE2eDiagram(diagramTitle))?.hotspots.find((h) => h.number === 1))
      .toMatchObject({ xBp: 2650, yBp: 4010, productSlug: `e2e-${tag}-02` });

    // în bază: 3 hotspot-uri, 2 produse diferite, unul doar cu etichetă și fără poziție
    const saved = await readE2eDiagram(diagramTitle);
    expect(saved?.hotspots.map((h) => [h.number, h.productSlug, h.label])).toEqual([
      [1, `e2e-${tag}-02`, null],
      [2, `e2e-${tag}-03`, null],
      [3, null, "Șurub M6"],
    ]);
    expect(saved?.hotspots[2]).toMatchObject({ xBp: null, yBp: null });
    expect(saved?.hotspots[1]?.xBp).toBeGreaterThan(4900);
    expect(saved?.hotspots[1]?.xBp).toBeLessThan(5100);

    // asocierea la produsul 1 din tabul „Piese de schimb”
    await page.goto(`/admin/produse?q=${encodeURIComponent(`E2E ${tag}`)}`);
    await page.getByRole("link", { name: `Deschide produsul ${pumpTitle}` }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(pumpTitle);
    await tab(page, "Piese de schimb").click();
    await page.getByLabel("Fișa de asociat").selectOption({ label: diagramTitle });
    await page.getByRole("button", { name: "Asociază", exact: true }).click();
    await expect(page.locator(`[data-spare-diagram="${diagramTitle}"]`)).toBeVisible();
    await expect
      .poll(async () => (await readE2eDiagram(diagramTitle))?.productSlugs)
      .toEqual([`e2e-${tag}-01`]);
    await page.getByRole("link", { name: `Deschide fișa ${diagramTitle}` }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(diagramTitle);
    await expect(page.locator(`[data-diagram-product="${pumpTitle}"]`)).toBeVisible();

    // imaginea folosită nu se poate șterge: refuz cu fișa ca loc de folosire, cu link
    await page.goto(`/admin/media?q=${tag}`);
    await page.getByRole("button", { name: `Deschide ${imageName}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Șterge…" }).click();
    await page.getByRole("button", { name: "Șterge definitiv" }).click();
    const refusal = page.getByRole("dialog", { name: "Fișierul este folosit" });
    await expect(refusal).toBeVisible();
    const link = refusal.getByRole("link", { name: `Fișă explodată: ${diagramTitle}` });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", /^\/admin\/fise-explodate\/.+/);
    await expect(refusal.getByRole("button", { name: "Șterge definitiv" })).toHaveCount(0);
    await refusal.getByRole("button", { name: "Anulează" }).click();

    // produs legat șters DEFINITIV: hotspot-ul rămâne, fără produs, vizibil ca atare
    await hardDeleteE2eProduct(`e2e-${tag}-02`);
    await page.goto(`/admin/fise-explodate/${saved?.id}`);
    await expect(row(page, 1)).toContainText("fără produs");
    expect((await readE2eDiagram(diagramTitle))?.hotspots).toHaveLength(3);

    // ștergerea fișei: confirmare cu numărul de hotspot-uri; numărul real apare în dialog
    await page.getByRole("button", { name: "Șterge fișa" }).click();
    const confirm = page.getByRole("dialog", { name: `Ștergi fișa «${diagramTitle}»?` });
    await expect(confirm).toContainText("3 hotspot-uri");
    await confirm.getByRole("button", { name: "Anulează" }).click();
    expect(await readE2eDiagram(diagramTitle)).not.toBeNull();
    await page.getByRole("button", { name: "Șterge fișa" }).click();
    await page
      .getByRole("dialog", { name: `Ștergi fișa «${diagramTitle}»?` })
      .getByRole("button", { name: "Șterge fișa definitiv" })
      .click();
    await page.waitForURL(/\/admin\/fise-explodate$/);
    expect(await readE2eDiagram(diagramTitle)).toBeNull();

    // imaginea nu mai e folosită: se șterge
    await page.goto(`/admin/media?q=${tag}`);
    await page.getByRole("button", { name: `Deschide ${imageName}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Șterge…" }).click();
    await page.getByRole("button", { name: "Șterge definitiv" }).click();
    await expect(page.locator("[data-media-card]")).toHaveCount(0, { timeout: 15_000 });
  });

  test("Editorul vede fișele doar pentru citire; Suportul e interzis", async ({
    page,
    request,
    baseURL,
    browser,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const editor = await createAccount(request, baseURL as string, "editor");
    const support = await createAccount(request, baseURL as string, "support");
    const tag = randomBytes(3).toString("hex");
    const diagramTitle = `E2E Fișă ${tag}`;
    const imageName = `fisa-${tag}.png`;
    trackE2eDiagram(diagramTitle);
    await setE2eFeatureFlag("partsDiagrams", true);
    await login(page, owner, "/admin/media");
    await uploadReadyImage(page, baseURL as string, imageName);
    await page.goto("/admin/fise-explodate");
    await page.getByRole("button", { name: "Fișă nouă" }).click();
    const dialog = page.getByRole("dialog", { name: "Fișă explodată nouă" });
    await dialog.getByLabel("Titlu", { exact: true }).fill(diagramTitle);
    await dialog.getByRole("button", { name: "Alege imaginea" }).click();
    const picker = page.getByRole("dialog", { name: "Alege imaginea fișei" });
    await picker.getByLabel("Caută după nume, text alternativ sau tag").fill(tag);
    await picker.getByRole("button", { name: "Caută" }).click();
    await picker.getByRole("button", { name: new RegExp(`^(Alege )?fisa-${tag}`) }).click();
    await picker.getByRole("button", { name: "Alege 1 imagine" }).click();
    await dialog.getByRole("button", { name: "Creează fișa" }).click();
    await page.waitForURL(/\/admin\/fise-explodate\/[A-Za-z0-9_-]+$/);
    const diagramUrl = page.url();

    const context = await browser.newContext({ baseURL: baseURL as string });
    const ePage = await context.newPage();
    await login(ePage, editor, "/admin/fise-explodate");
    await expect(ePage.getByRole("button", { name: "Fișă nouă" })).toHaveCount(0);
    await expect(ePage.getByText("Poți vedea fișele, dar nu le poți modifica")).toBeVisible();
    await ePage.goto(diagramUrl);
    await expect(ePage.getByRole("button", { name: "Adaugă hotspot" })).toHaveCount(0);
    await expect(ePage.getByRole("button", { name: "Șterge fișa" })).toHaveCount(0);
    await expect(ePage.getByLabel("Titlu", { exact: true })).toBeDisabled();

    const sPage = await context.newPage();
    await context.clearCookies();
    await login(sPage, support, "/admin");
    await sPage.goto("/admin/fise-explodate");
    await expect(sPage).toHaveURL(/\/admin\/acces-interzis/);
    await context.close();
  });
});

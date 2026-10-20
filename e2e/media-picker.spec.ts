import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { insertE2eMedia, promoteE2eUser } from "../packages/core/test/e2e-support";
import { solidPng } from "./support/png";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Selectorul `MediaPicker`, în browser, printr-un harness care există doar în teste (pagina
 * `*.e2e.tsx`, activată de `E2E_HARNESS=1` din configul Playwright; nu se livrează).
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

async function uploadViaApi(
  request: APIRequestContext,
  origin: string,
  name: string,
  color: [number, number, number],
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await request.post(`${origin}/api/media`, {
      headers: { origin, "x-file-name": name },
      data: solidPng(320, 180, color),
    });
    if (response.status() === 201) return;
    // 503 = MEDIA_BUSY (limita globală de decodări): se reîncearcă; orice altceva e o eroare reală.
    expect({ status: response.status(), body: await response.text() }).toMatchObject({
      status: 503,
    });
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("încărcarea nu a reușit");
}

const HARNESS = "/admin/e2e-harness/media-picker";

/** Pregătește: Owner, 4 fișiere gata + unul pending + unul failed (inserate direct), toate cu `tag`. */
async function seed(request: APIRequestContext, origin: string, page: Page) {
  const owner = await createAccount(request, origin, "owner");
  const tag = randomBytes(3).toString("hex");
  const names = ["alfa", "beta", "gama", "delta"].map((n) => `${n}-${tag}.png`);
  await login(page, owner, "/admin/media");
  const colors: [number, number, number][] = [
    [200, 50, 50],
    [50, 200, 50],
    [50, 50, 200],
    [200, 200, 50],
  ];
  for (const [i, name] of names.entries()) {
    await uploadViaApi(page.request, origin, name, colors[i] as [number, number, number]);
  }
  await insertE2eMedia(owner.email, { name: `pending-${tag}.png`, status: "pending" });
  await insertE2eMedia(owner.email, { name: `esuat-${tag}.png`, status: "failed" });

  // Așteaptă ca toate cele 4 să fie „Gata” (pagina bibliotecii își actualizează singură starea).
  await page.goto(`/admin/media?q=${tag}`);
  await expect(page.locator("[data-media-card]")).toHaveCount(6, { timeout: 30_000 });
  await expect(page.locator("[data-media-card]").getByText("Gata", { exact: true })).toHaveCount(
    4,
    { timeout: 90_000 },
  );
  return { owner, tag, names };
}

async function openPicker(page: Page, mode: "single" | "multiple", tag: string) {
  await page.goto(HARNESS);
  await page
    .getByRole("button", {
      name: mode === "single" ? "Deschide selector (unic)" : "Deschide selector (multiplu, max 3)",
    })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // Doar fișierele acestui test (aceeași bibliotecă e folosită în paralel de alte teste).
  await dialog.getByLabel("Caută după nume, text alternativ sau tag").fill(tag);
  await dialog.getByRole("button", { name: "Caută" }).click();
  return dialog;
}

const card = (dialog: Locator, name: string) =>
  dialog.getByRole("button", { name: new RegExp(`^(Alege )?${name}`) });

// Pregătirea (încărcarea și procesarea a 4 imagini, cu limita globală de 2 decodări) durează mai mult
// când testele rulează în paralel.
// Pe rând în fișier: testele încarcă imagini, iar limita globală e de 2 decodări simultane (în producție
// o încărcare peste limită primește 503 și se reîncearcă; aici ar face doar zgomot în paralel).
test.describe.configure({ timeout: 180_000, mode: "serial" });

test.describe("MediaPicker (harness E2E)", () => {
  test("arată doar fișiere gata, cu thumb; selecția unică înlocuiește; returnează doar id-uri", async ({
    page,
    request,
    baseURL,
  }) => {
    const origin = baseURL as string;
    const { tag, names } = await seed(request, origin, page);
    const dialog = await openPicker(page, "single", tag);

    // doar cele 4 gata; pending și failed nu apar
    await expect(dialog.locator("[data-media-card]")).toHaveCount(4);
    await expect(dialog.getByText(`pending-${tag}.png`)).toHaveCount(0);
    await expect(dialog.getByText(`esuat-${tag}.png`)).toHaveCount(0);
    // numai variante thumb, niciodată originalul
    const sources = await dialog
      .locator("[data-media-card] img")
      .evaluateAll((els) => els.map((el) => (el as HTMLImageElement).src));
    expect(sources.length).toBe(4);
    for (const src of sources) {
      expect(src).toMatch(/\/media\/media\/[0-9a-f-]{36}\/thumb\.[0-9a-f]{8}\.(webp|jpg|avif)$/);
    }

    await card(dialog, names[0] as string).click();
    await expect(dialog.getByTestId("picker-count")).toHaveText("1 din 1 ales");
    await card(dialog, names[2] as string).click(); // înlocuiește
    await expect(dialog.getByTestId("picker-count")).toHaveText("1 din 1 ales");
    await expect(dialog.locator('[data-media-card][aria-pressed="true"]')).toHaveCount(1);
    await expect(dialog.locator('[data-media-card][aria-pressed="true"]')).toContainText(
      names[2] as string,
    );

    await dialog.getByRole("button", { name: "Alege 1 imagine" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const raw = (await page.getByTestId("result").textContent()) ?? "";
    const result = JSON.parse(raw) as string[];
    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/^[a-z0-9]{20,40}$/); // doar un id, nu o cheie sau o adresă
    for (const leak of ["public/", "original", "storage", "http"]) expect(raw).not.toContain(leak);
  });

  test("selecție multiplă: ordinea alegerii se păstrează, maximul 3 e respectat, deselectarea merge", async ({
    page,
    request,
    baseURL,
  }) => {
    const { tag, names } = await seed(request, baseURL as string, page);
    const dialog = await openPicker(page, "multiple", tag);
    const [alfa, beta, gama, delta] = names as [string, string, string, string];

    // se aleg în ordinea: gama, alfa, beta (nu cea din galerie)
    await card(dialog, gama).click();
    await card(dialog, alfa).click();
    await card(dialog, beta).click();
    await expect(dialog.getByTestId("picker-count")).toHaveText("3 din 3 alese");
    const tray = dialog.getByRole("region", { name: "Imaginile alese, în ordine" });
    const items = tray.locator("li");
    await expect(items.nth(0)).toContainText(gama);
    await expect(items.nth(1)).toContainText(alfa);
    await expect(items.nth(2)).toContainText(beta);

    // a patra e respinsă, cu mesaj
    // la maxim cardul e `aria-disabled` (rămâne focusabil și anunță); click-ul declanșează mesajul
    await card(dialog, delta).click({ force: true });
    await expect(dialog.getByRole("alert")).toContainText("Ai atins maximul de 3 imagini");
    await expect(dialog.getByTestId("picker-count")).toHaveText("3 din 3 alese");

    // scot prima (gama), apoi pot alege delta, la sfârșit
    await tray.getByRole("button", { name: `Scoate din selecție: ${gama}` }).click();
    await card(dialog, delta).click();
    await expect(items.nth(0)).toContainText(alfa);
    await expect(items.nth(1)).toContainText(beta);
    await expect(items.nth(2)).toContainText(delta);

    // selecția persistă la căutare: schimbăm căutarea, apoi confirmăm
    await dialog.getByLabel("Caută după nume, text alternativ sau tag").fill(`gama-${tag}`);
    await dialog.getByRole("button", { name: "Caută" }).click();
    await expect(dialog.locator("[data-media-card]")).toHaveCount(1);
    await expect(dialog.getByTestId("picker-count")).toHaveText("3 din 3 alese");

    await dialog.getByRole("button", { name: "Alege 3 imagini" }).click();
    const ids = JSON.parse((await page.getByTestId("result").textContent()) ?? "[]") as string[];
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  test("tastatură: săgeți, Enter/Space aleg, Tab rămâne în dialog, Escape anulează și întoarce focusul", async ({
    page,
    request,
    baseURL,
  }) => {
    const { tag } = await seed(request, baseURL as string, page);
    const dialog = await openPicker(page, "multiple", tag);
    const cards = dialog.locator("[data-media-card]");
    await expect(cards).toHaveCount(4);

    await cards.first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(cards.nth(1)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(cards.nth(1)).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Space");
    await expect(cards.nth(1)).toHaveAttribute("aria-pressed", "false");

    // focusul nu iese din dialog nici după multe Tab-uri
    for (let i = 0; i < 25; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(
      true,
    );

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("cancelled")).toHaveText("anulări: 1");
    await expect(page.getByTestId("result")).toHaveText("niciun rezultat");
    await expect(
      page.getByRole("button", { name: "Deschide selector (multiplu, max 3)" }),
    ).toBeFocused();
  });

  test("selecție inițială: id-urile primite apar alese, în ordine", async ({
    page,
    request,
    baseURL,
  }) => {
    const { tag } = await seed(request, baseURL as string, page);
    const dialog = await openPicker(page, "multiple", tag);
    await expect(dialog.locator("[data-media-card]")).toHaveCount(4);
    const ids = await dialog
      .locator("[data-media-card]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-media-id") as string));
    await page.keyboard.press("Escape");

    await page
      .getByLabel("Id-uri alese inițial (separate prin virgulă)")
      .fill(`${ids[2]},${ids[0]}`);
    await page.getByRole("button", { name: "Deschide selector (multiplu, max 3)" }).click();
    const reopened = page.getByRole("dialog");
    await expect(reopened.getByTestId("picker-count")).toHaveText("2 din 3 alese");
    await reopened.getByRole("button", { name: "Alege 2 imagini" }).click();
    expect(JSON.parse((await page.getByTestId("result").textContent()) ?? "[]")).toEqual([
      ids[2],
      ids[0],
    ]);
  });

  test("Owner încarcă din selector și fișierul apare când e gata; Manager alege, dar nu are încărcare", async ({
    page,
    request,
    baseURL,
    browser,
  }) => {
    const origin = baseURL as string;
    const { tag } = await seed(request, origin, page);

    const dialog = await openPicker(page, "multiple", tag);
    await expect(dialog.locator("[data-media-card]")).toHaveCount(4);
    await dialog.getByText("Încarcă imagini noi").click();
    await dialog.locator('input[type="file"]').setInputFiles({
      name: `nou-${tag}.png`,
      mimeType: "image/png",
      buffer: solidPng(400, 300, [10, 150, 150]),
    });
    await expect(dialog.getByText("1 din 1 încărcate")).toBeVisible({ timeout: 60_000 });
    await expect(dialog.locator("[data-media-card]")).toHaveCount(5, { timeout: 90_000 });

    // Manager: același selector, fără zona de încărcare.
    const manager = await createAccount(request, origin, "manager");
    const context = await browser.newContext({ baseURL: origin });
    const managerPage = await context.newPage();
    await login(managerPage, manager, HARNESS);
    await managerPage.getByRole("button", { name: "Deschide selector (multiplu, max 3)" }).click();
    const managerDialog = managerPage.getByRole("dialog");
    await expect(managerDialog.locator("[data-media-card]").first()).toBeVisible();
    await expect(managerDialog.getByText("Încarcă imagini noi")).toHaveCount(0);
    await managerDialog.locator("[data-media-card]").first().click();
    await managerDialog.getByRole("button", { name: "Alege 1 imagine" }).click();
    expect(
      JSON.parse((await managerPage.getByTestId("result").textContent()) ?? "[]"),
    ).toHaveLength(1);
    await context.close();
  });

  test("telefon (375 px): dialogul încape fără scroll orizontal; mod întunecat funcțional", async ({
    page,
    request,
    baseURL,
  }) => {
    const { tag } = await seed(request, baseURL as string, page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: "dark" });
    const dialog = await openPicker(page, "multiple", tag);
    await expect(dialog.locator("[data-media-card]").first()).toBeVisible();
    // elementele care ies în afara dialogului (pentru un mesaj de eroare util)
    const offenders = await dialog.evaluate((el) => {
      const right = el.getBoundingClientRect().right;
      return [...el.querySelectorAll("*")]
        .filter((n) => n.getBoundingClientRect().right > right + 1)
        .slice(0, 5)
        .map(
          (n) =>
            `${n.tagName.toLowerCase()}.${String(n.className).slice(0, 60)} +${Math.round(n.getBoundingClientRect().right - right)}`,
        );
    });
    expect(offenders).toEqual([]);
    const overflow = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const bg = await dialog.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe("rgb(255, 255, 255)");
    await expect(dialog.getByRole("button", { name: "Anulează" })).toBeVisible();
  });
});

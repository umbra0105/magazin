import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  ageE2eSessions,
  promoteE2eUser,
  setE2eFeatureFlag,
} from "../packages/core/test/e2e-support";

/**
 * Zona de admin, în browser. Conturile se creează prin API-ul real de înregistrare (parole
 * generate la fiecare rulare, niciodată în cod), apoi li se atribuie rolul direct în baza de TEST.
 * Convenția `e2e-<id>@example.test` face ca global teardown să le șteargă.
 */

interface Account {
  email: string;
  password: string;
}

async function createAccount(
  request: APIRequestContext,
  baseURL: string,
  roleKey: string | null,
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
  await page.waitForURL((url) => url.pathname === next);
}

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Navigare principală" });

test.describe("zona de admin", () => {
  test("Owner: panou, meniu cu intrările permise, flag-urile oprite ascund funcțiile", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner);

    await expect(page.getByRole("heading", { level: 1, name: "Panou de control" })).toBeVisible();
    await expect(sidebar(page).getByRole("link", { name: "Comenzi" })).toBeVisible();
    await expect(sidebar(page).getByRole("link", { name: "Utilizatori și roluri" })).toBeVisible();
    // Implicit toate funcțiile opționale sunt oprite și nu apar în meniu.
    for (const hidden of ["Recenzii", "Loialitate", "Vouchere"]) {
      await expect(sidebar(page).getByRole("link", { name: hidden })).toHaveCount(0);
    }
    await expect(sidebar(page).getByRole("link", { name: "Panou" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("un flag pornit arată funcția în meniu, unul oprit o ascunde (și ruta dă 404)", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner);
    try {
      await setE2eFeatureFlag("blog", true);
      await page.reload();
      await expect(sidebar(page).getByRole("link", { name: "Blog" })).toBeVisible();
      await page.goto("/admin/blog");
      await expect(page.getByRole("heading", { level: 1, name: "Blog" })).toBeVisible();

      await setE2eFeatureFlag("blog", false);
      await page.goto("/admin");
      await expect(sidebar(page).getByRole("link", { name: "Blog" })).toHaveCount(0);
      const response = await page.goto("/admin/blog");
      expect(response?.status()).toBe(404);
    } finally {
      await setE2eFeatureFlag("blog", false);
    }
  });

  test("Suport: meniul ascunde ce nu are voie, iar ruta interzisă duce la „Acces interzis”", async ({
    page,
    request,
    baseURL,
  }) => {
    const support = await createAccount(request, baseURL as string, "support");
    await login(page, support);
    await expect(sidebar(page).getByRole("link", { name: "Comenzi" })).toBeVisible();
    for (const hidden of ["Produse", "Setări", "Utilizatori și roluri", "Jurnal de audit"]) {
      await expect(sidebar(page).getByRole("link", { name: hidden })).toHaveCount(0);
    }
    await page.goto("/admin/produse");
    await expect(page).toHaveURL(/\/admin\/acces-interzis$/);
    await expect(
      page.getByText("Nu ai permisiunea necesară pentru această secțiune."),
    ).toBeVisible();
  });

  test("clientul fără roluri nu intră în admin", async ({ page, request, baseURL }) => {
    const customer = await createAccount(request, baseURL as string, null);
    await login(page, customer, "/cont");
    await page.goto("/admin");
    await expect(page.getByRole("heading", { level: 1, name: "Acces interzis" })).toBeVisible();
    await expect(page.getByText("Contul tău nu are acces la zona de administrare.")).toBeVisible();
    await expect(sidebar(page)).toHaveCount(0);
  });

  test("sesiune de admin mai veche decât limita: redirect la autentificare cu „Sesiunea a expirat”", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin");
    expect(await ageE2eSessions(owner.email, 9)).toBeGreaterThan(0); // limita implicită: 8 ore

    await page.goto("/admin");
    await expect(page).toHaveURL(/\/autentificare\?sesiune=expirata&next=%2Fadmin$/);
    await expect(page.locator("main [role=alert]")).toHaveText(
      "Sesiunea a expirat. Autentifică-te din nou.",
    );

    // După o nouă autentificare, ajunge înapoi unde voia.
    await page.getByLabel("Email").fill(owner.email);
    await page.getByLabel("Parolă", { exact: true }).fill(owner.password);
    await page.getByRole("button", { name: "Intră în cont" }).click();
    await page.waitForURL((url) => url.pathname === "/admin");
    await expect(page.getByRole("heading", { level: 1, name: "Panou de control" })).toBeVisible();
  });

  test("paginile /admin au Cache-Control: no-store, X-Robots-Tag și meta noindex", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner);
    const response = await page.goto("/admin");
    expect(response?.headers()["cache-control"]).toContain("no-store");
    expect(response?.headers()["x-robots-tag"]).toContain("noindex");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  });

  test("deconectarea nu merge prin link GET; merge prin buton (POST)", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner);

    // Niciun link către o rută de deconectare în pagină.
    await expect(page.locator('a[href*="sign-out"], a[href*="logout"]')).toHaveCount(0);
    // Un GET către API-ul de deconectare nu închide sesiunea.
    const get = await page.request.get("/api/auth/sign-out");
    expect(get.ok()).toBe(false);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { level: 1, name: "Panou de control" })).toBeVisible();

    await page.getByRole("button", { name: "Meniul utilizatorului" }).click();
    await page.getByRole("button", { name: "Deconectare" }).click();
    await expect(page).toHaveURL(/\/autentificare$/);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/autentificare\?next=%2Fadmin$/);
  });

  test("tastatură: skip-link primul, meniul utilizatorului cu Enter/Escape", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner);
    await page.goto("/admin");
    // Tastele se trimit abia după hidratare (altfel Enter pe buton nu face nimic).
    await page.waitForLoadState("networkidle");

    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Sari la conținut" });
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();

    const trigger = page.getByRole("button", { name: "Meniul utilizatorului" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Deconectare" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Deconectare" })).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("dark mode: alegerea se aplică, se păstrează după reîncărcare și funcționează fără stocare", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner);

    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const light = await bg();

    await page.getByRole("button", { name: "Meniul utilizatorului" }).click();
    await page.getByRole("button", { name: "Întunecat" }).click();
    await expect(page.locator("#admin-theme-dark")).toHaveAttribute("media", "all");
    await expect.poll(bg).not.toBe(light);
    const dark = await bg();

    await page.reload();
    await expect(page.locator("#admin-theme-dark")).toHaveAttribute("media", "all");
    expect(await bg()).toBe(dark);

    await page.getByRole("button", { name: "Meniul utilizatorului" }).click();
    await page.getByRole("button", { name: "Luminos" }).click();
    await expect.poll(bg).toBe(light);
  });

  test("dark mode: după „Întunecat” și reîncărcare nu apare nicio eroare de hidratare în consolă", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner);

    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        problems.push(message.text());
      }
    });
    page.on("pageerror", (error) => problems.push(error.message));

    await page.goto("/admin");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Meniul utilizatorului" }).click();
    await page.getByRole("button", { name: "Întunecat" }).click();
    await expect(page.locator("#admin-theme-dark")).toHaveAttribute("media", "all");

    problems.length = 0; // ne interesează doar încărcarea de după alegere
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#admin-theme-dark")).toHaveAttribute("media", "all");
    await expect(page.getByRole("heading", { level: 1, name: "Panou de control" })).toBeVisible();

    const hydration = problems.filter((text) => /hydrat|didn't match|did not match/i.test(text));
    expect(hydration).toEqual([]);
  });

  test("dark mode cu localStorage blocat: pagina se încarcă, iar alegerea merge pe pagina curentă", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner);
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new Error("SecurityError");
        },
      });
    });
    await page.goto("/admin");
    await expect(page.getByRole("heading", { level: 1, name: "Panou de control" })).toBeVisible();
    await page.getByRole("button", { name: "Meniul utilizatorului" }).click();
    await page.getByRole("button", { name: "Întunecat" }).click();
    await expect(page.locator("#admin-theme-dark")).toHaveAttribute("media", "all");
  });

  test("telefon: sidebar-ul e ascuns și se deschide din buton; Escape îl închide", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/admin");

    await expect(sidebar(page).getByRole("link", { name: "Comenzi" })).toBeHidden();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);

    // Un clic dat înainte de hidratare se pierde: repetăm clicul până apare meniul.
    await expect(async () => {
      await page.getByRole("button", { name: "Deschide meniul" }).click();
      await expect(sidebar(page).getByRole("link", { name: "Comenzi" })).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await expect(sidebar(page).getByRole("link", { name: "Comenzi" })).toBeHidden();
  });
});

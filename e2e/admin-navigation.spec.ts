import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { promoteE2eUser } from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Blocul 8b în browser: o singură intrare «Produse» în meniu, ecranele grupului ca bară de taburi (legături de
 * navigare), taburile după drepturile rolului, adresele vechi → noi (308, cu parametrii), editorul de produs fără bară,
 * firimiturile «Produse › Stoc» și bara pe telefon. Flag-ul `partsDiagrams` e global și îl pornește/oprește
 * `parts-diagrams.spec.ts`: aici «Fișe explodate» se ignoră în listele de taburi (rolul e acoperit acolo și în unitare).
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

/** Autentificare; întoarce după ce s-a ieșit din pagina de autentificare (și pentru conturile fără acces la pagina cerută). */
async function login(page: Page, account: Account, next: string) {
  await page.goto(`/autentificare?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Parolă", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Intră în cont" }).click();
  await page.waitForURL((url) => url.pathname !== "/autentificare");
}

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Navigare principală" });
const tabBar = (page: Page) => page.getByRole("navigation", { name: "Secțiunile produselor" });
const breadcrumb = (page: Page) => page.getByRole("navigation", { name: "Poziția în pagină" });

/** Numele taburilor, fără «Fișe explodate» (flag global, schimbat de alt fișier de teste). */
async function tabNames(bar: Locator): Promise<string[]> {
  const names = await bar.getByRole("link").allInnerTexts();
  return names.map((n) => n.trim()).filter((n) => n !== "Fișe explodate");
}

const CATALOG_TABS = ["Toate produsele", "Categorii", "Branduri", "Atribute", "Unități de măsură"];
const MOVED = ["Categorii", "Branduri", "Atribute", "Unități de măsură", "Fișe explodate", "Stoc"];

test.describe("meniul și bara de taburi, pe roluri", () => {
  for (const [role, label, tabs] of [
    ["owner", "Owner", [...CATALOG_TABS, "Stoc"]],
    ["manager", "Manager", [...CATALOG_TABS, "Stoc"]],
    // cu drepturile actuale Depozitul are products.read și inventory.read: vede aceleași ecrane ca Managerul
    ["warehouse", "Depozit", [...CATALOG_TABS, "Stoc"]],
    ["editor", "Editor", CATALOG_TABS],
  ] as const) {
    test(`${label}: o singură intrare «Produse» în meniu, iar bara are exact taburile permise`, async ({
      page,
      request,
      baseURL,
    }) => {
      const account = await createAccount(request, baseURL as string, role);
      await login(page, account, "/admin/produse");

      // meniul: «Produse» o dată, fără ecranele mutate; «Media» rămâne separat
      await expect(sidebar(page).getByRole("link", { name: "Produse", exact: true })).toHaveCount(
        1,
      );
      for (const moved of MOVED) {
        await expect(sidebar(page).getByRole("link", { name: moved, exact: true })).toHaveCount(0);
      }
      await expect(sidebar(page).getByRole("link", { name: "Media", exact: true })).toBeVisible();
      await expect(
        sidebar(page).getByRole("link", { name: "Produse", exact: true }),
      ).toHaveAttribute("aria-current", "page");

      // bara: legături, în ordinea cerută, doar cele permise
      await expect(tabBar(page)).toBeVisible();
      expect(await tabNames(tabBar(page))).toEqual(tabs);
      await expect(tabBar(page).getByRole("link", { name: "Toate produsele" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(page.getByRole("tab")).toHaveCount(0);
    });
  }

  test("Editor: nu vede «Stoc» (nici tab, nici pagină), iar adresa directă duce la «Acces interzis»", async ({
    page,
    request,
    baseURL,
  }) => {
    const editor = await createAccount(request, baseURL as string, "editor");
    await login(page, editor, "/admin/produse");
    await expect(tabBar(page).getByRole("link", { name: "Stoc", exact: true })).toHaveCount(0);
    await page.goto("/admin/produse/stoc");
    await expect(page).toHaveURL(/\/admin\/acces-interzis/);
  });

  for (const role of ["support", "accountant"]) {
    test(`${role}: fără intrarea «Produse» în meniu și fără acces la ecranele grupului`, async ({
      page,
      request,
      baseURL,
    }) => {
      const account = await createAccount(request, baseURL as string, role);
      await login(page, account, "/admin");
      await expect(sidebar(page).getByRole("link", { name: "Panou", exact: true })).toBeVisible();
      await expect(sidebar(page).getByRole("link", { name: "Produse", exact: true })).toHaveCount(
        0,
      );
      for (const url of ["/admin/produse", "/admin/produse/categorii", "/admin/produse/stoc"]) {
        await page.goto(url);
        await expect(page).toHaveURL(/\/admin\/acces-interzis/);
        await expect(tabBar(page)).toHaveCount(0);
      }
    });
  }

  test("anonim: adresele noi duc la autentificare", async ({ page }) => {
    await page.goto("/admin/produse/stoc");
    await expect(page).toHaveURL(/\/autentificare/);
  });
});

test.describe("bara de taburi: navigare, tastatură, filtre, pagini întregi, firimituri", () => {
  test("clic pe fiecare tab: adresa nouă, aria-current pe tab, «Produse» rămâne activ în meniu", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse");
    for (const [name, path] of [
      ["Categorii", "/admin/produse/categorii"],
      ["Branduri", "/admin/produse/branduri"],
      ["Atribute", "/admin/produse/atribute"],
      ["Unități de măsură", "/admin/produse/unitati-de-masura"],
      ["Stoc", "/admin/produse/stoc"],
      ["Toate produsele", "/admin/produse"],
    ] as const) {
      await tabBar(page).getByRole("link", { name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path.replaceAll("/", "\\/")}$`));
      await expect(tabBar(page).getByRole("link", { name, exact: true })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(tabBar(page).locator('[aria-current="page"]')).toHaveCount(1);
      await expect(
        sidebar(page).getByRole("link", { name: "Produse", exact: true }),
      ).toHaveAttribute("aria-current", "page");
    }
  });

  test("din meniu: «Produse» duce la primul tab permis", async ({ page, request, baseURL }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse/stoc");
    await sidebar(page).getByRole("link", { name: "Panou", exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await sidebar(page).getByRole("link", { name: "Produse", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/produse$/);
    await expect(tabBar(page)).toBeVisible();
  });

  test("tastatura: Tab trece de la un tab la următorul, Enter îl deschide, focusul e vizibil", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse");
    const first = tabBar(page).getByRole("link", { name: "Toate produsele", exact: true });
    const second = tabBar(page).getByRole("link", { name: "Categorii", exact: true });
    await first.focus();
    await expect(first).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(second).toBeFocused();
    await expect(second).toHaveCSS("outline-style", /auto|solid|none/);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/admin\/produse\/categorii$/);
    await expect(
      tabBar(page).getByRole("link", { name: "Categorii", exact: true }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("căutarea (q) trece între «Toate produsele» și «Stoc»; filtrele și celelalte taburi se resetează", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse?q=liner&stare=draft&pagina=2");
    await expect(tabBar(page).getByRole("link", { name: "Stoc", exact: true })).toHaveAttribute(
      "href",
      "/admin/produse/stoc?q=liner",
    );
    await expect(
      tabBar(page).getByRole("link", { name: "Categorii", exact: true }),
    ).toHaveAttribute("href", "/admin/produse/categorii");
    await tabBar(page).getByRole("link", { name: "Stoc", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/produse\/stoc\?q=liner$/);
    await expect(
      tabBar(page).getByRole("link", { name: "Toate produsele", exact: true }),
    ).toHaveAttribute("href", "/admin/produse?q=liner");
  });

  test("editorul de produs, produsul nou și importul sunt pagini întregi, fără bară de taburi", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse/nou");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(tabBar(page)).toHaveCount(0);
    for (const url of ["/admin/produse/import", "/admin/produse/import/istoric"]) {
      await page.goto(url);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(tabBar(page)).toHaveCount(0);
    }
    // meniul rămâne pe «Produse»
    await expect(sidebar(page).getByRole("link", { name: "Produse", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("firimituri: Panou › Produse › Stoc, iar «Produse» duce la listă", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse/stoc");
    const crumbs = breadcrumb(page).getByRole("listitem");
    await expect(crumbs).toHaveText(["Panou", "Produse", "Stoc"]);
    await expect(breadcrumb(page).locator('[aria-current="page"]')).toHaveText("Stoc");
    await breadcrumb(page).getByRole("link", { name: "Produse", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/produse$/);
    await expect(breadcrumb(page).getByRole("listitem")).toHaveText(["Panou", "Produse"]);
  });
});

test.describe("adresele vechi redirecționează permanent (308), cu parametrii păstrați", () => {
  const cases: [string, string][] = [
    ["/admin/categorii", "/admin/produse/categorii"],
    ["/admin/categorii?edit=abc123", "/admin/produse/categorii?edit=abc123"],
    ["/admin/branduri?edit=abc123", "/admin/produse/branduri?edit=abc123"],
    ["/admin/atribute", "/admin/produse/atribute"],
    ["/admin/unitati-de-masura", "/admin/produse/unitati-de-masura"],
    ["/admin/fise-explodate", "/admin/produse/fise-explodate"],
    ["/admin/fise-explodate/abc123", "/admin/produse/fise-explodate/abc123"],
    ["/admin/stoc", "/admin/produse/stoc"],
    [
      "/admin/stoc?q=liner&tip=unmanaged&pagina=2",
      "/admin/produse/stoc?q=liner&tip=unmanaged&pagina=2",
    ],
    ["/admin/stoc/abc123?pagina=3", "/admin/produse/stoc/abc123?pagina=3"],
  ];
  for (const [from, to] of cases) {
    test(`${from} → ${to}`, async ({ request }) => {
      const response = await request.get(from, { maxRedirects: 0 });
      expect(response.status()).toBe(308);
      const location = new URL(response.headers()["location"] as string, "http://x");
      expect(location.pathname + location.search).toBe(to);
    });
  }

  test("în browser: adresa veche cu parametri ajunge pe tabul nou, cu tabul activ", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin");
    await page.goto("/admin/stoc?q=liner");
    await expect(page).toHaveURL(/\/admin\/produse\/stoc\?q=liner$/);
    await expect(tabBar(page).getByRole("link", { name: "Stoc", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.goto("/admin/categorii");
    await expect(page).toHaveURL(/\/admin\/produse\/categorii$/);
  });

  test("adresele noi inexistente rămân 404, nu redirecturi", async ({ request }) => {
    const response = await request.get("/admin/produse/categorii-inexistente", { maxRedirects: 0 });
    expect(response.status()).not.toBe(308);
  });
});

test.describe("telefon", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("bara se derulează orizontal în interiorul ei, pagina nu, iar tabul activ e vizibil", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse/stoc");
    await expect(tabBar(page)).toBeVisible();
    const metrics = await page.evaluate(() => {
      const bar = document.querySelector('nav[aria-label="Secțiunile produselor"]') as HTMLElement;
      const active = bar.querySelector('[aria-current="page"]') as HTMLElement;
      const barBox = bar.getBoundingClientRect();
      const activeBox = active.getBoundingClientRect();
      return {
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        barOverflow: bar.scrollWidth - bar.clientWidth,
        activeInside: activeBox.left >= barBox.left - 1 && activeBox.right <= barBox.right + 1,
      };
    });
    expect(metrics.pageOverflow).toBeLessThanOrEqual(0);
    expect(metrics.barOverflow).toBeGreaterThan(0);
    expect(metrics.activeInside).toBe(true);
    // un tab ascuns la început se poate ajunge cu tastatura
    const first = tabBar(page).getByRole("link", { name: "Toate produsele", exact: true });
    await first.focus();
    await expect(first).toBeFocused();
  });
});

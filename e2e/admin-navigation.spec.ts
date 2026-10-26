import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  promoteE2eUser,
  removeE2eProducts,
  seedE2eProducts,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Blocul 8c în browser: meniul din stânga are grupul «Catalog» (se deschide și se închide, cu săgeată), cu sub-elementele
 * Produse, Categorii, Branduri, Atribute, Unități de măsură, Fișe explodate, Stoc; bara de taburi a dispărut. Elementele
 * după drepturile rolului, grupul se deschide singur pe paginile lui cu elementul curent evidențiat, editorul de produs
 * ține «Produse» evidențiat, adresele vechi → noi (308, cu parametrii), firimiturile «Panou › Catalog › …», telefonul.
 * Flag-ul `partsDiagrams` e global și îl pornește/oprește `parts-diagrams.spec.ts`: aici «Fișe explodate» se ignoră în
 * listele de elemente (rolul e acoperit acolo și în unitare).
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
const breadcrumb = (page: Page) => page.getByRole("navigation", { name: "Poziția în pagină" });
const groupButton = (page: Page) =>
  sidebar(page).getByRole("button", { name: "Catalog", exact: true });
const submenu = (page: Page) => sidebar(page).locator('[data-nav-group="catalog"] ul');
const itemLink = (page: Page, name: string) =>
  submenu(page).getByRole("link", { name, exact: true });
/** Vechea bară de taburi: nu mai trebuie să existe nicăieri. */
const oldTabBar = (page: Page) => page.getByRole("navigation", { name: "Secțiunile produselor" });

/** Numele elementelor din grup, în ordinea afișării, fără «Fișe explodate» (flag global, schimbat de alt fișier). */
async function itemNames(page: Page): Promise<string[]> {
  const names = await submenu(page).getByRole("link").allInnerTexts();
  return names.map((n) => n.trim()).filter((n) => n !== "Fișe explodate");
}

const CATALOG_ITEMS = ["Produse", "Categorii", "Branduri", "Atribute", "Unități de măsură"];

/** Un clic dat înainte de hidratare se pierde: îl repetăm până apare efectul. */
async function openDrawer(page: Page) {
  await expect(async () => {
    await page.getByRole("button", { name: "Deschide meniul" }).click();
    await expect(groupButton(page)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

/** Deschide grupul din meniu, repetând clicul până se vede (hidratarea). */
async function openGroup(page: Page) {
  await expect(async () => {
    if ((await groupButton(page).getAttribute("aria-expanded")) !== "true") {
      await groupButton(page).click();
    }
    await expect(groupButton(page)).toHaveAttribute("aria-expanded", "true", { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

test.describe("meniul «Catalog», pe roluri", () => {
  for (const [role, label, items] of [
    ["owner", "Owner", [...CATALOG_ITEMS, "Stoc"]],
    ["manager", "Manager", [...CATALOG_ITEMS, "Stoc"]],
    // cu drepturile actuale Depozitul are products.read și inventory.read: vede aceleași ecrane ca Managerul
    ["warehouse", "Depozit", [...CATALOG_ITEMS, "Stoc"]],
    ["editor", "Editor", CATALOG_ITEMS],
  ] as const) {
    test(`${label}: grupul «Catalog» e o singură intrare, închisă pe Panou, cu exact elementele permise, în ordine`, async ({
      page,
      request,
      baseURL,
    }) => {
      const account = await createAccount(request, baseURL as string, role);
      await login(page, account, "/admin");

      // pe Panou grupul e închis și nu arată elemente
      await expect(groupButton(page)).toBeVisible();
      await expect(groupButton(page)).toHaveAttribute("aria-expanded", "false");
      await expect(submenu(page)).toBeHidden();
      // grupul închis nu arată legături către ecranele lui, iar nicio intrare «Produse» nu mai există în afara lui;
      // «Media» rămâne separat
      for (const name of ["Produse", "Categorii", "Branduri", "Atribute", "Stoc"]) {
        await expect(sidebar(page).getByRole("link", { name, exact: true })).toHaveCount(0);
      }
      await expect(sidebar(page).getByRole("link", { name: "Media", exact: true })).toBeVisible();

      await openGroup(page);
      await expect(submenu(page)).toBeVisible();
      expect(await itemNames(page)).toEqual(items);
      // nicio bară de taburi, nicăieri
      await page.goto("/admin/produse");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(oldTabBar(page)).toHaveCount(0);
      await expect(page.getByRole("tab")).toHaveCount(0);
    });
  }

  test("Editor: nu vede «Stoc» (nici în grup, nici ca pagină), iar adresa directă duce la «Acces interzis»", async ({
    page,
    request,
    baseURL,
  }) => {
    const editor = await createAccount(request, baseURL as string, "editor");
    await login(page, editor, "/admin/produse");
    await expect(itemLink(page, "Stoc")).toHaveCount(0);
    await page.goto("/admin/produse/stoc");
    await expect(page).toHaveURL(/\/admin\/acces-interzis/);
  });

  for (const role of ["support", "accountant"]) {
    test(`${role}: fără grupul «Catalog» în meniu și fără acces la ecranele lui`, async ({
      page,
      request,
      baseURL,
    }) => {
      const account = await createAccount(request, baseURL as string, role);
      await login(page, account, "/admin");
      await expect(sidebar(page).getByRole("link", { name: "Panou", exact: true })).toBeVisible();
      await expect(groupButton(page)).toHaveCount(0);
      await expect(sidebar(page).locator("[data-nav-group]")).toHaveCount(0);
      for (const url of ["/admin/produse", "/admin/produse/categorii", "/admin/produse/stoc"]) {
        await page.goto(url);
        await expect(page).toHaveURL(/\/admin\/acces-interzis/);
        await expect(groupButton(page)).toHaveCount(0);
      }
    });
  }

  test("anonim: adresele grupului duc la autentificare", async ({ page }) => {
    await page.goto("/admin/produse/stoc");
    await expect(page).toHaveURL(/\/autentificare/);
  });
});

test.describe("grupul: deschidere, închidere, evidențiere", () => {
  test("se deschide și se închide cu clic și cu tastatura; săgeata, aria-expanded și aria-controls sunt corecte", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin");
    const button = groupButton(page);
    await expect(button).toHaveAttribute("aria-expanded", "false");
    const controlled = await button.getAttribute("aria-controls");
    expect(controlled).toBeTruthy();
    await expect(submenu(page)).toHaveAttribute("id", controlled as string);

    await openGroup(page);
    await expect(submenu(page)).toBeVisible();
    await button.click();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(submenu(page)).toBeHidden();
    // elementele închise nu mai sunt în ordinea de tab
    await expect(submenu(page).getByRole("link")).toHaveCount(0);

    // tastatura: Enter deschide, Space închide, focusul rămâne pe buton și e vizibil
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(button).toBeFocused();
    await page.keyboard.press("Space");
    await expect(button).toHaveAttribute("aria-expanded", "false");
    // deschis, Tab trece de la buton la primul element, apoi la următorul
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(itemLink(page, "Produse")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(itemLink(page, "Categorii")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/admin\/produse\/categorii$/);
  });

  test("pe paginile grupului se deschide singur, cu elementul curent evidențiat (unul singur) și grupul marcat activ", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse/stoc");
    await expect(groupButton(page)).toHaveAttribute("aria-expanded", "true");
    await expect(groupButton(page)).toHaveAttribute("data-active", "true");
    await expect(itemLink(page, "Stoc")).toHaveAttribute("aria-current", "page");
    await expect(itemLink(page, "Produse")).not.toHaveAttribute("aria-current", "page");
    await expect(sidebar(page).locator('[aria-current="page"]')).toHaveCount(1);

    // pe Panou grupul nu e activ și e închis
    await sidebar(page).getByRole("link", { name: "Panou", exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(sidebar(page).getByRole("link", { name: "Panou", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // închis manual pe o pagină a grupului, titlul rămâne marcat activ
    await page.goto("/admin/produse/branduri");
    await expect(groupButton(page)).toHaveAttribute("aria-expanded", "true");
    await groupButton(page).click();
    await expect(groupButton(page)).toHaveAttribute("aria-expanded", "false");
    await expect(groupButton(page)).toHaveAttribute("data-active", "true");
  });

  test("clic pe fiecare element: adresa nouă, aria-current doar pe el, grupul rămâne deschis", async ({
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
      ["Produse", "/admin/produse"],
    ] as const) {
      await itemLink(page, name).click();
      await expect(page).toHaveURL(new RegExp(`${path.replaceAll("/", "\\/")}$`));
      await expect(itemLink(page, name)).toHaveAttribute("aria-current", "page");
      await expect(sidebar(page).locator('[aria-current="page"]')).toHaveCount(1);
      await expect(groupButton(page)).toHaveAttribute("aria-expanded", "true");
    }
    // nicio bară de taburi n-a apărut pe parcurs
    await expect(oldTabBar(page)).toHaveCount(0);
  });

  test("editorul de produs, produsul nou și importul țin «Produse» evidențiat, în grup deschis, fără bară de taburi", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const [title] = await seedE2eProducts(tag, 1);
    try {
      await login(page, owner, `/admin/produse?q=${tag}`);
      // produsul existent: din listă în editor
      await page
        .getByRole("link", { name: title as string })
        .first()
        .click();
      await expect(page).toHaveURL(/\/admin\/produse\/[^/?]+$/);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(groupButton(page)).toHaveAttribute("aria-expanded", "true");
      await expect(itemLink(page, "Produse")).toHaveAttribute("aria-current", "page");
      await expect(sidebar(page).locator('[aria-current="page"]')).toHaveCount(1);
      await expect(oldTabBar(page)).toHaveCount(0);

      for (const url of [
        "/admin/produse/nou",
        "/admin/produse/import",
        "/admin/produse/import/istoric",
      ]) {
        await page.goto(url);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expect(groupButton(page)).toHaveAttribute("aria-expanded", "true");
        await expect(itemLink(page, "Produse")).toHaveAttribute("aria-current", "page");
        await expect(oldTabBar(page)).toHaveCount(0);
      }
    } finally {
      await removeE2eProducts();
    }
  });

  test("căutarea (q) trece între «Produse» și «Stoc»; filtrele și celelalte elemente se resetează", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse?q=liner&stare=draft&pagina=2");
    await expect(itemLink(page, "Stoc")).toHaveAttribute("href", "/admin/produse/stoc?q=liner");
    await expect(itemLink(page, "Categorii")).toHaveAttribute("href", "/admin/produse/categorii");
    await itemLink(page, "Stoc").click();
    await expect(page).toHaveURL(/\/admin\/produse\/stoc\?q=liner$/);
    await expect(itemLink(page, "Produse")).toHaveAttribute("href", "/admin/produse?q=liner");
  });

  test("firimituri: Panou › Catalog › Stoc, iar «Catalog» duce la lista de produse", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin/produse/stoc");
    await expect(breadcrumb(page).getByRole("listitem")).toHaveText(["Panou", "Catalog", "Stoc"]);
    await expect(breadcrumb(page).locator('[aria-current="page"]')).toHaveText("Stoc");
    await breadcrumb(page).getByRole("link", { name: "Catalog", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/produse$/);
    await expect(breadcrumb(page).getByRole("listitem")).toHaveText([
      "Panou",
      "Catalog",
      "Produse",
    ]);
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

  test("în browser: adresa veche cu parametri ajunge pe elementul nou, cu grupul deschis și elementul activ", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin");
    await page.goto("/admin/stoc?q=liner");
    await expect(page).toHaveURL(/\/admin\/produse\/stoc\?q=liner$/);
    await expect(groupButton(page)).toHaveAttribute("aria-expanded", "true");
    await expect(itemLink(page, "Stoc")).toHaveAttribute("aria-current", "page");
    await page.goto("/admin/categorii");
    await expect(page).toHaveURL(/\/admin\/produse\/categorii$/);
    await expect(itemLink(page, "Categorii")).toHaveAttribute("aria-current", "page");
  });

  test("adresele noi inexistente rămân 404, nu redirecturi", async ({ request }) => {
    const response = await request.get("/admin/produse/categorii-inexistente", { maxRedirects: 0 });
    expect(response.status()).not.toBe(308);
  });
});

test.describe("telefon", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("în sertar: grupul se deschide, elementele sunt ușor de atins, alegerea unui element închide sertarul, pagina nu iese din ecran", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin");
    await expect(page.getByRole("button", { name: "Deschide meniul" })).toBeVisible();
    // sertar închis: nici grupul, nici elementele nu sunt accesibile
    await expect(groupButton(page)).toBeHidden();

    await openDrawer(page);
    await expect(groupButton(page)).toHaveAttribute("aria-expanded", "false");
    await openGroup(page);
    await expect(submenu(page)).toBeVisible();
    // țintă de atins de cel puțin 44px înălțime, în sertarul de 16rem (fără defilare orizontală)
    const metrics = await page.evaluate(() => {
      const links = [...document.querySelectorAll('[data-nav-group="catalog"] ul a')];
      const aside = document.getElementById("admin-sidebar") as HTMLElement;
      return {
        minHeight: Math.min(...links.map((a) => a.getBoundingClientRect().height)),
        asideOverflow: aside.scrollWidth - aside.clientWidth,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        buttonHeight: (
          document.querySelector('[data-nav-group="catalog"] button') as HTMLElement
        ).getBoundingClientRect().height,
      };
    });
    expect(metrics.minHeight).toBeGreaterThanOrEqual(44);
    expect(metrics.buttonHeight).toBeGreaterThanOrEqual(44);
    expect(metrics.asideOverflow).toBeLessThanOrEqual(0);
    expect(metrics.pageOverflow).toBeLessThanOrEqual(0);

    await itemLink(page, "Stoc").click();
    await expect(page).toHaveURL(/\/admin\/produse\/stoc$/);
    // sertarul se închide la navigare
    await expect(groupButton(page)).toBeHidden();
    await expect(oldTabBar(page)).toHaveCount(0);

    // redeschis pe o pagină a grupului: grupul e deschis, elementul curent evidențiat
    await openDrawer(page);
    await expect(groupButton(page)).toHaveAttribute("aria-expanded", "true");
    await expect(itemLink(page, "Stoc")).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Escape");
    await expect(groupButton(page)).toBeHidden();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

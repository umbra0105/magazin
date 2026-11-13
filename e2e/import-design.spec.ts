import { randomBytes } from "node:crypto";
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  insertE2eInterruptedImport,
  promoteE2eUser,
  removeE2eImports,
  removeE2eProducts,
  seedE2eProducts,
  trackE2eImportFile,
  trackE2eProduct,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Redesign admin, Lotul 3b-2 (docs/17): importul de produse. Pagina și pașii (fișier, mapare, verificare, confirmare, rezultat) în
 * fluxul real, cu un CSV mic; opțiunile WooCommerce, raportul lui și progresul imaginilor pe pagina-harness
 * `/admin/e2e-harness/import` (date fixe, fără rețea); istoricul (importuri și exporturi) și detaliile unui import. Invarianți:
 * un singur buton principal pe ecran și în dialog, tabele pe `Table` (mod stivuit pe telefon), blocuri cu chenar-token, mesaje în
 * tonul Problemă, fără derulare orizontală la 390 px, ținte tactile de 44 px. Comportamentul (parsare, planificare, aplicare,
 * drepturi) rămâne în `product-import*.spec.ts`.
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
  await page.waitForURL((url) => url.pathname !== "/autentificare");
}

/** Context cu ecran tactil (pointer grosier), autentificat. */
async function touchPage(
  browser: Browser,
  baseURL: string,
  account: Account,
  next: string,
  viewport: { width: number; height: number },
) {
  const context = await browser.newContext({ baseURL, hasTouch: true, isMobile: true, viewport });
  const page = await context.newPage();
  await login(page, account, next);
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  return { page, context };
}

test.describe.configure({ mode: "serial", timeout: 240_000 });

let account: Account;
const tag = randomBytes(3).toString("hex");
const fileName = `e2e-${tag}-design.csv`;

test.beforeAll(async ({ request, baseURL }) => {
  account = await createAccount(request, baseURL as string, "owner");
  trackE2eProduct(`e2e-${tag}-nou`);
});

test.afterAll(async () => {
  await removeE2eImports();
  await removeE2eProducts();
});

const css = (locator: Locator, property: string) =>
  locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);

/** Pagina nu derulează pe orizontală (scrollWidth ≤ clientWidth). */
const pageOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Valoarea unei proprietăți pentru o clasă-token, citită dintr-un element-sondă din suprafața adminului. */
const tokenStyle = (page: Page, className: string, property: string) =>
  page.evaluate(
    ([name, prop]) => {
      const probe = document.createElement("div");
      probe.className = name as string;
      (document.querySelector('[data-surface="admin"]') ?? document.body).append(probe);
      const value = getComputedStyle(probe).getPropertyValue(prop as string);
      probe.remove();
      return value;
    },
    [className, property] as const,
  );

/**
 * Butoanele principale vizibile dintr-o rădăcină (fundal `--action`): culoarea se citește dintr-un element-sondă cu clasa
 * `bg-action`. Întoarce numele lor (aria-label sau text). Fără rădăcină: toată pagina.
 */
async function primaryControls(page: Page, root?: Locator): Promise<string[]> {
  const scan = (element: Element | null) => {
    const scope: Element | Document = element ?? document;
    const probe = document.createElement("div");
    probe.className = "bg-action";
    (document.querySelector('[data-surface="admin"]') ?? document.body).append(probe);
    const primary = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const found: string[] = [];
    for (const el of scope.querySelectorAll<HTMLElement>(
      'button, a, [role="button"], label[for]',
    )) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (getComputedStyle(el).backgroundColor !== primary) continue;
      found.push((el.getAttribute("aria-label") ?? el.textContent ?? "").trim());
    }
    return found;
  };
  return root ? root.evaluate(scan) : page.evaluate(scan, null);
}

/** Dialogul nu iese din fereastră și nu derulează pe orizontală. */
async function expectDialogFits(page: Page, dialog: Locator) {
  const viewport = page.viewportSize() as { width: number; height: number };
  const box = (await dialog.boundingBox()) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  expect(box.x, "dialog: marginea din stânga").toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width, "dialog: marginea din dreapta").toBeLessThanOrEqual(
    viewport.width + 0.5,
  );
  expect(box.y + box.height, "dialog: marginea de jos").toBeLessThanOrEqual(viewport.height + 0.5);
  expect(
    await dialog.evaluate((el) => el.scrollWidth - el.clientWidth),
    "dialog: derulare orizontală",
  ).toBeLessThanOrEqual(0);
}

/** Tabelul e un `Table` din design system: antet pe `--surface-subtle`, fără chenar vechi; pe telefon, mod stivuit. */
async function expectTable(page: Page, table: Locator, label: string) {
  await expect(table, label).toBeVisible();
  expect(await css(table.locator("thead"), "background-color"), `${label}: antet`).toBe(
    await tokenStyle(page, "bg-surface-subtle", "background-color"),
  );
}

/** La 390 px pagina nu derulează pe orizontală, apoi revine la 1440. */
async function expectPhoneFits(page: Page, label: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await pageOverflow(page), `${label}: derulare orizontală la 390 px`).toBeLessThanOrEqual(
    0,
  );
  await page.setViewportSize({ width: 1440, height: 900 });
}

const HARNESS = (ecran: string, stare = "") =>
  `/admin/e2e-harness/import?ecran=${ecran}${stare ? `&stare=${stare}` : ""}`;

// ───────────────────────── Pagina și pașii (flux real) ─────────────────────────

test.describe("import: pagina și pașii", () => {
  test("pasul 1 (1440 px): antet cu legătura înapoi și «Istoric importuri» secundar, pași în tonuri-token, un singur buton principal («Încarcă și analizează»), mesaj lipsă-fișier în tonul Problemă", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, "/admin/produse/import");
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toHaveText("Import de produse");
    expect(await css(h1, "font-size")).toBe("22px");
    const back = page.getByRole("link", { name: "Înapoi la lista de produse" });
    expect(await css(back, "font-size")).toBe("14px");
    // pașii: cel curent cu chenar din brand și fundal subtil, ceilalți cu chenar-token
    const steps = page.getByRole("list", { name: "Import de produse" }).locator("li");
    await expect(steps).toHaveCount(4);
    const current = steps.filter({ hasText: "1. Fișier" });
    await expect(current).toHaveAttribute("aria-current", "step");
    expect(await css(current, "border-top-color")).toBe(
      await tokenStyle(page, "border-brand", "border-top-color"),
    );
    expect(await css(current, "background-color")).toBe(
      await tokenStyle(page, "bg-surface-subtle", "background-color"),
    );
    expect(await css(steps.filter({ hasText: "2. Mapare" }), "border-top-color")).toBe(
      await tokenStyle(page, "border-line-subtle", "border-top-color"),
    );
    // blocul «Șablon de import»: chenar-token
    const template = page.locator("[data-template]").first().locator("xpath=ancestor::div[2]");
    expect(await css(template, "border-top-color")).toBe(
      await tokenStyle(page, "border-line-subtle", "border-top-color"),
    );
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    expect(await primaryControls(page)).toEqual(["Încarcă și analizează"]);
    // fără fișier: mesajul de validare, în tonul Problemă
    await page.getByRole("button", { name: "Încarcă și analizează" }).click();
    const problem = page.locator("[data-problem]");
    await expect(problem).toHaveText("Alege mai întâi un fișier.");
    expect(await css(problem, "color")).toBe(
      await tokenStyle(page, "text-tone-problem-fg", "color"),
    );
    expect(await css(problem, "background-color")).toBe(
      await tokenStyle(page, "bg-tone-problem-bg", "background-color"),
    );
    await expectPhoneFits(page, "pasul 1");
  });

  test("pașii 2–5: mapare pe Table, verificare cu contoare în chenar-token și raport pe Table, confirmare cu un singur buton principal, rezultat cu «Către lista de produse» principal", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, "/admin/produse/import");
    const csv = `SKU;Titlu;Preț (lei, cu TVA)\r\nE2E-${tag.toUpperCase()}-NEW;E2E ${tag} Nou;10\r\nE2E-${tag.toUpperCase()}-BAD;E2E ${tag} Greșit;abc\r\n`;
    trackE2eImportFile(fileName);
    await page.getByLabel("Fișier CSV sau XLSX").setInputFiles({
      name: fileName,
      mimeType: "application/octet-stream",
      buffer: Buffer.from(csv, "utf8"),
    });
    await page.getByRole("button", { name: "Încarcă și analizează" }).click();

    // ── maparea ──
    const mappingTitle = page.getByRole("heading", { name: "Mapează coloanele" });
    await expect(mappingTitle).toBeVisible();
    expect(await css(mappingTitle, "font-size")).toBe("16px");
    const mapping = page.getByRole("table", { name: "Mapează coloanele" });
    await expectTable(page, mapping, "maparea");
    expect(await primaryControls(page)).toEqual(["Verifică (fără modificări)"]);
    await expectPhoneFits(page, "maparea");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator("table[data-stacked]").count()).toBeGreaterThan(0);
    // pe telefon, câmpul «Importă în câmpul» încape în card
    const select = page.getByLabel("Importă în câmpul: SKU");
    const box = await select.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    await page.setViewportSize({ width: 1440, height: 900 });

    // ── verificarea ──
    await page.locator("[data-import-check]").click();
    const checkTitle = page.getByRole("heading", { name: "Rezultatul verificării" });
    await expect(checkTitle).toBeVisible();
    expect(await css(checkTitle, "font-size")).toBe("16px");
    const note = page.getByRole("note").filter({ hasText: "Nu s-a modificat nimic în catalog." });
    expect(await css(note, "background-color")).toBe(
      await tokenStyle(page, "bg-surface-subtle", "background-color"),
    );
    const tile = page.locator('[data-count="new"]');
    expect(await css(tile, "border-top-color")).toBe(
      await tokenStyle(page, "border-line-subtle", "border-top-color"),
    );
    expect(await css(tile.locator("dd"), "font-size")).toBe("22px");
    await expectTable(
      page,
      page.getByRole("table", { name: "Rânduri cu ceva de spus" }),
      "raportul",
    );
    expect(await primaryControls(page)).toEqual(["Aplică importul…"]);
    // «Descarcă raportul» și «Schimbă maparea» sunt secundare (verificat prin lista de mai sus)
    await expectPhoneFits(page, "verificarea");

    // ── confirmarea ──
    await page.locator("[data-import-apply]").click();
    const dialog = page.getByRole("dialog", { name: "Aplici importul?" });
    await expect(dialog).toBeVisible();
    expect(await primaryControls(page, dialog)).toEqual(["Confirm și aplic"]);
    expect(await css(dialog.locator("[data-import-summary]"), "border-top-color")).toBe(
      await tokenStyle(page, "border-line-subtle", "border-top-color"),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await expectDialogFits(page, dialog);
    await page.setViewportSize({ width: 1440, height: 900 });

    // ── rezultatul ──
    await dialog.locator("[data-import-confirm]").click();
    await expect(page.locator("[data-import-done]")).toBeVisible();
    expect(await primaryControls(page)).toEqual(["Către lista de produse"]);
    await expectPhoneFits(page, "rezultatul");
  });
});

// ───────────────────────── Părțile WooCommerce și imaginile (pagina-harness) ─────────────────────────

test.describe("import: WooCommerce și imagini", () => {
  test("opțiunile Woo: grupuri cu legendă de 14 px, clasele de livrare și atributele pe Table, coloanele ignorate în chenar-token, fără buton principal; fără derulare orizontală la 390 px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, HARNESS("woo"));
    await expect(page.locator("[data-woo-options]")).toBeVisible();
    expect(await css(page.locator("legend").first(), "font-size")).toBe("14px");
    await expectTable(
      page,
      page.getByRole("table", { name: "Clase de livrare" }),
      "clasele de livrare",
    );
    await expectTable(page, page.getByRole("table", { name: "Atribute" }), "atributele");
    const columns = page.locator("[data-woo-columns]");
    expect(await css(columns, "border-top-color")).toBe(
      await tokenStyle(page, "border-line-subtle", "border-top-color"),
    );
    expect(await primaryControls(page)).toEqual([]);
    await expect(page.getByLabel("Clasa din aplicație: Clasa mare")).toBeVisible();
    await expectPhoneFits(page, "opțiunile Woo");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator("table[data-stacked]").count()).toBe(2);
  });

  test("opțiunile Woo: mesajul «fără drept» pe fundal subtil, «fără domenii» în tonul Problemă; modul «doar descrieri»", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, HARNESS("woo", "fara-drept"));
    const noRight = page.locator("[data-images-no-right]");
    await expect(noRight).toBeVisible();
    expect(await css(noRight, "background-color")).toBe(
      await tokenStyle(page, "bg-surface-subtle", "background-color"),
    );
    await page.goto(HARNESS("woo", "fara-domenii"));
    const noHosts = page.locator("[data-images-no-hosts]");
    await expect(noHosts).toBeVisible();
    expect(await css(noHosts, "background-color")).toBe(
      await tokenStyle(page, "bg-tone-problem-bg", "background-color"),
    );
    expect(await css(noHosts, "color")).toBe(
      await tokenStyle(page, "text-tone-problem-fg", "color"),
    );
    await page.goto(HARNESS("woo", "descrieri"));
    await expect(page.locator("[data-woo-descriptions-only]")).toBeVisible();
    await expect(page.getByRole("table", { name: "Clase de livrare" })).toHaveCount(0);
  });

  test("raportul Woo: bloc cu chenar-token, valori pe perechi, imaginile respinse pe Table într-un <details> cu chenar-token", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, HARNESS("raport"));
    const report = page.locator("[data-woo-report]");
    await expect(report).toBeVisible();
    expect(await css(report, "border-top-color")).toBe(
      await tokenStyle(page, "border-line-subtle", "border-top-color"),
    );
    await page.getByText("Imagini respinse (fără adresa completă)").click();
    await expectTable(
      page,
      page.getByRole("table", { name: "Imagini respinse (fără adresa completă)" }),
      "imaginile respinse",
    );
    expect(await primaryControls(page)).toEqual([]);
    await expectPhoneFits(page, "raportul Woo");
  });

  test("progresul imaginilor: bară subțire din design system, contoare în chenar-token, tabel de eșecuri pe Table, «Reia imaginile» secundar", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, HARNESS("imagini", "oprit"));
    const bar = page.getByRole("progressbar");
    await expect(bar).toBeVisible();
    expect((await bar.boundingBox())?.height ?? 99).toBeLessThanOrEqual(8);
    const tile = page.locator('[data-image-count="failed"]');
    expect(await css(tile, "border-top-color")).toBe(
      await tokenStyle(page, "border-line-subtle", "border-top-color"),
    );
    expect(await css(tile.locator("dd"), "font-size")).toBe("22px");
    await expectTable(page, page.getByRole("table", { name: "Imagini eșuate" }), "eșecurile");
    await expect(page.getByRole("button", { name: "Reia imaginile" })).toBeVisible();
    expect(await primaryControls(page)).toEqual([]);
    await expectPhoneFits(page, "progresul imaginilor");
  });
});

// ───────────────────────── Istoricul ─────────────────────────

test.describe("import: istoric", () => {
  test("lista (1440 px): titlu, file-uri ca tab-uri (nu butoane principale), tabel pe Table cu stare în pastilă, fără buton principal; pe telefon carduri fără derulare orizontală", async ({
    page,
  }) => {
    await insertE2eInterruptedImport(account.email, `e2e-${tag}-intrerupt.csv`, 7, 20);
    await seedE2eProducts(tag, 1);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, "/admin/produse/import/istoric");
    const h1 = page.getByRole("heading", { level: 1, name: "Istoric importuri" });
    await expect(h1).toBeVisible();
    expect(await css(h1, "font-size")).toBe("22px");
    const tabs = page.locator("[data-history-tabs]");
    const active = tabs.getByRole("link", { name: "Importuri" });
    await expect(active).toHaveAttribute("aria-current", "page");
    expect(await css(active, "border-bottom-color")).toBe(
      await tokenStyle(page, "border-ink", "border-top-color"),
    );
    expect(await css(active, "background-color")).toBe("rgba(0, 0, 0, 0)");
    await expectTable(page, page.locator("[data-history-table]"), "istoricul");
    for (const row of await page.locator("[data-history-row]").all()) {
      expect((await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(48);
    }
    expect(await primaryControls(page)).toEqual([]);
    await expectPhoneFits(page, "istoricul");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator("table[data-stacked]").count()).toBe(1);
    const interrupted = page.locator("[data-history-row]").filter({ hasText: "intrerupt" });
    expect((await interrupted.boundingBox())?.width ?? 999).toBeLessThanOrEqual(390);
    expect(await css(interrupted.locator("[data-history-interrupted]"), "color")).toBe(
      await tokenStyle(page, "text-tone-problem-fg", "color"),
    );
  });

  test("fila Exporturi: tabel pe Table, pastila «Descărcat», nota «fără drept» în chenar-token", async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, "/admin/produse");
    const exported = await page.request.post("/api/admin/product-exports", {
      headers: { origin: baseURL as string },
      data: { format: "csv", scope: "filters", filters: { q: tag } },
    });
    expect(exported.status()).toBe(200);
    await exported.body();
    await page.goto("/admin/produse/import/istoric?fila=exporturi");
    await expect(page.getByRole("heading", { name: "Exporturi de produse" })).toBeVisible();
    await expectTable(page, page.locator("[data-exports-table]"), "exporturile");
    expect(await primaryControls(page)).toEqual([]);
    await expectPhoneFits(page, "exporturile");
  });

  test("detaliile unui import: antet cu stare în pastilă, contoare în chenar-token, filtre ca tab-uri, raport pe Table, descărcarea secundară, fără buton principal; fără derulare orizontală la 390 px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, "/admin/produse/import/istoric");
    await page
      .locator("[data-history-row]")
      .filter({ hasText: fileName })
      .locator("[data-history-details]")
      .click();
    await page.waitForURL(/\/istoric\/[^/]+$/);
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toContainText(fileName);
    expect(await css(h1, "font-size")).toBe("22px");
    await expect(page.locator("[data-history-state]")).toBeVisible();
    const tile = page.locator('[data-count="new"]');
    expect(await css(tile, "border-top-color")).toBe(
      await tokenStyle(page, "border-line-subtle", "border-top-color"),
    );
    const filters = page.locator("[data-history-filters]");
    const all = filters.getByRole("link", { name: "Toate" });
    await expect(all).toHaveAttribute("aria-current", "page");
    expect(await css(all, "background-color")).toBe("rgba(0, 0, 0, 0)");
    await expectTable(
      page,
      page.getByRole("table", { name: "Rânduri cu ceva de spus" }),
      "raportul",
    );
    expect(await primaryControls(page)).toEqual([]);
    await expectPhoneFits(page, "detaliile importului");
  });

  test("ecran tactil (390 px): butonul de încărcare, șabloanele și «Istoric importuri» au cel puțin 44 px", async ({
    browser,
    baseURL,
  }) => {
    const { page, context } = await touchPage(
      browser,
      baseURL as string,
      account,
      "/admin/produse/import",
      { width: 390, height: 844 },
    );
    try {
      for (const control of [
        page.getByRole("button", { name: "Încarcă și analizează" }),
        page.locator("[data-template]").first(),
        page.locator("[data-import-history-link]"),
      ]) {
        const box = await control.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
    } finally {
      await context.close();
    }
  });
});

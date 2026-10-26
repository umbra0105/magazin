import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  promoteE2eUser,
  readE2eStock,
  readE2eStockAudit,
  removeE2eStock,
  seedE2eStock,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Faza 5, punctul 10a, în browser: «Stoc mic» ca VEDERE a paginii Stoc (`?filtru=stoc-mic`, aliasul vechi `?mic=1`), ordonată după
 * urgență, cu motiv, prag și numărători; dialogul «Prag stoc mic» (0–1000 de pași, gol = setarea globală, validări proprii în
 * română, audit cu înainte/după); drepturile; telefonul. Meniul Catalog NU primește un element nou. Produsele de probă au adresa
 * `e2e-stoc-<tag>-…` și se șterg la final (doar cele ale acestui fișier).
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

test.describe.configure({ mode: "serial", timeout: 150_000 });

const tag = randomBytes(3).toString("hex");
const search = `E2E ${tag}`;
const LOW_URL = `/admin/produse/stoc?q=${encodeURIComponent(search)}&filtru=stoc-mic`;
const ALL_URL = `/admin/produse/stoc?q=${encodeURIComponent(search)}`;
let skus: string[] = [];
const [ALGE, BEC, POMPA, FILTRU, LINER, CAPAC, CARTUS, GHID] = [0, 1, 2, 3, 4, 5, 6, 7];
const sku = (index: number): string => skus[index] as string;

test.beforeAll(async () => {
  skus = await seedE2eStock(tag, [
    { title: `Alge ${search}`, variants: [{ sku: "A", physical: "0" }] },
    { title: `Bec ${search}`, variants: [{ sku: "B", physical: "1" }] },
    { title: `Pompă ${search}`, variants: [{ sku: "P", physical: "2" }] },
    { title: `Filtru ${search}`, variants: [{ sku: "F", physical: "3" }] },
    {
      title: `Liner ${search}`,
      unit: { symbol: "mp", decimals: 2 },
      step: "41,25",
      variants: [{ sku: "L", physical: "17,5" }],
    },
    { title: `Capac ${search}`, variants: [{ sku: "C", physical: "50" }] },
    {
      title: `Cartuș ${search}`,
      manageStock: false,
      stockStatus: "outofstock",
      variants: [{ sku: "R", physical: null }],
    },
    {
      title: `Ghid ${search}`,
      type: "digital",
      manageStock: false,
      variants: [{ sku: "G", physical: null }],
    },
  ]);
});

test.afterAll(async () => {
  await removeE2eStock({ tag });
});

const lowRow = (page: Page, code: string): Locator => page.locator(`[data-low-row="${code}"]`);
const allRow = (page: Page, code: string): Locator => page.locator(`[data-variant-row="${code}"]`);
const viewSwitch = (page: Page) => page.getByRole("navigation", { name: "Vedere" });
const sidebar = (page: Page) => page.getByRole("navigation", { name: "Navigare principală" });
const thresholdDialog = (page: Page) => page.getByRole("dialog", { name: /^Prag stoc mic:/ });
const thresholdButton = (scope: Locator) =>
  scope.getByRole("button", { name: /^Setează pragul de stoc mic:/ });

/** Codurile SKU ale rândurilor din vederea «Stoc mic», în ordinea afișată. */
async function lowOrder(page: Page): Promise<string[]> {
  return page
    .locator("[data-low-row]")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-low-row") as string));
}

/** Un clic dat înainte de hidratare se pierde: îl repetăm până se deschide dialogul. */
async function openThreshold(page: Page, row: Locator) {
  await expect(async () => {
    if (!(await thresholdDialog(page).isVisible())) await thresholdButton(row).click();
    await expect(thresholdDialog(page)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

const value = (page: Page) =>
  thresholdDialog(page).getByLabel("Prag de stoc mic (în pași)", { exact: true });

function failOnNativeDialog(page: Page): void {
  page.on("dialog", async (dialog) => {
    await dialog.dismiss();
    throw new Error(`Dialog nativ neașteptat: ${dialog.message()}`);
  });
}

test.describe("vederea «Stoc mic» în pagina Stoc", () => {
  test("comutator cu număr, ordine de urgență, motiv, prag și numărători; fără element nou în meniu", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, ALL_URL);

    // pagina obișnuită: comutatorul arată câte variante sunt la stoc mic (Alge, Liner, Bec, Pompă)
    await expect(viewSwitch(page).getByRole("link", { name: "Toate variantele" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const low = viewSwitch(page).getByRole("link", { name: /^Stoc mic \(\d+\)$/ });
    await expect(low).toHaveText("Stoc mic (4)");
    await expect(allRow(page, sku(ALGE))).toBeVisible();

    await low.click();
    await expect(page).toHaveURL(/filtru=stoc-mic/);
    await expect(low).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("heading", { level: 2, name: "Variante la stoc mic" }),
    ).toBeVisible();
    // «Doar stoc mic» din filtre e același filtru, nu un al doilea
    await expect(page.getByLabel("Doar stoc mic")).toBeChecked();

    // epuizat, apoi doar rest nevandabil, apoi sub prag cu cei mai puțini pași întâi
    await expect(lowRow(page, sku(ALGE))).toBeVisible();
    expect(await lowOrder(page)).toEqual([sku(ALGE), sku(LINER), sku(BEC), sku(POMPA)]);
    await expect(lowRow(page, sku(ALGE))).toHaveAttribute("data-reason", "out_of_stock");
    await expect(lowRow(page, sku(LINER))).toHaveAttribute("data-reason", "remainder_only");
    await expect(lowRow(page, sku(BEC))).toHaveAttribute("data-reason", "below_threshold");
    await expect(lowRow(page, sku(POMPA))).toHaveAttribute("data-reason", "below_threshold");
    await expect(lowRow(page, sku(ALGE)).locator('[data-cell="reason"]')).toHaveText("Epuizat");
    await expect(lowRow(page, sku(LINER)).locator('[data-cell="reason"]')).toHaveText(
      "Doar rest nevandabil",
    );
    // pragul efectiv și originea lui
    await expect(lowRow(page, sku(BEC)).locator('[data-cell="threshold"]')).toContainText("2 pași");
    await expect(lowRow(page, sku(BEC)).locator('[data-cell="threshold"]')).toContainText(
      "setarea globală",
    );
    // numărătorile pe motiv
    await expect(page.locator('[data-count="out_of_stock"] dd')).toHaveText("1");
    await expect(page.locator('[data-count="remainder_only"] dd')).toHaveText("1");
    await expect(page.locator('[data-count="below_threshold"] dd')).toHaveText("2");
    // nu apar: peste prag, negestionat, digital
    for (const absent of [FILTRU, CAPAC, CARTUS, GHID]) {
      await expect(lowRow(page, sku(absent))).toHaveCount(0);
    }

    // aliasul vechi ?mic=1 duce la aceeași vedere
    await page.goto(`${ALL_URL}&mic=1`);
    await expect(viewSwitch(page).getByRole("link", { name: /^Stoc mic/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(await lowOrder(page)).toEqual([sku(ALGE), sku(LINER), sku(BEC), sku(POMPA)]);

    // meniul Catalog nu are element «Stoc mic»: rămâne cu elementele cerute
    const items = (
      await sidebar(page).locator('[data-nav-group="catalog"] ul').getByRole("link").allInnerTexts()
    )
      .map((name) => name.trim())
      .filter((name) => name !== "Fișe explodate");
    expect(items).toEqual([
      "Produse",
      "Categorii",
      "Branduri",
      "Atribute",
      "Unități de măsură",
      "Stoc",
    ]);
    await expect(sidebar(page).getByRole("link", { name: /Stoc mic/ })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Secțiunile produselor" })).toHaveCount(0);
  });

  test("lista obișnuită: «Prag» doar la variante gestionate; negestionatul și digitalul nu au", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, ALL_URL);
    await expect(allRow(page, sku(ALGE))).toBeVisible();
    for (const managed of [ALGE, BEC, FILTRU, LINER, CAPAC]) {
      await expect(thresholdButton(allRow(page, sku(managed)))).toHaveCount(1);
    }
    for (const other of [CARTUS, GHID]) {
      await expect(thresholdButton(allRow(page, sku(other)))).toHaveCount(0);
    }
  });
});

const alertsRegion = (page: Page) => page.locator("[data-stock-alerts]");
const alertValue = async (page: Page, alert: string): Promise<number> =>
  Number.parseInt(
    (await page.locator(`[data-alert="${alert}"] [data-value]`).innerText()).trim(),
    10,
  );

test.describe("Panoul: cardurile de stoc (punctul 10b)", () => {
  test("Owner vede cele trei carduri, cu numere și legături spre vederea «Stoc mic»; meniul nu are element nou", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin");
    await expect(page.getByRole("heading", { level: 1, name: "Panou de control" })).toBeVisible();
    await expect(alertsRegion(page).getByRole("heading", { name: "Alerte de stoc" })).toBeVisible();

    // numărătorile sunt pe tot depozitul (și produsele altor teste): cel puțin ce a pus acest fișier (Alge, Liner, Bec, Pompă)
    expect(await alertValue(page, "low-stock")).toBeGreaterThanOrEqual(4);
    expect(await alertValue(page, "remainder")).toBeGreaterThanOrEqual(1);
    await expect(page.locator('[data-alert="low-stock"]')).toHaveAttribute(
      "href",
      "/admin/produse/stoc?filtru=stoc-mic",
    );
    await expect(page.locator('[data-alert="remainder"]')).toHaveAttribute(
      "href",
      "/admin/produse/stoc?filtru=stoc-mic&motiv=rest-nevandabil",
    );
    await expect(page.locator('[data-alert="snapshot"]')).toHaveAttribute(
      "href",
      "/admin/produse/stoc",
    );
    await expect(page.locator('[data-alert="snapshot"]')).toContainText("Poza SmartBill");

    // meniul rămâne neschimbat: niciun «Stoc mic» în el
    await expect(sidebar(page).getByRole("link", { name: /Stoc mic/ })).toHaveCount(0);
  });

  test("cardul «Stoc mic» duce în vederea «Stoc mic»; «Doar rest nevandabil» o filtrează pe motiv; cardurile vederii comută motivul", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin");

    await page.locator('[data-alert="low-stock"]').click();
    await expect(page).toHaveURL(/\/admin\/produse\/stoc\?filtru=stoc-mic$/);
    await expect(
      page.getByRole("heading", { level: 2, name: "Variante la stoc mic" }),
    ).toBeVisible();
    await expect(viewSwitch(page).getByRole("link", { name: /^Stoc mic/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator('[data-count="out_of_stock"] a')).not.toHaveAttribute(
      "aria-current",
      "page",
    );

    // din Panou: doar restul nevandabil (același filtru, plus motivul)
    await page.goto("/admin");
    await page.locator('[data-alert="remainder"]').click();
    await expect(page).toHaveURL(/filtru=stoc-mic&motiv=rest-nevandabil$/);
    await expect(lowRow(page, sku(LINER))).toBeVisible();
    const reasons = await page
      .locator("[data-low-row]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-reason")));
    expect(reasons.length).toBeGreaterThan(0);
    expect(new Set(reasons)).toEqual(new Set(["remainder_only"]));
    await expect(page.locator('[data-count="remainder_only"] a')).toHaveAttribute(
      "aria-current",
      "page",
    );
    // comutatorul păstrează numărul total (numărătorile nu depind de motivul ales)
    await expect(viewSwitch(page).getByRole("link", { name: /^Stoc mic/ })).toHaveText(
      new RegExp("^Stoc mic \\(\\d+\\)$"),
    );

    // alt motiv: epuizate (Alge); al doilea clic pe cel activ le arată din nou pe toate
    await page.locator('[data-count="out_of_stock"] a').click();
    await expect(page).toHaveURL(/motiv=epuizat$/);
    await expect(lowRow(page, sku(ALGE))).toBeVisible();
    await expect(lowRow(page, sku(LINER))).toHaveCount(0);
    await page.locator('[data-count="out_of_stock"] a').click();
    await expect(page).toHaveURL(/\/admin\/produse\/stoc\?filtru=stoc-mic$/);
    await expect(lowRow(page, sku(LINER))).toBeVisible();
    await expect(lowRow(page, sku(ALGE))).toBeVisible();

    // comutatorul scoate motivul: din «rest nevandabil» înapoi în toată vederea, apoi în toate variantele
    await page.locator('[data-count="remainder_only"] a').click();
    await expect(page).toHaveURL(/motiv=rest-nevandabil$/);
    await viewSwitch(page).getByRole("link", { name: "Toate variantele" }).click();
    await expect(page).toHaveURL(/\/admin\/produse\/stoc$/);
  });

  test("fără inventory.read nu există carduri (Editor, Suport, Contabil); Depozit le vede", async ({
    page,
    request,
    baseURL,
  }) => {
    for (const role of ["editor", "support", "accountant"]) {
      const account = await createAccount(request, baseURL as string, role);
      await login(page, account, "/admin");
      await expect(
        page.getByRole("heading", { level: 1, name: "Panou de control" }),
        role,
      ).toBeVisible();
      await expect(alertsRegion(page), role).toHaveCount(0);
      await expect(page.locator("[data-alert]"), role).toHaveCount(0);
      await page.context().clearCookies();
    }
    const warehouse = await createAccount(request, baseURL as string, "warehouse");
    await login(page, warehouse, "/admin");
    await expect(alertsRegion(page)).toBeVisible();
    await expect(page.locator("[data-alert]")).toHaveCount(3);
  });
});

test.describe("dialogul «Prag stoc mic»", () => {
  test("setează pragul propriu și apoi îl șterge (setarea globală): rândul apare/iese din vedere, cu audit înainte/după", async ({
    page,
    request,
    baseURL,
  }) => {
    failOnNativeDialog(page);
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, ALL_URL);
    const variantId = (await readE2eStock(sku(FILTRU)))?.variantId as string;
    await expect(allRow(page, sku(FILTRU))).toBeVisible();

    // 3 pași, prag global 2: nu e la stoc mic; cu pragul propriu 3 intră
    await openThreshold(page, allRow(page, sku(FILTRU)));
    await expect(thresholdDialog(page)).toContainText("Acum: 2 pași (setarea globală).");
    await expect(value(page)).toHaveValue("");
    await value(page).fill("3");
    await thresholdDialog(page).getByRole("button", { name: "Salvează" }).click();
    await expect(thresholdDialog(page).locator("[data-saved]")).toContainText("este acum 3 pași");
    await expect.poll(async () => (await readE2eStock(sku(FILTRU)))?.lowStockSteps).toBe(3);
    const audit = await readE2eStockAudit(variantId, "stock.threshold.update");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      outcome: "success",
      actorLabel: owner.email,
      before: { lowStockSteps: null },
      after: { lowStockSteps: 3 },
    });
    await thresholdDialog(page)
      .getByRole("button", { name: "Închide", exact: true })
      .first()
      .click();
    await expect(thresholdDialog(page)).toHaveCount(0);

    // vederea «Stoc mic»: acum 5, iar Filtru e ultimul (3 pași)
    await page.goto(LOW_URL);
    await expect(lowRow(page, sku(FILTRU))).toBeVisible();
    expect(await lowOrder(page)).toEqual([
      sku(ALGE),
      sku(LINER),
      sku(BEC),
      sku(POMPA),
      sku(FILTRU),
    ]);
    await expect(lowRow(page, sku(FILTRU)).locator('[data-cell="threshold"]')).toContainText(
      "propriu",
    );
    await expect(viewSwitch(page).getByRole("link", { name: /^Stoc mic/ })).toHaveText(
      "Stoc mic (5)",
    );

    // ștergerea pragului propriu (gol) revine la setarea globală: iese din vedere
    await openThreshold(page, lowRow(page, sku(FILTRU)));
    await expect(thresholdDialog(page)).toContainText("Acum: 3 pași (propriu).");
    await expect(value(page)).toHaveValue("3");
    await value(page).fill("");
    await thresholdDialog(page).getByRole("button", { name: "Salvează" }).click();
    await expect(thresholdDialog(page).locator("[data-saved]")).toContainText(
      "folosește acum setarea globală (2 pași)",
    );
    await expect.poll(async () => (await readE2eStock(sku(FILTRU)))?.lowStockSteps).toBeNull();
    const after = await readE2eStockAudit(variantId, "stock.threshold.update");
    expect(after).toHaveLength(2);
    expect(after[1]).toMatchObject({
      before: { lowStockSteps: 3 },
      after: { lowStockSteps: null },
    });
    await thresholdDialog(page)
      .getByRole("button", { name: "Închide", exact: true })
      .first()
      .click();
    // lista se reîmprospătează la închiderea dialogului (fără reîncărcarea paginii): Filtru a ieșit din vedere
    await expect(lowRow(page, sku(FILTRU))).toHaveCount(0);
    await expect(viewSwitch(page).getByRole("link", { name: /^Stoc mic/ })).toHaveText(
      "Stoc mic (4)",
    );
    await page.goto(LOW_URL);
    await expect(lowRow(page, sku(ALGE))).toBeVisible();
    await expect(lowRow(page, sku(FILTRU))).toHaveCount(0);
  });

  test("aceeași valoare: «nimic nu s-a schimbat» și niciun eveniment de audit", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, LOW_URL);
    const variantId = (await readE2eStock(sku(BEC)))?.variantId as string;
    await expect(lowRow(page, sku(BEC))).toBeVisible();
    await openThreshold(page, lowRow(page, sku(BEC)));
    await thresholdDialog(page).getByRole("button", { name: "Salvează" }).click();
    await expect(thresholdDialog(page).locator("[data-saved]")).toContainText(
      "Pragul era deja acesta; nimic nu s-a schimbat.",
    );
    expect(await readE2eStockAudit(variantId, "stock.threshold.update")).toHaveLength(0);
    expect((await readE2eStock(sku(BEC)))?.lowStockSteps).toBeNull();
  });

  test("validări proprii în română (fără baloane native): zecimale, text, negativ, peste 1000; nimic nu se salvează", async ({
    page,
    request,
    baseURL,
  }) => {
    failOnNativeDialog(page);
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, LOW_URL);
    const variantId = (await readE2eStock(sku(BEC)))?.variantId as string;
    await expect(lowRow(page, sku(BEC))).toBeVisible();
    await openThreshold(page, lowRow(page, sku(BEC)));
    await expect(thresholdDialog(page).locator("form")).toHaveAttribute("novalidate", "");

    for (const [typed, message] of [
      ["2,5", "Pragul e în pași întregi: nu poate avea zecimale."],
      ["abc", "Scrie un număr întreg de pași (de exemplu 2), sau lasă gol."],
      ["-1", "Scrie un număr întreg de pași (de exemplu 2), sau lasă gol."],
      ["1001", "Pragul poate fi între 0 și 1000 de pași."],
    ] as const) {
      await value(page).fill(typed);
      await thresholdDialog(page).getByRole("button", { name: "Salvează" }).click();
      await expect(thresholdDialog(page)).toContainText(message);
      await expect(value(page)).toHaveAttribute("aria-invalid", "true");
      await expect(value(page)).toBeFocused();
    }
    // dialogul a rămas deschis, iar nimic nu s-a scris
    await expect(thresholdDialog(page).locator("[data-saved]")).toHaveCount(0);
    expect((await readE2eStock(sku(BEC)))?.lowStockSteps).toBeNull();
    expect(await readE2eStockAudit(variantId, "stock.threshold.update")).toHaveLength(0);
    // «Renunță» închide fără să salveze
    await thresholdDialog(page).getByRole("button", { name: "Renunță" }).click();
    await expect(thresholdDialog(page)).toHaveCount(0);
  });

  test("Depozit poate seta pragul; auditul poartă contul lui", async ({
    page,
    request,
    baseURL,
  }) => {
    const warehouse = await createAccount(request, baseURL as string, "warehouse");
    await login(page, warehouse, LOW_URL);
    const variantId = (await readE2eStock(sku(POMPA)))?.variantId as string;
    await expect(lowRow(page, sku(POMPA))).toBeVisible();
    await openThreshold(page, lowRow(page, sku(POMPA)));
    await value(page).fill("4");
    await thresholdDialog(page).getByRole("button", { name: "Salvează" }).click();
    await expect(thresholdDialog(page).locator("[data-saved]")).toBeVisible();
    await expect.poll(async () => (await readE2eStock(sku(POMPA)))?.lowStockSteps).toBe(4);
    const audit = await readE2eStockAudit(variantId, "stock.threshold.update");
    expect(audit[0]).toMatchObject({ actorLabel: warehouse.email, after: { lowStockSteps: 4 } });
  });

  test("pragul 0 înseamnă doar la epuizare: varianta cu 1 pas iese din vedere, iar numărătoarea scade", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, LOW_URL);
    await expect(lowRow(page, sku(BEC))).toBeVisible();
    await expect(page.locator('[data-count="below_threshold"] dd')).toHaveText("2");
    await openThreshold(page, lowRow(page, sku(BEC)));
    await value(page).fill("0");
    await thresholdDialog(page).getByRole("button", { name: "Salvează" }).click();
    await expect(thresholdDialog(page).locator("[data-saved]")).toContainText("este acum 0 pași");
    await expect.poll(async () => (await readE2eStock(sku(BEC)))?.lowStockSteps).toBe(0);
    await thresholdDialog(page)
      .getByRole("button", { name: "Închide", exact: true })
      .first()
      .click();
    await page.goto(LOW_URL);
    await expect(lowRow(page, sku(ALGE))).toBeVisible();
    await expect(lowRow(page, sku(BEC))).toHaveCount(0);
    await expect(page.locator('[data-count="below_threshold"] dd')).toHaveText("1");
  });
});

test.describe("«Ajustează» din vederea «Stoc mic»", () => {
  test("confirmarea rămâne vizibilă după salvare; la închidere lista se reîmprospătează și rândul iese din vedere", async ({
    page,
    request,
    baseURL,
  }) => {
    failOnNativeDialog(page);
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, LOW_URL);
    await expect(lowRow(page, sku(POMPA))).toBeVisible();
    await expect(page.locator('[data-count="below_threshold"] dd')).toHaveText("1");
    const adjust = lowRow(page, sku(POMPA)).getByRole("button", { name: /^Ajustează stocul:/ });
    const dialog = page.getByRole("dialog", { name: /^Ajustează stocul:/ });
    await expect(async () => {
      if (!(await dialog.isVisible())) await adjust.click();
      await expect(dialog).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await dialog.getByLabel("Motiv", { exact: true }).selectOption({ label: "Recepție marfă" });
    await dialog.getByLabel("Cantitate", { exact: true }).fill("10");
    await dialog.getByLabel("Text (obligatoriu)").fill("recepție E2E stoc mic");
    await dialog.getByRole("button", { name: "Salvează" }).click();
    // 2 → 12 pași, peste pragul 4: rândul trebuie să iasă din listă, dar mesajul de confirmare rămâne
    await expect(dialog.locator("[data-saved]")).toBeVisible();
    await expect.poll(async () => (await readE2eStock(sku(POMPA)))?.physical).toBe("120000");
    await expect(lowRow(page, sku(POMPA))).toBeVisible();
    await dialog.getByRole("button", { name: "Închide", exact: true }).first().click();
    await expect(dialog).toHaveCount(0);
    await expect(lowRow(page, sku(POMPA))).toHaveCount(0);
    await expect(page.locator('[data-count="below_threshold"] dd')).toHaveText("0");
  });
});

test.describe("telefon", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("vederea «Stoc mic» încape pe ecran: tabelul se derulează în interiorul lui, pagina nu, iar «Prag» rămâne accesibil", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, LOW_URL);
    await expect(lowRow(page, sku(ALGE))).toBeVisible();
    await expect(viewSwitch(page)).toBeVisible();
    const metrics = await page.evaluate(() => {
      const table = document.querySelector(
        'table[aria-label="Variantele la stoc mic"]',
      ) as HTMLElement;
      const box = table.parentElement as HTMLElement;
      return {
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        tableOverflow: box.scrollWidth - box.clientWidth,
      };
    });
    expect(metrics.pageOverflow).toBeLessThanOrEqual(0);
    expect(metrics.tableOverflow).toBeGreaterThan(0);
    // pe telefon textul butonului se ascunde, dar eticheta pentru cititoarele de ecran rămâne
    await expect(thresholdButton(lowRow(page, sku(ALGE)))).toBeVisible();
  });

  test("Panoul: cardurile de stoc se așază unul sub altul și pagina nu iese din ecran", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    await login(page, owner, "/admin");
    await expect(alertsRegion(page)).toBeVisible();
    const metrics = await page.evaluate(() => {
      const cards = [...document.querySelectorAll("[data-alert]")].map((card) =>
        card.getBoundingClientRect(),
      );
      return {
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        sameColumn: cards.every((box) => Math.abs(box.left - (cards[0]?.left ?? 0)) < 1),
        count: cards.length,
      };
    });
    expect(metrics.count).toBe(3);
    expect(metrics.pageOverflow).toBeLessThanOrEqual(0);
    expect(metrics.sameColumn).toBe(true);
  });
});

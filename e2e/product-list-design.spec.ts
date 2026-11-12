import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  lengthenE2eSkus,
  linkE2eProductsToCatalogRefs,
  promoteE2eUser,
  removeE2eCatalogRefs,
  removeE2eProducts,
  removeE2eStock,
  removeE2eStockShared,
  seedE2eCatalogRefs,
  seedE2eProducts,
  seedE2eStock,
  setE2eStockSnapshot,
  trashE2eProducts,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Redesign admin, Lotul 2a (docs/17): lista de produse. Titlu cu număr, vederile ca tab-uri (Produse / Coș de gunoi), bara de
 * unelte (Exportă, Importă, Produs nou), etichete de filtru eliminabile, tabelul pe componenta `Table` (antet gri, rând compact,
 * cifre tabulare, stări ca pastile, priorități de coloane), paginarea cu «rânduri pe pagină» și modul stivuit pe telefon.
 * Comportamentul (căutare, editare inline, acțiuni în masă, ciclul de viață) rămâne în `products.spec.ts` și
 * `product-lifecycle.spec.ts`. Produsele de probă au adresa `e2e-<tag>-NN` și se șterg la final.
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
const LIST = `/admin/produse?q=${encodeURIComponent(search)}&sort=title_asc`;
const TOTAL = 30;
const TRASHED = [28, 29, 30];
let account: Account;
let titles: string[] = [];

// produse gestionate, negestionate și digitale, într-o listă separată (căutare proprie): celula Stoc și rândurile lor
const stockTag = randomBytes(3).toString("hex");
const searchStock = `E2E ${stockTag}`;
const LIST_STOCK = `/admin/produse?q=${encodeURIComponent(searchStock)}&sort=title_asc`;
/** SKU-ul complet al produsului `n` după `lengthenE2eSkus` (primele 3 produse). */
const skuOf = (n: number) =>
  `E2E-${tag.toUpperCase()}-${String(n).padStart(2, "0")}-RAFT-ACCESORIU-LUNG`;

const slugOf = (n: number) => `e2e-${tag}-${String(n).padStart(2, "0")}`;

test.beforeAll(async ({ request, baseURL }) => {
  account = await createAccount(request, baseURL as string, "owner");
  titles = await seedE2eProducts(tag, TOTAL);
  await trashE2eProducts(TRASHED.map(slugOf));
  // primele 3 produse au brand și categorie (linia de sub titlu e atunci lungă, ca în date reale)
  await seedE2eCatalogRefs(tag);
  await linkE2eProductsToCatalogRefs([1, 2, 3].map(slugOf), tag);
  // SKU-uri lungi pe primele 3 produse: coloana SKU se lărgește și ar strânge coloana Produs fără o lățime proprie
  await lengthenE2eSkus([1, 2, 3].map(slugOf));
  await seedE2eStock(
    stockTag,
    [
      {
        title: `Liner ${searchStock}`,
        unit: { symbol: "mp", decimals: 2 },
        step: "41,25",
        variants: [{ sku: "L", physical: "17,5" }],
      },
      {
        title: `Bisulfat ${searchStock}`,
        unit: { symbol: "kg", decimals: 0 },
        step: "25",
        variants: [{ sku: "K", physical: "80" }],
      },
      {
        title: `Cartuș ${searchStock}`,
        manageStock: false,
        stockStatus: "outofstock",
        variants: [{ sku: "R", physical: null }],
      },
      {
        title: `Ghid ${searchStock}`,
        type: "digital",
        manageStock: false,
        variants: [{ sku: "G", physical: null }],
      },
    ],
    { asOfHoursAgo: 3 },
  );
  await setE2eStockSnapshot(3);
});

test.afterAll(async () => {
  await removeE2eProducts();
  await removeE2eCatalogRefs();
  await removeE2eStock({ tag: stockTag });
  await removeE2eStockShared();
});

const css = (locator: Locator, property: string) =>
  locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);

/**
 * Butoanele principale vizibile ale paginii (fundal `--action`): culoarea se citește dintr-un element-sondă cu clasa `bg-action`, în
 * suprafața adminului. Întoarce numele lor (text sau aria-label).
 */
async function primaryControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "bg-action";
    (document.querySelector('[data-surface="admin"]') ?? document.body).append(probe);
    const primary = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const names: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('button, a, [role="button"]')) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (getComputedStyle(el).backgroundColor !== primary) continue;
      names.push((el.getAttribute("aria-label") ?? el.textContent ?? "").trim());
    }
    return names;
  });
}

/** Nici regiunea tabelului, nici pagina nu derulează pe orizontală (scrollWidth ≤ clientWidth). */
async function expectNoHorizontalScroll(page: Page, table: Locator) {
  const scroller = table.locator("xpath=..");
  const [tableOverflow, pageOverflow] = await Promise.all([
    scroller.evaluate((el) => el.scrollWidth - el.clientWidth),
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ]);
  expect(tableOverflow, "derulare orizontală în regiunea tabelului (px)").toBeLessThanOrEqual(0);
  expect(pageOverflow, "derulare orizontală a paginii (px)").toBeLessThanOrEqual(0);
}

const rowOf = (page: Page, n: number) => page.locator(`[data-product-title="${titles[n - 1]}"]`);
const tableOf = (page: Page) => page.getByRole("table", { name: "Lista produselor" });

test.describe("lista de produse, pe componentele din docs/17", () => {
  test("titlul cu număr, vederile ca tab-uri și bara de unelte (Exportă, Importă, Produs nou)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, LIST);
    // «Produse (27)»: numărul produselor active care corespund căutării (3 sunt în coșul de gunoi)
    await expect(
      page.getByRole("heading", { level: 1, name: `Produse (${TOTAL - TRASHED.length})` }),
    ).toBeVisible();
    await expect(page.locator("[data-product-total]")).toHaveText(
      `${TOTAL - TRASHED.length} de produse`,
    );

    // vederile: tab-uri-legături cu linie de 2 px pe cel activ și aria-current; coșul de gunoi are adresa lui
    const nav = page.getByRole("navigation", { name: "Vedere" });
    const active = nav.getByRole("link", { name: "Produse", exact: true });
    const trash = nav.getByRole("link", { name: "Coș de gunoi", exact: true });
    await expect(active).toHaveAttribute("aria-current", "page");
    expect(await css(active, "border-bottom-width")).toBe("2px");
    expect(await css(trash, "border-bottom-color")).toBe("rgba(0, 0, 0, 0)");
    await trash.click();
    await expect(page).toHaveURL(/view=deleted/);
    // tab-ul duce la tot coșul (fără căutare): numărul depinde de ce au șters și alte teste, deci aici doar formatul
    await expect(page.getByRole("heading", { level: 1, name: /^Produse \(\d+\)$/ })).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Vedere" })
        .getByRole("link", { name: "Coș de gunoi", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    // cu căutarea în adresă, numărul exact: cele 3 produse de probă din coș
    await page.goto(`/admin/produse?view=deleted&q=${encodeURIComponent(search)}`);
    await expect(
      page.getByRole("heading", { level: 1, name: `Produse (${TRASHED.length})` }),
    ).toBeVisible();
    // în coșul de gunoi: Restaurează și Șterge definitiv, cu nume accesibil, pe fiecare rând
    const trashed = rowOf(page, TRASHED[0] as number);
    await expect(
      trashed.getByRole("button", { name: `Restaurează: ${titles[(TRASHED[0] as number) - 1]}` }),
    ).toBeVisible();
    await expect(trashed.getByRole("button", { name: /^Șterge definitiv/ })).toBeVisible();

    // bara de unelte: Exportă, Import produse, Produs nou (acțiunea principală, ultima), toate deasupra tabelului
    await page.goto(LIST);
    const toolbar = page.locator("[data-product-toolbar]");
    const entries = toolbar.locator("button, a");
    await expect(entries).toHaveText([/Exportă/, "Import produse", "Produs nou"]);
    const boxes = await Promise.all(
      [0, 1, 2].map(async (i) => (await entries.nth(i).boundingBox()) ?? { x: 0, y: 0 }),
    );
    expect(boxes[0]?.x).toBeLessThan(boxes[1]?.x ?? 0);
    expect(boxes[1]?.x).toBeLessThan(boxes[2]?.x ?? 0);
    // singurul buton principal (fundal închis) e «Produs nou»; Exportă și Importă sunt secundare (fundal alb)
    const primary = await css(entries.nth(2), "background-color");
    expect(await css(entries.nth(0), "background-color")).not.toBe(primary);
    expect(await css(entries.nth(1), "background-color")).not.toBe(primary);
    // și nu mai există o bară separată de export deasupra tabelului
    await expect(page.locator("[data-export-toolbar]")).toHaveCount(0);
  });

  test("Exportă din bara de unelte folosește selecția din tabel", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, LIST);
    await page.getByRole("checkbox", { name: `Selectează ${titles[0]}` }).check();
    await page
      .locator("[data-product-toolbar]")
      .getByRole("button", { name: /Exportă/ })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // domeniul implicit cu o selecție: produsele selectate (1)
    await expect(dialog.getByRole("radio", { name: "Produsele selectate (1)" })).toBeChecked();

    // selecția e a paginii curente: după trecerea la pagina 2, «Exportă» nu mai primește produsul selectat pe pagina 1
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page
      .getByRole("navigation", { name: "Paginare" })
      .getByRole("link", { name: "Pagina 2" })
      .click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.locator("[data-product-row]")).toHaveCount(TOTAL - TRASHED.length - 25);
    await page
      .locator("[data-product-toolbar]")
      .getByRole("button", { name: /Exportă/ })
      .click();
    await expect(
      page.getByRole("dialog").getByRole("radio", { name: /nu ai selectat niciunul/ }),
    ).toBeDisabled();
  });

  test("tabelul: antet gri, rând de cel mult 56 px, cifre tabulare la dreapta, stări ca pastile, coloanele de la 1440 px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, LIST);
    const table = tableOf(page);
    for (const name of ["Produs", "SKU", "Preț", "Stare", "Stoc", "Livrare", "Modificat"]) {
      await expect(table.getByRole("columnheader", { name, exact: true }), name).toBeVisible();
    }
    await expectNoHorizontalScroll(page, table);
    expect(await css(table.locator("thead"), "background-color")).not.toBe("rgba(0, 0, 0, 0)");
    expect(await css(table.getByRole("columnheader", { name: "Preț" }), "font-size")).toBe("12px");
    expect(await css(table.getByRole("columnheader", { name: "Preț" }), "text-align")).toBe(
      "right",
    );

    // rândul: 48–56 px cu numele pe un singur rând; prețul la dreapta, cifre tabulare, nu se rupe
    const first = rowOf(page, 5);
    const height = (await first.boundingBox())?.height ?? 0;
    expect(height, "înălțimea rândului").toBeGreaterThanOrEqual(48);
    expect(height, "înălțimea rândului").toBeLessThanOrEqual(56);
    const price = first.locator('[data-cell="price"]');
    expect(await css(price, "text-align")).toBe("right");
    expect(await css(price, "font-variant-numeric")).toContain("tabular-nums");
    expect(await css(price, "white-space")).toBe("nowrap");
    // titlul nu se strânge: coloana Produs primește loc, deci titlul rămâne pe un singur rând chiar și când produsul are brand și
    // categorie (linia de sub titlu e atunci lungă și se poate rupe pe mai multe rânduri: asta nu face titlul să se rupă)
    for (const n of [1, 2, 3]) {
      const linked = rowOf(page, n);
      const title = linked.getByRole("link", { name: `Deschide produsul ${titles[n - 1]}` });
      expect(
        (await title.boundingBox())?.height ?? 99,
        `titlul ${n} pe un singur rând`,
      ).toBeLessThanOrEqual(24);
      expect(
        (await linked.locator('th[scope="row"]').boundingBox())?.width ?? 0,
        "lățimea coloanei Produs",
      ).toBeGreaterThanOrEqual(240); // lățimea depinde și de cifrele datei «Modificat» (12.11 e mai lată decât 11.11): marja de 20 px
    }
    // fără linii verticale între celule
    expect(await css(price, "border-left-width")).toBe("0px");

    // starea ca pastilă (rază mare, text scris); ciorna și activul au tonuri diferite
    const draft = first.locator('[data-cell="status"] [data-status-pill]');
    const activeRow = rowOf(page, 3).locator('[data-cell="status"] [data-status-pill]');
    await expect(draft).toHaveText("Ciornă");
    await expect(activeRow).toHaveText("Activ");
    expect(await css(draft, "border-top-left-radius")).not.toBe("0px");
    expect(await css(draft, "background-color")).not.toBe(await css(activeRow, "background-color"));

    // imaginea (sau locul ei gol) are 32 px, titlul e o legătură spre editor și nu mai există legătura separată «Deschide»
    const link = first.getByRole("link", { name: `Deschide produsul ${titles[4]}` });
    await expect(link).toHaveText(titles[4] as string);
    await expect(first.getByText("Deschide", { exact: true })).toHaveCount(0);
    const thumb = first.locator("[data-product-thumb]");
    expect((await thumb.boundingBox())?.width).toBe(32);
  });

  test("1280 px: apar SKU și Stoc, se ascund Livrare și Modificat; 1024 px: doar Produs, Preț, Stare și Acțiuni; fără derulare orizontală", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page, account, LIST);
    const table = tableOf(page);
    await expectNoHorizontalScroll(page, table);
    for (const name of ["SKU", "Stoc"]) {
      await expect(table.getByRole("columnheader", { name, exact: true }), name).toBeVisible();
    }
    for (const name of ["Livrare", "Modificat"]) {
      await expect(table.getByRole("columnheader", { name, exact: true }), name).toBeHidden();
    }
    const height = (await rowOf(page, 5).boundingBox())?.height ?? 0;
    expect(height).toBeLessThanOrEqual(56);

    await page.setViewportSize({ width: 1024, height: 768 });
    await expectNoHorizontalScroll(page, table);
    for (const name of ["Produs", "Preț", "Stare"]) {
      await expect(table.getByRole("columnheader", { name, exact: true }), name).toBeVisible();
    }
    for (const name of ["SKU", "Stoc", "Livrare", "Modificat"]) {
      await expect(table.getByRole("columnheader", { name, exact: true }), name).toBeHidden();
    }
    // informația unei coloane ascunse rămâne la un clic distanță: titlul duce la editor, unde sunt SKU-ul, stocul și livrarea
    await expect(
      rowOf(page, 1).getByRole("link", { name: `Deschide produsul ${titles[0]}` }),
    ).toBeVisible();
  });

  test("filtrele active apar ca etichete eliminabile; ștergerea lor readuce lista; fără rezultate: stare goală cu o singură acțiune", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, `${LIST}&status=active`);
    const chips = page.getByRole("list", { name: "Filtre active" });
    await expect(
      chips.getByRole("link", { name: `Elimină filtrul Căutare: ${search}` }),
    ).toBeVisible();
    await expect(chips.getByRole("link", { name: "Elimină filtrul Stare: Activ" })).toBeVisible();
    const filtered = Number((await page.locator("[data-product-total]").innerText()).split(" ")[0]);
    await chips.getByRole("link", { name: "Elimină filtrul Stare: Activ" }).click();
    await expect(page).not.toHaveURL(/status=/);
    await expect(page.getByRole("link", { name: /Elimină filtrul Stare/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Elimină filtrul Căutare/ })).toBeVisible();
    // lista s-a lărgit: erau doar produsele active
    const widened = Number((await page.locator("[data-product-total]").innerText()).split(" ")[0]);
    expect(widened).toBeGreaterThan(filtered);

    // o căutare fără rezultate: stare goală cu un titlu și o singură acțiune, care readuce lista
    await page.goto(`/admin/produse?q=${encodeURIComponent(`nimic-${tag}`)}`);
    await expect(
      page.getByRole("heading", { name: "Niciun produs nu corespunde căutării sau filtrelor." }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Șterge filtrele" }).click();
    await expect(page).toHaveURL(/\/admin\/produse$/);
    await expect(
      page.getByRole("heading", { name: "Niciun produs nu corespunde căutării sau filtrelor." }),
    ).toHaveCount(0);
  });

  test("paginare: numere cu pagina curentă, «rânduri pe pagină» care păstrează filtrul, bara rămâne la 50", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    // 30 de produse de probă (3 în coș): vederea «Coș de gunoi» nu intră; aici 27 active → 2 pagini cu 25 pe pagină
    await login(page, account, LIST);
    const rows = page.locator("[data-product-row]");
    await expect(rows).toHaveCount(25);
    const nav = page.getByRole("navigation", { name: "Paginare" });
    await expect(nav.locator('[aria-current="page"]')).toHaveText("1");
    await expect(nav.getByRole("link", { name: "Pagina 2" })).toBeVisible();
    const size = nav.getByLabel("Rânduri pe pagină");
    await expect(size).toHaveValue("25");
    // «Pe pagină» a ieșit din formularul de filtre (e în bara de paginare)
    await expect(page.getByRole("search").getByLabel("Pe pagină")).toHaveCount(0);

    // 50 pe pagină: o singură pagină, căutarea rămâne, bara rămâne ca să te poți întoarce la 25
    await expect(async () => {
      await size.selectOption("50");
      await expect(page).toHaveURL(/size=50/, { timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    await expect(page).toHaveURL(/q=E2E/);
    await expect(rows).toHaveCount(TOTAL - TRASHED.length);
    const nav50 = page.getByRole("navigation", { name: "Paginare" });
    await expect(nav50.getByLabel("Rânduri pe pagină")).toHaveValue("50");
    await expect(nav50.getByRole("link", { name: "Pagina 2" })).toHaveCount(0);

    // înapoi la 25: parametrul dispare (25 e implicit); pagina 2 prin legătură numerotată
    await nav50.getByLabel("Rânduri pe pagină").selectOption("25");
    await expect(page).not.toHaveURL(/size=/);
    await expect(rows).toHaveCount(25);
    await page
      .getByRole("navigation", { name: "Paginare" })
      .getByRole("link", { name: "Pagina 2" })
      .click();
    await expect(page).toHaveURL(/page=2/);
    await expect(rows).toHaveCount(TOTAL - TRASHED.length - 25);
  });

  test("acțiunile în masă: bara apare la selecție, fără bordură colorată, și se închide cu «Deselectează tot»", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, LIST);
    await expect(page.locator("[data-bulk-bar]")).toHaveCount(0);
    await page.getByRole("checkbox", { name: `Selectează ${titles[0]}` }).check();
    await page.getByRole("checkbox", { name: `Selectează ${titles[1]}` }).check();
    const bar = page.locator("[data-bulk-bar]");
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("2 produse selectate");
    // fond propriu din tokeni, fără bordură
    expect(await css(bar, "background-color")).not.toBe("rgba(0, 0, 0, 0)");
    expect(await css(bar, "border-top-width")).toBe("0px");
    await bar.getByRole("button", { name: "Deselectează tot" }).click();
    await expect(page.locator("[data-bulk-bar]")).toHaveCount(0);
  });

  test("un singur buton principal pe pagina Produse, în toate stările (listă, selecție, filtre, coș); Panou și Stoc au cel mult unul", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, LIST);
    // lista simplă
    expect(await primaryControls(page), "lista").toEqual(["Produs nou"]);
    // cu rânduri bifate (banda de acțiuni în masă are propriul «Aplică…», dar nu mai e un al doilea buton principal)
    await page.getByRole("checkbox", { name: `Selectează ${titles[0]}` }).check();
    await expect(page.locator("[data-bulk-bar]")).toBeVisible();
    expect(await primaryControls(page), "cu selecție").toEqual(["Produs nou"]);
    // cu filtre active și în coșul de gunoi
    await page.goto(`${LIST}&status=active`);
    expect(await primaryControls(page), "cu filtre").toEqual(["Produs nou"]);
    await page.goto(`/admin/produse?view=deleted&q=${encodeURIComponent(search)}`);
    expect(await primaryControls(page), "coș").toEqual(["Produs nou"]);
    // «Caută» e buton secundar: fundal alb și bordură
    await page.goto(LIST);
    const search1 = page.getByRole("button", { name: "Caută", exact: true });
    expect(await css(search1, "border-top-width")).not.toBe("0px");

    // celelalte ecrane migrate: Panou și Stoc au cel mult un buton principal
    for (const url of ["/admin", "/admin/produse/stoc"]) {
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      expect(
        (await primaryControls(page)).length,
        `butoane principale pe ${url}`,
      ).toBeLessThanOrEqual(1);
    }
  });

  test("creioanele de editare: pe dispozitive cu cursor apar la hover sau la focus pe rând; numele accesibile rămân", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, LIST);
    expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(true);
    const row = rowOf(page, 5);
    const icons = row.locator("svg[data-edit-icon]");
    // titlu, preț, stare (produsul e negestionat? nu: stocul se editează doar la produsele negestionate)
    expect(await icons.count()).toBeGreaterThanOrEqual(3);
    const opacities = async () =>
      Promise.all((await icons.all()).map((icon) => css(icon, "opacity")));
    await page.mouse.move(0, 0);
    await expect
      .poll(opacities, { message: "fără hover" })
      .toEqual(Array(await icons.count()).fill("0"));
    // hover pe rând: toate creioanele rândului apar
    await row.hover();
    await expect
      .poll(opacities, { message: "hover pe rând" })
      .toEqual(Array(await icons.count()).fill("1"));
    // doar rândul cu cursorul: celălalt rând rămâne curat
    const other = rowOf(page, 6).locator("svg[data-edit-icon]").first();
    expect(await css(other, "opacity")).toBe("0");
    // cu tastatura: focus pe un buton al rândului arată creioanele (și cu mouse-ul în altă parte)
    await page.mouse.move(0, 0);
    await row.getByRole("button", { name: `Editează prețul pentru ${titles[4]}` }).focus();
    await expect
      .poll(opacities, { message: "focus pe rând" })
      .toEqual(Array(await icons.count()).fill("1"));
    // numele accesibile și selectorii pe rol rămân valizi chiar și cu creioanele ascunse
    await page.mouse.move(0, 0);
    await row.getByRole("button", { name: `Editează starea pentru ${titles[4]}` }).click();
    await expect(page.getByLabel(`Editează starea pentru ${titles[4]}`)).toBeVisible();
  });

  test("creioanele de editare: pe ecrane tactile (fără hover) rămân vizibile", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL: baseURL as string,
      hasTouch: true,
      isMobile: true,
      viewport: { width: 1280, height: 800 },
    });
    try {
      const page = await context.newPage();
      await login(page, account, LIST);
      expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(false);
      const icons = rowOf(page, 5).locator("svg[data-edit-icon]");
      await expect(icons.first()).toBeVisible();
      for (const icon of await icons.all()) {
        expect(await css(icon, "opacity")).toBe("1");
      }
    } finally {
      await context.close();
    }
  });

  test.describe("celula Stoc și rândurile cu produse gestionate, negestionate și digitale", () => {
    for (const width of [1440, 1280]) {
      test(`${width} px: pastila și creionul pe aceeași linie, textul pe a doua; rândurile ≤ 64 px (cele simple ≤ 56 px)`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await login(page, account, LIST_STOCK);
        const table = tableOf(page);
        await expectNoHorizontalScroll(page, table);
        const cases = [
          { title: `Cartuș ${searchStock}`, text: "Negestionat", pencil: true },
          { title: `Ghid ${searchStock}`, text: "Digital", pencil: false },
          { title: `Bisulfat ${searchStock}`, text: /Disponibil 80 kg/, pencil: false },
        ];
        for (const item of cases) {
          const row = page.locator(`[data-product-title="${item.title}"]`);
          await expect(row).toBeVisible();
          const cell = row.locator('[data-cell="stock"]');
          const pill = cell.locator("[data-stock-pill]");
          const text = cell.locator("[data-stock-text]");
          await expect(text).toHaveText(item.text);
          const pillBox = await pill.boundingBox();
          const textBox = await text.boundingBox();
          // textul e sub pastilă (a doua linie), pe o singură linie
          expect(textBox?.y ?? 0, `${item.title}: textul sub pastilă`).toBeGreaterThanOrEqual(
            (pillBox?.y ?? 0) + (pillBox?.height ?? 0) - 2,
          );
          expect(textBox?.height ?? 99, `${item.title}: text pe o linie`).toBeLessThanOrEqual(20);
          // linia pastilei nu se rupe, iar creionul (dacă există) e pe aceeași linie cu pastila
          expect(await css(pill.locator("xpath=.."), "white-space")).toBe("nowrap");
          if (item.pencil) {
            const icon = await cell.locator("svg[data-edit-icon]").boundingBox();
            expect(
              Math.abs(
                (icon?.y ?? 0) +
                  (icon?.height ?? 0) / 2 -
                  ((pillBox?.y ?? 0) + (pillBox?.height ?? 0) / 2),
              ),
              `${item.title}: creionul pe linia pastilei`,
            ).toBeLessThanOrEqual(6);
          }
          expect(
            (await row.boundingBox())?.height ?? 99,
            `${item.title}: rând`,
          ).toBeLessThanOrEqual(64);
        }
        // prețul pe unitate («/ kg») stă lipit de preț, în interiorul valorii-buton (nu după creionul invizibil)
        const bisulfat = page.locator(`[data-product-title="Bisulfat ${searchStock}"]`);
        const priceButton = bisulfat.getByRole("button", { name: /^Editează prețul pentru/ });
        await expect(priceButton.locator("[data-price-per]")).toHaveText("/ kg");
        // rândurile simple (un titlu, o variantă): cel mult 56 px
        await page.goto(LIST);
        const plain = (await rowOf(page, 5).boundingBox())?.height ?? 99;
        expect(plain).toBeLessThanOrEqual(56);
      });
    }
  });

  test("SKU și subtitlu pe o singură linie, cu ellipsis și textul întreg în title; titlul rămâne pe un rând (1440 și 1280 px)", async ({
    page,
  }) => {
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 1440) await login(page, account, LIST);
      else await page.reload();
      for (const n of [1, 2, 3]) {
        const row = rowOf(page, n);
        const sku = row.locator('[data-cell="sku"] [data-sku-text]');
        const fullSku = `${skuOf(n)}`;
        // SKU lung (peste 24 de caractere): o linie, nowrap, ellipsis, textul întreg în title
        expect(fullSku.length).toBeGreaterThan(24);
        await expect(sku).toHaveAttribute("title", fullSku);
        expect(await css(sku, "white-space")).toBe("nowrap");
        expect(await css(sku, "text-overflow")).toBe("ellipsis");
        expect((await sku.boundingBox())?.height ?? 99, `SKU ${n} pe o linie`).toBeLessThanOrEqual(
          24,
        );

        // subtitlul «Brand · Categorie · 1 variantă»: o linie, ellipsis, textul întreg în title
        const subtitle = row.locator("[data-product-subtitle]");
        await expect(subtitle).toHaveAttribute(
          "title",
          /E2E Brand .* · E2E Categorie .* · 1 variantă$/,
        );
        expect(await css(subtitle, "white-space")).toBe("nowrap");
        expect(await css(subtitle, "text-overflow")).toBe("ellipsis");
        expect((await subtitle.boundingBox())?.height ?? 99, `subtitlu ${n}`).toBeLessThanOrEqual(
          20,
        );

        // titlul pe un rând; rândul cu subtitlu lung rămâne compact
        const title = row.getByRole("link", { name: `Deschide produsul ${titles[n - 1]}` });
        expect((await title.boundingBox())?.height ?? 99, `titlul ${n}`).toBeLessThanOrEqual(24);
        expect((await row.boundingBox())?.height ?? 99, `rândul ${n}`).toBeLessThanOrEqual(64);
      }
      // un SKU scurt nu primește title (nu e tăiat) și un subtitlu scurt rămâne întreg
      const short = rowOf(page, 5);
      await expect(short.locator('[data-cell="sku"] [data-sku-text]')).not.toHaveAttribute(
        "title",
        /.+/,
      );
      await expect(short.locator("[data-product-subtitle]")).toHaveText("1 variantă");
    }
  });
  test.describe("telefon (390 px): tabelul devine listă de carduri", () => {
    test("fiecare rând e un card de cel mult 120 px: caseta, imaginea și titlul; apoi prețul, starea și «Duplică»; valorile sunt butoanele de editare (ținte de 44 px)", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await login(page, account, LIST);
      const table = tableOf(page);
      await expect(table).toBeVisible();
      await expect(page.locator("[data-product-row]").first()).toBeVisible();
      await expectNoHorizontalScroll(page, table);
      await expect(table.locator("thead")).not.toBeInViewport();
      // fără coloane de detaliu în card
      await expect(table.getByRole("columnheader", { name: "SKU", exact: true })).toBeHidden();

      const row = rowOf(page, 5);
      await row.scrollIntoViewIfNeeded();
      const box = await row.boundingBox();
      expect(box?.height ?? 999, "înălțimea cardului").toBeLessThanOrEqual(120);
      expect(box?.height ?? 0, "înălțimea cardului").toBeGreaterThanOrEqual(90);
      // prima linie: caseta, imaginea și numele (care umple restul liniei, cel puțin 12rem, nu o fâșie de câteva litere)
      const check = await row.locator("td").first().boundingBox();
      const thumb = await row.locator("[data-product-thumb]").boundingBox();
      const head = await row.locator('th[scope="row"]').boundingBox();
      expect(head?.width ?? 0, "lățimea numelui").toBeGreaterThanOrEqual(192);
      expect(
        (head?.x ?? 0) + (head?.width ?? 0),
        "numele ajunge la marginea cardului",
      ).toBeGreaterThanOrEqual((box?.x ?? 0) + (box?.width ?? 0) - 24);
      expect(check?.x ?? 99, "caseta înaintea imaginii").toBeLessThan(thumb?.x ?? 0);
      expect(thumb?.x ?? 99, "imaginea înaintea numelui").toBeLessThan(head?.x ?? 0);
      expect(Math.abs((thumb?.y ?? 0) - (head?.y ?? 99)), "pe aceeași linie").toBeLessThanOrEqual(
        40,
      );

      // linia 2: valorile sunt ele însele butoane de editare (fără creion separat), iar «Duplică» e în dreapta, pe aceeași linie
      const priceCell = row.locator('[data-cell="price"]');
      const statusCell = row.locator('[data-cell="status"]');
      const priceEdit = row.getByRole("button", { name: `Editează prețul pentru ${titles[4]}` });
      const statusEdit = row.getByRole("button", { name: `Editează starea pentru ${titles[4]}` });
      await expect(priceEdit).toContainText("105,00");
      await expect(statusEdit).toContainText("Ciornă");
      for (const edit of [priceEdit, statusEdit]) {
        expect((await edit.boundingBox())?.height ?? 0, "țintă de 44 px").toBeGreaterThanOrEqual(
          44,
        );
        // creionul din interiorul valorii nu ocupă loc propriu pe telefon
        await expect(edit.locator("svg[data-edit-icon]")).toBeHidden();
      }
      const price = await priceCell.boundingBox();
      const status = await statusCell.boundingBox();
      expect(Math.abs((price?.y ?? 0) - (status?.y ?? 99))).toBeLessThanOrEqual(12);
      expect(price?.x ?? 99).toBeLessThan(status?.x ?? 0);
      expect(price?.x ?? 99, "aliniat la stânga").toBeLessThanOrEqual((box?.x ?? 0) + 24);
      const duplicate = row.getByRole("button", { name: `Duplică produsul ${titles[4]}` });
      await expect(duplicate).toBeVisible();
      const dup = await duplicate.boundingBox();
      expect(dup?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(dup?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(
        Math.abs(
          (dup?.y ?? 0) + (dup?.height ?? 0) / 2 - ((price?.y ?? 0) + (price?.height ?? 0) / 2),
        ),
        "Duplică pe linia prețului",
      ).toBeLessThanOrEqual(24);
      expect(
        (dup?.x ?? 0) + (dup?.width ?? 0),
        "Duplică în dreapta cardului",
      ).toBeGreaterThanOrEqual((box?.x ?? 0) + (box?.width ?? 0) - 24);
      expect(dup?.x ?? 0, "Duplică după stare").toBeGreaterThan(
        (status?.x ?? 0) + (status?.width ?? 0),
      );
      // linia 1: titlul cu «1 variantă» dedesubt; creionul titlului rămâne (țintă de 44 px)
      const titleBox = await row
        .getByRole("link", { name: `Deschide produsul ${titles[4]}` })
        .boundingBox();
      const subBox = await row.locator("[data-product-subtitle]").boundingBox();
      expect(subBox?.y ?? 0, "subtitlul sub titlu").toBeGreaterThan(
        (titleBox?.y ?? 0) + (titleBox?.height ?? 0) - 4,
      );
      const titleEdit = row.getByRole("button", { name: `Editează titlul pentru ${titles[4]}` });
      await expect(titleEdit).toBeVisible();
      expect((await titleEdit.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      // paginarea de pe telefon: «Pagina 1 din 2», butoane de 44 px
      const nav = page.getByRole("navigation", { name: "Paginare" });
      await expect(nav.getByText("Pagina 1 din 2")).toBeVisible();
      expect(
        (await nav.getByRole("link", { name: "Pagina următoare" }).boundingBox())?.height ?? 0,
      ).toBeGreaterThanOrEqual(44);
    });

    test("filtrele din spatele butonului «Filtre (N)»: căutarea și «Caută» rămân vizibile, etichetele active sub ele", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await login(page, account, `${LIST}&status=active&shipping=standard`);
      const toggle = page.getByRole("button", { name: "Filtre (2)" });
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      const control = page.locator(`#${(await toggle.getAttribute("aria-controls")) as string}`);
      // închis: selectoarele nu se văd, dar căutarea și «Caută» da
      await expect(page.getByLabel("Categorie", { exact: true })).toBeHidden();
      await expect(control).toBeHidden();
      const input = page.getByLabel("Caută produse");
      const submit = page.getByRole("button", { name: "Caută", exact: true });
      await expect(input).toBeVisible();
      await expect(submit).toBeVisible();
      // etichetele active rămân sub căutare și «Caută»; căutarea e și ea o etichetă, dar nu intră în numărul din buton
      const chips = page.getByRole("list", { name: "Filtre active" });
      await expect(chips).toBeVisible();
      const [inputBox, submitBox, chipsBox, toggleBox] = await Promise.all(
        [input, submit, chips, toggle].map((c) => c.boundingBox()),
      );
      expect(chipsBox?.y ?? 0, "etichetele sub «Caută»").toBeGreaterThan(
        (submitBox?.y ?? 0) + (submitBox?.height ?? 0) - 2,
      );
      expect(submitBox?.y ?? 0, "«Caută» sub câmp").toBeGreaterThan(
        (inputBox?.y ?? 0) + (inputBox?.height ?? 0) - 2,
      );
      expect(toggleBox?.height ?? 0, "țintă de 44 px").toBeGreaterThanOrEqual(44);
      // deschis: selectoarele apar, aria-expanded devine true; închis din nou: dispar
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByLabel("Categorie", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Clasă de livrare", { exact: true })).toBeVisible();
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByLabel("Categorie", { exact: true })).toBeHidden();
      // fără filtre din panou: «Filtre (0)»; la desktop butonul nu există, iar selectoarele sunt mereu vizibile
      await page.goto(LIST);
      await expect(page.getByRole("button", { name: "Filtre (0)" })).toBeVisible();
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(page.getByRole("button", { name: /^Filtre \(/ })).toBeHidden();
      await expect(page.getByLabel("Categorie", { exact: true })).toBeVisible();
    });

    test("coșul de gunoi pe telefon: carduri cu «Restaurează» și «Șterge definitiv», fără derulare orizontală", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await login(page, account, `/admin/produse?view=deleted&q=${encodeURIComponent(search)}`);
      const table = tableOf(page);
      await expect(page.locator("[data-product-row]")).toHaveCount(TRASHED.length);
      await expectNoHorizontalScroll(page, table);
      const row = rowOf(page, TRASHED[0] as number);
      const restore = row.getByRole("button", {
        name: `Restaurează: ${titles[(TRASHED[0] as number) - 1]}`,
      });
      await expect(restore).toBeVisible();
      expect((await restore.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    });
  });
});

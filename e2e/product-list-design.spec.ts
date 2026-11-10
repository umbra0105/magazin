import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  lengthenE2eSkus,
  linkE2eProductsToCatalogRefs,
  promoteE2eUser,
  removeE2eCatalogRefs,
  removeE2eProducts,
  seedE2eCatalogRefs,
  seedE2eProducts,
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
});

test.afterAll(async () => {
  await removeE2eProducts();
  await removeE2eCatalogRefs();
});

const css = (locator: Locator, property: string) =>
  locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);

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
      ).toBeGreaterThanOrEqual(260);
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

  test.describe("telefon (390 px): tabelul devine listă de carduri", () => {
    test("fiecare rând e un card: numele pe toată lățimea, prețul și starea pe o linie, apoi acțiunile (ținte de 44 px)", async ({
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
      expect(box?.height ?? 999, "înălțimea cardului").toBeLessThanOrEqual(160);
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

      // prețul și starea pe aceeași linie, prețul primul, aliniat la stânga
      const price = await row.locator('[data-cell="price"]').boundingBox();
      const status = await row.locator('[data-cell="status"]').boundingBox();
      expect(Math.abs((price?.y ?? 0) - (status?.y ?? 99))).toBeLessThanOrEqual(12);
      expect(price?.x ?? 99).toBeLessThan(status?.x ?? 0);
      expect(price?.x ?? 99, "aliniat la stânga").toBeLessThanOrEqual((box?.x ?? 0) + 24);

      // acțiunile pe ultima linie: nume accesibil și țintă de cel puțin 44 px
      const actions = await row.locator('[data-cell="actions"]').boundingBox();
      expect(actions?.width ?? 0, "rândul de acțiuni pe toată lățimea").toBeGreaterThanOrEqual(
        (box?.width ?? 0) - 24,
      );
      expect(actions?.y ?? 0).toBeGreaterThan((price?.y ?? 0) + (price?.height ?? 0) - 4);
      const duplicate = row.getByRole("button", { name: `Duplică produsul ${titles[4]}` });
      await expect(duplicate).toBeVisible();
      expect((await duplicate.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect((await duplicate.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44);
      for (const edit of ["titlul", "starea", "prețul"]) {
        const button = row.getByRole("button", { name: `Editează ${edit} pentru ${titles[4]}` });
        await expect(button).toBeVisible();
        expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
      // paginarea de pe telefon: «Pagina 1 din 2», butoane de 44 px
      const nav = page.getByRole("navigation", { name: "Paginare" });
      await expect(nav.getByText("Pagina 1 din 2")).toBeVisible();
      expect(
        (await nav.getByRole("link", { name: "Pagina următoare" }).boundingBox())?.height ?? 0,
      ).toBeGreaterThanOrEqual(44);
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

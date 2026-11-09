import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  promoteE2eUser,
  removeE2eStock,
  removeE2eStockShared,
  seedE2eStock,
  setE2eStockSnapshot,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Redesign admin, Lotul 1 (docs/17): ecranele Stoc și Panou. Aspectul din tokeni (antet gri, rând de 48 px, cifre tabulare la
 * dreapta, stări ca pastile cu tonurile din §2.2), tab-urile vederilor, paginarea cu «rânduri pe pagină», etichetele de filtru
 * eliminabile, bara de stoc segmentată (Stoc și Panou) și telefonul (prima coloană fixă, fără defilare orizontală a paginii).
 * Comportamentul (filtre, ajustări, praguri) rămâne în `stock.spec.ts` și `low-stock.spec.ts`. Produsele de probă au adresa
 * `e2e-stoc-<tag>-…` și se șterg la final.
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
const LIST = `/admin/produse/stoc?q=${encodeURIComponent(search)}`;
const SIMPLE = 24;
let account: Account;
let skus: string[] = [];
// Alge e epuizat; Accesoriu 01 (primul din lista sortată după titlu) e în stoc și apare pe prima pagină
const [ALGE, ACCESORIU] = [0, 8];

test.beforeAll(async ({ request, baseURL }) => {
  account = await createAccount(request, baseURL as string, "owner");
  skus = await seedE2eStock(
    tag,
    [
      // la stoc mic: Alge (epuizat), Liner (doar rest nevandabil), Bec și Pompă (sub prag); în stoc: Filtru, Capac
      { title: `Alge ${search}`, variants: [{ sku: "A", physical: "0" }] },
      { title: `Bec ${search}`, variants: [{ sku: "B", physical: "1" }] },
      { title: `Pompă ${search}`, variants: [{ sku: "P", physical: "2" }] },
      { title: `Filtru ${search}`, variants: [{ sku: "F", physical: "30" }] },
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
      ...Array.from({ length: SIMPLE }, (_, i) => ({
        title: `Accesoriu ${String(i + 1).padStart(2, "0")} ${search}`,
        variants: [{ sku: `S${i + 1}`, physical: String(40 + i) }],
      })),
    ],
    { asOfHoursAgo: 3 },
  );
  await setE2eStockSnapshot(3);
});

test.afterAll(async () => {
  await removeE2eStock({ tag });
  await removeE2eStockShared();
});

const css = (locator: Locator, property: string) =>
  locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);

/** Cifrele din legenda barei de stoc: «În stoc 2», «Stoc mic 2» … din numele accesibil al imaginii. */
async function barNumbers(scope: Locator): Promise<Record<string, number>> {
  const label = (await scope.locator('[role="img"]').getAttribute("aria-label")) ?? "";
  const numbers: Record<string, number> = {};
  for (const [, name, value] of label.matchAll(/(În stoc|Stoc mic|Epuizat) ([\d.]+)/g)) {
    numbers[name as string] = Number((value as string).replaceAll(".", ""));
  }
  return numbers;
}

test.describe("ecranul Stoc, pe componentele din docs/17", () => {
  test("tabelul: antet gri, rând de cel puțin 48 px, cifre tabulare la dreapta, stări ca pastile", async ({
    page,
  }) => {
    await login(page, account, LIST);
    await expect(page.getByRole("heading", { level: 1, name: /^Stoc \(\d+/ })).toBeVisible();
    const table = page.getByRole("table", { name: "Stocul variantelor" });
    const headerCell = table.getByRole("columnheader", { name: "Fizică" });
    // antetul are fundal propriu (--surface-subtle), nu transparent, iar textul e secundar de 12 px
    expect(await css(table.locator("thead"), "background-color")).not.toBe("rgba(0, 0, 0, 0)");
    expect(await css(headerCell, "font-size")).toBe("12px");
    expect(await css(headerCell, "text-align")).toBe("right");

    const alge = page.locator(`[data-variant-row="${skus[ALGE]}"]`);
    await expect(alge).toBeVisible();
    const rowBox = await alge.boundingBox();
    expect(rowBox?.height).toBeGreaterThanOrEqual(48);
    const physical = alge.locator('[data-cell="physical"]');
    expect(await css(physical, "text-align")).toBe("right");
    expect(await css(physical, "font-variant-numeric")).toContain("tabular-nums");
    // fără linii verticale: celulele nu au bordură stânga/dreapta
    expect(await css(physical, "border-left-width")).toBe("0px");
    expect(await css(physical, "border-right-width")).toBe("0px");

    // starea e o pastilă (rază mare), cu textul scris
    const pill = alge.locator('[data-cell="state"] span').first();
    await expect(pill).toHaveText("Indisponibil");
    expect(await css(pill, "border-top-left-radius")).not.toBe("0px");
    const inStock = page
      .locator(`[data-variant-row="${skus[ACCESORIU]}"]`)
      .locator('[data-cell="state"] span')
      .first();
    await expect(inStock).toHaveText("În stoc");
    // tonuri diferite: epuizat (Problemă) și în stoc (Succes) nu au același fundal sau același text
    expect(await css(pill, "background-color")).not.toBe(await css(inStock, "background-color"));
    expect(await css(pill, "color")).not.toBe(await css(inStock, "color"));
  });

  test("bara de stoc segmentată: în stoc, stoc mic și epuizat din variantele gestionate; însumează baza din legendă", async ({
    page,
  }) => {
    await login(page, account, LIST);
    const health = page.locator("[data-stock-health]");
    await expect(health).toBeVisible();
    const numbers = await barNumbers(health);
    // 6 + 24 variante gestionate (negestionatul și digitalul nu intră); la stoc mic: 4 (Alge, Liner, Bec, Pompă)
    expect(numbers["Epuizat"]).toBe(2); // Alge + Liner (doar rest nevandabil)
    expect(numbers["Stoc mic"]).toBe(2); // Bec + Pompă
    expect(numbers["În stoc"]).toBe(SIMPLE + 2); // Filtru + Capac + accesoriile
    await expect(health).toContainText(`${SIMPLE + 6} de variante gestionate`);
    // bara are 6 px și rază mare; segmentele nu sunt doar culoare: legenda are cuvinte și numere
    const bar = health.locator('[role="img"]');
    expect((await bar.boundingBox())?.height).toBe(6);
    await expect(health.getByText("Epuizat")).toBeVisible();
    // trei segmente, în proporție cu numerele
    await expect(health.locator("[data-segment]")).toHaveCount(3);
  });

  test("vederile ca tab-uri: cel activ are linie de 2 px și aria-current; «Stoc mic» filtrează vederea", async ({
    page,
  }) => {
    await login(page, account, LIST);
    const nav = page.getByRole("navigation", { name: "Vedere" });
    const all = nav.getByRole("link", { name: "Toate variantele" });
    const low = nav.getByRole("link", { name: /^Stoc mic \(\d+\)$/ });
    await expect(all).toHaveAttribute("aria-current", "page");
    expect(await css(all, "border-bottom-width")).toBe("2px");
    expect(await css(low, "border-bottom-color")).toBe("rgba(0, 0, 0, 0)");
    await low.click();
    await expect(page).toHaveURL(/filtru=stoc-mic/);
    const lowNow = page
      .getByRole("navigation", { name: "Vedere" })
      .getByRole("link", { name: /^Stoc mic/ });
    await expect(lowNow).toHaveAttribute("aria-current", "page");
    expect(await css(lowNow, "border-bottom-width")).toBe("2px");
    // vederea are propriul tabel (rânduri plate) cu motivul ca pastilă
    const row = page.locator(`[data-low-row="${skus[ALGE]}"]`);
    await expect(row.locator('[data-cell="reason"] span').first()).toHaveText("Epuizat");
    expect(await (await row.boundingBox())?.height).toBeGreaterThanOrEqual(48);
    // cardurile de numărători sunt legături cu cifre mari tabulare
    const count = page.locator('[data-count="out_of_stock"] dd');
    await expect(count).toHaveText("1");
    expect(await css(count, "font-size")).toBe("28px");
  });

  test("paginare: 25 pe pagină, numere cu pagina curentă, «rânduri pe pagină» care păstrează filtrul și bara rămâne la 50", async ({
    page,
  }) => {
    await login(page, account, LIST);
    const total = SIMPLE + 8;
    const rows = page.locator("[data-variant-row]");
    await expect(rows).toHaveCount(25);
    const nav = page.getByRole("navigation", { name: "Paginare" });
    await expect(nav.locator('[aria-current="page"]')).toHaveText("1");
    await expect(nav.getByRole("link", { name: "Pagina 2" })).toBeVisible();
    const size = nav.getByLabel("Rânduri pe pagină");
    await expect(size).toHaveValue("25");

    // 50 pe pagină: o singură pagină cu toate rândurile, căutarea rămâne, iar bara rămâne ca să te poți întoarce la 25
    // un clic/alegere înainte de hidratare se pierde: se repetă până se schimbă adresa
    await expect(async () => {
      await size.selectOption("50");
      await expect(page).toHaveURL(/pe-pagina=50/, { timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    await expect(page).toHaveURL(/q=E2E/);
    await expect(rows).toHaveCount(total);
    const nav50 = page.getByRole("navigation", { name: "Paginare" });
    await expect(nav50.getByLabel("Rânduri pe pagină")).toHaveValue("50");
    await expect(nav50.getByRole("link", { name: "Pagina 2" })).toHaveCount(0);

    // înapoi la 25: adresa nu mai are parametrul (25 e implicit)
    await nav50.getByLabel("Rânduri pe pagină").selectOption("25");
    await expect(page).not.toHaveURL(/pe-pagina/);
    await expect(rows).toHaveCount(25);

    // pagina 2 prin legătură numerotată: restul de rânduri
    await page
      .getByRole("navigation", { name: "Paginare" })
      .getByRole("link", { name: "Pagina 2" })
      .click();
    await expect(page).toHaveURL(/pagina=2/);
    await expect(rows).toHaveCount(total - 25);
    await expect(
      page.getByRole("navigation", { name: "Paginare" }).locator('[aria-current="page"]'),
    ).toHaveText("2");
  });

  test("filtrele active apar ca etichete eliminabile; ștergerea lor readuce lista; fără rezultate: stare goală cu o singură acțiune", async ({
    page,
  }) => {
    await login(page, account, `${LIST}&tip=managed`);
    const chips = page.getByRole("list", { name: "Filtre active" });
    await expect(
      chips.getByRole("link", { name: `Elimină filtrul Căutare: ${search}` }),
    ).toBeVisible();
    await expect(chips.getByRole("link", { name: "Elimină filtrul Tip: Gestionat" })).toBeVisible();
    await chips.getByRole("link", { name: "Elimină filtrul Tip: Gestionat" }).click();
    await expect(page).not.toHaveURL(/tip=/);
    await expect(page.getByRole("link", { name: /Elimină filtrul Tip/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Elimină filtrul Căutare/ })).toBeVisible();

    // o căutare fără rezultate: stare goală, cu «Șterge filtrele» care readuce lista
    await page.goto(`/admin/produse/stoc?q=${encodeURIComponent(`nimic-${tag}`)}`);
    await expect(
      page.getByRole("heading", { name: "Nicio variantă nu corespunde filtrelor." }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Șterge filtrele" }).click();
    await expect(page).toHaveURL(/\/admin\/produse\/stoc$/);
    await expect(
      page.getByRole("heading", { name: "Nicio variantă nu corespunde filtrelor." }),
    ).toHaveCount(0);
  });

  test("telefon: pagina nu derulează pe orizontală; tabelul da, iar prima coloană rămâne pe loc", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, account, LIST);
    await expect(page.locator("[data-variant-row]").first()).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
    ).toBe(false);
    const table = page.getByRole("table", { name: "Stocul variantelor" });
    const scroller = table.locator("xpath=..");
    expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const firstCell = page.locator('[data-variant-row] th[scope="row"]').first();
    const before = (await firstCell.boundingBox())?.x ?? -1;
    await scroller.evaluate((el) => {
      el.scrollLeft = 300;
    });
    await expect.poll(async () => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
    const after = (await firstCell.boundingBox())?.x ?? -2;
    expect(after).toBeCloseTo(before, 0);
    // butoanele au 44 px înălțime pe telefon (țintă tactilă)
    const button = page.getByRole("button", { name: /^Ajustează stocul:/ }).first();
    await button.scrollIntoViewIfNeeded();
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe("Panou: carduri de indicator și bara de stoc", () => {
  test("cardurile sunt legături pe fundal pastelat, fără bordură; bara se potrivește cu cardul «Stoc mic»", async ({
    page,
  }) => {
    await login(page, account, "/admin");
    await expect(page.getByRole("heading", { level: 1, name: "Panou de control" })).toBeVisible();
    const region = page.locator("[data-stock-alerts]");
    const card = region.locator('[data-alert="low-stock"]');
    expect(await css(card, "border-top-width")).toBe("0px");
    expect(await css(card, "border-top-left-radius")).toBe("12px");
    expect(await css(card, "background-color")).not.toBe("rgba(0, 0, 0, 0)");
    expect(await css(card.locator("[data-value]"), "font-size")).toBe("28px");

    // bara: «Stoc mic» (cardul) = sub prag + epuizat (bara), din aceeași citire a paginii
    const numbers = await barNumbers(region.locator("[data-stock-health]"));
    const cardTotal = Number(await card.locator("[data-value]").innerText());
    expect((numbers["Stoc mic"] ?? 0) + (numbers["Epuizat"] ?? 0)).toBe(cardTotal);
    const caption = await region.locator("[data-stock-health] p").innerText();
    const base = Number(caption.replace(/\D/g, ""));
    expect((numbers["În stoc"] ?? 0) + cardTotal).toBe(base);
  });

  test("la 390 px cardurile se așază pe o coloană și pagina nu derulează pe orizontală", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, account, "/admin");
    const cards = page.locator("[data-stock-alerts] [data-alert]");
    await expect(cards).toHaveCount(3);
    const boxes = await Promise.all([0, 1, 2].map((i) => cards.nth(i).boundingBox()));
    expect(new Set(boxes.map((b) => Math.round(b?.x ?? -1))).size).toBe(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
    ).toBe(false);
  });
});

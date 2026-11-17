import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  removeE2eAttributes,
  removeE2eCatalogRefs,
  removeE2eProducts,
  seedE2eFilterCatalog,
} from "../packages/core/test/e2e-support";

/**
 * Catalogul vitrinei (Faza 7, pasul C): filtre în adresă (funcționale și fără JavaScript), contorizări, chip-uri eliminabile, panou
 * pe calculator și sertar pe telefon, căutare cu autocomplete, date structurate pe server, robots și sitemap. Datele (o categorie,
 * două mărci, un atribut numeric și trei produse) sunt create de test și șterse la final.
 */
const tag = randomBytes(3).toString("hex");
type Seed = Awaited<ReturnType<typeof seedE2eFilterCatalog>>;
let seed: Seed;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  seed = await seedE2eFilterCatalog(tag);
});

test.afterAll(async () => {
  await removeE2eProducts();
  await removeE2eAttributes();
  await removeE2eCatalogRefs();
});

const list = (path: string, params = "") => `/categorie/${path}${params}`;

test.describe("filtre: fără JavaScript", () => {
  test("formularul GET ajunge la adresa canonică, lista se îngustează, apar chip-uri și contorizări corecte", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(list(seed.categoryPath));
    const panel = page.locator("[data-filter-panel]");
    await expect(page.locator("[data-total-label]")).toHaveText("3 produse");
    // contorizările de lângă mărci: Alfa 2, Beta 1
    await expect(panel.getByText(`Marca Alfa ${tag}`)).toBeVisible();
    await expect(panel.locator("label", { hasText: `Marca Alfa ${tag}` })).toContainText("(2)");
    await expect(panel.locator("label", { hasText: `Marca Beta ${tag}` })).toContainText("(1)");

    await panel
      .locator("label", { hasText: `Marca Alfa ${tag}` })
      .locator("input")
      .check();
    await panel.locator(`input[name="min_${seed.attributeCode}"]`).fill("15");
    await panel.getByRole("button", { name: "Aplică filtrele" }).click();

    // adresa canonică (nu min_/max_), doar produsul din Alfa cu debit ≥ 15
    await expect(page).toHaveURL(
      new RegExp(`marca=${seed.brandA.slug}&f_${seed.attributeCode}=15-$`),
    );
    await expect(page.locator("[data-total-label]")).toHaveText("1 produs");
    await expect(page.locator("article")).toHaveCount(1);
    await expect(page.locator("article")).toContainText("medie");
    const chips = page.locator("[data-filter-chips]");
    await expect(chips).toContainText(`Marca Alfa ${tag}`);
    await expect(chips).toContainText(`Debit ${tag}: ≥ 15 mc/h`);
    // contorizarea mărcilor ține cont de intervalul ales, dar nu de marca însăși: Beta rămâne vizibilă, cu 1
    await expect(
      page.locator("[data-filter-panel] label", { hasText: `Marca Beta ${tag}` }),
    ).toContainText("(1)");

    // chip-ul elimină un singur filtru
    await chips.getByRole("link", { name: `Elimină filtrul Marca Alfa ${tag}` }).click();
    await expect(page).toHaveURL(new RegExp(`f_${seed.attributeCode}=15-$`));
    await expect(page.locator("[data-total-label]")).toHaveText("2 produse");
    await context.close();
  });

  test("un filtru necunoscut sau învechit se ignoră (redirecționare la adresa curată), o pagină peste capăt dă 404", async ({
    page,
  }) => {
    await page.goto(list(seed.categoryPath, "?f_inexistent=1-2"));
    await expect(page).toHaveURL(new RegExp(`${seed.categoryPath}$`));
    await expect(page.locator("[data-total-label]")).toHaveText("3 produse");
    const response = await page.goto(list(seed.categoryPath, "?pagina=9"));
    expect(response?.status()).toBe(404);
  });

  test("filtrele și sortările nu se indexează, iar canonicul rămâne lista fără parametri", async ({
    page,
  }) => {
    await page.goto(list(seed.categoryPath, `?marca=${seed.brandA.slug}`));
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      new RegExp(`/categorie/${seed.categoryPath}$`),
    );
    await page.goto(list(seed.categoryPath));
    await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
  });
});

test.describe("format românesc și aspect (S3 din Faza 7)", () => {
  test("intervalul se scrie cu virgulă: chip-ul, câmpul și adresa canonică", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(list(seed.categoryPath));
    const panel = page.locator("[data-filter-panel]");
    const field = panel.locator(`input[name="min_${seed.attributeCode}"]`);
    await field.fill("12,5");
    await panel.getByRole("button", { name: "Aplică filtrele" }).click();
    await expect(page).toHaveURL(new RegExp(`f_${seed.attributeCode}=12\\.5-$`));
    await expect(page.locator("[data-filter-chips]")).toContainText(`Debit ${tag}: ≥ 12,5 mc/h`);
    // câmpul își păstrează valoarea cu virgulă
    await expect(field).toHaveValue("12,5");
  });

  test("titlul foarte lung de produs coboară o treaptă și nu depășește trei rânduri pe calculator", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/produs/${seed.products[2]?.slug}`);
    const h1 = page.locator("h1");
    const size = await h1.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
    const lines = await h1.evaluate((node) => {
      const style = getComputedStyle(node);
      return Math.round(node.getBoundingClientRect().height / parseFloat(style.lineHeight));
    });
    expect(size).toBeLessThanOrEqual(20);
    expect(lines).toBeLessThanOrEqual(3);
    // un titlu scurt rămâne mare
    await page.goto(`/produs/${seed.products[0]?.slug}`);
    const shortSize = await page
      .locator("h1")
      .evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
    expect(shortSize).toBeGreaterThanOrEqual(30);
  });

  test("pe telefon firimiturile ocupă un singur rând, cu numele lung trunchiat", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/produs/${seed.products[2]?.slug}`);
    const nav = page.getByRole("navigation", { name: "Firimituri" }).first();
    const height = await nav.evaluate((node) => node.getBoundingClientRect().height);
    const lineHeight = await nav.evaluate((node) => parseFloat(getComputedStyle(node).lineHeight));
    expect(height).toBeLessThan(lineHeight * 1.5);
    // fără defilare orizontală a paginii
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
});

test.describe("filtre: cu JavaScript", () => {
  test("bifa aplică singură filtrul; intervalul are glisoare legate de câmpuri; sertarul de pe telefon", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(list(seed.categoryPath));
    const panel = page.locator("[data-filter-panel]");
    await expect(panel.locator("[data-range-slider]")).toHaveCount(2);
    await panel
      .locator("label", { hasText: `Marca Beta ${tag}` })
      .locator("input")
      .check();
    await expect(page).toHaveURL(new RegExp(`marca=${seed.brandB.slug}`));
    await expect(page.locator("[data-total-label]")).toHaveText("1 produs");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(list(seed.categoryPath));
    await expect(page.locator("[data-filter-panel]")).toBeHidden();
    const sheet = page.locator("[data-filter-sheet]");
    await expect(sheet.locator("summary")).toContainText("Filtrează");
    await sheet.locator("summary").click();
    await expect(sheet.locator(`input[name="marca"]`).first()).toBeVisible();
  });
});

test.describe("căutare", () => {
  test("găsește fără diacritice și cu diacritice; pagina de căutare nu se indexează", async ({
    page,
  }) => {
    await page.goto(`/cautare?q=${encodeURIComponent(`pompa alfa ${tag}`)}`);
    await expect(page.locator("[data-total-label]")).toHaveText("2 produse");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await page.goto(`/cautare?q=${encodeURIComponent(`Pompă ALFA ${tag}`)}`);
    await expect(page.locator("[data-total-label]")).toHaveText("2 produse");
    await page.goto(`/cautare?q=a`);
    await expect(page.getByText("Scrie cel puțin două caractere")).toBeVisible();
  });

  test("autocomplete în header: sugestii, navigare cu tastatura; Enter fără sugestie alege căutarea întreagă", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    const box = page.getByRole("banner").getByRole("combobox").first();
    await box.fill(`pompa beta ${tag}`);
    const option = page.getByRole("option").first();
    await expect(option).toContainText("Beta");
    await box.press("ArrowDown");
    await expect(box).toHaveAttribute("aria-activedescendant", /.+/);
    await box.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await box.fill(`pompa alfa ${tag}`);
    await expect(page.getByRole("option").first()).toBeVisible();
    // Enter fără sugestie aleasă: formularul trimite căutarea întreagă
    await box.press("Enter");
    await expect(page).toHaveURL(/\/cautare\?q=/);
    await expect(page.locator("[data-total-label]")).toHaveText("2 produse");
  });

  test("fără JavaScript: câmpul din header e un formular GET spre /cautare", async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto("/");
    const form = page.getByRole("search").first();
    await expect(form).toHaveAttribute("action", "/cautare");
    await expect(form).toHaveAttribute("method", "get");
    await context.close();
  });
});

test.describe("date structurate, robots, sitemap", () => {
  const jsonLd = async (page: Page) =>
    (await page.locator('script[type="application/ld+json"]').allTextContents()).flatMap((text) => {
      const parsed = JSON.parse(text) as unknown;
      return Array.isArray(parsed) ? parsed : [parsed];
    }) as Record<string, unknown>[];

  test("categoria are BreadcrumbList și ItemList; produsul are Product cu oferta afișată, fără costuri", async ({
    page,
  }) => {
    await page.goto(list(seed.categoryPath));
    const category = await jsonLd(page);
    expect(category.map((d) => d["@type"])).toEqual(
      expect.arrayContaining(["BreadcrumbList", "ItemList"]),
    );

    const first = seed.products[0];
    await page.goto(`/produs/${first?.slug}`);
    const product = (await jsonLd(page)).find((d) => d["@type"] === "Product");
    expect(product).toBeTruthy();
    expect(product).toMatchObject({
      name: first?.title,
      offers: {
        priceCurrency: "RON",
        availability: "https://schema.org/InStock",
        price: "110.00",
      },
    });
    expect(JSON.stringify(product)).not.toMatch(/cost/i);
    expect((await jsonLd(page)).some((d) => d["@type"] === "BreadcrumbList")).toBe(true);
  });

  test("pagina de start are Organization și WebSite cu SearchAction pe adresa reală", async ({
    page,
  }) => {
    await page.goto("/");
    const data = await jsonLd(page);
    expect(data.some((d) => d["@type"] === "Organization")).toBe(true);
    const site = data.find((d) => d["@type"] === "WebSite") as {
      potentialAction: { target: { urlTemplate: string } };
    };
    expect(site.potentialAction.target.urlTemplate).toContain("/cautare?q={search_term_string}");
  });

  test("robots.txt, sitemap.xml și llms.txt", async ({ request }) => {
    const robots = await (await request.get("/robots.txt")).text();
    expect(robots).toContain("Disallow: /cont");
    expect(robots).toContain("Disallow: /cautare");
    expect(robots).toMatch(/Sitemap: .+\/sitemap\.xml/);
    const sitemapResponse = await request.get("/sitemap.xml");
    expect(sitemapResponse.headers()["content-type"]).toContain("xml");
    const sitemap = await sitemapResponse.text();
    expect(sitemap).toContain(`/produs/${seed.products[0]?.slug}`);
    expect(sitemap).toContain(`/categorie/${seed.categoryPath}`);
    expect(sitemap).not.toContain("priority");
    const llms = await (await request.get("/llms.txt")).text();
    expect(llms).toMatch(/^# /);
    expect(llms).toContain("/sitemap.xml");
  });
});

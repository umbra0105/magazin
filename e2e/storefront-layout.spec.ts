import { expect, test, type Page } from "@playwright/test";

/**
 * Cadrul vitrinei (Faza 6): header, footer, meniu, drawer, presets. Cerințele SEO de layout din docs/19 §1 (meniu cu `<a href>` în
 * HTML-ul serverului, un singur H1, 404 real, linkuri legale în footer) și invarianții de design (ținte tactile, fără derulare
 * laterală în niciun preset și nicio temă). Galeria de design (`/galerie-vitrina`) există doar cu E2E_HARNESS=1.
 */
const PRESETS = ["minimal", "bold", "editorial"] as const;
const THEMES = ["deschisa", "inchisa"] as const;
const gallery = (preset: string, tema = "deschisa", extra = "") =>
  `/galerie-vitrina?preset=${preset}&tema=${tema}${extra}`;

async function noHorizontalScroll(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
}

test.describe("pagina principală și cadrul real", () => {
  test("un singur H1, header, footer și legătura «Sari la conținut»", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("contentinfo")).toBeVisible();
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Sari la conținut" });
    await expect(skip).toBeFocused();
    await expect(skip).toHaveAttribute("href", "#continut");
    await expect(page.locator("main#continut")).toHaveCount(1);
  });

  test("căutarea și coșul sunt dezactivate (structură, fără funcție), favoritele ascunse fără steag", async ({
    page,
  }) => {
    await page.goto("/");
    const header = page.getByRole("banner");
    await expect(header.getByRole("searchbox").first()).toBeDisabled();
    await expect(header.getByRole("button", { name: /Coșul tău/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(header.getByRole("button", { name: /Favorite/ })).toHaveCount(0);
    await expect(header.getByRole("link", { name: "Contul meu" })).toHaveAttribute("href", "/cont");
  });

  test("footer: linkurile legale și informative din docs/03", async ({ page }) => {
    await page.goto("/");
    const footer = page.getByRole("contentinfo");
    for (const href of [
      "/termeni-si-conditii",
      "/politica-de-confidentialitate",
      "/politica-cookie-uri",
      "/politica-de-retur",
    ]) {
      await expect(footer.locator(`a[href="${href}"]`)).toHaveCount(1);
    }
  });

  test("404 real: o adresă necunoscută întoarce statusul 404", async ({ page }) => {
    const response = await page.goto("/adresa-care-nu-exista-faza-6");
    expect(response?.status()).toBe(404);
  });
});

test.describe("HTML-ul serverului (fără JavaScript)", () => {
  test("meniul și footer-ul au linkuri <a href> în răspunsul inițial", async ({ request }) => {
    const html = await (await request.get(gallery("minimal"))).text();
    expect(html).toContain('href="/categorie/demo-0"');
    expect(html).toContain('href="/categorie/demo-0/demo-0-0"');
    expect(html).toContain('href="/politica-de-confidentialitate"');
    // meniul de pe telefon (în panoul închis) e și el în HTML
    expect(html.split('href="/categorie/demo-0"').length - 1).toBeGreaterThanOrEqual(2);
  });

  test("galeria are un singur H1, iar cadrul nu adaugă altul", async ({ page }) => {
    await page.goto(gallery("bold"));
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  });
});

test.describe("mega menu (desktop)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("se deschide la click, schimbă panoul la hover și se închide cu Escape", async ({
    page,
  }) => {
    await page.goto(gallery("minimal"));
    const trigger = page.getByRole("button", { name: "Produse" });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("link", { name: "Tot din Pompe și filtrare" })).toBeVisible();
    await page.getByRole("link", { name: "Încălzire", exact: true }).first().hover();
    await expect(page.getByRole("link", { name: "Tot din Încălzire" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Tot din Pompe și filtrare" })).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();
  });
});

test.describe("meniul de pe telefon", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("butonul deschide panoul din stânga, linkurile sunt reale, Esc îl închide", async ({
    page,
  }) => {
    await page.goto(gallery("minimal"));
    const open = page.getByRole("button", { name: "Deschide meniul" });
    await expect(open).toBeVisible();
    const box = await open.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await open.click();
    const dialog = page.getByRole("dialog", { name: "Meniu" });
    await expect(dialog).toBeVisible();
    await dialog.getByText("Încălzire", { exact: true }).click();
    await expect(dialog.getByRole("link", { name: "Pompe de căldură" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});

for (const preset of PRESETS) {
  for (const tema of THEMES) {
    test(`galeria ${preset} / ${tema}: fără derulare laterală la 390 px și ținte tactile`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(gallery(preset, tema));
      expect(await noHorizontalScroll(page)).toBe(true);
      for (const name of ["Adaugă în coș", "Vezi detalii"]) {
        const box = await page.getByRole("button", { name }).first().boundingBox();
        expect(box?.height, name).toBeGreaterThanOrEqual(44);
      }
      const searchBox = await page.getByRole("searchbox").first().boundingBox();
      expect(searchBox?.height).toBeGreaterThanOrEqual(44);
    });
  }
}

test.describe("presetul dă forma butonului și a cardului", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  async function radii(page: Page) {
    return page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Adaugă în coș"),
      ) as HTMLElement;
      const card = document.querySelector("article") as HTMLElement;
      return {
        button: Number.parseFloat(getComputedStyle(button).borderTopLeftRadius),
        card: Number.parseFloat(getComputedStyle(card).borderTopLeftRadius),
      };
    });
  }

  test("Minimal: pastilă și card mare; Bold: rotunjit; Editorial: aproape dreptunghiular", async ({
    page,
  }) => {
    const found: Record<string, { button: number; card: number }> = {};
    for (const preset of PRESETS) {
      await page.goto(gallery(preset));
      found[preset] = await radii(page);
    }
    const { minimal, bold, editorial } = found as Record<
      (typeof PRESETS)[number],
      { button: number; card: number }
    >;
    expect(minimal.button).toBeGreaterThan(bold.button);
    expect(bold.button).toBeGreaterThan(editorial.button);
    expect(minimal.card).toBeGreaterThan(bold.card);
    expect(bold.card).toBeGreaterThan(editorial.card);
    expect(editorial.button).toBeLessThanOrEqual(4);
  });

  test("titlul din hero are expresia în culoare de accent, diferită de textul titlului", async ({
    page,
  }) => {
    await page.goto(gallery("minimal"));
    const colors = await page.evaluate(() => {
      const accent = document.querySelector("h2 span") as HTMLElement;
      const title = accent.parentElement as HTMLElement;
      return { accent: getComputedStyle(accent).color, title: getComputedStyle(title).color };
    });
    expect(colors.accent).not.toBe(colors.title);
  });
});

test.describe("cardurile de produs", () => {
  test("fiecare card are un singur link (tab oprește o dată pe produs)", async ({ page }) => {
    await page.goto(gallery("minimal"));
    for (const article of await page.locator("article").all()) {
      await expect(article.getByRole("link")).toHaveCount(1);
    }
  });
});

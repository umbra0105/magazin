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

  test("căutarea (Faza 7) și coșul (Faza 8) sunt active, favoritele ascunse fără steag", async ({
    page,
  }) => {
    await page.goto("/");
    const header = page.getByRole("banner");
    // căutarea e activă: câmp cu rol `combobox` (autocomplete), în formularul `role=search`, fără `disabled`
    await expect(header.getByRole("combobox").first()).toBeEnabled();
    // coșul e o legătură reală către /cos (și deschide sertarul cu JavaScript)
    await expect(header.getByRole("link", { name: /Coșul tău/ })).toHaveAttribute("href", "/cos");
    await expect(header.getByRole("button", { name: /Coșul tău/ })).toHaveCount(0);
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

test.describe("mega menu: plăci de categorie cu imagine (opționale)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("categoriile cu imagine sunt plăci, celelalte rămân text; fiecare e un singur link", async ({
    page,
  }) => {
    await page.goto(gallery("minimal", "deschisa", "&meniu=deschis"));
    const panel = page.locator(
      "#" + (await page.getByRole("button", { name: "Produse" }).getAttribute("aria-controls")),
    );
    const tiles = panel.locator("a:has(img)");
    const tileCount = await tiles.count();
    expect(tileCount).toBeGreaterThan(0);
    // o categorie fără imagine există și rămâne link text (fără <img>)
    const textOnly = panel.getByRole("link", { name: "Filtre cu nisip", exact: true });
    await expect(textOnly).toBeVisible();
    await expect(textOnly.locator("img")).toHaveCount(0);
    // placa e vizibilă, cu dimensiuni explicite și încărcare leneșă
    const first = tiles.first();
    await expect(first).toBeVisible();
    const attrs = await first.locator("img").evaluate((img: HTMLImageElement) => ({
      width: img.getAttribute("width"),
      height: img.getAttribute("height"),
      loading: img.getAttribute("loading"),
      alt: img.getAttribute("alt"),
    }));
    expect(Number(attrs.width)).toBeGreaterThan(0);
    expect(Number(attrs.height)).toBeGreaterThan(0);
    expect(attrs.loading).toBe("lazy");
    expect(attrs.alt).toBe("");
    // fără link în link
    expect(await panel.locator("a a").count()).toBe(0);
  });

  test("imaginile din meniu sunt în HTML-ul serverului, în panoul ascuns, alături de toate linkurile text", async ({
    request,
  }) => {
    const out = await (await request.get(gallery("minimal"))).text();
    expect(out).toMatch(/<a [^>]*href="\/categorie\/demo-0\/demo-0-0"[^>]*><span[^>]*><img /);
    expect(out).toContain('href="/categorie/demo-0/demo-0-1"');
  });
});

test.describe("masa foto: plăcile de meniu și imaginile cardurilor au aceeași suprafață în toate presets și temele", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  /** Culoarea de fundal și geometria unei zone de imagine (placă sau card), plus cum e încadrată imaginea. */
  async function frames(page: Page, selector: string) {
    return page.locator(selector).evaluateAll((elements) =>
      elements.map((el) => {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const img = el.querySelector("img");
        const imgBox = img?.getBoundingClientRect();
        return {
          background: style.backgroundColor,
          width: Math.round(box.width),
          height: Math.round(box.height),
          left: Math.round(box.left),
          padding: Number.parseFloat(style.paddingLeft),
          fit: img ? getComputedStyle(img).objectFit : null,
          blend: img ? getComputedStyle(img).mixBlendMode : null,
          imgInside:
            imgBox === undefined ||
            (imgBox.left >= box.left &&
              imgBox.right <= box.right &&
              imgBox.top >= box.top &&
              imgBox.bottom <= box.bottom),
        };
      }),
    );
  }

  test("plăcile de meniu: același cadru 4:3, aceeași suprafață, imaginea întreagă cu umplutură, într-o grilă cu 3 coloane", async ({
    page,
  }) => {
    const backgrounds = new Set<string>();
    for (const preset of PRESETS) {
      for (const tema of THEMES) {
        await page.goto(gallery(preset, tema, "&meniu=deschis"));
        const tiles = await frames(page, "[data-mega-tile]:visible");
        expect(tiles.length, `${preset} ${tema}`).toBeGreaterThanOrEqual(2);
        const [firstTile] = tiles;
        for (const tile of tiles) {
          expect(tile.width, `${preset} ${tema} lățime`).toBe(firstTile?.width);
          expect(tile.height, `${preset} ${tema} înălțime`).toBe(firstTile?.height);
          expect(Math.abs(tile.width / tile.height - 4 / 3)).toBeLessThan(0.02);
          expect(tile.padding).toBeGreaterThan(0);
          expect(tile.fit).toBe("contain");
          expect(tile.blend).toBe("multiply");
          expect(tile.imgInside).toBe(true);
          backgrounds.add(tile.background);
        }
        // grila are cel mult 3 coloane, iar lista de text de sub plăci stă pe aceleași coloane
        const tileColumns = new Set(tiles.map((tile) => tile.left));
        expect(tileColumns.size).toBeLessThanOrEqual(3);
        const texts = await page
          .locator("[data-mega-texts]:visible > li")
          .evaluateAll((items) =>
            items.map((item) => Math.round(item.getBoundingClientRect().left)),
          );
        expect(texts.length).toBeGreaterThan(0);
        for (const left of texts)
          expect(tileColumns.has(left), `${preset} ${tema} text`).toBe(true);
      }
    }
    // aceeași suprafață în toate 6 combinațiile (presets × teme): nu depinde de paleta presetului
    expect([...backgrounds]).toHaveLength(1);
  });

  test("cardurile de produs: zona de imagine are aceeași suprafață, același raport și aceeași încadrare peste tot", async ({
    page,
  }) => {
    const backgrounds = new Set<string>();
    for (const preset of PRESETS) {
      for (const tema of THEMES) {
        await page.goto(gallery(preset, tema));
        const zones = await frames(page, "article > div:first-child");
        expect(zones.length, `${preset} ${tema}`).toBeGreaterThanOrEqual(4);
        const [firstZone] = zones;
        for (const zone of zones) {
          expect(zone.width).toBe(firstZone?.width);
          expect(zone.height).toBe(zone.width);
          expect(zone.padding).toBeGreaterThan(0);
          // fără fotografii în baza de dezvoltare (CI), cardul are un substituent fără <img>: încadrarea se verifică doar cu imagine
          expect(zone.fit ?? "contain", `${preset} ${tema}`).toBe("contain");
          expect(zone.blend ?? "multiply", `${preset} ${tema}`).toBe("multiply");
          expect(zone.imgInside).toBe(true);
          backgrounds.add(zone.background);
        }
      }
    }
    expect([...backgrounds]).toHaveLength(1);
    // masa foto a cardurilor și a plăcilor e aceeași suprafață
    await page.goto(gallery("minimal", "deschisa", "&meniu=deschis"));
    const tile = await frames(page, "[data-mega-tile]:visible");
    expect([...backgrounds][0]).toBe(tile[0]?.background);
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

  test("panoul acoperă tot ecranul (nicio fâșie din pagină la dreapta sau jos) și blochează derularea paginii", async ({
    page,
  }) => {
    await page.goto(gallery("minimal"));
    await page.getByRole("button", { name: "Deschide meniul" }).click();
    const dialog = page.getByRole("dialog", { name: "Meniu" });
    await expect(dialog).toBeVisible();
    // panoul intră printr-o tranziție scurtă: se așteaptă poziția finală, apoi se compară cu ecranul întreg
    const view = page.viewportSize();
    await expect
      .poll(async () => {
        const box = await dialog.boundingBox();
        return box && [box.x, box.y, box.width, box.height];
      })
      .toEqual([0, 0, view?.width, view?.height]);
    const overflow = await page.evaluate(
      () => getComputedStyle(document.documentElement).overflowY,
    );
    expect(overflow).toBe("hidden");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    const after = await page.evaluate(() => getComputedStyle(document.documentElement).overflowY);
    expect(after).not.toBe("hidden");
  });
});

test.describe("galeria: fără degrade pe substituenții de imagine", () => {
  test("nicio imagine-substituent nu are fundal degrade (reflexul «cărămiziu spre turcoaz»)", async ({
    page,
  }) => {
    for (const preset of PRESETS) {
      await page.goto(gallery(preset));
      const gradients = await page.evaluate(
        () =>
          [...document.querySelectorAll('[role="img"]')].filter((el) =>
            getComputedStyle(el).backgroundImage.includes("gradient"),
          ).length,
      );
      expect(gradients, preset).toBe(0);
    }
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

test.describe("variante de aspect: header sticlă, footer compact, bară de anunț", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("header «sticlă»: translucid cu estompare, iar hero-ul urcă sub el (aceeași margine de sus)", async ({
    page,
  }) => {
    await page.goto(gallery("minimal", "deschisa", "&header=glass"));
    const header = page.locator('[data-header="glass"] header').first();
    const hero = page.locator('[data-header="glass"] [data-hero]').first();
    await expect(header).toBeVisible();
    const style = await header.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, blur: s.backdropFilter };
    });
    expect(style.blur).toContain("blur");
    // culoare cu canal alfa sub 1 (rgba/color(... / a))
    expect(style.bg).toMatch(/\/\s*0?\.\d+\)|rgba\([^)]*,\s*0?\.\d+\)/);
    const h = await header.boundingBox();
    const g = await hero.boundingBox();
    expect(Math.abs((g?.y ?? 0) - (h?.y ?? 99))).toBeLessThanOrEqual(1);
    expect(g?.height).toBeGreaterThan((h?.height ?? 0) + 200);
  });

  test("header standard: opac, hero-ul începe sub el", async ({ page }) => {
    await page.goto(gallery("minimal", "deschisa", "&header=default"));
    const header = page.locator("header").first();
    const bg = await header.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toMatch(/\/\s*0?\.\d+\)|rgba\([^)]*,\s*0?\.\d+\)/);
    const blur = await header.evaluate((el) => getComputedStyle(el).backdropFilter);
    expect(blur).toBe("none");
  });

  test("footer compact: fără coloanele de linkuri, dar cu date firmă, linkuri legale și ANPC/SAL", async ({
    page,
  }) => {
    await page.goto(gallery("minimal", "deschisa", "&footer=compact"));
    const footer = page.locator("footer");
    await expect(footer.getByRole("heading")).toHaveCount(0);
    for (const href of [
      "/termeni-si-conditii",
      "/politica-de-confidentialitate",
      "/politica-cookie-uri",
    ]) {
      await expect(footer.locator(`a[href="${href}"]`)).toHaveCount(1);
    }
    await expect(footer.getByRole("link", { name: /ANPC/ })).toHaveCount(1);
    await expect(footer).toContainText("RO00000000");
    const compact = (await footer.boundingBox())?.height ?? 0;
    await page.goto(gallery("minimal", "deschisa", "&footer=default"));
    const full = (await page.locator("footer").boundingBox())?.height ?? 0;
    expect(compact).toBeLessThan(full);
  });

  test("bara de anunț: deasupra header-ului, cu text și un singur link, în ambele tonuri", async ({
    page,
  }) => {
    await page.goto(gallery("minimal", "deschisa", "&anunt=brand"));
    const bar = page.getByRole("complementary", { name: "Anunț" });
    await expect(bar).toBeVisible();
    await expect(bar.getByRole("link")).toHaveCount(1);
    const barBox = await bar.boundingBox();
    const headerBox = await page.locator("header").first().boundingBox();
    expect((barBox?.y ?? 0) + (barBox?.height ?? 0)).toBeLessThanOrEqual((headerBox?.y ?? 0) + 1);
    await page.goto(gallery("minimal", "deschisa", "&anunt=neutral"));
    await expect(page.getByRole("complementary", { name: "Anunț" })).toBeVisible();
    await page.goto(gallery("minimal", "deschisa"));
    await expect(page.getByRole("complementary", { name: "Anunț" })).toHaveCount(0);
  });
});

test.describe("consimțământ pentru cookie-uri (implicit refuzat)", () => {
  const banner = (page: Page) => page.locator("[data-consent-banner]");
  const consentCookie = async (page: Page) =>
    (await page.context().cookies()).find((cookie) => cookie.name === "ecom_consent");

  test("prima vizită: bannerul apare după hidratare (cookie-ul se citește în browser, pagina rămâne în cache), cu trei butoane, și nu s-a salvat nicio alegere", async ({
    page,
    request,
  }) => {
    // pagina din cache e aceeași pentru toți vizitatorii: bannerul nu e în HTML-ul serverului, ci îl desenează browserul
    const html = await (await request.get("/")).text();
    expect(html).not.toContain("data-consent-banner");
    await page.goto("/");
    await expect(banner(page)).toBeVisible();
    await expect(banner(page).getByRole("button")).toHaveText([
      "Refuz",
      "Acceptă tot",
      "Preferințe",
    ]);
    expect(await consentCookie(page)).toBeUndefined();
  });

  test("«Refuz» și «Acceptă tot» au exact același stil și aceeași înălțime (refuzul e la fel de ușor ca acceptul)", async ({
    page,
  }) => {
    await page.goto("/");
    const style = (name: string) =>
      banner(page)
        .getByRole("button", { name, exact: true })
        .evaluate((el) => {
          const s = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          return {
            background: s.backgroundColor,
            color: s.color,
            fontSize: s.fontSize,
            fontWeight: s.fontWeight,
            border: s.borderTopWidth,
            radius: s.borderTopLeftRadius,
            height: box.height,
          };
        });
    expect(await style("Refuz")).toEqual(await style("Acceptă tot"));
  });

  test("«Refuz»: cookie cu totul refuzat, bannerul dispare și nu mai revine după reîncărcare", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    await banner(page).getByRole("button", { name: "Refuz", exact: true }).click();
    await expect(banner(page)).toHaveCount(0);
    expect((await consentCookie(page))?.value).toBe("v1.a0.m0");
    await page.reload();
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    const cookie = await consentCookie(page);
    expect(cookie?.sameSite).toBe("Lax");
    // cu cookie-ul, HTML-ul serverului nu mai conține bannerul
    const html = await (
      await request.get("/", { headers: { cookie: "ecom_consent=v1.a0.m0" } })
    ).text();
    expect(html).not.toContain("data-consent-banner");
  });

  test("«Acceptă tot» salvează alegerea completă", async ({ page }) => {
    await page.goto("/");
    await banner(page).getByRole("button", { name: "Acceptă tot", exact: true }).click();
    await expect(banner(page)).toHaveCount(0);
    expect((await consentCookie(page))?.value).toBe("v1.a1.m1");
  });

  test("«Preferințe»: categoriile cer acord și pornesc oprite; salvarea scrie doar ce s-a bifat", async ({
    page,
  }) => {
    await page.goto("/");
    await banner(page).getByRole("button", { name: "Preferințe", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Preferințele pentru cookie-uri" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: /Necesare/ })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: /Necesare/ })).toBeDisabled();
    await expect(dialog.getByRole("checkbox", { name: /Statistici/ })).not.toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: /Marketing/ })).not.toBeChecked();
    await dialog.getByRole("checkbox", { name: /Statistici/ }).check();
    await dialog.getByRole("button", { name: "Salvează alegerea" }).click();
    await expect(dialog).toBeHidden();
    await expect(banner(page)).toHaveCount(0);
    expect((await consentCookie(page))?.value).toBe("v1.a1.m0");
  });

  test("din subsol alegerea se poate schimba oricând, pornind de la alegerea curentă", async ({
    page,
  }) => {
    await page.goto("/");
    await banner(page).getByRole("button", { name: "Acceptă tot", exact: true }).click();
    await page
      .getByRole("contentinfo")
      .getByRole("button", { name: "Setările cookie-urilor" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Preferințele pentru cookie-uri" });
    await expect(dialog.getByRole("checkbox", { name: /Marketing/ })).toBeChecked();
    await dialog.getByRole("checkbox", { name: /Marketing/ }).uncheck();
    await dialog.getByRole("button", { name: "Salvează alegerea" }).click();
    await expect(dialog).toBeHidden();
    expect((await consentCookie(page))?.value).toBe("v1.a1.m0");
  });

  test("un cookie stricat sau de altă versiune nu e o alegere: apare din nou bannerul", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await context.addCookies([{ name: "ecom_consent", value: "v9.a1.m1", url: page.url() }]);
    await page.goto("/");
    await expect(banner(page)).toBeVisible();
  });
});

test.describe("stările vitrinei: eroare și încărcare", () => {
  test("o eroare într-o pagină păstrează cadrul și arată starea de eroare, cu «Reîncearcă»", async ({
    page,
  }) => {
    await page.goto("/harness-vitrina/eroare?arunca=1");
    const alert = page.getByRole("alert").filter({ hasText: "Ceva nu a mers bine" });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole("heading", { level: 1 })).toHaveText("Ceva nu a mers bine");
    await expect(alert.getByRole("button", { name: "Reîncearcă" })).toBeVisible();
    await expect(alert.getByRole("link", { name: "Prima pagină" })).toHaveAttribute("href", "/");
    // header și footer rămân; textul erorii nu se arată
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("contentinfo")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Eroare de probă");
  });

  test("cât se încarcă pagina apare scheletul (regiune status, ocupat), apoi conținutul", async ({
    page,
  }) => {
    await page.goto("/harness-vitrina/incarcare", { waitUntil: "commit" });
    const skeleton = page.getByRole("status").filter({ hasText: "Se încarcă pagina…" });
    await expect(skeleton).toBeVisible();
    await expect(skeleton).toHaveAttribute("aria-busy", "true");
    await expect(
      page.getByRole("heading", { level: 1, name: "Pagina s-a încărcat" }),
    ).toBeVisible();
    await expect(skeleton).toHaveCount(0);
  });
});

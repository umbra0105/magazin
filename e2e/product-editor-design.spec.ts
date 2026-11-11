import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  linkE2eProductsToCatalogRefs,
  promoteE2eUser,
  readE2eProductId,
  removeE2eCatalogRefs,
  removeE2eProducts,
  seedE2eCatalogRefs,
  seedE2eProducts,
  seedE2eVariants,
  setE2eProductDescription,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Redesign admin, Lotul 2b (docs/17 §4.2): pagina de editare a produsului. Antetul (titlu, pastilă de stare, acțiuni secundare),
 * taburile pe un singur rând derulabil, bara de salvare lipită jos peste logica existentă «modificări nesalvate», secțiuni separate
 * prin linii în coloană de cel mult 880 px, un singur buton principal pe tab, editorul vizual de descriere (bara de unelte, focus,
 * tema închisă) și pagina «Produs nou». Comportamentul (salvări, validări, ciclul de viață) rămâne în `product-editor.spec.ts`
 * și celelalte specuri de produs. Produsul de probă are adresa `e2e-<tag>-01` și se șterge la final.
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
const SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
] as const;
const DESCRIPTION =
  "<h2>Pompă de căldură</h2><p>Pompa <strong>inverter</strong> încălzește apa piscinei eficient.</p>" +
  "<ul><li>Putere termică 9 kW</li><li>Clasa energetică A+++</li></ul>";
let account: Account;
let title = "";
let editor = "";

test.beforeAll(async ({ request, baseURL }) => {
  account = await createAccount(request, baseURL as string, "owner");
  [title = ""] = await seedE2eProducts(tag, 1);
  const slug = `e2e-${tag}-01`;
  await seedE2eVariants(slug, [`E2E-${tag.toUpperCase()}-01-A`, `E2E-${tag.toUpperCase()}-01-B`]);
  await seedE2eCatalogRefs(tag);
  await linkE2eProductsToCatalogRefs([slug], tag);
  await setE2eProductDescription(slug, DESCRIPTION);
  editor = `/admin/produse/${await readE2eProductId(slug)}`;
});

test.afterAll(async () => {
  await removeE2eProducts();
  await removeE2eCatalogRefs();
});

const css = (locator: Locator, property: string) =>
  locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);

/** Pagina nu derulează pe orizontală (scrollWidth ≤ clientWidth). */
const pageOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

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

/** Culoarea de fundal a unei clase-token (ex. `bg-tone-info-bg`), citită dintr-un element-sondă din suprafața adminului. */
const tokenBackground = (page: Page, className: string) =>
  page.evaluate((name) => {
    const probe = document.createElement("div");
    probe.className = name;
    (document.querySelector('[data-surface="admin"]') ?? document.body).append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, className);

/** O proprietate calculată a unei clase-token (ex. `border border-line-control` → `border-top-color`), citită dintr-un element-sondă. */
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

/** Luminanța relativă (0–1) a unei culori `rgb(...)`/`rgba(...)`, pentru verificarea temei închise. */
const luminance = (color: string): number => {
  const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).map(Number);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const tabList = (page: Page) => page.getByRole("tablist", { name: "Secțiunile produsului" });

test.describe("editarea produsului, pe componentele din docs/17", () => {
  test("antetul: legătura de întoarcere, titlul de 22 px, pastila de stare și acțiunile ciclului de viață secundare", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, editor);
    await expect(page.getByRole("link", { name: "Înapoi la lista de produse" })).toBeVisible();
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toContainText(title);
    expect(await css(h1, "font-size")).toBe("22px");
    // starea ca pastilă (rază mare, text scris), în tonul din listă (ciornă = informare)
    const pill = page.locator("[data-status-pill]").first();
    await expect(pill).toHaveText("Ciornă");
    expect(await css(pill, "border-top-left-radius")).not.toBe("0px");
    expect(await css(pill, "background-color"), "ciorna = ton Informare, ca în listă").toBe(
      await tokenBackground(page, "bg-tone-info-bg"),
    );
    // acțiunile ciclului de viață sunt secundare: pe tabul General singurul buton principal e «Salvează»
    for (const name of ["Duplică", "Arhivează", "Mută în coșul de gunoi"]) {
      await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    }
    expect(await primaryControls(page)).toEqual(["Salvează"]);
  });

  test("taburile: un singur rând, derulabil pe orizontală; tabul activ rămâne în câmpul vizual", async ({
    page,
  }) => {
    for (const size of [SIZES[0], SIZES[3]]) {
      await page.setViewportSize(size);
      if (size === SIZES[0]) await login(page, account, `${editor}?tab=seo`);
      else await page.goto(`${editor}?tab=seo`);
      const list = tabList(page);
      await expect(list).toBeVisible();
      // un singur rând: înălțimea listei e a unui tab (+ linia), nu a mai multor rânduri
      expect(
        (await list.boundingBox())?.height ?? 999,
        `${size.width}px: înălțimea listei`,
      ).toBeLessThanOrEqual(56);
      expect(await css(list, "overflow-x"), "derulare orizontală").toBe("auto");
      expect(await css(list.getByRole("tab").first(), "white-space")).toBe("nowrap");
      // pe telefon taburile nu încap: lista derulează, iar pagina nu
      if (size.width === 390) {
        expect(await list.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0);
      }
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
      // tabul activ (SEO, ultimul) se vede întreg în lista derulabilă
      const listBox = await list.boundingBox();
      const active = await list.getByRole("tab", { name: "SEO", selected: true }).boundingBox();
      expect(active?.x ?? 0, `${size.width}px: începutul tabului activ`).toBeGreaterThanOrEqual(
        (listBox?.x ?? 0) - 1,
      );
      expect(
        (active?.x ?? 0) + (active?.width ?? 0),
        `${size.width}px: sfârșitul tabului activ`,
      ).toBeLessThanOrEqual((listBox?.x ?? 0) + (listBox?.width ?? 0) + 1);
    }
    // de la tastatură: Home duce la General și îl aduce în câmpul vizual
    await page.getByRole("tab", { name: "SEO", selected: true }).focus();
    await page.keyboard.press("Home");
    const list = tabList(page);
    const general = await list.getByRole("tab", { name: "General" }).boundingBox();
    expect(general?.x ?? -99).toBeGreaterThanOrEqual(((await list.boundingBox())?.x ?? 0) - 1);
  });

  test("bara de salvare e lipită jos, pe fundal propriu, cu «modificări nesalvate» și butonul principal «Salvează» (1440, 1024, 390 px)", async ({
    page,
  }) => {
    // între iterații pagina cu modificări se părăsește prin navigare: dialogul nativ «beforeunload» se acceptă
    page.on("dialog", (dialog) => void dialog.accept());
    for (const size of [SIZES[0], SIZES[2], SIZES[3]]) {
      await page.setViewportSize(size);
      if (size === SIZES[0]) await login(page, account, `${editor}?tab=general`);
      else await page.goto(`${editor}?tab=general`);
      const bar = page.locator("[data-save-bar]:visible");
      await expect(bar).toHaveCount(1);
      expect(await css(bar, "position"), `${size.width}px`).toBe("sticky");
      expect(await css(bar, "background-color")).not.toBe("rgba(0, 0, 0, 0)");
      // pagina e mai înaltă decât fereastra: bara stă lipită de marginea de jos a ferestrei, nu la capătul formularului
      const box = await bar.boundingBox();
      expect(
        (box?.y ?? 0) + (box?.height ?? 0),
        `${size.width}px: marginea de jos`,
      ).toBeGreaterThanOrEqual(size.height - 2);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(size.height + 1);
      // fără modificări nu apare mențiunea; cu o modificare apare în bară
      await expect(bar.locator("[data-unsaved-mark]")).toHaveCount(0);
      await page.getByLabel("Titlu", { exact: true }).fill(`${title} (modificat)`);
      await expect(bar.locator("[data-unsaved-mark]")).toBeVisible();
      await expect(bar.locator("[data-unsaved-mark]")).toHaveText(/modificări nesalvate/i);
      const save = bar.getByRole("button", { name: "Salvează" });
      expect(await primaryControls(page)).toEqual(["Salvează"]);
      if (size.width === 390) {
        expect((await save.boundingBox())?.height ?? 0, "țintă de 44 px").toBeGreaterThanOrEqual(
          44,
        );
      }
      // la capătul paginii bara rămâne vizibilă, sub conținut
      await page.mouse.wheel(0, 20_000);
      await expect(bar).toBeInViewport();
      // protecția existentă: cu modificări, plecarea cere confirmare în dialogul aplicației
      await page.getByRole("link", { name: "Înapoi la lista de produse" }).scrollIntoViewIfNeeded();
      await page.getByRole("link", { name: "Înapoi la lista de produse" }).click();
      await expect(page.locator("[data-unsaved-dialog]")).toBeVisible();
      await page.locator("[data-unsaved-stay]").click();
      await expect(page.locator("[data-unsaved-dialog]")).toBeHidden();
    }
  });

  test("secțiuni separate prin linii (nu prin casete), într-o coloană de cel mult 880 px; fără derulare orizontală", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, `${editor}?tab=general`);
    const sections = page.locator('[role="tabpanel"]:visible [data-editor-section]');
    expect(await sections.count()).toBeGreaterThanOrEqual(3);
    const titles = await sections.evaluateAll((nodes) =>
      nodes.map((node) => node.querySelector("h2")?.textContent?.trim() ?? ""),
    );
    expect(titles).toEqual(
      expect.arrayContaining(["Date de bază", "Descrierea produsului", "Clasificare și livrare"]),
    );
    for (const [index, section] of (await sections.all()).entries()) {
      // linie deasupra (1 px) — mai puțin prima secțiune — și nicio bordură pe laterale
      expect(await css(section, "border-top-width"), `secțiunea ${index}`).toBe(
        index === 0 ? "0px" : "1px",
      );
      expect(await css(section, "border-left-width")).toBe("0px");
      expect(await css(section, "border-right-width")).toBe("0px");
      expect(await css(section, "border-bottom-width")).toBe("0px");
    }
    // coloana formularului: cel mult 880 px
    const form = page.locator('[role="tabpanel"]:visible form').first();
    expect((await form.boundingBox())?.width ?? 999).toBeLessThanOrEqual(880);
    for (const size of SIZES) {
      await page.setViewportSize(size);
      expect(await pageOverflow(page), `${size.width}px`).toBeLessThanOrEqual(0);
    }
  });

  test("toate taburile: un singur buton principal și pagina fără derulare orizontală, la 1440, 1280, 1024 și 390 px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, `${editor}?tab=general`);
    const names = await tabList(page)
      .getByRole("tab")
      .evaluateAll((nodes) => nodes.map((n) => n.textContent?.replace(/●.*/, "").trim() ?? ""));
    expect(names.length).toBeGreaterThanOrEqual(12);
    const tabIds = [
      "general",
      "preturi",
      "vanzare",
      "variante",
      "stoc",
      "categorii",
      "atribute",
      "asociate",
      "piese",
      "documente",
      "conformitate",
      "media",
      "seo",
    ];
    for (const size of SIZES) {
      await page.setViewportSize(size);
      for (const id of tabIds) {
        await page.goto(`${editor}?tab=${id}`);
        const selected = tabList(page).getByRole("tab", { selected: true });
        if ((await selected.count()) === 0) continue;
        await expect(page.locator('[role="tabpanel"]:visible')).toHaveCount(1);
        const primary = await primaryControls(page);
        expect(
          primary.length,
          `${size.width}px, tabul ${id}: butoane principale ${JSON.stringify(primary)}`,
        ).toBeLessThanOrEqual(1);
        // tabul cu bară de salvare și buton are exact «Salvează» ca singur principal; taburile cu acțiune proprie (Documente: «Încarcă»)
        // și cele doar cu starea în bară au cel mult un buton principal (verificat mai sus)
        const saveButtons = page.locator("[data-save-bar]:visible").getByRole("button");
        if ((await saveButtons.count()) > 0) {
          expect(primary, `${size.width}px, tabul ${id}`).toEqual(["Salvează"]);
        }
        expect(
          await pageOverflow(page),
          `${size.width}px, tabul ${id}: derulare orizontală`,
        ).toBeLessThanOrEqual(0);
      }
    }
  });

  test("editorul de descriere: unelte de 32 px (44 px pe telefon), grupuri cu separatoare, starea apăsată fără buton principal, focus vizibil", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, `${editor}?tab=general`);
    const box = page.locator("[data-description-editor]");
    await expect(box).toBeVisible();
    const toolbar = box.getByRole("toolbar");
    const tools = toolbar.locator("button[data-tool]");
    expect(await tools.count()).toBeGreaterThan(10);
    for (const tool of await tools.all()) {
      const toolBox = await tool.boundingBox();
      // unelte pătrate de 32 px, cu excepția selectorului de format (câmp) și a butoanelor cu text ale uneltelor de tabel
      if ((await tool.evaluate((el) => el.tagName)) !== "BUTTON") continue;
      expect(toolBox?.height ?? 0).toBeGreaterThanOrEqual(32);
      expect(toolBox?.width ?? 0, "unealtă pătrată").toBeCloseTo(toolBox?.height ?? 0, 0);
    }
    // grupuri separate prin linii subțiri (text, liste și blocuri, inserări, istoric)
    expect(
      await toolbar.locator("[data-tool-divider]").count(),
      "4 separatoare între 5 grupuri",
    ).toBe(4);
    // bordura și raza sunt ale câmpurilor de formular
    const input = page.getByLabel("Titlu", { exact: true });
    expect(await css(box, "border-top-color")).toBe(await css(input, "border-top-color"));
    expect(await css(box, "border-top-left-radius")).toBe(
      await css(input, "border-top-left-radius"),
    );
    // focus: inel vizibil pe tot câmpul
    expect(await css(box, "box-shadow")).toBe("none");
    await page.locator('[contenteditable="true"]').first().click();
    expect(await css(box, "box-shadow")).not.toBe("none");
    // starea apăsată («Aldin») se vede fără să devină buton principal; aria-pressed rămâne
    const bold = toolbar.getByRole("button", { name: "Aldin" });
    await bold.click();
    await expect(bold).toHaveAttribute("aria-pressed", "true");
    expect(await primaryControls(page)).toEqual(["Salvează"]);
    // starea apăsată are fundal propriu (tranziția de culoare durează o clipă)
    // cursorul pleacă de pe buton: fundalul vine din starea apăsată, nu din hover
    await page.mouse.move(0, 0);
    await page.waitForTimeout(400); // tranziția de culoare (150 ms) s-a încheiat: nu mai e culoarea de hover
    await expect
      .poll(() => css(bold, "background-color"), { message: "fundalul uneltei apăsate" })
      .not.toBe("rgba(0, 0, 0, 0)");
    // telefon: ținte de 44 px
    await page.setViewportSize({ width: 390, height: 844 });
    for (const tool of await tools.all()) {
      expect((await tool.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("editorul de descriere în tema închisă: fundal închis, text deschis, unelte vizibile", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, `${editor}?tab=general`);
    const box = page.locator("[data-description-editor]");
    await expect(box).toBeVisible();
    expect(luminance(await css(box, "background-color")), "fundalul editorului").toBeLessThan(0.1);
    const content = box.locator('[contenteditable="true"] p').first();
    expect(luminance(await css(content, "color")), "textul descrierii").toBeGreaterThan(0.5);
    const tool = box.getByRole("toolbar").getByRole("button", { name: "Aldin" });
    expect(luminance(await css(tool, "color")), "iconița uneltei").toBeGreaterThan(0.3);
    // bara de salvare și secțiunile urmează tema: fundal închis
    expect(
      luminance(await css(page.locator("[data-save-bar]:visible"), "background-color")),
    ).toBeLessThan(0.1);
    await page.emulateMedia({ colorScheme: "light" });
  });

  test("bara de salvare: linie de 1 px sus cu tokenul de bordură, fundal opac din token și fără umbră (1440 și 390 px; lipită și secundară)", async ({
    page,
  }) => {
    for (const size of [SIZES[0], SIZES[3]]) {
      await page.setViewportSize(size);
      if (size === SIZES[0]) await login(page, account, `${editor}?tab=general`);
      for (const tab of ["general", "stoc"]) {
        await page.goto(`${editor}?tab=${tab}`);
        const bars = page.locator("[data-save-bar]:visible");
        // Stoc are două: cea lipită (setările stocului) și cea secundară (variantele)
        await expect(bars).toHaveCount(tab === "stoc" ? 2 : 1);
        const line = await tokenStyle(page, "border border-line-control", "border-top-color");
        const surface = await tokenStyle(page, "bg-surface-page", "background-color");
        for (const [index, bar] of (await bars.all()).entries()) {
          const where = `${size.width}px, tabul ${tab}, bara ${index}`;
          expect(await css(bar, "border-top-width"), `${where}: grosimea liniei`).toBe("1px");
          expect(await css(bar, "border-top-style"), `${where}: stilul liniei`).toBe("solid");
          expect(await css(bar, "border-top-color"), `${where}: linia e tokenul de bordură`).toBe(
            line,
          );
          expect(
            await css(bar, "background-color"),
            `${where}: fundal din tokenul de suprafață`,
          ).toBe(surface);
          expect(surface, "fundalul e opac").not.toMatch(/rgba\(.*,\s*0(\.\d+)?\)$/);
          expect(await css(bar, "box-shadow"), `${where}: fără umbră`).toBe("none");
        }
      }
    }
  });

  test("editorul de descriere pe telefon: bara de unelte pe un singur rând, derulabil pe orizontală, ținte de 44 px, selectorul de titlu primul; de la 640 px nu derulează", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, account, `${editor}?tab=general`);
    const toolbar = page.locator("[data-description-editor]").getByRole("toolbar");
    await expect(toolbar).toBeVisible();
    expect(
      (await toolbar.boundingBox())?.height ?? 999,
      "înălțimea barei pe telefon",
    ).toBeLessThanOrEqual(52);
    expect(await css(toolbar, "overflow-x"), "derulare orizontală").toBe("auto");
    expect(
      await toolbar.evaluate((el) => el.scrollWidth - el.clientWidth),
      "conținut ascuns",
    ).toBeGreaterThan(0);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    // selectorul de titlu e primul; toate uneltele stau pe același rând, cu ținte de 44 px
    const tools = toolbar.locator("[data-tool]");
    expect(await tools.first().evaluate((el) => el.tagName)).toBe("SELECT");
    const tops = new Set<number>();
    for (const tool of await tools.all()) {
      const box = await tool.boundingBox();
      tops.add(Math.round(box?.y ?? 0));
      expect(box?.height ?? 0, "țintă de 44 px").toBeGreaterThanOrEqual(44);
    }
    expect([...tops].length, "toate uneltele pe un singur rând").toBe(1);
    // de la 640 px în sus nu derulează (rupe pe rânduri dacă nu încape)
    for (const width of [1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await css(toolbar, "overflow-x"), `${width}px`).toBe("visible");
      expect(
        await toolbar.evaluate((el) => el.scrollWidth - el.clientWidth),
        `${width}px`,
      ).toBeLessThanOrEqual(0);
    }
  });

  test("taburile derulabile: estompare discretă pe marginea cu taburi ascunse, dispare la capăt (1024, 1440 și 390 px)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await login(page, account, `${editor}?tab=general`);
    const list = tabList(page);
    const start = page.locator('[data-tabs-fade="start"]');
    const end = page.locator('[data-tabs-fade="end"]');
    // la început: taburile ascunse sunt în dreapta
    await expect(end).toHaveCount(1);
    await expect(start).toHaveCount(0);
    // doar vizual: din tokenul de suprafață, fără captarea mouse-ului și fără valoare în text
    expect(await css(end, "background-image")).toContain("linear-gradient");
    expect(await css(end, "pointer-events")).toBe("none");
    await expect(end).toHaveAttribute("aria-hidden", "true");
    expect(await end.evaluate((el) => el.textContent)).toBe("");
    // în dreapta fade-ul se întinde pe înălțimea listei, nu peste linia de jos (fără umbră)
    const listBox = await list.boundingBox();
    const fadeBox = await end.boundingBox();
    expect(
      (fadeBox?.x ?? 0) + (fadeBox?.width ?? 0),
      "fade-ul e lipit de marginea dreaptă",
    ).toBeGreaterThanOrEqual((listBox?.x ?? 0) + (listBox?.width ?? 0) - 1);
    // fade-ul nu acoperă linia de jos a listei (se oprește deasupra ei: lista se suprapune cu 1 px peste linie, fade-ul rămâne cu 2 px mai sus)
    expect(
      (fadeBox?.y ?? 0) + (fadeBox?.height ?? 0),
      "fade-ul nu acoperă linia de jos",
    ).toBeLessThanOrEqual((listBox?.y ?? 0) + (listBox?.height ?? 0) - 1.5);
    // derulare la capăt: dispare cel din dreapta, apare cel din stânga
    await list.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await expect(end).toHaveCount(0);
    await expect(start).toHaveCount(1);
    // înapoi la început
    await list.evaluate((el) => {
      el.scrollLeft = 0;
    });
    await expect(start).toHaveCount(0);
    await expect(end).toHaveCount(1);
    // fără taburi ascunse (lista încape) nu există niciun indicator
    await page.setViewportSize({ width: 1440, height: 900 });
    const overflow = await list.evaluate((el) => el.scrollWidth - el.clientWidth);
    await expect(end).toHaveCount(overflow > 1 ? 1 : 0);
    await expect(start).toHaveCount(0);
    // pe telefon, deschis pe ultimul tab (SEO): taburile ascunse sunt în stânga
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${editor}?tab=seo`);
    await expect(start).toHaveCount(1);
    await expect(end).toHaveCount(0);
  });

  test("pagina «Produs nou»: un singur buton principal, secundarul «Anulează», fără derulare orizontală", async ({
    page,
  }) => {
    for (const size of [SIZES[0], SIZES[3]]) {
      await page.setViewportSize(size);
      if (size === SIZES[0]) await login(page, account, "/admin/produse/nou");
      else await page.goto("/admin/produse/nou");
      const primary = await primaryControls(page);
      expect(primary.length, `${size.width}px: ${JSON.stringify(primary)}`).toBe(1);
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
      const h1 = page.getByRole("heading", { level: 1 });
      expect(await css(h1, "font-size")).toBe("22px");
    }
  });
});

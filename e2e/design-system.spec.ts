import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { promoteE2eUser } from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Sistemul de design al adminului (docs/17), Lot 0: tokenii pe suprafața adminului, Inter cu diacriticele românești, comportamentul
 * componentelor din pagina de exemplu (`/admin/galerie-componente`, doar în build-ul de test: fișier `*.e2e.tsx`) și al cadrului
 * (bara laterală pliabilă cu stare reținută, meniul utilizatorului, tema). Pagina de exemplu NU există într-un build de producție
 * obișnuit (testele de arhitectură și `page-extensions.test.ts` o păzesc).
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

const GALLERY = "/admin/galerie-componente";
const sidebarNav = (page: Page) => page.getByRole("navigation", { name: "Navigare principală" });
const surface = (page: Page) => page.locator('[data-surface="admin"]');
const cssVar = (page: Page, name: string) =>
  surface(page).evaluate((el, n) => getComputedStyle(el).getPropertyValue(n).trim(), name);

test.describe("sistemul de design al adminului", () => {
  test.describe.configure({ mode: "serial" });
  let account: Account;

  test.beforeAll(async ({ request, baseURL }) => {
    account = await createAccount(request, baseURL as string, "owner");
  });

  test("Inter se încarcă din fișiere proprii și acoperă ă â î ș ț (latin și latin-ext)", async ({
    page,
  }) => {
    const external: string[] = [];
    page.on("request", (req) => {
      const host = new URL(req.url()).hostname;
      if (host !== "localhost" && host !== "127.0.0.1") external.push(req.url());
    });
    await login(page, account, GALLERY);
    await expect(page.locator("[data-font-probe]")).toBeVisible();

    const family = await page
      .locator("[data-font-probe]")
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(family).toMatch(/Inter/i);

    // fonturile de pe pagină s-au încărcat din fișierele proprii: subsetul latin-ext (ă, ș, ț: U+0103, U+0218–U+021B) și latin
    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      const faces: Array<{ family: string; range: string }> = [];
      document.fonts.forEach((face) => {
        if (face.status === "loaded") faces.push({ family: face.family, range: face.unicodeRange });
      });
      return faces;
    });
    const inter = loaded.filter((face) => /Inter/i.test(face.family));
    expect(inter.length).toBeGreaterThanOrEqual(2);
    // fiecare literă românească e acoperită de un fișier Inter încărcat (intervalele unicode-range, scrise de Chrome fără zerouri)
    const covers = (range: string, code: number) =>
      range.split(",").some((part) => {
        const m = part.trim().match(/^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/i);
        if (!m) return false;
        const from = Number.parseInt(m[1] as string, 16);
        const to = m[2] ? Number.parseInt(m[2], 16) : from;
        return code >= from && code <= to;
      });
    for (const letter of Array.from("ăâîșțĂÂÎȘȚ")) {
      const code = letter.codePointAt(0) as number;
      expect(
        inter.some((face) => covers(face.range, code)),
        `${letter} (U+${code.toString(16)}) acoperită de Inter`,
      ).toBe(true);
    }
    expect(external).toEqual([]);
  });

  test("tokenii: butonul principal e neutru, fundalul alb, câmpul are 14 px și 36 px pe desktop", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, GALLERY);
    await expect(
      page.getByRole("heading", { level: 1, name: "Galerie de componente" }),
    ).toBeVisible();

    expect(await surface(page).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      "rgb(255, 255, 255)",
    );
    const primary = page
      .locator('[data-gallery="buttons"]')
      .getByRole("button", { name: "Salvează", exact: true });
    expect(await primary.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      "rgb(48, 50, 54)",
    );
    expect((await primary.boundingBox())?.height).toBe(36);
    const input = page.getByLabel("Denumire produs");
    expect((await input.boundingBox())?.height).toBe(36);
    expect(await input.evaluate((el) => getComputedStyle(el).fontSize)).toBe("14px");
    // bordura câmpului: 3:1 (--border-input)
    expect(await input.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(
      "rgb(138, 138, 138)",
    );
  });

  test("telefon: câmpuri și butoane de 44 px, text de 16 px (fără zoom iOS), fără defilare orizontală", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, account, GALLERY);
    await expect(
      page.getByRole("heading", { level: 1, name: "Galerie de componente" }),
    ).toBeVisible();

    const input = page.getByLabel("Denumire produs");
    expect((await input.boundingBox())?.height).toBe(44);
    expect(await input.evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
    const primary = page
      .locator('[data-gallery="buttons"]')
      .getByRole("button", { name: "Salvează", exact: true });
    expect((await primary.boundingBox())?.height).toBe(44);
    // textul butoanelor rămâne 14 px și pe telefon (doar câmpurile au 16 px); altfel rândurile cu butoane depășesc ecranul
    expect(await primary.evaluate((el) => getComputedStyle(el).fontSize)).toBe("14px");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });

  test("tema închisă: tokenii se schimbă prin color-scheme, iar fundalul devine închis", async ({
    page,
  }) => {
    await login(page, account, GALLERY);
    await expect(
      page.getByRole("heading", { level: 1, name: "Galerie de componente" }),
    ).toBeVisible();
    expect(await surface(page).evaluate((el) => getComputedStyle(el).color)).toBe(
      "rgb(26, 26, 26)",
    );

    await page.getByRole("button", { name: "Meniul utilizatorului" }).click();
    await page.getByRole("button", { name: "Întunecat" }).click();
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    await expect
      .poll(() => surface(page).evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe("rgb(18, 19, 21)");
    expect(await surface(page).evaluate((el) => getComputedStyle(el).color)).toBe(
      "rgb(242, 242, 243)",
    );
    // butonul principal se inversează (deschis pe fundal închis)
    const primary = page
      .locator('[data-gallery="buttons"]')
      .getByRole("button", { name: "Salvează", exact: true });
    // butonul are tranziție de culoare (150 ms): se așteaptă valoarea finală
    await expect
      .poll(() => primary.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe("rgb(236, 236, 238)");

    // panoul meniului rămâne deschis după alegere: «Luminos» e deja la îndemână
    await page.getByRole("button", { name: "Luminos" }).click();
    await expect
      .poll(() => surface(page).evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe("rgb(255, 255, 255)");
  });

  test("«Sistem» urmează preferința browserului, fără alegere salvată", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await login(page, account, GALLERY);
    await expect
      .poll(() => surface(page).evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe("rgb(18, 19, 21)");
    await page.emulateMedia({ colorScheme: "light" });
    await expect
      .poll(() => surface(page).evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe("rgb(255, 255, 255)");
  });

  test("panoul lateral (drawer): focus în panou, Esc îl închide și întoarce focusul, 560 px pe desktop", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, GALLERY);
    const trigger = page.getByRole("button", { name: "Deschide panoul lateral" });
    await trigger.click();
    const drawer = page.getByRole("dialog", { name: "Pompă de căldură inverter 12 kW" });
    await expect(drawer).toBeVisible();
    await expect.poll(async () => (await drawer.boundingBox())?.width).toBe(560);
    // focusul e prins în panou
    await expect(page.getByRole("button", { name: "Închide panoul", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    // acțiunile principale rămân jos, iar conținutul derulează
    const footerButton = drawer.getByRole("button", { name: "Deschide produsul" });
    await expect(footerButton).toBeInViewport();

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();

    // click pe fundal îl închide
    await trigger.click();
    await expect(drawer).toBeVisible();
    await page.mouse.click(100, 450);
    await expect(drawer).toBeHidden();
  });

  test("panoul lateral e pe ecran întreg pe telefon", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, account, GALLERY);
    await page.getByRole("button", { name: "Deschide panoul lateral" }).click();
    const drawer = page.getByRole("dialog", { name: "Pompă de căldură inverter 12 kW" });
    await expect(drawer).toBeVisible();
    await expect.poll(async () => (await drawer.boundingBox())?.width).toBe(390);
  });

  test("mișcare redusă: panoul apare fără alunecare (--motion = 0)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await login(page, account, GALLERY);
    // Chrome serializează valoarea ca «0s»
    expect(await cssVar(page, "--motion")).toMatch(/^0(ms|s)$/);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    expect(await cssVar(page, "--motion")).toMatch(/^(150ms|0?.15s)$/);
  });

  test("dialogul: se deschide, Esc îl închide, rază 12 px și umbră de token", async ({ page }) => {
    await login(page, account, GALLERY);
    const trigger = page.getByRole("button", { name: "Deschide dialogul" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Ștergi produsul?" });
    await expect(dialog).toBeVisible();
    const panel = dialog.locator("div").first();
    expect(await panel.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("12px");
    expect(await panel.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("paginare: pagina curentă cu bordură, butoane de 32 px la desktop și de 44 px pe telefon, doar rezumatul pe telefon", async ({
    page,
  }) => {
    await login(page, account, GALLERY);
    await page.setViewportSize({ width: 1440, height: 900 });
    const nav = page.locator('[data-gallery="pagination"]').getByRole("navigation", {
      name: "Paginare",
      exact: true,
    });
    await expect(nav).toBeVisible();
    const current = nav.locator('[aria-current="page"]');
    await expect(current).toHaveText("4");
    const box = await current.boundingBox();
    expect(box?.width).toBe(32);
    expect(box?.height).toBe(32);
    expect(await current.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("6px");
    // numerele cu «…» între ele; pagina 12 e ultima
    await expect(nav.getByRole("link", { name: "Pagina 12" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Pagina anterioară" })).toBeVisible();
    // pe prima pagină butonul «înapoi» e dezactivat (nu e legătură)
    const first = page.getByRole("navigation", { name: "Paginare, prima pagină" });
    await expect(first.getByRole("link", { name: "Pagina anterioară" })).toHaveCount(0);
    await expect(first.locator('[aria-disabled="true"]')).toHaveAttribute(
      "aria-label",
      "Pagina anterioară",
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(nav.getByText("Pagina 4 din 12")).toBeVisible();
    await expect(nav.getByRole("link", { name: "Pagina 12" })).toBeHidden();
    const next = nav.getByRole("link", { name: "Pagina următoare" });
    const nextBox = await next.boundingBox();
    expect(nextBox?.width).toBe(44);
    expect(nextBox?.height).toBe(44);
  });

  test("tab-uri ca legături, carduri de indicator și etichete de filtru: aspect din tokeni și focus vizibil", async ({
    page,
  }) => {
    await login(page, account, GALLERY);
    const tabs = page.getByRole("navigation", { name: "Vedere" });
    const active = tabs.getByRole("link", { name: "Toate variantele" });
    const inactive = tabs.getByRole("link", { name: /^Stoc mic/ });
    await expect(active).toHaveAttribute("aria-current", "page");
    expect(await active.evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe("2px");
    expect(await inactive.evaluate((el) => getComputedStyle(el).borderBottomColor)).toBe(
      "rgba(0, 0, 0, 0)",
    );
    expect(await active.evaluate((el) => getComputedStyle(el).borderBottomColor)).not.toBe(
      "rgba(0, 0, 0, 0)",
    );

    const kpi = page.locator('[data-gallery="kpi"]');
    const card = kpi.locator("div", { hasText: "Comenzi noi" }).last();
    expect(await card.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("12px");
    expect(await card.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");
    expect(await card.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");
    const figure = card.locator("[data-value]");
    expect(await figure.evaluate((el) => getComputedStyle(el).fontSize)).toBe("28px");
    expect(await figure.evaluate((el) => getComputedStyle(el).fontVariantNumeric)).toContain(
      "tabular-nums",
    );

    // legăturile au inel de focus la tastatură (card-legătură, etichetă de filtru)
    for (const name of ["Card-legătură", "Elimină filtrul Tip: Gestionat"]) {
      const target =
        name === "Card-legătură"
          ? kpi.getByRole("link", { name: /Card-legătură/ })
          : page.getByRole("link", { name });
      // Shift+Tab apoi Tab: modalitate de tastatură, ca inelul `focus-visible` să se aplice
      await target.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(target).toBeFocused();
      expect(
        await target.evaluate((el) => getComputedStyle(el).boxShadow),
        `inel de focus la «${name}»`,
      ).not.toBe("none");
    }
  });

  test("notificări: cele reușite dispar singure după 4 secunde, erorile rămân până sunt închise", async ({
    page,
  }) => {
    await login(page, account, GALLERY);
    const ok = page.locator('[data-toast="success"]');
    const error = page.locator('[data-toast="danger"]');
    // eroarea întâi (rămâne): primul click poate veni înainte de hidratare, deci se repetă până apare
    await expect(async () => {
      await page.getByRole("button", { name: /^Eroare/ }).click();
      await expect(error.first()).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await expect(error).toHaveCount(1);
    await expect(error).toHaveAttribute("role", "alert"); // anunțată imediat
    // apoi reușita: ține doar ~4 s, deci se verifică imediat ce apare
    await page.getByRole("button", { name: "Notificare reușită" }).click();
    await expect(ok).toHaveAttribute("role", "status"); // anunțată politicos

    // ceas real: reușita dispare după ~4 s (așteptarea aserțiunii e de 15 s), eroarea rămâne
    await expect(ok).toHaveCount(0);
    await expect(error).toHaveCount(1);
    await error.getByRole("button", { name: "Închide notificarea" }).click();
    await expect(error).toHaveCount(0);
  });

  test("bara laterală: se pliază la 64 px, rămâne pliată după reîncărcare, etichetele rămân accesibile", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, "/admin");
    const aside = page.locator("#admin-sidebar");
    await expect.poll(async () => (await aside.boundingBox())?.width).toBe(240);

    await page.getByRole("button", { name: "Restrânge meniul" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-admin-sidebar", "collapsed");
    await expect.poll(async () => (await aside.boundingBox())?.width).toBe(64);
    // etichetele sunt doar ascunse vizual: legătura rămâne găsită după nume
    await expect(sidebarNav(page).getByRole("link", { name: "Panou", exact: true })).toHaveCount(1);
    expect(
      await sidebarNav(page)
        .getByRole("link", { name: "Panou", exact: true })
        .getAttribute("title"),
    ).toBe("Panou");

    // starea e pusă de scriptul din layout înainte de primul paint: după reîncărcare bara e pliată de la început
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-admin-sidebar", "collapsed");
    await expect.poll(async () => (await aside.boundingBox())?.width).toBe(64);
    await expect(page.getByRole("button", { name: "Extinde meniul" })).toBeVisible();

    // un grup pliat desface bara la primul click
    await sidebarNav(page).getByRole("button", { name: "Catalog", exact: true }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-admin-sidebar", "collapsed");
    await expect.poll(async () => (await aside.boundingBox())?.width).toBe(240);
    await expect(
      sidebarNav(page).getByRole("button", { name: "Catalog", exact: true }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  test("bara laterală: fără stocare, pagina funcționează și alegerea merge pe pagina curentă", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, "/admin");
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new Error("SecurityError");
        },
      });
    });
    await page.goto("/admin");
    await page.getByRole("button", { name: "Restrânge meniul" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-admin-sidebar", "collapsed");
  });

  test("sigla: fără logoUrl apare inițiala numelui magazinului pe fundal neutru; numele stă lângă ea", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, "/admin");
    const initial = page.locator("[data-store-initial]");
    await expect(initial).toBeVisible();
    expect(await initial.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      "rgb(48, 50, 54)",
    );
    expect(await initial.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("12px");
    expect((await initial.boundingBox())?.width).toBe(32);
    const name = await page.locator("#admin-sidebar [data-sidebar-label]").first().innerText();
    expect((await initial.innerText()).toLowerCase()).toBe(
      Array.from(name.trim())[0]?.toLowerCase(),
    );
  });

  test("pagina de exemplu: textul românesc lung nu rupe machetele (fără defilare orizontală la 1440, 1024 și 390 px)", async ({
    page,
  }) => {
    await login(page, account, GALLERY);
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(GALLERY);
      await expect(
        page.getByRole("heading", { level: 1, name: "Galerie de componente" }),
      ).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(overflow, `la ${width}px`).toBe(false);
    }
  });
});

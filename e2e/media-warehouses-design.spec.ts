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
  attachMediaToE2eProduct,
  insertE2eMedia,
  promoteE2eUser,
  removeE2eCatalogRefs,
  removeE2eProducts,
  seedE2eBrandList,
  seedE2eCategoryTree,
  seedE2eProducts,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Redesign admin, Lotul 3b-1 (docs/17): Media (biblioteca, încărcările, detaliile, folderele, selectorul) și Depozite. Titlu cu număr,
 * carduri uniforme pe rând, acțiuni doar cu pictogramă (terțe, 44 px pe tactil), erori în tonul Problemă, ștergerea ca acțiune de
 * pericol, cel mult un buton principal în fiecare stare (listă, dialog, stare goală, eroare, încărcare). Stările pe care baza comună nu
 * le poate garanta (goală, doar citire, texte lungi, toate stările unei încărcări) se verifică pe pagina-harness
 * `/admin/e2e-harness/media-depozite`. Comportamentul (încărcare, procesare, foldere, ștergere, depozite) rămâne în `media.spec.ts`,
 * `media-picker.spec.ts` și `warehouses.spec.ts`.
 */

/** Dreptunghiul unui element, în pixeli de fereastră. */
type Box = { x: number; y: number; width: number; height: number };

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
  return { page, context };
}

test.describe.configure({ mode: "serial", timeout: 150_000 });

const tag = randomBytes(3).toString("hex");
let account: Account;
const names = {
  ready: [1, 2, 3, 4, 5].map((n) => `m-${tag}-${n}.png`),
  pending: `m-${tag}-pending.png`,
  failed: `m-${tag}-failed.png`,
  long: `m-${tag}-pompa-de-caldura-inverter-cu-agent-frigorific-ecologic-pentru-piscine-rezidentiale-2026.png`,
};

test.beforeAll(async ({ request, baseURL }) => {
  account = await createAccount(request, baseURL as string, "owner");
  for (const name of [...names.ready, names.long]) {
    await insertE2eMedia(account.email, { name, status: "ready" });
  }
  await insertE2eMedia(account.email, { name: names.pending, status: "pending" });
  await insertE2eMedia(account.email, { name: names.failed, status: "failed" });
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

/** Culoarea unei proprietăți pentru o clasă-token, citită dintr-un element-sondă din suprafața adminului. */
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

const HARNESS = (ecran: string, stare = "lista") =>
  `/admin/e2e-harness/media-depozite?ecran=${ecran}&stare=${stare}`;
const PICKER = "/admin/e2e-harness/media-picker";

/** Butoanele-pictogramă terțe: fără bordură și fără fundal în repaus, fără text, cu nume accesibil și tooltip. */
async function expectGhostIcon(page: Page, button: Locator, label: string) {
  await expect(button, label).toBeVisible();
  await expect(button, label).toHaveText("");
  await expect(button, `${label}: tooltip`).toHaveAttribute("title", /.+/);
  await page.mouse.move(0, 0);
  expect(await css(button, "border-top-width"), `${label}: bordură în repaus`).toBe("0px");
  expect(await css(button, "background-color"), `${label}: fundal în repaus`).toBe(
    "rgba(0, 0, 0, 0)",
  );
}

// ───────────────────────── Media: pagina bibliotecii (date reale) ─────────────────────────

test.describe("media: pagina bibliotecii", () => {
  const url = () => `/admin/media?q=${tag}`;

  test("1440 px: titlu cu număr (fără rândul separat «N fișiere»), filtre cu «Caută» secundar, carduri cu chenar-token și nume tăiat cu «…»", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, url());
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toHaveText(/^Biblioteca media \(\d+\)$/);
    expect(await css(h1, "font-size")).toBe("22px");
    // numărul e în titlu; paragraful separat «N fișiere» nu mai există
    await expect(page.getByText(/^\d+ fișiere?$/)).toHaveCount(0);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);

    // «Alege fișiere» (zona de încărcare) e singurul buton principal; «Caută» și «Resetează filtrele» sunt secundare
    const search = page.getByRole("button", { name: "Caută", exact: true });
    await expect(search).toBeVisible();
    expect(await primaryControls(page)).toEqual(["Alege fișiere"]);
    await expect(page.getByRole("link", { name: "Resetează filtrele" })).toBeVisible();

    // cardurile: chenar și fundal din tokeni, colțuri rotunjite, numele pe o singură linie cu «…» și title
    const cards = page.locator("[data-media-card]");
    await expect(cards).toHaveCount(8);
    const card = page.getByRole("button", { name: `Deschide ${names.long}` });
    expect(await css(card, "border-top-color")).toBe(
      await tokenStyle(page, "border-line-subtle", "border-top-color"),
    );
    expect(await css(card, "background-color")).toBe(
      await tokenStyle(page, "bg-surface-page", "background-color"),
    );
    expect(Number.parseFloat(await css(card, "border-top-left-radius"))).toBeGreaterThanOrEqual(8);
    const title = card.locator("span.truncate");
    expect(await css(title, "white-space")).toBe("nowrap");
    expect(await css(title, "text-overflow")).toBe("ellipsis");
    await expect(title).toHaveAttribute("title", names.long);
    expect((await title.boundingBox())?.height ?? 99).toBeLessThanOrEqual(24);
  });

  test("1024 px: foldere în coloana din stânga (16rem), cardurile în dreapta, fără derulare orizontală", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await login(page, account, url());
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const folders = page.getByRole("navigation", { name: "Foldere" });
    const grid = page.getByRole("list", { name: "Fișiere media" });
    const folderBox = (await folders.boundingBox()) as { x: number; width: number };
    const gridBox = (await grid.boundingBox()) as { x: number; width: number };
    expect(folderBox.width, "coloana de foldere").toBeCloseTo(256, 0);
    expect(gridBox.x, "cardurile sunt la dreapta folderelor").toBeGreaterThanOrEqual(
      folderBox.x + folderBox.width,
    );
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("390 px: folderele deasupra cardurilor, câmpurile de filtru pe toată lățimea, două coloane de carduri, fără derulare orizontală", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, account, url());
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    const folders = page.getByRole("navigation", { name: "Foldere" });
    const grid = page.getByRole("list", { name: "Fișiere media" });
    expect(((await folders.boundingBox())?.y ?? 0) < ((await grid.boundingBox())?.y ?? 0)).toBe(
      true,
    );
    const search = page.getByRole("search");
    // căutarea împarte primul rând cu «Caută»; Folder și Stare au câte o coloană din două
    for (const [label, min] of [
      ["Caută după nume, text alternativ sau tag", 240],
      ["Folder", 150],
      ["Stare", 150],
    ] as const) {
      const field = search.getByLabel(label, { exact: true });
      expect((await field.boundingBox())?.width ?? 0, label).toBeGreaterThanOrEqual(min);
    }
    const cards = await page.locator("[data-media-card]").all();
    const xs = new Set<number>();
    for (const c of cards) xs.add(Math.round((await c.boundingBox())?.x ?? 0));
    expect(xs.size, "coloane de carduri").toBe(2);
    expect(await primaryControls(page)).toEqual(["Alege fișiere"]);
  });
});

// ───────────────────────── Media: stări pe harness ─────────────────────────

test.describe("media: stări (pagina-harness)", () => {
  test("biblioteca goală: stare goală cu titlu, fără al doilea buton principal; filtrată: mesaj propriu; doar citire: nota «doar citire» și nicio acțiune de scriere", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, HARNESS("biblioteca", "goala"));
    await expect(
      page.getByRole("heading", {
        level: 2,
        name: "Biblioteca este goală. Încarcă prima imagine.",
      }),
    ).toBeVisible();
    // starea goală nu dublează acțiunea: singurul buton principal rămâne «Alege fișiere» din zona de încărcare
    expect(await primaryControls(page)).toEqual(["Alege fișiere"]);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);

    await page.goto(HARNESS("biblioteca", "filtrata"));
    await expect(
      page.getByRole("heading", { level: 2, name: "Niciun fișier nu corespunde filtrelor." }),
    ).toBeVisible();
    expect(await primaryControls(page)).toEqual(["Alege fișiere"]);

    await page.goto(HARNESS("biblioteca", "citire"));
    const note = page.getByRole("note");
    await expect(note).toContainText("Ai acces doar de citire");
    expect(await css(note, "background-color")).toBe(
      await tokenStyle(page, "bg-surface-subtle", "background-color"),
    );
    await expect(page.getByRole("button", { name: "Folder nou" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Alege fișiere" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^(Redenumește|Mută):/ })).toHaveCount(0);
    expect(await primaryControls(page)).toEqual([]);
  });

  for (const width of [1440, 390]) {
    test(`${width} px, texte lungi: fără derulare orizontală, numele de fișier tăiat cu «…», folderele lungi tăiate, cardurile egale pe rând`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await login(page, account, HARNESS("biblioteca", "lung"));
      await expect(page.locator("[data-media-card]").first()).toBeVisible();
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
      for (const name of await page.locator("[data-media-card] span.truncate").all()) {
        expect(await css(name, "white-space")).toBe("nowrap");
        expect(await css(name, "text-overflow")).toBe("ellipsis");
      }
      // folderul cu nume lung nu împinge numărul și acțiunile în afară
      const folders = page.getByRole("navigation", { name: "Foldere" });
      const box = (await folders.boundingBox()) as { x: number; width: number };
      for (const control of await folders.locator("a, button").all()) {
        const b = await control.boundingBox();
        if (!b) continue;
        expect(b.x + b.width, "în coloana de foldere").toBeLessThanOrEqual(box.x + box.width + 0.5);
      }
      // cardurile de pe același rând au aceeași înălțime
      const rows = new Map<number, number[]>();
      for (const card of await page.locator("[data-media-card]").all()) {
        const b = (await card.boundingBox()) as { y: number; height: number };
        const key = Math.round(b.y);
        rows.set(key, [...(rows.get(key) ?? []), b.height]);
      }
      for (const [y, heights] of rows) {
        expect(
          Math.max(...heights) - Math.min(...heights),
          `rândul de la y=${y}`,
        ).toBeLessThanOrEqual(1);
      }
    });
  }

  test("1440 px: acțiunile folderelor sunt pictograme terțe (fără bordură în repaus, cu nume accesibil și tooltip, 32 px)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, HARNESS("biblioteca"));
    const folders = page.getByRole("navigation", { name: "Foldere" });
    for (const folder of ["Produse", "Pompe de căldură", "Branding"]) {
      for (const verb of ["Redenumește", "Mută"]) {
        const button = folders.getByRole("button", { name: `${verb}: ${folder}` });
        await expectGhostIcon(page, button, `${verb}: ${folder}`);
        const box = await button.boundingBox();
        expect(box?.height ?? 0).toBeCloseTo(32, 0);
        expect(box?.width ?? 0).toBeCloseTo(32, 0);
      }
    }
    await folders.getByRole("button", { name: "Mută: Produse" }).hover();
    await expect
      .poll(() => css(folders.getByRole("button", { name: "Mută: Produse" }), "background-color"))
      .not.toBe("rgba(0, 0, 0, 0)");
  });

  test("ecran tactil (pointer grosier, 1024 px): acțiunile folderelor și «Scoate din listă» au cel puțin 44 px", async ({
    browser,
    baseURL,
  }) => {
    const { page, context } = await touchPage(
      browser,
      baseURL as string,
      account,
      HARNESS("biblioteca"),
      {
        width: 1024,
        height: 768,
      },
    );
    try {
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      for (const name of ["Redenumește: Produse", "Mută: Produse"]) {
        const box = await page.getByRole("button", { name }).boundingBox();
        expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(44);
        expect(box?.width ?? 0, name).toBeGreaterThanOrEqual(44);
      }
      await page.goto(HARNESS("incarcari"));
      for (const button of await page.getByRole("button", { name: /^Scoate din listă:/ }).all()) {
        const box = await button.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      }
    } finally {
      await context.close();
    }
  });

  for (const width of [1440, 390]) {
    test(`${width} px, încărcări: toate stările și erorile (în tonul Problemă / Succes), «Reîncearcă» secundar, «Scoate din listă» doar pictogramă, fără derulare orizontală`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await login(page, account, HARNESS("incarcari", "lung"));
      await expect(page.getByText("în coadă", { exact: false }).first()).toBeVisible();
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
      const problem = await tokenStyle(page, "text-tone-problem-fg", "color");
      const success = await tokenStyle(page, "text-tone-success-fg", "color");
      for (const message of [
        "Fișierul depășește mărimea maximă permisă.",
        "Tip de fișier neacceptat",
        "Prea multe încărcări. Încearcă din nou peste 30 s.",
        "Serverul procesează prea multe imagini",
        "Stocarea fișierelor nu este disponibilă",
        "Conexiunea a căzut",
        "Încărcarea a eșuat. Încearcă din nou.",
      ]) {
        const text = page.getByText(message, { exact: false }).first();
        await expect(text, message).toBeVisible();
        expect(await css(text, "color"), message).toBe(problem);
      }
      const done = page.getByText("Încărcat", { exact: true }).first();
      expect(await css(done, "color")).toBe(success);
      // «Reîncearcă» secundar; singurul buton principal e «Alege fișiere»
      expect(await primaryControls(page)).toEqual(["Alege fișiere"]);
      const retry = page.getByRole("button", { name: "Reîncearcă" }).first();
      expect(await css(retry, "background-color")).not.toBe(
        await tokenStyle(page, "bg-action", "background-color"),
      );
      // «Scoate din listă»: pictogramă terță
      for (const button of await page.getByRole("button", { name: /^Scoate din listă:/ }).all()) {
        await expect(button).toHaveText("");
        await expect(button).toHaveAttribute("title", /.+/);
        expect(await css(button, "border-top-width")).toBe("0px");
        expect(await css(button, "background-color")).toBe("rgba(0, 0, 0, 0)");
      }
      // numele fișierelor lungi: o linie, cu «…»
      for (const name of await page.locator("section li span.truncate").all()) {
        expect(await css(name, "text-overflow")).toBe("ellipsis");
      }
      // chenarul fiecărei încărcări: token, rotunjit
      const item = page.locator("section li").first();
      expect(await css(item, "border-top-color")).toBe(
        await tokenStyle(page, "border-line-subtle", "border-top-color"),
      );
      expect(Number.parseFloat(await css(item, "border-top-left-radius"))).toBeGreaterThanOrEqual(
        8,
      );
    });
  }
});

// ───────────────────────── Media: dialoguri ─────────────────────────

test.describe("media: dialoguri (detalii, ștergere, foldere)", () => {
  for (const width of [1440, 390]) {
    test(`${width} px, detalii: un singur buton principal («Salvează»), «Regenerează» secundar chiar și la procesare eșuată, «Șterge…» de pericol, eroarea de procesare în tonul Problemă`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await login(page, account, HARNESS("biblioteca"));
      await page.getByRole("button", { name: "Deschide pompa.png" }).click();
      const dialog = page.getByRole("dialog", { name: "pompa.png" });
      await expect(dialog).toBeVisible();
      expect(await primaryControls(page, dialog)).toEqual(["Salvează"]);
      const remove = dialog.getByRole("button", { name: "Șterge…" });
      expect(await css(remove, "color")).toBe(
        await tokenStyle(page, "text-tone-problem-fg", "color"),
      );
      expect(await css(remove, "background-color")).not.toBe(
        await tokenStyle(page, "bg-action", "background-color"),
      );
      await expectDialogFits(page, dialog);
      if (width === 1440) {
        // coloana cu miniatura: 14rem (w-56), informațiile alături
        const thumbBox = await dialog.locator("img").locator("xpath=..").boundingBox();
        expect(thumbBox?.width ?? 0).toBeCloseTo(224, 0);
      }
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "Deschide esuat.png" }).click();
      const failed = page.getByRole("dialog", { name: "esuat.png" });
      await expect(failed.getByRole("alert")).toContainText("Procesarea a eșuat");
      const alert = failed.getByRole("alert");
      expect(await css(alert, "background-color")).toBe(
        await tokenStyle(page, "bg-tone-problem-bg", "background-color"),
      );
      expect(await css(alert, "color")).toBe(
        await tokenStyle(page, "text-tone-problem-fg", "color"),
      );
      expect(await primaryControls(page, failed)).toEqual(["Salvează"]);
      await expectDialogFits(page, failed);
    });
  }

  test("confirmarea ștergerii: «Șterge definitiv» de pericol (nu principal), «Anulează» secundar", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, HARNESS("biblioteca"));
    await page.getByRole("button", { name: "Deschide pompa.png" }).click();
    await page
      .getByRole("dialog", { name: "pompa.png" })
      .getByRole("button", { name: "Șterge…" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Ștergi acest fișier?" });
    await expect(dialog).toBeVisible();
    expect(await primaryControls(page, dialog)).toEqual([]);
    const confirm = dialog.getByRole("button", { name: "Șterge definitiv" });
    expect(await css(confirm, "color")).toBe(
      await tokenStyle(page, "text-tone-problem-fg", "color"),
    );
    expect(await css(confirm, "border-top-color")).toBe(
      await tokenStyle(page, "border-line-control", "border-top-color"),
    );
    expect(
      await css(dialog.getByRole("button", { name: "Anulează" }), "background-color"),
    ).not.toBe(await tokenStyle(page, "bg-action", "background-color"));
  });

  test("fișier folosit de un produs: lista locurilor în carduri cu chenar-token, fără buton de ștergere și fără buton principal", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const slug = await attachMediaToE2eProduct(
      names.ready[0] as string,
      `Produs ${tag}`,
      `m-${tag}`,
    );
    expect(slug).toContain(tag);
    await login(page, account, `/admin/media?q=${tag}`);
    await page.getByRole("button", { name: `Deschide ${names.ready[0]}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Șterge…" }).click();
    await page.getByRole("button", { name: "Șterge definitiv" }).click();
    const refusal = page.getByRole("dialog", { name: "Fișierul este folosit" });
    await expect(refusal).toBeVisible();
    const entry = refusal.getByRole("listitem").first();
    expect(await css(entry, "border-top-color")).toBe(
      await tokenStyle(page, "border-line-subtle", "border-top-color"),
    );
    expect(Number.parseFloat(await css(entry, "border-top-left-radius"))).toBeGreaterThanOrEqual(8);
    expect(await primaryControls(page, refusal)).toEqual([]);
    await expect(refusal.getByRole("button", { name: "Șterge definitiv" })).toHaveCount(0);
  });

  test("folder nou: un singur buton principal («Salvează»), eroarea de validare în tonul Problemă cu focus pe câmp", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, HARNESS("biblioteca"));
    await page.getByRole("button", { name: "Folder nou" }).click();
    const dialog = page.getByRole("dialog", { name: "Creează folder" });
    await expect(dialog).toBeVisible();
    expect(await primaryControls(page, dialog)).toEqual(["Salvează"]);
    await dialog.getByRole("button", { name: "Salvează" }).click();
    const alert = dialog.getByRole("alert");
    await expect(alert).toContainText("Numele dosarului e obligatoriu.");
    expect(await css(alert, "color")).toBe(await tokenStyle(page, "text-tone-problem-fg", "color"));
    await expect(dialog.getByLabel("Nume folder")).toBeFocused();
  });
});

// ───────────────────────── Media: bara dialogului, filtre pe telefon, zona de încărcare ─────────────────────────

test.describe("media: dialogul de detalii, o singură bară de butoane", () => {
  const open = async (page: Page) => {
    await login(page, account, HARNESS("biblioteca"));
    await page.getByRole("button", { name: "Deschide pompa.png" }).click();
    const dialog = page.getByRole("dialog", { name: "pompa.png" });
    await expect(dialog).toBeVisible();
    return dialog;
  };

  test("1440 px: «Șterge…» (ghost, pericol) la stânga, «Regenerează variantele» (secundar) și «Salvează» (principal) la dreapta, toate pe același centru vertical; fără gol mare deasupra barei", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const dialog = await open(page);
    const bar = dialog.locator("[data-media-actions]");
    await expect(bar).toHaveCount(1);
    await expect(bar.getByRole("button")).toHaveCount(3);
    const remove = bar.getByRole("button", { name: "Șterge…" });
    const regenerate = bar.getByRole("button", { name: "Regenerează variantele" });
    const save = bar.getByRole("button", { name: "Salvează" });
    const [r, g, v] = (await Promise.all(
      [remove, regenerate, save].map((b) => b.boundingBox()),
    )) as [Box, Box, Box];
    const center = (b: { y: number; height: number }) => b.y + b.height / 2;
    expect(
      Math.abs(center(r) - center(g)),
      "Șterge… și Regenerează pe același centru",
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(center(g) - center(v)),
      "Regenerează și Salvează pe același centru",
    ).toBeLessThanOrEqual(1);
    expect(r.x, "Șterge… în stânga").toBeLessThan(g.x);
    expect(g.x, "Regenerează înaintea lui Salvează").toBeLessThan(v.x);
    // «Salvează» e lipit de marginea din dreapta a conținutului, «Șterge…» de cea din stânga a coloanei de câmpuri
    const barBox = (await bar.boundingBox()) as { x: number; width: number };
    expect(barBox.x + barBox.width - (v.x + v.width), "Salvează la dreapta").toBeLessThanOrEqual(1);
    // stiluri: «Șterge…» terț cu text de pericol; «Regenerează» secundar; «Salvează» principal
    expect(await css(remove, "background-color")).toBe("rgba(0, 0, 0, 0)");
    expect(await css(remove, "border-top-width")).toBe("0px");
    expect(await css(remove, "color")).toBe(
      await tokenStyle(page, "text-tone-problem-fg", "color"),
    );
    expect(await primaryControls(page, dialog)).toEqual(["Salvează"]);
    // fără gol mare: de la câmpul Folder la bară; rândul de stare gol nu ocupă loc
    await expect(dialog.locator('p[role="status"]')).toBeHidden();
    const folder = (await dialog.getByLabel("Folder", { exact: true }).boundingBox()) as {
      y: number;
      height: number;
    };
    const gap = ((await bar.boundingBox()) as { y: number }).y - (folder.y + folder.height);
    expect(gap, "golul dintre ultimul câmp și bară").toBeLessThanOrEqual(24);
  });

  for (const width of [390, 320]) {
    test(`${width} px: ținte de 44 px, bara încape (fără derulare, nicio acțiune în afara ei), acțiunile principale jos și «Șterge…» deasupra sau pe același rând, «Salvează» lipit la dreapta, fără gol mare`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const dialog = await open(page);
      const bar = dialog.locator("[data-media-actions]");
      await bar.scrollIntoViewIfNeeded();
      await expectDialogFits(page, dialog);
      if (width === 390) expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
      const barBox = (await bar.boundingBox()) as Box;
      const boxes: Record<string, Box> = {};
      for (const name of ["Șterge…", "Regenerează variantele", "Salvează"]) {
        const b = (await bar.getByRole("button", { name }).boundingBox()) as Box;
        expect(b.height, `${name}: înălțime`).toBeGreaterThanOrEqual(44);
        expect(b.height, `${name}: pe o singură linie`).toBeLessThanOrEqual(48);
        expect(b.x, `${name}: în bară, la stânga`).toBeGreaterThanOrEqual(barBox.x - 0.5);
        expect(b.x + b.width, `${name}: în bară, la dreapta`).toBeLessThanOrEqual(
          barBox.x + barBox.width + 0.5,
        );
        boxes[name] = b;
      }
      const remove = boxes["Șterge…"] as Box;
      const save = boxes["Salvează"] as Box;
      expect(save.y, "«Salvează» nu e deasupra lui «Șterge…»").toBeGreaterThanOrEqual(remove.y - 1);
      // când bara nu încape pe un rând (320 px), «Șterge…» rămâne deasupra, iar acțiunile principale jos
      if (width === 320) expect(save.y, "bara pe două rânduri").toBeGreaterThan(remove.y + 20);
      expect(
        barBox.x + barBox.width - (save.x + save.width),
        "«Salvează» lipit la dreapta",
      ).toBeLessThanOrEqual(1);
      // pe 390 px bara are cel mult două rânduri; pe 320 px, unde nici cele două acțiuni principale nu încap alături, trei
      expect(barBox.height, "înălțimea barei").toBeLessThanOrEqual(width === 390 ? 110 : 160);
      const folder = (await dialog.getByLabel("Folder", { exact: true }).boundingBox()) as Box;
      expect(
        barBox.y - (folder.y + folder.height),
        "golul dintre ultimul câmp și bară",
      ).toBeLessThanOrEqual(24);
      expect(await primaryControls(page, dialog)).toEqual(["Salvează"]);
    });
  }
});

test.describe("media: filtrele pe telefon", () => {
  test("390 px: căutarea și «Caută» pe primul rând, Folder și Stare pe două coloane pe al doilea, «Resetează filtrele» mic dedesubt; blocul de cel mult 200 px, fără derulare laterală", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, account, `/admin/media?q=${tag}`);
    const form = page.getByRole("search");
    const box = (await form.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    expect(box.height, "înălțimea blocului de filtre").toBeLessThanOrEqual(200);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    const q = (await form
      .getByLabel("Caută după nume, text alternativ sau tag", { exact: true })
      .boundingBox()) as { x: number; y: number; width: number; height: number };
    const go = (await form.getByRole("button", { name: "Caută", exact: true }).boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    expect(go.x, "«Caută» la dreapta câmpului").toBeGreaterThanOrEqual(q.x + q.width);
    expect(
      Math.abs(go.y + go.height - (q.y + q.height)),
      "«Caută» aliniat cu câmpul",
    ).toBeLessThanOrEqual(2);
    const folder = (await form.getByLabel("Folder", { exact: true }).boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const status = (await form.getByLabel("Stare", { exact: true }).boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    expect(folder.y, "Folder sub căutare").toBeGreaterThanOrEqual(q.y + q.height);
    expect(Math.abs(folder.y - status.y), "Folder și Stare pe același rând").toBeLessThanOrEqual(1);
    expect(status.x, "Stare lângă Folder").toBeGreaterThanOrEqual(folder.x + folder.width);
    expect(Math.abs(folder.width - status.width), "două coloane egale").toBeLessThanOrEqual(2);
    expect(folder.width, "coloană lată").toBeGreaterThanOrEqual(150);
    const reset = form.getByRole("link", { name: "Resetează filtrele" });
    const rb = (await reset.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    expect(rb.y, "«Resetează filtrele» sub Folder și Stare").toBeGreaterThanOrEqual(
      folder.y + folder.height,
    );
    expect(rb.height, "acțiune mică").toBeLessThanOrEqual(44);
    expect(Math.abs(rb.x - box.x), "aliniat la stânga").toBeLessThanOrEqual(1);
    expect(await css(reset, "background-color")).not.toBe(
      await tokenStyle(page, "bg-action", "background-color"),
    );
  });

  test("1440 px: filtrele rămân pe un singur rând (căutare, Folder, Stare, «Caută», «Resetează filtrele»)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, `/admin/media?q=${tag}`);
    const form = page.getByRole("search");
    const bottoms: number[] = [];
    for (const locator of [
      form.getByLabel("Caută după nume, text alternativ sau tag", { exact: true }),
      form.getByLabel("Folder", { exact: true }),
      form.getByLabel("Stare", { exact: true }),
      form.getByRole("button", { name: "Caută", exact: true }),
      form.getByRole("link", { name: "Resetează filtrele" }),
    ]) {
      const b = (await locator.boundingBox()) as { y: number; height: number };
      bottoms.push(b.y + b.height);
    }
    expect(Math.max(...bottoms) - Math.min(...bottoms), "un singur rând").toBeLessThanOrEqual(2);
  });

  test("selectorul de imagini, 390 px: căutarea și «Caută» pe primul rând, Folder dedesubt, fără derulare laterală", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, account, PICKER);
    const dialog = await openPicker(page);
    // animația de deschidere s-a terminat când apar cardurile
    await expect(dialog.locator("[data-media-card]").first()).toBeVisible({ timeout: 20_000 });
    const form = dialog.getByRole("search");
    const q = (await form.getByLabel(SEARCH_LABEL, { exact: true }).boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const go = (await form.getByRole("button", { name: "Caută", exact: true }).boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const folder = (await form.getByLabel("Folder", { exact: true }).boundingBox()) as {
      y: number;
    };
    expect(go.x).toBeGreaterThanOrEqual(q.x + q.width);
    expect(Math.abs(go.y + go.height - (q.y + q.height))).toBeLessThanOrEqual(2);
    expect(folder.y).toBeGreaterThanOrEqual(q.y + q.height);
    expect(
      ((await form.boundingBox()) as { height: number }).height,
      "înălțimea filtrelor",
    ).toBeLessThanOrEqual(160);
    await expectDialogFits(page, dialog);
  });
});

test.describe("media: zona de încărcare, compactă pe ecrane tactile", () => {
  test("desktop (cursor fin): cu textul de tragere («Trage imaginile aici», «sau»), «Alege fișiere» principal", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, HARNESS("biblioteca"));
    await expect(page.getByText("Trage imaginile aici")).toBeVisible();
    await expect(page.getByText("sau", { exact: true })).toBeVisible();
    expect(await primaryControls(page)).toEqual(["Alege fișiere"]);
  });

  test("ecran tactil, 390 px: fără «Trage imaginile aici» și «sau»; rămân «Alege fișiere» (principal) și nota despre formate, într-un panou de cel mult 130 px, fără derulare laterală", async ({
    browser,
    baseURL,
  }) => {
    const { page, context } = await touchPage(
      browser,
      baseURL as string,
      account,
      HARNESS("biblioteca"),
      { width: 390, height: 844 },
    );
    try {
      expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      await expect(page.getByText("Trage imaginile aici")).toBeHidden();
      await expect(page.getByText("sau", { exact: true })).toBeHidden();
      await expect(page.getByText(/^JPEG, PNG, WebP, AVIF/)).toBeVisible();
      expect(await primaryControls(page)).toEqual(["Alege fișiere"]);
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
      const zone = page.locator("[data-upload-zone]");
      await expect(zone).toBeVisible();
      expect(
        ((await zone.boundingBox()) as { height: number }).height,
        "panoul de încărcare",
      ).toBeLessThanOrEqual(130);
    } finally {
      await context.close();
    }
  });
});

// ───────────────────────── Selectorul de media ─────────────────────────

async function openPicker(page: Page, mode: "single" | "multiple" = "multiple") {
  await page.goto(PICKER);
  await page
    .getByRole("button", {
      name: mode === "single" ? "Deschide selector (unic)" : "Deschide selector (multiplu, max 3)",
    })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

const SEARCH_LABEL = "Caută după nume, text alternativ sau tag";

async function searchPicker(dialog: Locator, text: string) {
  await dialog.getByLabel(SEARCH_LABEL).fill(text);
  await dialog.getByRole("button", { name: "Caută", exact: true }).click();
}

test.describe("selectorul de media", () => {
  test("1440 px: un singur buton principal («Alege …»), «Caută» secundar; selecția cu insignă și chenar din brand, ordinea în tavă, «Scoate din selecție» doar pictogramă", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, PICKER);
    const dialog = await openPicker(page);
    await searchPicker(dialog, tag);
    await expect(dialog.locator("[data-media-card]")).toHaveCount(6);
    expect(await primaryControls(page, dialog)).toEqual(["Alege 0 imagini"]);
    expect(
      await css(dialog.getByRole("button", { name: "Caută", exact: true }), "background-color"),
    ).not.toBe(await tokenStyle(page, "bg-action", "background-color"));

    const first = dialog.getByRole("button", { name: new RegExp(`^(Alege )?${names.ready[0]}`) });
    await first.click();
    await dialog.getByRole("button", { name: new RegExp(`^(Alege )?${names.ready[1]}`) }).click();
    await expect(dialog.getByTestId("picker-count")).toContainText("2 din 3 alese");
    const selected = dialog.getByRole("button", { name: new RegExp(`^${names.ready[0]}, ales`) });
    await expect(selected).toHaveAttribute("aria-pressed", "true");
    expect(await css(selected, "border-top-color")).toBe(
      await tokenStyle(page, "border-brand", "border-top-color"),
    );
    const badge = selected.locator("span[aria-hidden='true']").first();
    expect(await css(badge, "background-color")).toBe(
      await tokenStyle(page, "bg-brand", "background-color"),
    );
    expect(await css(badge, "color")).toBe(await tokenStyle(page, "text-on-brand", "color"));
    // butonul de confirmare rămâne singurul principal, cu eticheta actualizată
    expect(await primaryControls(page, dialog)).toEqual(["Alege 2 imagini"]);

    const tray = dialog.getByRole("region", { name: "Imaginile alese, în ordine" });
    for (const remove of await tray.getByRole("button", { name: /^Scoate din selecție:/ }).all()) {
      await expect(remove).toHaveText("");
      await expect(remove).toHaveAttribute("title", /.+/);
      expect(await css(remove, "border-top-width")).toBe("0px");
      expect(await css(remove, "background-color")).toBe("rgba(0, 0, 0, 0)");
    }
    const chip = tray.getByRole("listitem").first();
    expect(await css(chip, "border-top-color")).toBe(
      await tokenStyle(page, "border-line-subtle", "border-top-color"),
    );
    expect(Number.parseFloat(await css(chip, "border-top-left-radius"))).toBeGreaterThanOrEqual(8);
    await expectDialogFits(page, dialog);
  });

  test("stări: goală, eroare de încărcare (cu «Reîncearcă» secundar) și încărcare; în fiecare, cel mult un buton principal", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, PICKER);
    // încărcare: prima listă întârziată
    let delay = true;
    await page.route("**/*", async (route) => {
      if (delay && route.request().headers()["next-action"]) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
      }
      await route.continue();
    });
    await page.goto(PICKER);
    await page.getByRole("button", { name: "Deschide selector (multiplu, max 3)" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Se încarcă fișierele…")).toBeVisible();
    expect(await primaryControls(page, dialog)).toEqual(["Alege 0 imagini"]);
    await expect(dialog.locator("[data-media-card]").first()).toBeVisible({ timeout: 20_000 });
    delay = false;

    // goală
    await searchPicker(dialog, `zzz${tag}`);
    const empty = dialog.getByText("Nu există fișiere gata în această căutare.");
    await expect(empty).toBeVisible();
    expect(await primaryControls(page, dialog)).toEqual(["Alege 0 imagini"]);

    // eroare: acțiunea de server cade
    await page.unroute("**/*");
    await page.route("**/*", (route) =>
      route.request().headers()["next-action"] ? route.abort() : route.continue(),
    );
    await searchPicker(dialog, tag);
    const alert = dialog.getByRole("alert").filter({ hasText: "Nu am putut încărca biblioteca" });
    await expect(alert).toBeVisible();
    expect(await primaryControls(page, dialog)).toEqual(["Alege 0 imagini"]);
    const retry = alert.getByRole("button", { name: "Reîncearcă" });
    expect(await css(retry, "background-color")).not.toBe(
      await tokenStyle(page, "bg-action", "background-color"),
    );
  });

  test("390 px: dialogul încape în fereastră, fără derulare orizontală, cu două coloane de carduri și un singur buton principal", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, account, PICKER);
    const dialog = await openPicker(page);
    await searchPicker(dialog, tag);
    await expect(dialog.locator("[data-media-card]").first()).toBeVisible();
    await dialog.getByRole("button", { name: new RegExp(`^(Alege )?${names.ready[0]}`) }).click();
    await expectDialogFits(page, dialog);
    expect(await primaryControls(page, dialog)).toEqual(["Alege 1 imagine"]);
    const xs = new Set<number>();
    for (const c of await dialog.locator("[data-media-card]").all()) {
      xs.add(Math.round((await c.boundingBox())?.x ?? 0));
    }
    expect(xs.size).toBe(2);
  });

  test("ecran tactil: «Scoate din selecție» are cel puțin 44 px", async ({ browser, baseURL }) => {
    const { page, context } = await touchPage(browser, baseURL as string, account, PICKER, {
      width: 1024,
      height: 768,
    });
    try {
      const dialog = await openPicker(page, "single");
      await searchPicker(dialog, tag);
      await dialog.getByRole("button", { name: new RegExp(`^(Alege )?${names.ready[0]}`) }).click();
      const remove = dialog.getByRole("button", { name: /^Scoate din selecție:/ });
      const box = await remove.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    } finally {
      await context.close();
    }
  });

  for (const width of [1440, 390]) {
    test(`${width} px, selectorul în editorul de produs, brand și categorie: dialogul de alegere încape, fără derulare orizontală, un singur buton principal`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      // etichetă proprie pe lățime: seed-urile din cele două rulări nu se ciocnesc (aceleași slug-uri)
      const own = `${tag}${width}`;
      const [title] = await seedE2eProducts(own, 1);
      await seedE2eBrandList(own, [`Hayward ${own}`]);
      await seedE2eCategoryTree(own, [{ name: `Pompe ${own}` }]);
      await login(page, account, `/admin/produse?q=${encodeURIComponent(`E2E ${own}`)}`);

      const check = async (picker: Locator, label: string) => {
        await expect(picker, label).toBeVisible();
        await expect(picker.locator("[data-media-card]").first(), label).toBeVisible({
          timeout: 20_000,
        });
        expect(await primaryControls(page, picker), label).toHaveLength(1);
        await expectDialogFits(page, picker);
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
      };

      // produs: tabul Media
      await page.getByRole("link", { name: `Deschide produsul ${title}` }).click();
      await page.waitForURL(/\/admin\/produse\/[A-Za-z0-9_-]+(\?|$)/);
      await page.getByRole("tab", { name: "Media", exact: true }).click();
      await page.getByRole("button", { name: "Adaugă din bibliotecă" }).click();
      await check(page.getByRole("dialog", { name: "Alege imaginile produsului" }), "produs");

      // brand: logo
      await page.goto("/admin/produse/branduri");
      await page.getByRole("button", { name: `Editează brandul Hayward ${own}` }).click();
      await page.getByRole("button", { name: /^Alege logoul|^Schimbă logoul/ }).click();
      await check(page.getByRole("dialog", { name: "Alege o imagine" }), "brand");

      // categorie: imagine
      await page.goto("/admin/produse/categorii");
      await page.getByRole("button", { name: `Editează categoria Pompe ${own}` }).click();
      await page.getByRole("button", { name: /^Alege imaginea|^Schimbă imaginea/ }).click();
      await check(page.getByRole("dialog", { name: "Alege o imagine" }), "categorie");
    });
  }
});

// ───────────────────────── Depozite (harness) ─────────────────────────

test.describe("depozite", () => {
  const TABLE = "Lista depozitelor";
  const row = (page: Page, code: string) => page.locator(`[data-warehouse-row="${code}"]`);
  const ACTIONS = {
    magazin_bucuresti: [/^Redenumește depozitul/, /^Dezactivează depozitul/],
    vechi: [/^Redenumește depozitul/, /^Activează depozitul/],
  } as const;

  test("1440 px: titlu cu număr, antet gri, rânduri de cel mult 56 px, acțiuni doar cu pictogramă terță, un singur buton principal", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, HARNESS("depozite"));
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toHaveText(/^Depozite \(\d+\)$/);
    expect(await css(h1, "font-size")).toBe("22px");
    const table = page.getByRole("table", { name: TABLE });
    await expect(table).toBeVisible();
    for (const name of ["Nume", "Cod", "Stoc", "Stare", "Acțiuni"]) {
      await expect(table.getByRole("columnheader", { name, exact: true }), name).toBeVisible();
    }
    expect(await css(table.locator("thead"), "background-color")).not.toBe("rgba(0, 0, 0, 0)");
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    for (const code of ["principal", "magazin_bucuresti", "vechi", "cu_stoc"]) {
      const height = (await row(page, code).boundingBox())?.height ?? 0;
      expect(height, `înălțimea rândului ${code}`).toBeGreaterThanOrEqual(48);
      expect(height, `înălțimea rândului ${code}`).toBeLessThanOrEqual(56);
      for (const cell of ["code", "stock"]) {
        expect(
          await css(row(page, code).locator(`[data-cell="${cell}"]`), "white-space"),
          cell,
        ).toBe("nowrap");
      }
    }
    for (const [code, actions] of Object.entries(ACTIONS)) {
      for (const action of actions) {
        await expectGhostIcon(
          page,
          row(page, code).getByRole("button", { name: action }),
          `${code}: ${action}`,
        );
      }
    }
    // depozitul implicit nu se dezactivează: doar «Redenumește»
    await expect(row(page, "principal").getByRole("button")).toHaveCount(1);
    // pastile de stare: tonuri diferite pentru Activ și Dezactivat
    const active = row(page, "magazin_bucuresti").locator("[data-status-pill]").first();
    const inactive = row(page, "vechi").locator("[data-status-pill]").first();
    await expect(active).toHaveText("Activ");
    await expect(inactive).toHaveText("Dezactivat");
    expect(await css(active, "background-color")).not.toBe(await css(inactive, "background-color"));
    await expect(row(page, "principal").getByText("Implicit")).toBeVisible();
    expect(await primaryControls(page)).toEqual(["Depozit nou"]);
  });

  test("1024 px: doar coloanele principale, fără derulare orizontală", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await login(page, account, HARNESS("depozite"));
    const table = page.getByRole("table", { name: TABLE });
    await expect(table).toBeVisible();
    for (const name of ["Nume", "Stare", "Acțiuni"]) {
      await expect(table.getByRole("columnheader", { name, exact: true }), name).toBeVisible();
    }
    for (const name of ["Cod", "Stoc"]) {
      await expect(table.getByRole("columnheader", { name, exact: true }), name).toBeHidden();
    }
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    expect(
      await table.locator("xpath=..").evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(0);
  });

  test("390 px: cardul de cel mult 84 px (200 px cu texte lungi), acțiunile de 44 px în colțul din dreapta-sus, numele se oprește înaintea lor, fără derulare orizontală", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, account, HARNESS("depozite"));
    for (const stare of ["lista", "lung"]) {
      await page.goto(HARNESS("depozite", stare));
      await expect(page.getByRole("table", { name: TABLE })).toBeVisible();
      expect(await pageOverflow(page), stare).toBeLessThanOrEqual(0);
      for (const card of await page.locator("[data-warehouse-row]").all()) {
        const code = (await card.getAttribute("data-warehouse-row")) as string;
        const box = (await card.boundingBox()) as {
          x: number;
          y: number;
          width: number;
          height: number;
        };
        expect(box.height, `cardul ${code} (${stare})`).toBeLessThanOrEqual(
          stare === "lista" ? 84 : 200,
        );
        const lefts: number[] = [];
        for (const button of await card.getByRole("button").all()) {
          const b = (await button.boundingBox()) as {
            x: number;
            y: number;
            width: number;
            height: number;
          };
          expect(b.height).toBeGreaterThanOrEqual(44);
          expect(b.width).toBeGreaterThanOrEqual(44);
          expect(b.y, `${code}: acțiunea în prima bandă`).toBeLessThanOrEqual(box.y + 12);
          expect(b.x + b.width, `${code}: în interiorul cardului`).toBeLessThanOrEqual(
            box.x + box.width + 0.5,
          );
          lefts.push(b.x);
        }
        // numele (textul, nu celula) se oprește înaintea acțiunilor, chiar și când e foarte lung
        const nameRight = await card.locator('th[scope="row"]').evaluate((cell) => {
          const range = document.createRange();
          range.selectNodeContents(cell);
          return range.getBoundingClientRect().right;
        });
        expect(nameRight, `${code} (${stare}): numele și acțiunile`).toBeLessThanOrEqual(
          Math.min(...lefts) + 0.5,
        );
      }
    }
    await page.goto(HARNESS("depozite"));
    expect(await primaryControls(page)).toEqual(["Depozit nou"]);
  });

  test("ecran tactil (1024 px): acțiunile rândurilor au cel puțin 44 px", async ({
    browser,
    baseURL,
  }) => {
    const { page, context } = await touchPage(
      browser,
      baseURL as string,
      account,
      HARNESS("depozite"),
      {
        width: 1024,
        height: 768,
      },
    );
    try {
      for (const button of await row(page, "magazin_bucuresti").getByRole("button").all()) {
        const box = await button.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      }
    } finally {
      await context.close();
    }
  });

  test("lista goală: stare goală cu o singură acțiune; doar citire: acțiuni dezactivate și estompate, nota în antet; texte lungi fără derulare orizontală", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, HARNESS("depozite", "goala"));
    const heading = page.getByRole("heading", { level: 2, name: "Nu există niciun depozit." });
    await expect(heading).toBeVisible();
    await expect(page.getByRole("button", { name: "Depozit nou" })).toHaveCount(1);
    expect(await primaryControls(page)).toEqual(["Depozit nou"]);

    await page.goto(HARNESS("depozite", "citire"));
    await expect(page.getByRole("note").filter({ hasText: "Poți vedea depozitele" })).toBeVisible();
    for (const button of await page.locator("[data-warehouse-row] button").all()) {
      await expect(button).toBeDisabled();
      expect(Number(await css(button, "opacity"))).toBeLessThan(1);
    }
    await expect(page.getByRole("button", { name: "Depozit nou" })).toBeDisabled();

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(HARNESS("depozite", "lung"));
      await expect(page.getByRole("table", { name: TABLE })).toBeVisible();
      expect(await pageOverflow(page), `${width} px`).toBeLessThanOrEqual(0);
      for (const text of await page.locator("[data-cell-text]").all()) {
        if (!(await text.isVisible())) continue;
        expect(await css(text, "white-space")).toBe("nowrap");
        expect(await css(text, "text-overflow")).toBe("ellipsis");
      }
      for (const r of await page.locator("[data-warehouse-row]").all()) {
        expect((await r.boundingBox())?.height ?? 999).toBeLessThanOrEqual(200);
      }
    }
  });

  test("dialoguri: «Depozit nou» are un singur buton principal și eroarea de validare în tonul Problemă; dezactivarea e acțiune de pericol (nu principală), cu nota «are stoc» în tonul Problemă", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, HARNESS("depozite"));
    await page.getByRole("button", { name: "Depozit nou" }).click();
    const create = page.getByRole("dialog", { name: "Depozit nou" });
    await expect(create).toBeVisible();
    expect(await primaryControls(page, create)).toEqual(["Salvează"]);
    await create.getByRole("button", { name: "Salvează" }).click();
    const error = create.getByText("Numele e obligatoriu.");
    await expect(error).toBeVisible();
    expect(await css(error, "color")).toBe(await tokenStyle(page, "text-tone-problem-fg", "color"));
    await expect(create.getByLabel("Nume")).toBeFocused();
    await create.getByRole("button", { name: "Anulează" }).click();

    await row(page, "magazin_bucuresti")
      .getByRole("button", { name: /^Dezactivează depozitul/ })
      .click();
    const off = page.getByRole("dialog", { name: "Dezactivezi «Magazin București»?" });
    await expect(off).toBeVisible();
    expect(await primaryControls(page, off)).toEqual([]);
    const confirm = off.getByRole("button", { name: "Dezactivează", exact: true });
    expect(await css(confirm, "color")).toBe(
      await tokenStyle(page, "text-tone-problem-fg", "color"),
    );
    expect(await css(confirm, "border-top-color")).toBe(
      await tokenStyle(page, "border-line-control", "border-top-color"),
    );
    await off.getByRole("button", { name: "Anulează" }).click();

    await row(page, "cu_stoc")
      .getByRole("button", { name: /^Dezactivează depozitul/ })
      .click();
    const stocked = page.getByRole("dialog", { name: "Dezactivezi «Depozit cu stoc»?" });
    const note = stocked.locator("[data-has-stock]");
    await expect(note).toBeVisible();
    expect(await css(note, "background-color")).toBe(
      await tokenStyle(page, "bg-tone-problem-bg", "background-color"),
    );
    expect(await css(note, "color")).toBe(await tokenStyle(page, "text-tone-problem-fg", "color"));
    await expect(stocked.getByRole("button", { name: "Dezactivează", exact: true })).toBeDisabled();
    expect(await primaryControls(page, stocked)).toEqual([]);
  });
});

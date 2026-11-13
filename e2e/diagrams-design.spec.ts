import { randomBytes } from "node:crypto";
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";
import { promoteE2eUser } from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Redesign admin, Lotul 3b-2 (docs/17): Fișe explodate. Lista pe `Table` (mod stivuit pe telefon, miniatura în card), titlu cu
 * număr, stare goală cu `EmptyState`; editorul (doar shell-ul, nu logica canvasului): antet cu titlu, secțiuni separate prin linie,
 * marcajele și rândurile hotspot-urilor în tonuri-token (selecția din brand), câmpuri pe grilă, acțiuni doar cu pictogramă,
 * un singur buton principal pe ecran și în fiecare dialog (confirmările de ștergere sunt de pericol, nu principale).
 * Toate stările se verifică pe pagina-harness `/admin/e2e-harness/fise-explodate` (date fixe, fără bază de date și fără flag);
 * comportamentul (creare, hotspot-uri, produse asociate, ștergere) rămâne în `parts-diagrams.spec.ts`.
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
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  return { page, context };
}

test.describe.configure({ mode: "serial", timeout: 150_000 });

let account: Account;

test.beforeAll(async ({ request, baseURL }) => {
  account = await createAccount(request, baseURL as string, "owner");
});

const css = (locator: Locator, property: string) =>
  locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);

/** Pagina nu derulează pe orizontală (scrollWidth ≤ clientWidth). */
const pageOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Valoarea unei proprietăți pentru o clasă-token, citită dintr-un element-sondă din suprafața adminului. */
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

const HARNESS = (ecran: string, stare = "normal") =>
  `/admin/e2e-harness/fise-explodate?ecran=${ecran}&stare=${stare}`;
const TABLE = "Fișele explodate";
const row = (page: Page, title: string) => page.locator(`[data-diagram-row="${title}"]`);
const hotspot = (page: Page, n: number) => page.locator(`[data-hotspot-row="${n}"]`);

// ───────────────────────── Lista ─────────────────────────

test.describe("fișe explodate: lista", () => {
  test("1440 px: titlu cu număr, antet gri, rânduri de 48–72 px cu miniatură, numărătorile cu text, un singur buton principal", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, HARNESS("lista"));
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toHaveText(/^Fișe explodate \(3\)$/);
    expect(await css(h1, "font-size")).toBe("22px");
    const table = page.getByRole("table", { name: TABLE });
    await expect(table).toBeVisible();
    for (const name of ["Imagine", "Titlu", "Hotspot-uri", "Produse"]) {
      await expect(table.getByRole("columnheader", { name, exact: true }), name).toBeVisible();
    }
    expect(await css(table.locator("thead"), "background-color")).not.toBe("rgba(0, 0, 0, 0)");
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    for (const title of ["Pompă de filtrare", "Filtru cu nisip", "Skimmer"]) {
      const height = (await row(page, title).boundingBox())?.height ?? 0;
      expect(height, `înălțimea rândului ${title}`).toBeGreaterThanOrEqual(48);
      expect(height, `înălțimea rândului ${title}`).toBeLessThanOrEqual(72);
    }
    await expect(row(page, "Pompă de filtrare").getByText("12 hotspot-uri")).toBeVisible();
    await expect(row(page, "Pompă de filtrare").getByText("5 produse")).toBeVisible();
    await expect(row(page, "Filtru cu nisip").getByText("Fără imagine")).toBeVisible();
    await expect(row(page, "Skimmer").getByText("0 de produse")).toBeVisible();
    // miniatura are chenar-token, nu clasa veche
    const thumb = row(page, "Pompă de filtrare").locator("img");
    expect(await css(thumb, "border-top-color")).toBe(
      await tokenStyle(page, "border-line-subtle", "border-top-color"),
    );
    expect(await primaryControls(page)).toEqual(["Fișă nouă"]);
  });

  test("1024 px: fără derulare orizontală", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await login(page, account, HARNESS("lista"));
    await expect(page.getByRole("table", { name: TABLE })).toBeVisible();
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("390 px: carduri (mod stivuit) de cel mult 120 px, fără derulare orizontală, titlul lung nu rupe pagina", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, account, HARNESS("lista", "lung"));
    await expect(page.getByRole("table", { name: TABLE })).toBeVisible();
    expect(await page.locator("table[data-stacked]").count()).toBe(1);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    for (const title of ["Pompă de filtrare", "Filtru cu nisip"]) {
      const height = (await row(page, title).boundingBox())?.height ?? 0;
      expect(height, `înălțimea cardului ${title}`).toBeLessThanOrEqual(120);
    }
    const long = row(
      page,
      "Pompă de căldură inverter cu agent frigorific ecologic pentru piscine rezidențiale",
    );
    expect((await long.boundingBox())?.width ?? 0).toBeLessThanOrEqual(390);
  });

  test("lista goală: stare goală cu o singură acțiune; doar citire: fără «Fișă nouă», nota în antet", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, HARNESS("lista", "goala"));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Fișe explodate \(0\)$/);
    await expect(page.getByText("Nu există încă nicio fișă explodată.")).toBeVisible();
    await expect(page.getByRole("table", { name: TABLE })).toHaveCount(0);
    // o singură acțiune de creare (nu și în antet, nu două)
    await expect(page.getByRole("button", { name: "Fișă nouă" })).toHaveCount(1);
    expect(await primaryControls(page)).toEqual(["Fișă nouă"]);

    await page.goto(HARNESS("lista", "citire"));
    await expect(page.getByRole("note")).toHaveText("Poți vedea fișele, dar nu le poți modifica.");
    await expect(page.getByRole("button", { name: "Fișă nouă" })).toHaveCount(0);
    expect(await primaryControls(page)).toEqual([]);
  });

  test("«Fișă nouă»: un singur buton principal, eroarea de validare în tonul Problemă cu focus pe primul câmp greșit, încape pe telefon", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, HARNESS("lista"));
    await page.getByRole("button", { name: "Fișă nouă" }).click();
    const dialog = page.getByRole("dialog", { name: "Fișă explodată nouă" });
    await expect(dialog).toBeVisible();
    expect(await primaryControls(page, dialog)).toEqual(["Creează fișa"]);
    await dialog.getByRole("button", { name: "Creează fișa" }).click();
    const titleError = dialog.getByText("Titlul e obligatoriu.");
    await expect(titleError).toBeVisible();
    expect(await css(titleError, "color")).toBe(
      await tokenStyle(page, "text-tone-problem-fg", "color"),
    );
    const imageError = dialog.locator("[data-problem]").filter({ hasText: /imagin/i });
    await expect(imageError).toBeVisible();
    expect(await css(imageError, "color")).toBe(
      await tokenStyle(page, "text-tone-problem-fg", "color"),
    );
    await expect(dialog.getByLabel("Titlu", { exact: true })).toBeFocused();

    await page.setViewportSize({ width: 390, height: 844 });
    await expectDialogFits(page, dialog);
  });
});

// ───────────────────────── Editorul ─────────────────────────

test.describe("fișe explodate: editorul", () => {
  test("1440 px: antet cu legătură înapoi și titlu, secțiuni cu titlu de 16 px separate prin linie, coloană de cel mult 896 px, un singur buton principal («Adaugă hotspot»)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, HARNESS("editor"));
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toHaveText("Pompă de filtrare");
    expect(await css(h1, "font-size")).toBe("22px");
    const back = page.getByRole("link", { name: "Înapoi la fișele explodate" });
    expect(await css(back, "font-size")).toBe("14px");
    for (const name of ["Imagine", "Hotspot-uri", "Produse asociate fișei"]) {
      const heading = page.getByRole("heading", { level: 2, name, exact: true });
      await expect(heading, name).toBeVisible();
      expect(await css(heading, "font-size"), name).toBe("16px");
    }
    // secțiunile se despart prin linie-token, nu prin chenar vechi
    const sections = page.locator("main section");
    expect(await sections.count()).toBeGreaterThanOrEqual(3);
    for (const index of [0, 1, 2]) {
      expect(await css(sections.nth(index), "border-top-color"), `secțiunea ${index}`).toBe(
        await tokenStyle(page, "border-line-subtle", "border-top-color"),
      );
      expect(await css(sections.nth(index), "border-top-width"), `secțiunea ${index}`).toBe("1px");
    }
    const column = (await page.locator("main section").first().boundingBox())?.width ?? 0;
    expect(column).toBeLessThanOrEqual(896);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    expect(await primaryControls(page)).toEqual(["Adaugă hotspot"]);
    // «Salvează titlul» și «Salvează» pe rând sunt secundare
    await expect(page.getByRole("button", { name: "Salvează titlul" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Salvează hotspot-ul 1" })).toBeVisible();
  });

  test("marcajele și rândurile: selecția ia culoarea brandului, restul tonuri-token; câmpurile pe grilă (o linie pe desktop, număr/etichetă/poziții pe telefon)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, HARNESS("editor"));
    const marker1 = page.locator('[data-diagram-canvas] [data-marker="1"]');
    const marker2 = page.locator('[data-diagram-canvas] [data-marker="2"]');
    await marker1.click();
    await expect(marker1).toHaveAttribute("aria-pressed", "true");
    expect(await css(marker1, "background-color")).toBe(
      await tokenStyle(page, "bg-brand", "background-color"),
    );
    expect(await css(marker1, "color")).toBe(await tokenStyle(page, "text-on-brand", "color"));
    expect(await css(marker2, "background-color")).toBe(
      await tokenStyle(page, "bg-surface-page", "background-color"),
    );
    expect(await css(marker2, "color")).toBe(await tokenStyle(page, "text-ink", "color"));
    // rândul selectat: chenar din brand și fundal subtil; celălalt: chenar-token
    expect(await css(hotspot(page, 1), "border-top-color")).toBe(
      await tokenStyle(page, "border-brand", "border-top-color"),
    );
    expect(await css(hotspot(page, 1), "background-color")).toBe(
      await tokenStyle(page, "bg-surface-subtle", "background-color"),
    );
    expect(await css(hotspot(page, 2), "border-top-color")).toBe(
      await tokenStyle(page, "border-line-subtle", "border-top-color"),
    );
    // desktop: Nr., Etichetă, Orizontal, Vertical pe aceeași linie
    const tops = await Promise.all(
      [
        "Numărul hotspot-ului 1",
        "Eticheta hotspot-ului 1",
        "Poziția orizontală a hotspot-ului 1 (%)",
        "Poziția verticală a hotspot-ului 1 (%)",
      ].map(async (label) => (await hotspot(page, 1).getByLabel(label).boundingBox())?.y ?? -1),
    );
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    const xBox = await hotspot(page, 1)
      .getByLabel("Poziția orizontală a hotspot-ului 1 (%)")
      .boundingBox();
    const yBox = await hotspot(page, 1)
      .getByLabel("Poziția verticală a hotspot-ului 1 (%)")
      .boundingBox();
    const labelBox = await hotspot(page, 1).getByLabel("Eticheta hotspot-ului 1").boundingBox();
    expect(Math.abs((xBox?.y ?? 0) - (yBox?.y ?? 99))).toBeLessThanOrEqual(1); // poziții pe un rând
    expect(labelBox?.width ?? 0).toBeGreaterThan(300); // eticheta pe toată lățimea
  });

  test("acțiuni doar cu pictogramă (ștergerea hotspot-ului, desprinderea produsului), produsul șters în tonul Problemă", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, HARNESS("editor"));
    await expectGhostIcon(
      page,
      hotspot(page, 1).getByRole("button", { name: "Șterge hotspot-ul 1" }),
      "șterge hotspot",
    );
    await expectGhostIcon(
      page,
      page
        .locator('[data-diagram-product="Garnitură capac"]')
        .getByRole("button", { name: /^Scoate produsul/ }),
      "desprinde produs",
    );
    const deleted = hotspot(page, 3)
      .getByText(/produs șters/i)
      .first();
    await expect(deleted).toBeVisible();
    expect(await css(deleted, "color")).toBe(
      await tokenStyle(page, "text-tone-problem-fg", "color"),
    );
  });

  test("rând nou nesalvat cu eroare de validare: tonul Problemă, fără al doilea buton principal", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, HARNESS("editor"));
    await page.getByRole("button", { name: "Adaugă hotspot" }).click();
    await page.getByRole("button", { name: "Salvează hotspot-ul 4" }).click();
    const error = hotspot(page, 4).getByRole("alert");
    await expect(error).toBeVisible();
    expect(await css(error, "color")).toBe(await tokenStyle(page, "text-tone-problem-fg", "color"));
    expect(await primaryControls(page)).toEqual(["Adaugă hotspot"]);
  });

  test("ștergerea fișei: butonul declanșator e secundar, confirmarea de pericol (nu principală); dialogul încape pe telefon", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, HARNESS("editor"));
    await page.getByRole("button", { name: "Șterge fișa", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Ștergi fișa «Pompă de filtrare»?" });
    await expect(dialog).toBeVisible();
    expect(await primaryControls(page, dialog)).toEqual([]);
    const confirm = dialog.getByRole("button", { name: "Șterge fișa definitiv" });
    expect(await css(confirm, "color")).toBe(
      await tokenStyle(page, "text-tone-problem-fg", "color"),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await expectDialogFits(page, dialog);
  });

  test("doar citire: fără «Adaugă hotspot», «Salvează titlul», «Șterge fișa» și fără butoane principale; titlul lung nu rupe pagina pe telefon", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, account, HARNESS("editor", "citire"));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    for (const name of ["Adaugă hotspot", "Salvează titlul", "Șterge fișa", "Schimbă imaginea"]) {
      await expect(page.getByRole("button", { name, exact: true }), name).toHaveCount(0);
    }
    expect(await primaryControls(page)).toEqual([]);
    await page.goto(HARNESS("editor", "lung"));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("ecran tactil (390 px): marcajele, acțiunile rândurilor și rezultatele au cel puțin 44 px", async ({
    browser,
    baseURL,
  }) => {
    const { page, context } = await touchPage(
      browser,
      baseURL as string,
      account,
      HARNESS("editor"),
      {
        width: 390,
        height: 844,
      },
    );
    try {
      for (const button of [
        page.locator('[data-diagram-canvas] [data-marker="1"]'),
        hotspot(page, 1).getByRole("button", { name: "Șterge hotspot-ul 1" }),
        hotspot(page, 1).getByRole("button", { name: "Alege hotspot-ul 1" }),
        page
          .locator('[data-diagram-product="Garnitură capac"]')
          .getByRole("button", { name: /^Scoate produsul/ }),
      ]) {
        const box = await button.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      }
    } finally {
      await context.close();
    }
  });
});

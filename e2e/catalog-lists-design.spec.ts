import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  promoteE2eUser,
  removeE2eAttributes,
  removeE2eCatalogRefs,
  removeE2eUnits,
  seedE2eAttributeList,
  seedE2eBrandList,
  seedE2eCategoryTree,
  seedE2eUnit,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Redesign admin, Lotul 3a (docs/17): Categorii, Branduri, Atribute și Unități de măsură. Titlu cu număr, liste pe `Table`
 * (priorități de coloane, mod stivuit pe telefon) sau, la categorii, arbore cu rânduri uniforme; acțiuni doar cu pictogramă
 * (nume accesibil și tooltip), valori care nu se rup în mijloc, stări goale cu `EmptyState` și o singură acțiune, un singur buton
 * principal pe ecran și în fiecare dialog (confirmările de ștergere sunt de pericol, nu principale). Stările pe care baza comună
 * nu le poate garanta (listă goală, doar citire, texte lungi) se verifică pe pagina-harness `/admin/e2e-harness/liste-catalog`.
 * Comportamentul (creare, editare, ștergere, mutare) rămâne în `categories.spec.ts`, `measure-units.spec.ts` și celelalte specuri.
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
let account: Account;

test.beforeAll(async ({ request, baseURL }) => {
  account = await createAccount(request, baseURL as string, "owner");
  await seedE2eUnit({ code: `e2e${tag}a`, name: "Rolă de liner", symbol: "rolă", decimals: 0 });
  await seedE2eUnit({ code: `e2e${tag}b`, name: "Kilogram de clor", symbol: "kg", decimals: 2 });
  await seedE2eBrandList(tag, [`Hayward ${tag}`, `Zodiac ${tag}`, `Astral Pool Europe ${tag}`]);
  await seedE2eCategoryTree(tag, [
    { name: `Pompe ${tag}`, children: ["Pompe inverter", "Pompe on/off"] },
    { name: `Tratarea apei ${tag}`, children: ["Clor și dezinfectanți"] },
  ]);
  await seedE2eAttributeList(tag);
});

test.afterAll(async () => {
  await removeE2eAttributes();
  await removeE2eCatalogRefs();
  await removeE2eUnits();
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
    const names: string[] = [];
    for (const el of scope.querySelectorAll<HTMLElement>('button, a, [role="button"]')) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (getComputedStyle(el).backgroundColor !== primary) continue;
      names.push((el.getAttribute("aria-label") ?? el.textContent ?? "").trim());
    }
    return names;
  };
  return root ? root.evaluate(scan) : page.evaluate(scan, null);
}

interface TableScreen {
  key: string;
  url: string;
  table: string;
  heading: RegExp;
  create: string;
  /** Rândul de probă, cu nume scurt (rând de un singur rând de text). */
  row: (page: Page) => Locator;
  columns: { primary: string[]; secondary: string[]; tertiary: string[]; detail: string[] };
  /** Acțiunile rândului (nume accesibil), toate doar cu pictogramă. */
  actions: RegExp[];
  /** Celulele cu valori scurte care nu se rup (data-cell). */
  nowrap: string[];
  /** Înălțimea maximă a cardului pe telefon (acțiunile stau în colțul din dreapta-sus, lângă nume). */
  phoneMax: number;
}

const TABLES: TableScreen[] = [
  {
    key: "unitati",
    url: "/admin/produse/unitati-de-masura",
    table: "Lista unităților de măsură",
    heading: /^Unități de măsură \(\d+\)$/,
    create: "Unitate nouă",
    row: (page) => page.locator(`[data-unit-row="e2e${tag}a"]`),
    columns: {
      primary: ["Nume", "Simbol", "Stare", "Acțiuni"],
      secondary: ["Cod", "Zecimale"],
      tertiary: ["Nume în SmartBill"],
      detail: ["Folosită de"],
    },
    actions: [/^Editează unitatea/, /^(Dezactivează|Activează) unitatea/],
    nowrap: ["code", "symbol", "decimals", "usage"],
    phoneMax: 84,
  },
  {
    key: "branduri",
    url: "/admin/produse/branduri",
    table: "Lista brandurilor",
    heading: /^Branduri \(\d+\)$/,
    create: "Brand nou",
    row: (page) => page.locator("[data-brand-row]").filter({ hasText: `Hayward ${tag}` }),
    columns: {
      primary: ["Nume", "Produse", "Acțiuni"],
      secondary: ["Adresă"],
      tertiary: ["Termen «La comandă»"],
      detail: [],
    },
    actions: [/^Editează brandul/, /^Șterge brandul/],
    nowrap: ["slug", "products", "lead-time"],
    phoneMax: 76,
  },
  {
    key: "atribute",
    url: "/admin/produse/atribute",
    table: "Atributele magazinului",
    heading: /^Atribute \(\d+\)$/,
    create: "Atribut nou",
    row: (page) => page.locator(`[data-attribute-row="e2e${tag}material"]`),
    columns: {
      primary: ["Nume", "Tip", "Acțiuni"],
      secondary: ["Cod", "Unitate"],
      tertiary: ["Filtrabil", "Utilizare"],
      detail: ["Opțiuni"],
    },
    actions: [/^Editează atributul/, /^Șterge atributul/],
    nowrap: ["code", "unit", "usage"],
    phoneMax: 76,
  },
];

const tableOf = (page: Page, screen: TableScreen) =>
  page.getByRole("table", { name: screen.table });

test.describe("liste pe Table: Unități de măsură, Branduri, Atribute", () => {
  for (const screen of TABLES) {
    test(`${screen.key}, 1440 px: titlu cu număr, antet gri, rânduri de cel mult 56 px, acțiuni doar cu pictogramă, un singur buton principal`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await login(page, account, screen.url);
      const h1 = page.getByRole("heading", { level: 1 });
      await expect(h1).toHaveText(screen.heading);
      expect(await css(h1, "font-size")).toBe("22px");
      const table = tableOf(page, screen);
      await expect(table).toBeVisible();
      for (const name of Object.values(screen.columns).flat()) {
        await expect(table.getByRole("columnheader", { name, exact: true }), name).toBeVisible();
      }
      expect(await css(table.locator("thead"), "background-color")).not.toBe("rgba(0, 0, 0, 0)");
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0);

      const row = screen.row(page);
      await expect(row).toBeVisible();
      const height = (await row.boundingBox())?.height ?? 0;
      expect(height, "înălțimea rândului").toBeGreaterThanOrEqual(48);
      expect(height, "înălțimea rândului").toBeLessThanOrEqual(56);
      // valorile scurte nu se rup în mijloc
      for (const cell of screen.nowrap) {
        const locator = row.locator(`[data-cell="${cell}"]`);
        await expect(locator, cell).toHaveCount(1);
        expect(await css(locator, "white-space"), `celula ${cell}`).toBe("nowrap");
      }
      // acțiunile: doar pictogramă (fără text), pătrate de 32 px, cu nume accesibil și tooltip
      for (const action of screen.actions) {
        const button = row.getByRole("button", { name: action });
        await expect(button).toHaveText("");
        await expect(button).toHaveAttribute("title", /.+/);
        const box = await button.boundingBox();
        expect(box?.width ?? 0, "buton pătrat").toBeCloseTo(box?.height ?? 1, 0);
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);
      }
      // un singur buton principal pe ecran
      expect(await primaryControls(page)).toEqual([screen.create]);
    });

    test(`${screen.key}, 1024 px: doar coloanele principale, fără derulare orizontală`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1024, height: 768 });
      await login(page, account, screen.url);
      const table = tableOf(page, screen);
      await expect(table).toBeVisible();
      for (const name of screen.columns.primary) {
        await expect(table.getByRole("columnheader", { name, exact: true }), name).toBeVisible();
      }
      for (const name of [
        ...screen.columns.secondary,
        ...screen.columns.tertiary,
        ...screen.columns.detail,
      ]) {
        await expect(table.getByRole("columnheader", { name, exact: true }), name).toBeHidden();
      }
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
      expect(
        await table.locator("xpath=..").evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(0);
    });

    test(`${screen.key}, 390 px: cardul de cel mult ${screen.phoneMax} px, acțiunile de 44 px în colțul din dreapta-sus, fără derulare orizontală`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await login(page, account, screen.url);
      const table = tableOf(page, screen);
      await expect(table).toBeVisible();
      await expect(table.locator("thead")).not.toBeInViewport();
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
      const row = screen.row(page);
      await row.scrollIntoViewIfNeeded();
      const box = await row.boundingBox();
      expect(box?.height ?? 999, "înălțimea cardului").toBeLessThanOrEqual(screen.phoneMax);
      for (const action of screen.actions) {
        const button = row.getByRole("button", { name: action });
        await expect(button).toBeVisible();
        expect((await button.boundingBox())?.height ?? 0, "țintă de 44 px").toBeGreaterThanOrEqual(
          44,
        );
        expect((await button.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44);
      }
      await expectActionsBesideName(row, `${screen.key}, 390 px`);
      expect(await primaryControls(page)).toEqual([screen.create]);
    });
  }
});

test.describe("categorii: arbore cu rânduri uniforme", () => {
  test("descrierea paginii: o singură formulare, completă; pe telefon dispare nota despre tragere și rămâne mențiunea cu butoanele «Mută»", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, "/admin/produse/categorii");
    const main = page.locator("main");
    await expect(main).toContainText("Arborele de categorii al magazinului");
    const text = async () => (await main.innerText()).replace(/\s+/g, " ");
    // desktop: arborele, ordinea din magazin, tragerea pentru subcategorie sau reordonare, butoanele «Mută» ca alternativă — o singură dată
    const desktop = await text();
    for (const part of [
      "Arborele de categorii al magazinului",
      "ordinea de aici e ordinea din magazin",
      "Poți trage o categorie peste alta ca să devină subcategoria ei, sau deasupra/dedesubtul ei ca să o reordonezi",
      "Alternativ, folosește butoanele „Mută”",
    ]) {
      expect(desktop.split(part).length - 1, `«${part}» apare o singură dată`).toBe(1);
    }
    // formularea veche (de pe antet) nu mai există
    expect(desktop).not.toContain("Trage o categorie sau folosește butoanele pentru a o muta");
    expect(desktop.split("butoanele „Mută”").length - 1, "mențiunea cu butoanele «Mută»").toBe(1);

    // telefon: nota despre tragere dispare, rămâne doar mențiunea cu butoanele «Mută» (o singură dată)
    await page.setViewportSize({ width: 390, height: 844 });
    const phone = await text();
    expect(phone).toContain("Arborele de categorii al magazinului");
    expect(phone).not.toContain("Poți trage");
    expect(phone).not.toContain("Alternativ");
    expect(phone).toContain("Folosește butoanele „Mută” pentru a muta o categorie");
    expect(phone.split("butoanele „Mută”").length - 1, "mențiunea cu butoanele «Mută»").toBe(1);
  });

  test("1440 px: titlu cu număr, rânduri de 48–60 px, acțiuni doar cu pictogramă, un singur buton principal", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, "/admin/produse/categorii");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Categorii \(\d+\)$/);
    const tree = page.getByRole("list", { name: "Arborele de categorii" });
    await expect(tree).toBeVisible();
    const rows = page.locator("[data-category-row]").filter({ hasText: tag });
    expect(await rows.count()).toBeGreaterThanOrEqual(5);
    for (const [index, row] of (await rows.all()).entries()) {
      const height = (await row.boundingBox())?.height ?? 0;
      expect(height, `rândul ${index}`).toBeGreaterThanOrEqual(48);
      expect(height, `rândul ${index}`).toBeLessThanOrEqual(60);
    }
    const first = rows.first();
    for (const name of [
      /^Mută .* mai sus$/,
      /^Mută .* mai jos$/,
      /^Mută categoria/,
      /^Editează categoria/,
      /^Șterge categoria/,
    ]) {
      const button = first.getByRole("button", { name });
      await expect(button, String(name)).toHaveText("");
      await expect(button).toHaveAttribute("title", /.+/);
      expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(32);
    }
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    expect(await primaryControls(page)).toEqual(["Categorie nouă"]);
  });

  test("390 px: rândul de cel mult 132 px, cele 5 acțiuni de 44 px pe o singură linie, fără derulare orizontală", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, account, "/admin/produse/categorii");
    const row = page
      .locator("[data-category-row]")
      .filter({ hasText: `Pompe ${tag}` })
      .first();
    await row.scrollIntoViewIfNeeded();
    expect((await row.boundingBox())?.height ?? 999).toBeLessThanOrEqual(132);
    const tops = new Set<number>();
    for (const name of [
      /^Mută .* mai sus$/,
      /^Mută .* mai jos$/,
      /^Mută categoria/,
      /^Editează categoria/,
      /^Șterge categoria/,
    ]) {
      const box = await row.getByRole("button", { name }).boundingBox();
      tops.add(Math.round(box?.y ?? 0));
      expect(box?.height ?? 0, "țintă de 44 px").toBeGreaterThanOrEqual(44);
    }
    expect([...tops].length, "acțiunile pe o singură linie").toBe(1);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
  });
});

/**
 * Acțiunile cardului de pe telefon (Branduri, Unități, Atribute) stau în colțul din dreapta-sus, lângă nume: toate în prima bandă
 * a cardului (primii 52 px), lipite de marginea din dreapta, în interiorul cardului; textul numelui se oprește înaintea lor.
 */
async function expectActionsBesideName(row: Locator, where: string) {
  const box = await row.boundingBox();
  const rowTop = box?.y ?? 0;
  const rowRight = (box?.x ?? 0) + (box?.width ?? 0);
  let firstLeft = Number.POSITIVE_INFINITY;
  let lastRight = 0;
  for (const button of await row.locator('[data-cell="actions"] button').all()) {
    const b = await button.boundingBox();
    expect(b?.y ?? 999, `${where}: acțiunea în prima bandă`).toBeLessThanOrEqual(rowTop + 12);
    expect(
      (b?.y ?? 0) + (b?.height ?? 0),
      `${where}: acțiunea în interiorul cardului`,
    ).toBeLessThanOrEqual((box?.y ?? 0) + (box?.height ?? 0) + 0.5);
    firstLeft = Math.min(firstLeft, b?.x ?? 0);
    lastRight = Math.max(lastRight, (b?.x ?? 0) + (b?.width ?? 0));
  }
  expect(rowRight - lastRight, `${where}: lipite de marginea din dreapta`).toBeLessThanOrEqual(16);
  expect(lastRight, `${where}: în interiorul cardului`).toBeLessThanOrEqual(rowRight + 0.5);
  // textul numelui (nu celula, care are umplutură) se oprește înaintea acțiunilor
  const nameRight = await row.locator('th[scope="row"]').evaluate((cell) => {
    const range = document.createRange();
    range.selectNodeContents(cell);
    return range.getBoundingClientRect().right;
  });
  expect(nameRight, `${where}: numele nu se suprapune cu acțiunile`).toBeLessThanOrEqual(
    firstLeft + 0.5,
  );
}

test.describe("acțiunile de rând: pictograme terțe (ghost), fără bordură în repaus", () => {
  const ROWS = [
    ...TABLES.map((screen) => ({
      key: screen.key,
      url: screen.url,
      row: screen.row,
      actions: screen.actions,
    })),
    {
      key: "categorii",
      url: "/admin/produse/categorii",
      row: (page: Page) =>
        page
          .locator("[data-category-row]")
          .filter({ hasText: `Pompe ${tag}` })
          .first(),
      actions: [
        /^Mută .* mai sus$/,
        /^Mută .* mai jos$/,
        /^Mută categoria/,
        /^Editează categoria/,
        /^Șterge categoria/,
      ],
    },
  ];

  for (const item of ROWS) {
    test(`${item.key}, 1440 px: în repaus fără bordură și fără fundal; la hover fundal, la focus de tastatură inel; ținta rămâne de 32 px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await login(page, account, item.url);
      expect(await page.evaluate(() => matchMedia("(pointer: fine)").matches)).toBe(true);
      const row = item.row(page);
      await expect(row).toBeVisible();
      for (const action of item.actions) {
        const button = row.getByRole("button", { name: action });
        await expect(button, String(action)).toBeVisible();
        // repaus: nicio bordură, niciun fundal (doar pictograma)
        await page.mouse.move(0, 0);
        await page.waitForTimeout(250);
        expect(await css(button, "border-top-width"), `${action}: bordură în repaus`).toBe("0px");
        expect(await css(button, "background-color"), `${action}: fundal în repaus`).toBe(
          "rgba(0, 0, 0, 0)",
        );
        // ținta de cursor fin: 32 px (nu 44 px, care e doar pentru ecrane tactile)
        const box = await button.boundingBox();
        expect(box?.height ?? 0, `${action}: înălțime`).toBeCloseTo(32, 0);
        expect(box?.width ?? 0, `${action}: lățime`).toBeCloseTo(32, 0);
        // hover: apare fundalul (dacă butonul e activ)
        if (await button.isEnabled()) {
          await button.hover();
          await expect
            .poll(() => css(button, "background-color"), { message: `${action}: fundal la hover` })
            .not.toBe("rgba(0, 0, 0, 0)");
          // focus de la tastatură: inel vizibil
          await page.mouse.move(0, 0);
          await button.focus();
          await page.keyboard.press("Shift+Tab");
          await page.keyboard.press("Tab");
          await expect(button).toBeFocused();
          expect(await css(button, "box-shadow"), `${action}: inel la focus`).not.toBe("none");
        }
      }
    });
  }

  test("categorii: săgețile de la capete sunt dezactivate și vizibil estompate (nu dispar)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, "/admin/produse/categorii");
    const row = page.locator("[data-category-row]").filter({ hasText: "Pompe inverter" }).first();
    const up = row.getByRole("button", { name: /^Mută Pompe inverter mai sus$/ });
    await expect(up).toBeVisible();
    await expect(up).toBeDisabled();
    const opacity = Number(await css(up, "opacity"));
    expect(opacity, "estompat").toBeLessThan(1);
    expect(opacity, "încă vizibil").toBeGreaterThanOrEqual(0.4);
    // are nume accesibil și tooltip (neschimbate)
    await expect(up).toHaveAttribute("title", /.+/);
  });

  for (const item of ROWS) {
    test(`${item.key}, ecran tactil (pointer grosier, 1024 px): acțiunile de rând au cel puțin 44 px`, async ({
      browser,
      baseURL,
    }) => {
      const context = await browser.newContext({
        baseURL: baseURL as string,
        hasTouch: true,
        isMobile: true,
        viewport: { width: 1024, height: 768 },
      });
      try {
        const page = await context.newPage();
        await login(page, account, item.url);
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
        const row = item.row(page);
        await expect(row).toBeVisible();
        for (const action of item.actions) {
          const button = row.getByRole("button", { name: action });
          await expect(button, String(action)).toBeVisible();
          const box = await button.boundingBox();
          expect(box?.height ?? 0, `${action}: înălțime`).toBeGreaterThanOrEqual(44);
          expect(box?.width ?? 0, `${action}: lățime`).toBeGreaterThanOrEqual(44);
        }
      } finally {
        await context.close();
      }
    });
  }
});

const HARNESS = (screen: string, stare: string) =>
  `/admin/e2e-harness/liste-catalog?ecran=${screen}&stare=${stare}`;
const EMPTY = [
  { key: "unitati", title: "Nu există nicio unitate de măsură.", create: "Unitate nouă" },
  { key: "branduri", title: "Nu există niciun brand încă.", create: "Brand nou" },
  { key: "atribute", title: "Nu ai definit încă niciun atribut.", create: "Atribut nou" },
  { key: "categorii", title: "Nu există nicio categorie încă.", create: "Categorie nouă" },
] as const;

test.describe("stări: listă goală, doar citire, texte lungi (pagina-harness)", () => {
  for (const item of EMPTY) {
    test(`${item.key}: lista goală e o stare goală cu o singură acțiune (butonul principal), fără al doilea «${item.create}»`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await login(page, account, HARNESS(item.key, "goala"));
      const heading = page.getByRole("heading", { level: 2, name: item.title });
      await expect(heading).toBeVisible();
      // titlul stării goale e în același bloc cu acțiunea
      await expect(
        heading.locator("xpath=..").getByRole("button", { name: item.create }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: item.create })).toHaveCount(1);
      expect(await primaryControls(page)).toEqual([item.create]);
      expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    });

    test(`${item.key}: doar pentru citire nu are nicio acțiune și niciun buton principal`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await login(page, account, HARNESS(item.key, "citire"));
      expect(await primaryControls(page)).toEqual([]);
      await expect(page.getByRole("button", { name: item.create })).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: /^(Editează|Șterge|Dezactivează|Activează|Mută)/ }),
      ).toHaveCount(0);
    });

    for (const width of [1440, 390]) {
      test(`${item.key}, ${width} px: texte lungi: fără derulare orizontală, valorile nu se rup, codurile se taie cu «…»`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await login(page, account, HARNESS(item.key, "lung"));
        expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
        // valorile numerice și codurile scurte rămân pe o linie
        for (const cell of await page
          .locator('[data-cell="products"], [data-cell="usage"], [data-cell="decimals"]')
          .all()) {
          if (!(await cell.isVisible())) continue;
          expect(await css(cell, "white-space")).toBe("nowrap");
        }
        // adresele și codurile lungi: o linie, cu ellipsis și textul întreg în title
        // pe lățimea mare codurile/adresele sunt vizibile (pe telefon coloanele secundare nu apar în card)
        if (width === 1440) {
          await expect(
            page.locator("[data-cell-text]:visible").first(),
            "cod sau adresă vizibilă",
          ).toBeVisible();
        }
        for (const text of await page.locator("[data-cell-text]").all()) {
          if (!(await text.isVisible())) continue;
          expect(await css(text, "white-space")).toBe("nowrap");
          expect(await css(text, "text-overflow")).toBe("ellipsis");
          expect((await text.boundingBox())?.height ?? 99).toBeLessThanOrEqual(24);
        }
        // pe telefon, la ecranele cu tabel: acțiunile rămân în colțul cardului chiar și cu nume lung (nu sunt împinse în afară)
        if (width === 390 && item.key !== "categorii") {
          for (const row of await page
            .locator("[data-unit-row], [data-brand-row], [data-attribute-row]")
            .all()) {
            if (!(await row.isVisible())) continue;
            await expectActionsBesideName(row, `${item.key} lung, 390 px`);
          }
        }
        // niciun rând nu e mai înalt de 200 px (numele lung se rupe pe cuvinte, nu în mijlocul lor)
        for (const row of await page
          .locator("[data-unit-row], [data-brand-row], [data-attribute-row], [data-category-row]")
          .all()) {
          if (!(await row.isVisible())) continue;
          expect((await row.boundingBox())?.height ?? 999).toBeLessThanOrEqual(200);
        }
      });
    }
  }

  test("unități: pastile de stare cu tonuri diferite (Activă / Dezactivată) și textul scris", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, HARNESS("unitati", "lista"));
    const active = page.locator('[data-unit-row="buc"] [data-status-pill]').first();
    const inactive = page.locator('[data-unit-row="litru"] [data-status-pill]').first();
    await expect(active).toHaveText("Activă");
    await expect(inactive).toHaveText("Dezactivată");
    expect(await css(active, "border-top-left-radius")).not.toBe("0px");
    expect(await css(active, "background-color")).not.toBe(await css(inactive, "background-color"));
    // «Implicită» e o pastilă separată, nu un buton
    await expect(page.locator('[data-unit-row="buc"]').getByText("Implicită")).toBeVisible();
  });
});

const CREATE_DIALOGS = [
  {
    key: "unitati",
    url: "/admin/produse/unitati-de-masura",
    open: "Unitate nouă",
    save: "Salvează",
  },
  { key: "branduri", url: "/admin/produse/branduri", open: "Brand nou", save: "Salvează" },
  {
    key: "atribute",
    url: "/admin/produse/atribute",
    open: "Atribut nou",
    save: "Creează atributul",
  },
  { key: "categorii", url: "/admin/produse/categorii", open: "Categorie nouă", save: "Salvează" },
] as const;

test.describe("dialoguri: un singur buton principal, erori în tonul Problemă, ștergerea ca acțiune de pericol", () => {
  for (const item of CREATE_DIALOGS) {
    for (const width of [1440, 390]) {
      test(`${item.key}, ${width} px: dialogul de creare are un singur buton principal (de salvare), «Anulează» secundar; o eroare nu adaugă altul`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await login(page, account, item.url);
        await page.getByRole("button", { name: item.open, exact: true }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        expect(await primaryControls(page, dialog), "butoane principale în dialog").toEqual([
          item.save,
        ]);
        await expect(dialog.getByRole("button", { name: "Anulează" })).toBeVisible();
        // salvare cu câmpuri goale: eroarea apare în tonul Problemă, iar dialogul rămâne cu un singur buton principal
        await dialog.getByRole("button", { name: item.save }).click();
        const problem = dialog.locator('[data-problem], [role="alert"], [id$="-error"]').first();
        await expect(problem).toBeVisible();
        expect(await css(problem, "color"), "culoarea erorii").toBe(
          await tokenStyle(page, "text-tone-problem-fg", "color"),
        );
        expect(await primaryControls(page, dialog)).toEqual([item.save]);
        expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
      });
    }
  }

  const DELETE = [
    {
      key: "branduri",
      url: "/admin/produse/branduri",
      row: `Zodiac ${tag}`,
      button: /^Șterge brandul/,
      rowSel: "[data-brand-row]",
    },
    {
      key: "atribute",
      url: "/admin/produse/atribute",
      row: "Cu telecomandă",
      button: /^Șterge atributul/,
      rowSel: "[data-attribute-row]",
    },
    {
      key: "categorii",
      url: "/admin/produse/categorii",
      row: `Tratarea apei ${tag}`,
      button: /^Șterge categoria/,
      rowSel: "[data-category-row]",
    },
  ] as const;
  for (const item of DELETE) {
    test(`${item.key}: confirmarea ștergerii e acțiune de pericol (nu buton principal), cu «Anulează» secundar`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await login(page, account, item.url);
      const row = page.locator(item.rowSel).filter({ hasText: item.row }).first();
      await row.getByRole("button", { name: item.button }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      expect(
        await primaryControls(page, dialog),
        "fără buton principal în confirmarea de ștergere",
      ).toEqual([]);
      const confirm = dialog.getByRole("button", { name: /^Șterge/ });
      expect(await css(confirm, "color"), "text în tonul Problemă").toBe(
        await tokenStyle(page, "text-tone-problem-fg", "color"),
      );
      expect(await css(confirm, "border-top-width")).toBe("1px");
      await expect(dialog.getByRole("button", { name: /^Anulează/ })).toBeVisible();
      await page.keyboard.press("Escape");
    });
  }
});
